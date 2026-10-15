import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { useEffect } from 'react';
import { Icon } from './Icon';

export function ReviewComposer({
  sessionId,
  draft,
  onDraftChange,
  onNew,
}: {
  sessionId: string;
  draft: string;
  onDraftChange(draft: string): void;
  onNew(): void;
}) {
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  useEffect(() => {
    aui.composer.setText(draft);
  }, [aui, sessionId, draft]);

  return (
    <footer className="shrink-0 border-t border-widget bg-sidebar px-3 pt-2.5 pb-2">
      <ComposerPrimitive.Root
        aria-label="发送给 Agent"
        className="flex items-end gap-2 rounded-md border border-input-border bg-input p-1 focus-within:border-focus high-contrast:border-contrast"
      >
        <textarea
          aria-label="询问 Agent"
          aria-describedby="composer-hint"
          className="[field-sizing:content] max-h-12 min-h-9 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2 text-[0.95rem] leading-5 text-input-foreground outline-none placeholder:text-input-placeholder"
          rows={1}
          value={text}
          maxLength={4000}
          placeholder="Ask the agent…"
          onChange={(event) => {
            aui.composer.setText(event.target.value);
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <ComposerPrimitive.Send
          className="mb-0.5 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-button-border bg-button text-button-foreground hover:bg-button-hover disabled:cursor-default disabled:opacity-40"
          aria-label="发送消息"
          title="发送消息"
        >
          <Icon name="send" />
        </ComposerPrimitive.Send>
        <ComposerPrimitive.Cancel aria-label="取消运行" className="rounded-sm px-2 py-1 text-error">
          停止
        </ComposerPrimitive.Cancel>
      </ComposerPrimitive.Root>
      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-[0.7rem] text-muted">
        <span id="composer-hint" className="truncate">
          {text.length === 4000 ? '已达到 4000 字符上限' : 'Enter 发送 · Shift+Enter 换行'}
        </span>
        <button
          type="button"
          className="icon-button size-4"
          aria-label="新建会话"
          title="新建会话"
          onClick={onNew}
        >
          <Icon name="plus" className="size-3" />
        </button>
      </div>
    </footer>
  );
}
