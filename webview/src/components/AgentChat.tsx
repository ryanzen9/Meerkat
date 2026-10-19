import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ActionBarPrimitive,
  AuiConfig,
  Tools,
  defineToolkit,
  makeAssistantDataUI,
  useAui,
  useAuiState,
  type AssistantState,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import type { CodeHeaderProps } from '@assistant-ui/react-markdown';
import type { GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { ReviewGitContext } from './GitStatusLine';
import { Icon } from './Icon';
import { Thread, type ThreadComponents } from './assistant-ui/elements/thread.aui';
import { ErrorState } from './assistant-ui/elements/error-state';
import { MarkdownText } from './assistant-ui/elements/markdown-text';
import { cn } from '../lib/utils';
import { isFileReferenceId } from '@shared/protocol';
import type {
  FinishReviewInput,
  FindingStatus,
  ReviewFinding,
  ReviewRunState,
  SubmitReviewInput,
  SubmitReviewResult,
} from '@shared/review';
import {
  ReviewComposerContext,
  ReviewComposerInput,
  ReviewComposerFooter,
  ReviewComposerControls,
  type ReviewComposerState,
} from './ReviewComposer';

interface ChatActions {
  openFile(uri: string): Promise<unknown>;
  openReference(referenceId: string): Promise<unknown>;
  openCode(code: string, language: string): Promise<unknown>;
  copy(text: string): Promise<unknown>;
  findings: ReviewFinding[];
  setFindingStatus(id: string, status: FindingStatus): Promise<void>;
  setFindingArchived(id: string, archived: boolean): Promise<void>;
}
export const ChatActionsContext = createContext<ChatActions | null>(null);

export function ReviewFindingCard({
  finding,
  openReference,
  onStatusChange,
  onArchiveChange,
}: {
  finding: ReviewFinding;
  openReference(referenceId: string): Promise<unknown>;
  onStatusChange?(status: FindingStatus): Promise<void>;
  onArchiveChange?(archived: boolean): Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const resolved = finding.status === 'resolved';
  const saveChange = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await action();
    } catch {
      setError('状态保存失败，请重试。');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  // Tool results have no text-part scope for MarkdownTextPrimitive to read.
  const markdownComponents = useMemo<Components>(
    () => ({
      ...FINDING_MARKDOWN_COMPONENTS,
      a: ({ href, children }) => (
        <MarkdownLink
          href={href}
          referenceScope={{ references: finding.references, openReference }}
        >
          {children}
        </MarkdownLink>
      ),
    }),
    [finding.references, openReference],
  );
  return (
    <article
      data-review-finding={finding.id}
      data-review-resolution={resolved ? 'resolved' : 'unresolved'}
      data-review-archived={finding.editorArchived ? 'true' : 'false'}
      aria-label={`${finding.priority} ${finding.title}`}
      className="my-3 rounded-lg border border-widget bg-surface p-3"
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="rounded bg-code px-1.5 py-0.5 font-mono text-xs font-semibold">
          {finding.priority}
        </span>
        <h3 className="min-w-0 flex-1 text-sm font-semibold wrap-anywhere">{finding.title}</h3>
        <span role="status" className="shrink-0 text-xs text-muted">
          {resolved ? '已解决' : '未解决'}
        </span>
      </div>
      <div className="min-w-0 text-sm leading-relaxed wrap-anywhere">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={markdownUrlTransform}
          components={markdownComponents}
        >
          {finding.description}
        </ReactMarkdown>
      </div>
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
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-widget pt-2">
        <button
          type="button"
          aria-pressed={resolved}
          disabled={saving || !onStatusChange}
          className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-link hover:bg-code"
          onClick={() => {
            if (onStatusChange)
              void saveChange(() => onStatusChange(resolved ? 'unresolved' : 'resolved'));
          }}
        >
          <Icon name={resolved ? 'undo' : 'check'} className="size-3.5" />
          {saving ? '正在保存…' : resolved ? '标记为未解决' : '标记为已解决'}
        </button>
        {finding.editorArchived && (
          <>
            <span className="text-xs text-muted">批注已归档</span>
            <button
              type="button"
              disabled={saving || !onArchiveChange}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-link hover:bg-code"
              onClick={() => {
                if (onArchiveChange)
                  void saveChange(async () => {
                    await onArchiveChange(false);
                    try {
                      await openReference(finding.references[0]!.referenceId);
                    } catch {
                      setError('批注已恢复，暂时无法打开代码引用，请点击引用重试。');
                    }
                  });
              }}
            >
              <Icon name="undo" className="size-3.5" />
              恢复批注
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
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
  const finding = actions.findings.find((item) => item.id === result.finding.id) ?? result.finding;
  return (
    <ReviewFindingCard
      finding={finding}
      openReference={actions.openReference}
      onStatusChange={(status) => actions.setFindingStatus(finding.id, status)}
      onArchiveChange={(archived) => actions.setFindingArchived(finding.id, archived)}
    />
  );
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

function MarkdownLink({
  href,
  children,
  referenceScope,
}: ComponentPropsWithoutRef<'a'> & {
  referenceScope?: {
    references: ReviewFinding['references'];
    openReference(referenceId: string): Promise<unknown>;
  };
}) {
  const actions = useContext(ChatActionsContext);
  if (href?.startsWith('review-file:')) {
    let target: string;
    try {
      target = decodeURIComponent(href.slice('review-file:'.length));
    } catch {
      return <span title="引用格式无效">{children}</span>;
    }
    const reference = isFileReferenceId(target);
    if (
      referenceScope &&
      !referenceScope.references.some(({ referenceId }) => referenceId === target)
    )
      return <span title="引用未通过验证">{children}</span>;
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
          void (
            reference
              ? (referenceScope?.openReference ?? actions!.openReference)(target)
              : actions!.openFile(target)
          ).catch(() => {});
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

const FINDING_MARKDOWN_COMPONENTS: Components = {
  img: MARKDOWN_COMPONENTS.img,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  code: ({ children }) => (
    <code className="rounded-sm bg-code px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md bg-code p-2 whitespace-pre">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-widget pl-3 text-muted">{children}</blockquote>
  ),
};

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

/**
 * The failure a turn carries, read from its message: the run error's `message`
 * when it has one, mirroring assistant-ui's own error predicate without adding
 * `@assistant-ui/core` as a direct dependency.
 */
const messageErrorDetail = (state: AssistantState) => {
  const status = state.message.status;
  if (status?.type !== 'incomplete' || status.reason !== 'error') return undefined;
  const error = status.error;
  if (typeof error === 'string') return error;
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  // The runtime always carries one of the shapes above; keep a failure visible
  // if a host ever reports something else.
  return '发生未知错误。';
};

/**
 * A failed turn renders where the reply would have been, as the
 * `elements-error-state` banner. Retry re-runs from this message's parent: the
 * Host drops an uncommitted turn, so a retry cannot duplicate its history. The
 * element hides its button behind the retrying line while a run is in flight,
 * which also keeps a second retry from starting on top of one.
 */
function ReviewMessageError() {
  const aui = useAui();
  const detail = useAuiState(messageErrorDetail);
  const retrying = useAuiState((state) => state.thread.isRunning);
  if (detail === undefined) return null;
  return (
    <ErrorState
      title="回复失败"
      detail={detail}
      retrying={retrying}
      onRetry={() => aui.message.reload()}
    />
  );
}

// The Host stores an append-only conversation, so editing and regeneration
// are not exposed until the Bridge supports replacing the remote history.
const THREAD_COMPONENTS: ThreadComponents = {
  Text: ReviewMarkdownText,
  ComposerInput: ReviewComposerInput,
  ComposerFooter: ReviewComposerFooter,
  ComposerLeading: ReviewComposerControls,
  AssistantActionBar: ReviewAssistantActionBar,
  UserActionBar: () => null,
  // A failed turn carries its own error; App keeps connection and panel
  // failures in its shared alert banner.
  MessageError: ReviewMessageError,
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
