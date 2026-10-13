import type { FormEvent } from 'react';

interface DemoActionsProps {
  draftName: string;
  onNameChange(value: string): void;
  onHello(): void;
  onRefresh(): void;
  busy: boolean;
  connected: boolean;
}

export function DemoActions({
  draftName,
  onNameChange,
  onHello,
  onRefresh,
  busy,
  connected,
}: DemoActionsProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && connected) onHello();
  };
  return (
    <section className="border-t border-section py-3.5" aria-labelledby="demo-heading">
      <h2 className="mb-3 text-base font-semibold" id="demo-heading">
        打个招呼
      </h2>
      <form onSubmit={submit}>
        <label className="mb-1.5 block" htmlFor="name">
          你的称呼
        </label>
        <input
          className="w-full min-w-0 rounded-[2px] border border-input-border bg-input px-2 py-1.5 text-input-foreground placeholder:text-input-placeholder focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-focus"
          id="name"
          type="text"
          value={draftName}
          maxLength={80}
          placeholder="开发者"
          onChange={(event) => onNameChange(event.target.value)}
        />
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button
            className="cursor-pointer rounded-[2px] border border-button-border bg-button px-2.5 py-1.5 text-button-foreground hover:bg-button-hover focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50 high-contrast:border-contrast"
            type="submit"
            disabled={busy || !connected}
          >
            发送问候
          </button>
          <button
            className="cursor-pointer rounded-[2px] border border-button-border bg-secondary px-2.5 py-1.5 text-secondary-foreground hover:bg-secondary-hover focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50 high-contrast:border-contrast"
            type="button"
            disabled={busy}
            onClick={onRefresh}
          >
            刷新工作区
          </button>
        </div>
      </form>
    </section>
  );
}
