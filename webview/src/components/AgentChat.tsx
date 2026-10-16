import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import {
  ActionBarPrimitive,
  AuiConfig,
  Tools,
  defineToolkit,
  makeAssistantDataUI,
  useAuiState,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import type { CodeHeaderProps } from '@assistant-ui/react-markdown';
import type { GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { ReviewGitContext } from './GitStatusLine';
import { Icon } from './Icon';
import { Thread, type ThreadComponents } from './assistant-ui/elements/thread.aui';
import { MarkdownText } from './assistant-ui/elements/markdown-text';
import { cn } from '../lib/utils';
import { isFileReferenceId } from '@shared/protocol';
import type {
  FinishReviewInput,
  ReviewFinding,
  ReviewRunState,
  SubmitReviewInput,
  SubmitReviewResult,
} from '@shared/review';
import {
  ReviewComposerContext,
  ReviewComposerInput,
  ReviewComposerFooter,
  ReviewModelSelector,
  type ReviewComposerState,
} from './ReviewComposer';

interface ChatActions {
  openFile(uri: string): Promise<unknown>;
  openReference(referenceId: string): Promise<unknown>;
  openCode(code: string, language: string): Promise<unknown>;
  copy(text: string): Promise<unknown>;
}
export const ChatActionsContext = createContext<ChatActions | null>(null);

export function ReviewFindingCard({
  finding,
  openReference,
}: {
  finding: ReviewFinding;
  openReference(referenceId: string): Promise<unknown>;
}) {
  return (
    <article
      data-review-finding={finding.id}
      aria-label={`${finding.priority} ${finding.title}`}
      className="my-3 rounded-lg border border-widget bg-surface p-3"
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="rounded bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">
          {finding.priority}
        </span>
        <h3 className="min-w-0 flex-1 text-sm font-semibold wrap-anywhere">{finding.title}</h3>
        <span className="shrink-0 text-xs text-muted">已保存</span>
      </div>
      <p className="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
        {finding.description}
      </p>
      <ul aria-label="已验证的代码引用" className="mt-3 flex flex-wrap gap-2">
        {finding.references.map((reference) => (
          <li key={reference.referenceId}>
            <button
              type="button"
              className="rounded-sm bg-code px-1 py-0.5 font-mono text-xs text-link underline underline-offset-2"
              onClick={() => {
                void openReference(reference.referenceId).catch(() => {});
              }}
            >
              {reference.label}
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

type ToolFailure = { error: { code: string; message: string } };
const ReviewFindingTool: ToolCallMessagePartComponent<
  SubmitReviewInput,
  SubmitReviewResult | ToolFailure
> = ({ result, toolCallId }) => {
  const actions = useContext(ChatActionsContext)!;
  if (!result) return null;
  if ('error' in result)
    return <p className="my-2 text-xs text-muted">意见尚未收录：{result.error.message}</p>;
  if (!result.accepted || result.finding.toolCallId !== toolCallId) return null;
  return <ReviewFindingCard finding={result.finding} openReference={actions.openReference} />;
};
const ReviewFinishTool: ToolCallMessagePartComponent<
  FinishReviewInput,
  { accepted: true; status: 'completed' | 'incomplete' } | ToolFailure
> = ({ result }) =>
  result && 'error' in result ? (
    <p className="my-2 text-xs text-muted">收尾校验未通过：{result.error.message}</p>
  ) : null;

const reviewToolkit = defineToolkit({
  submit_review: { type: 'backend', display: 'standalone', render: ReviewFindingTool },
  finish_review: { type: 'backend', display: 'standalone', render: ReviewFinishTool },
});
export const reviewToolConfig = AuiConfig({ tools: Tools({ toolkit: reviewToolkit }) });

export function ReviewRunSummary({ run }: { run: ReviewRunState }) {
  return (
    <div
      role="status"
      data-review-status={run.status}
      className="my-3 rounded-md border border-widget p-3 text-sm"
    >
      <p>{run.summary}</p>
      {run.unfinishedItems.length > 0 && (
        <div className="mt-2">
          <p className="font-medium">未完成事项</p>
          <ul className="list-disc pl-5">
            {run.unfinishedItems.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {run.limitations.length > 0 && (
        <div className="mt-2">
          <p className="font-medium">审查限制</p>
          <ul className="list-disc pl-5">
            {run.limitations.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
const ReviewStatusUI = makeAssistantDataUI<ReviewRunState>({
  name: 'review-status',
  render: ({ data }) => <ReviewRunSummary run={data} />,
});

function CodeHeader({ language = '', code }: CodeHeaderProps) {
  const actions = useContext(ChatActionsContext)!;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-3 flex items-center justify-between gap-2 rounded-t-md border border-widget bg-surface px-2 py-1 text-[0.75rem] text-muted">
      <span className="truncate font-mono">{language || 'text'}</span>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          className="icon-button size-6"
          aria-label={copied ? '已复制代码' : '复制代码'}
          title={copied ? '已复制' : '复制代码'}
          onClick={() => {
            void actions
              .copy(code)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} className="size-3" />
        </button>
        <button
          type="button"
          className="icon-button size-6"
          aria-label="在编辑器中打开代码"
          title="在编辑器中打开代码"
          onClick={() => {
            void actions
              .openCode(code, /^[\w+-]{0,40}$/.test(language) ? language : '')
              .catch(() => {});
          }}
        >
          <Icon name="open" className="size-3" />
        </button>
      </div>
      <span className="sr-only" role="status">
        {copied ? '代码已复制' : ''}
      </span>
    </div>
  );
}

function MarkdownLink({ href, children }: ComponentPropsWithoutRef<'a'>) {
  const actions = useContext(ChatActionsContext)!;
  if (href?.startsWith('review-file:')) {
    let target: string;
    try {
      target = decodeURIComponent(href.slice('review-file:'.length));
    } catch {
      return <span title="引用格式无效">{children}</span>;
    }
    const reference = isFileReferenceId(target);
    if (!reference && !/^(file:|vscode-remote:)/.test(target))
      return <span title="引用格式无效">{children}</span>;
    return (
      <a
        className={cn(
          'text-link underline underline-offset-2',
          reference && 'rounded-sm bg-code px-1 py-0.5 font-mono text-[0.9em]',
        )}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void (reference ? actions.openReference(target) : actions.openFile(target)).catch(
            () => {},
          );
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      className="text-link underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS = {
  CodeHeader,
  a: MarkdownLink,
  img: ({ alt }: ComponentPropsWithoutRef<'img'>) => <span className="text-muted">{alt}</span>,
};

const markdownUrlTransform = (url: string) =>
  /^(https?:|mailto:|review-file:)/.test(url) ? url : '';

function ReviewMarkdownText() {
  const reviewMessage = useAuiState(
    (state) => state.message.role === 'assistant' && state.message.id.startsWith('review-'),
  );
  if (reviewMessage) return null;
  return (
    <MarkdownText
      className="text-[0.95rem] leading-relaxed wrap-anywhere"
      smooth={false}
      skipHtml
      urlTransform={markdownUrlTransform}
      components={MARKDOWN_COMPONENTS}
    />
  );
}

function CopyResponse() {
  const actions = useContext(ChatActionsContext)!;
  const text = useAuiState((state) =>
    state.message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
  );
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        aria-label={copied ? '已复制回复' : '复制回复'}
        title={copied ? '已复制' : '复制回复'}
        disabled={!text || copying}
        className="flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-foreground motion-reduce:transition-none"
        onClick={() => {
          setCopied(false);
          setCopying(true);
          void actions
            .copy(text)
            .then(() => setCopied(true))
            .catch(() => {})
            .finally(() => setCopying(false));
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
      </button>
      <span className="sr-only" role="status">
        {copied ? '回复已复制' : ''}
      </span>
    </>
  );
}

function ReviewAssistantActionBar() {
  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="never">
      <CopyResponse />
    </ActionBarPrimitive.Root>
  );
}

// The Host stores an append-only conversation, so editing and regeneration
// are not exposed until the Bridge supports replacing the remote history.
const THREAD_COMPONENTS: ThreadComponents = {
  Text: ReviewMarkdownText,
  ComposerInput: ReviewComposerInput,
  ComposerFooter: ReviewComposerFooter,
  ComposerLeading: ReviewModelSelector,
  AssistantActionBar: ReviewAssistantActionBar,
  UserActionBar: () => null,
  // App renders connection and run failures in its shared alert banner.
  MessageError: () => null,
};

export function AgentChat({
  snapshot,
  repository,
  ...composer
}: ReviewComposerState & {
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
}) {
  return (
    <ReviewGitContext.Provider value={{ snapshot, repository }}>
      <ReviewComposerContext.Provider value={composer}>
        <ReviewStatusUI />
        <Thread components={THREAD_COMPONENTS} autoFocus={false} />
      </ReviewComposerContext.Provider>
    </ReviewGitContext.Provider>
  );
}
