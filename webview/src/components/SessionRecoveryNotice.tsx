import type { SessionRecovery } from '../state/sessionTranscript';

const LABELS: Record<SessionRecovery['status'], string> = {
  interrupted: '上一轮回答被中断',
  cancelled: '上一轮回答已停止',
  failed: '上一轮回答失败',
  running: 'Host 中仍有回答在运行',
};

/**
 * Durable conversations may end mid-answer. The partial turn stays visible from
 * the Host journal; this banner explains it and offers a manual continuation.
 */
export function SessionRecoveryNotice({
  recovery,
  truncated,
  disabled,
  onContinue,
}: {
  recovery: SessionRecovery | undefined;
  truncated: boolean;
  disabled: boolean;
  onContinue(): void;
}) {
  if (!recovery && !truncated) return null;
  const steps = recovery?.turn.checkpoints ?? 0;
  return (
    <div
      role="status"
      data-session-recovery={recovery?.status ?? 'truncated'}
      className="shrink-0 border-b border-widget bg-surface px-3 py-2 text-[0.85rem]"
    >
      {recovery && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1">
            {LABELS[recovery.status]}
            {steps > 0 ? `（已完成 ${steps} 个步骤）` : ''}
          </p>
          {recovery.status !== 'running' && (
            <button
              type="button"
              disabled={disabled}
              className="rounded-sm bg-code px-2 py-1 text-link hover:bg-hover disabled:cursor-default disabled:opacity-50"
              onClick={onContinue}
            >
              继续
            </button>
          )}
        </div>
      )}
      {truncated && <p className="mt-1 text-xs text-muted">更早的会话记录已归档，未全部显示。</p>}
      {recovery?.turn.error?.message && (
        <p className="mt-1 text-xs text-muted">{recovery.turn.error.message}</p>
      )}
    </div>
  );
}
