import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react';
import { MarkdownTextPrimitive, useIsMarkdownCodeBlock } from '@assistant-ui/react-markdown';
import type { CodeHeaderProps } from '@assistant-ui/react-markdown';
import { Icon } from './Icon';
import { Thread, type ThreadComponents } from './assistant-ui/elements/thread.aui';
import { SyntaxHighlighter } from './assistant-ui/elements/syntax-highlighter';
import { cn } from '../lib/utils';
import {
  ReviewComposerContext,
  ReviewComposerInput,
  ReviewComposerFooter,
  ReviewModelSelector,
  type ReviewComposerState,
} from './ReviewComposer';

interface ChatActions {
  openFile(uri: string): Promise<unknown>;
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
    return (
      <a
        className="text-link underline underline-offset-2"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          try {
            void actions
              .openFile(decodeURIComponent(href.slice('review-file:'.length)))
              .catch(() => {});
          } catch {
            /* Ignore malformed file references. */
          }
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

function MarkdownCode({ className, ...props }: ComponentPropsWithoutRef<'code'>) {
  const block = useIsMarkdownCodeBlock();
  return (
    <code
      {...props}
      className={cn(
        block
          ? 'font-mono text-[0.85rem]'
          : 'rounded-sm bg-code px-1 py-0.5 font-mono text-[0.9em]',
        className,
      )}
    />
  );
}

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="min-w-0 text-[0.95rem] leading-relaxed wrap-anywhere [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-link [&_blockquote]:pl-3 [&_h1]:my-3 [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-semibold [&_img]:hidden [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      smooth={false}
      skipHtml
      urlTransform={(url) => (/^(https?:|mailto:|review-file:)/.test(url) ? url : '')}
      components={{
        CodeHeader,
        SyntaxHighlighter,
        a: MarkdownLink,
        img: ({ alt }) => <span className="text-muted">{alt}</span>,
        code: MarkdownCode,
        pre: ({ className, ...props }) => (
          <pre
            {...props}
            className={cn(
              'mb-3 max-w-full overflow-x-auto rounded-b-md border border-t-0 border-widget bg-code p-3 leading-relaxed whitespace-pre',
              className,
            )}
          />
        ),
      }}
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
  Text: MarkdownText,
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
  ...composer
}: ReviewComposerState & {
  authenticated: boolean;
  onFiles(): void;
}) {
  return (
    <WelcomeContext.Provider value={{ authenticated, onFiles }}>
      <ReviewComposerContext.Provider value={composer}>
        <Thread components={THREAD_COMPONENTS} autoFocus={false} />
      </ReviewComposerContext.Provider>
    </WelcomeContext.Provider>
  );
}
