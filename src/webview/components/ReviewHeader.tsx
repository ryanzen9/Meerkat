import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

interface ReviewHeaderProps {
  refreshing: boolean;
  canExport: boolean;
  onRefresh(): void;
  onSettings(): void;
  onHistory(): void;
  onExport(): void;
}

export function ReviewHeader({
  refreshing,
  canExport,
  onRefresh,
  onSettings,
  onHistory,
  onExport,
}: ReviewHeaderProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (!menu.current?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        menu.current.querySelector('summary')?.focus();
      } else if (event.target instanceof Node && menu.current.contains(event.target)) return;
      menu.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  const action = (callback: () => void) => {
    if (menu.current) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
    callback();
  };
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-widget px-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md border border-widget bg-surface text-link">
          <Icon name="review" />
        </span>
        <h1 className="text-base font-semibold">Review</h1>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="icon-button"
          aria-label="刷新工作区"
          title="刷新工作区"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <Icon name="refresh" className={refreshing ? 'motion-safe:animate-spin' : ''} />
        </button>
        <details ref={menu} className="relative">
          <summary
            className="icon-button list-none [&::-webkit-details-marker]:hidden"
            aria-label="更多操作"
            title="更多操作"
          >
            <Icon name="more" />
          </summary>
          <div className="absolute top-9 right-0 z-20 w-44 rounded-md border border-widget bg-menu p-1 text-menu-foreground shadow-lg">
            <button className="menu-item" type="button" onClick={() => action(onSettings)}>
              设置
            </button>
            <button className="menu-item" type="button" onClick={() => action(onHistory)}>
              会话历史
            </button>
            <button
              className="menu-item"
              type="button"
              disabled={!canExport}
              onClick={() => action(onExport)}
            >
              导出会话
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
