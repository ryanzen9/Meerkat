import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react';
import type { CodeHeaderProps } from '@assistant-ui/react-markdown';
import type { GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { ReviewGitContext } from './GitStatusLine';
import { Icon } from './Icon';
import { Thread, type ThreadComponents } from './assistant-ui/elements/thread.aui';
import { MarkdownText } from './assistant-ui/elements/markdown-text';
import { cn } from '../lib/utils';
import { isFileReferenceId } from '@shared/protocol';
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

const WelcomeContext = createContext({ authenticated: false, onFiles: () => {} });

function ReviewWelcome() {
  const { authenticated, onFiles } = useContext(WelcomeContext);
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-start px-2">
      <span className="mb-4 flex size-10 items-center justify-center rounded-xl border border-widget bg-surface text-link">
        <Icon name="review" className="size-6" />
      </span>
      <h2 className="mb-2 text-[1.15rem] font-semibold">从变更开始对话</h2>
      <p className="mb-4 max-w-80 text-[0.9rem] leading-relaxed text-muted">
        查看工作区中的文件变更，记录你想让 Agent 审查的问题。
      </p>
      <button
        type="button"
        onClick={onFiles}
        className="flex items-center gap-2 rounded-md border border-widget bg-surface px-3 py-2 text-[0.85rem] hover:bg-hover"
      >
        <Icon name="file" className="size-3.5" />
        查看文件变更
        <Icon name="chevron" className="size-3" />
      </button>
      <p className="mt-5 text-[0.8rem] text-muted">
        {authenticated
          ? 'ChatGPT 已连接。仅发送你输入的内容。'
          : 'Continue with ChatGPT 后开始对话。'}
      </p>
    </div>
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
  Welcome: ReviewWelcome,
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
  authenticated,
  onFiles,
  snapshot,
  repository,
  ...composer
}: ReviewComposerState & {
  authenticated: boolean;
  onFiles(): void;
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
}) {
  return (
    <WelcomeContext.Provider value={{ authenticated, onFiles }}>
      <ReviewGitContext.Provider value={{ snapshot, repository }}>
        <ReviewComposerContext.Provider value={composer}>
          <Thread components={THREAD_COMPONENTS} autoFocus={false} />
        </ReviewComposerContext.Provider>
      </ReviewGitContext.Provider>
    </WelcomeContext.Provider>
  );
}
