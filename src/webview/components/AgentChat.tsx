import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { MarkdownTextPrimitive, useIsMarkdownCodeBlock } from '@assistant-ui/react-markdown';
import type { CodeHeaderProps } from '@assistant-ui/react-markdown';
import { Icon } from './Icon';

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

function MarkdownCode({ children }: ComponentPropsWithoutRef<'code'>) {
  const block = useIsMarkdownCodeBlock();
  return (
    <code
      className={
        block ? 'font-mono text-[0.85rem]' : 'rounded-sm bg-code px-1 py-0.5 font-mono text-[0.9em]'
      }
    >
      {children}
    </code>
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
        a: MarkdownLink,
        img: ({ alt }) => <span className="text-muted">{alt}</span>,
        code: MarkdownCode,
        pre: ({ children }) => (
          <pre className="mb-3 max-w-full overflow-x-auto rounded-b-md border border-t-0 border-widget bg-code p-3 leading-relaxed whitespace-pre">
            {children}
          </pre>
        ),
      }}
    />
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mb-5 min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-medium text-muted">
        <Icon name="review" className="size-3.5 text-link" />
        Review
      </div>
      <div className="min-w-0 rounded-md rounded-tl-none border border-widget bg-agent p-3">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-5 ml-5 min-w-0">
      <p className="mb-1.5 text-right text-[0.75rem] font-medium text-muted">You</p>
      <div className="min-w-0 rounded-md rounded-tr-none border border-widget bg-user p-3 text-user-foreground">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

export function AgentChat({ empty, onFiles }: { empty: boolean; onFiles(): void }) {
  return (
    <ThreadPrimitive.Viewport
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain p-3"
      role="log"
      aria-label="Agent 对话"
      aria-live="polite"
    >
      {empty && (
        <div className="flex min-h-full flex-col items-start justify-center px-1 py-6">
          <span className="mb-4 flex size-10 items-center justify-center rounded-lg border border-widget bg-surface text-link">
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
          <p className="mt-5 text-[0.8rem] text-muted">AI 模型尚未配置</p>
        </div>
      )}
      <ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} />
    </ThreadPrimitive.Viewport>
  );
}
