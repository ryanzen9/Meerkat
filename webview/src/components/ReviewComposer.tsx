import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { GitStatusLine } from './GitStatusLine';
import { Icon } from './Icon';
import { OpenAILogo } from './assistant-ui/elements/logos';
import { ModelSelector, type ModelOption } from './assistant-ui/elements/model-selector.aui';

import { isReasoningEffort, type AgentModel, type ReasoningEffort } from '@shared/agentModels';
import type { InteractionMode } from '@shared/review';

export interface ReviewComposerState {
  sessionId: string;
  draft: string;
  onDraftChange(draft: string): void;
  onNew(): void;
  models: readonly AgentModel[];
  modelsReady: boolean;
  modelsLoading: boolean;
  reasoningEffort: ReasoningEffort | undefined;
  onReasoningEffortChange(effort: ReasoningEffort): void;
  model: string;
  modelDisabled: boolean;
  onModelChange(model: string): void;
  mode: InteractionMode;
  onModeChange(mode: InteractionMode): void;
}

export const ReviewComposerContext = createContext<ReviewComposerState | null>(null);

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export function ReviewModelSelector() {
  const {
    models,
    modelsReady,
    model,
    modelDisabled,
    onModelChange,
    reasoningEffort,
    onReasoningEffortChange,
  } = useContext(ReviewComposerContext)!;
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const available: ModelOption[] = models.map((item) => ({
      id: item.id,
      name: item.name,
      icon: <OpenAILogo />,
      efforts: item.supportedReasoningEfforts.map((option) => ({
        id: option.reasoningEffort,
        name: EFFORT_LABELS[option.reasoningEffort],
      })),
    }));
    return model && !models.some(({ id }) => id === model)
      ? [
          {
            id: model,
            name: modelsReady ? `${model}（当前账户不可用）` : model,
            disabled: true,
          },
          ...available,
        ]
      : available;
  }, [models, modelsReady, model]);
  return (
    <ModelSelector
      models={options}
      value={model}
      effort={reasoningEffort ?? ''}
      onEffortChange={(value) => {
        if (
          !modelDisabled &&
          isReasoningEffort(value) &&
          models
            .find(({ id }) => id === model)
            ?.supportedReasoningEfforts.some((option) => option.reasoningEffort === value)
        )
          onReasoningEffortChange(value);
      }}
      open={!modelDisabled && open}
      onOpenChange={setOpen}
      onValueChange={(value) => {
        if (!modelDisabled && value !== model && models.some(({ id }) => id === value))
          onModelChange(value);
      }}
      disabled={modelDisabled || !models.length}
      aria-label="选择 AI 模型"
      searchable
      variant="ghost"
      size="sm"
      className="w-fit max-w-[65%] min-w-0 flex-initial justify-start px-2 text-muted-foreground"
      contentClassName="max-w-[calc(100vw-1.5rem)] border-widget"
    />
  );
}

export function ReviewComposerInput({ autoFocus }: { autoFocus: boolean }) {
  const { sessionId, draft, onDraftChange } = useContext(ReviewComposerContext)!;
  const aui = useAui();
  const readDraft = useEffectEvent(() => draft);
  const saveDraft = useEffectEvent(onDraftChange);
  useEffect(() => {
    // Restore once per session; the primitive owns live text and IME updates.
    // Mirroring a draft back during input can reset the browser's composition.
    let previousText = readDraft();
    aui.composer.setText(previousText);
    return aui.subscribe(() => {
      const text = aui.composer.getState().text;
      if (text === previousText) return;
      previousText = text;
      saveDraft(text);
    });
  }, [aui, sessionId]);

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
    />
  );
}

export function ReviewComposerFooter() {
  const { onNew, modelsLoading, mode, onModeChange } = useContext(ReviewComposerContext)!;
  const text = useAuiState((state) => state.composer.text);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-0.5 text-[0.7rem] text-muted">
      <GitStatusLine />
      <div className="flex min-w-0 items-center justify-between gap-2">
        <select
          aria-label="交互模式"
          value={mode}
          disabled={isRunning}
          onChange={(event) => onModeChange(event.target.value === 'review' ? 'review' : 'chat')}
          className="rounded-sm bg-input text-input-foreground"
        >
          <option value="review">代码审查</option>
          <option value="chat">普通聊天</option>
        </select>
        <span id="composer-hint" className="truncate" aria-live="polite">
          {modelsLoading
            ? '正在加载模型…'
            : text.length === 4000
              ? '已达到 4000 字符上限'
              : 'Enter 发送 · Shift+Enter 换行'}
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
    </div>
  );
}
