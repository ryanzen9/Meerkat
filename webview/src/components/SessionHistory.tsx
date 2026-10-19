import type { ChatSession } from '@shared/models';
import { Icon } from './Icon';
import { useState } from 'react';

export function SessionHistory({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
}: {
  sessions: ChatSession[];
  activeSessionId: string;
  onSelect(id: string): void;
  onNew(): void;
}) {
  const [visibleCount, setVisibleCount] = useState(20);
  const history = sessions
    .filter(
      ({ messages, reviews }) =>
        messages.length || reviews?.runs.length || reviews?.findings.length,
    )
    // oxlint-disable-next-line unicorn/no-array-sort -- filter created a fresh array; keep ES2022 support.
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="p-3">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[0.85rem] font-semibold">会话历史</h2>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-2 py-1.5 text-[0.8rem] text-link hover:bg-hover"
          onClick={onNew}
        >
          <Icon name="plus" className="size-3.5" />
          新建会话
        </button>
      </div>
      {history.length ? (
        <ul className="space-y-2">
          {history.slice(0, visibleCount).map((session) => (
            <li key={session.id}>
              <button
                type="button"
                aria-current={session.id === activeSessionId ? 'true' : undefined}
                onClick={() => onSelect(session.id)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-md border p-3 text-left hover:bg-hover ${session.id === activeSessionId ? 'border-link/40 bg-surface' : 'border-widget'}`}
              >
                <Icon name="chat" className="text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9rem] font-medium">{session.title}</span>
                  <span className="mt-1 block text-[0.75rem] text-muted">
                    <time dateTime={session.updatedAt}>
                      {new Date(session.updatedAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>{' '}
                    · {session.messages.length} 条消息
                  </span>
                </span>
                <Icon name="chevron" className="size-3 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="py-5">
          <Icon name="history" className="mb-3 size-6 text-muted" />
          <p className="mb-2 font-semibold">还没有会话</p>
          <p className="text-[0.9rem] leading-relaxed text-muted">
            在 Chat 发送问题后，随时从这里继续对话。
          </p>
        </div>
      )}
      {history.length > visibleCount && (
        <button
          type="button"
          className="mt-3 w-full rounded-sm px-2 py-2 text-sm text-link hover:bg-hover"
          onClick={() => setVisibleCount((count) => count + 20)}
        >
          加载更多会话
        </button>
      )}
    </div>
  );
}
