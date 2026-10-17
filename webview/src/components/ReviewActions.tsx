import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Account {
  id: string;
  email?: string;
  subject: string;
}

interface ReviewActionsProps {
  refreshing: boolean;
  canExport: boolean;
  authenticated: boolean;
  activeAccountId: string | undefined;
  accounts: Account[];
  waiting: boolean;
  chatRunning: boolean;
  onRefresh(): void;
  onSettings(): void;
  onHistory(): void;
  onExport(): void;
  onLogin(): void;
  onLogout(): void;
  onAddAccount(): void;
  onAccountChange(accountId: string): void;
}

export function ReviewActions({
  refreshing,
  canExport,
  authenticated,
  activeAccountId,
  accounts,
  waiting,
  chatRunning,
  onRefresh,
  onSettings,
  onHistory,
  onExport,
  onLogin,
  onLogout,
  onAddAccount,
  onAccountChange,
}: ReviewActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        trigger.current?.focus();
      } else if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);
  const action = (callback: () => void) => {
    setMenuOpen(false);
    trigger.current?.focus();
    callback();
  };
  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const accountLabel = activeAccount?.email ?? 'ChatGPT';

  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-widget pl-2">
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
      <div ref={menu} className="relative">
        <button
          ref={trigger}
          type="button"
          className="icon-button"
          aria-label="设置菜单"
          title="设置"
          aria-expanded={menuOpen}
          aria-controls="review-settings-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="settings" />
        </button>
        <div
          id="review-settings-menu"
          hidden={!menuOpen}
          className="absolute top-9 right-0 z-20 max-h-[80vh] w-64 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border border-widget bg-menu text-menu-foreground shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="text-xs font-semibold text-muted">ChatGPT 账户</p>
            {authenticated ? (
              <div className="mt-1 flex min-w-0 items-center gap-2 text-[0.85rem]">
                <span className="min-w-0 flex-1 truncate" title={accountLabel}>
                  {accountLabel}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-link hover:underline"
                  onClick={onLogout}
                >
                  登出
                </button>
              </div>
            ) : null}
            {accounts.length > 1 && (
              <select
                aria-label="切换 ChatGPT 账户"
                value={activeAccountId ?? ''}
                disabled={chatRunning || waiting}
                className="mt-2 w-full min-w-0 rounded-sm border border-input-border bg-input px-2 py-1 text-[0.8rem] text-input-foreground"
                onChange={(event) => onAccountChange(event.target.value)}
              >
                <option value="" disabled>
                  选择账户
                </option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.email ?? account.subject} · {account.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
            {authenticated ? (
              <>
                <button
                  type="button"
                  className="mt-2 block w-full text-left text-[0.85rem] text-link hover:underline"
                  disabled={chatRunning || waiting}
                  onClick={onAddAccount}
                >
                  添加账户
                </button>
                {waiting && (
                  <p role="status" className="mt-1 text-xs text-muted">
                    等待浏览器授权…
                  </p>
                )}
              </>
            ) : (
              <button
                type="button"
                className="mt-2 w-full rounded-sm bg-button px-2 py-1.5 text-[0.85rem] text-button-foreground hover:bg-button-hover"
                disabled={waiting}
                onClick={onLogin}
              >
                {waiting ? '等待浏览器授权…' : 'Continue with ChatGPT'}
              </button>
            )}
          </div>
          <div className="mx-2 border-t border-widget" />
          <div className="p-1">
            <button className="menu-item" type="button" onClick={() => action(onSettings)}>
              扩展设置…
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
        </div>
      </div>
    </div>
  );
}
