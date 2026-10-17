import type { KeyboardEvent } from 'react';
import type { ReviewTab } from '@shared/models';
import { Icon } from './Icon';
import type { IconName } from './Icon';

const tabs: { id: ReviewTab; label: string; name: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', name: 'Agent Chat Windows', icon: 'chat' },
  { id: 'files', label: 'Files', name: 'File Change Status', icon: 'file' },
  { id: 'history', label: 'History', name: 'History', icon: 'history' },
];

export function ReviewTabs({
  activeTab,
  fileCount,
  onChange,
}: {
  activeTab: ReviewTab;
  fileCount: number;
  onChange(tab: ReviewTab): void;
}) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!;
    onChange(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <div className="flex min-w-0 flex-1 items-stretch" role="tablist" aria-label="Review 内容">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          type="button"
          role="tab"
          aria-label={tab.name}
          aria-selected={activeTab === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={activeTab === tab.id ? 0 : -1}
          onKeyDown={(event) => navigate(event, index)}
          onClick={() => onChange(tab.id)}
          className={`flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-2 text-[0.9rem] ${activeTab === tab.id ? 'border-link text-foreground' : 'border-transparent text-muted hover:text-foreground'}`}
        >
          <Icon name={tab.icon} className="size-3.5" />
          {tab.label}
          {tab.id === 'files' && fileCount > 0 && (
            <span className="rounded-full bg-badge px-1.5 py-0.5 text-[0.7rem] leading-none text-badge-foreground">
              {fileCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
