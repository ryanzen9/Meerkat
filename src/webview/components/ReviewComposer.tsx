import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { createContext, useContext, useEffect } from 'react';
import { Icon } from './Icon';

interface ReviewComposerState {
  sessionId: string;
  draft: string;
  onDraftChange(draft: string): void;
  onNew(): void;
}

export const ReviewComposerContext = createContext<ReviewComposerState | null>(null);

export function ReviewComposerInput({ autoFocus }: { autoFocus: boolean }) {
  const { sessionId, draft, onDraftChange } = useContext(ReviewComposerContext)!;
  const aui = useAui();
  useEffect(() => {
    aui.composer.setText(draft);
  }, [aui, sessionId, draft]);

  return (
    <ComposerPrimitive.Input
      aria-label="询问 Agent"
      aria-describedby="composer-hint"
      className="aui-composer-input max-h-48 min-h-12 w-full resize-none bg-transparent px-2.5 py-1 text-[0.95rem] leading-6 text-input-foreground outline-none placeholder:text-input-placeholder"
      rows={1}
      autoFocus={autoFocus}
      enterKeyHint="send"
      maxLength={4000}
      placeholder="Ask the agent…"
      onChange={(event) => {
        aui.composer.setText(event.target.value);
        onDraftChange(event.target.value);
      }}
    />
  );
}

export function ReviewComposerFooter() {
  const { onNew } = useContext(ReviewComposerContext)!;
  const text = useAuiState((state) => state.composer.text);
  return (
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
  );
}
