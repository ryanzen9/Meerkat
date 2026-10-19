import type { GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { changeCounts } from '@shared/git';
import { cn } from '../lib/utils';
import { gitStatusText } from '../lib/gitStatus';
import { Icon } from './Icon';

interface ReviewContextProps {
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
  refreshing: boolean;
  error: boolean;
  onRepositoryChange(uri: string): void;
}

/** One-line repository, branch and Git status summary for the Files tab. */
export function ReviewContext({
  snapshot,
  repository,
  refreshing,
  error,
  onRepositoryChange,
}: ReviewContextProps) {
  const counts = changeCounts(repository);
  const branch = repository ? (repository.branch ?? 'Detached HEAD') : '—';
  const status = error ? 'Error' : refreshing ? 'Refreshing…' : gitStatusText(snapshot, repository);
  const statusColor = error
    ? 'text-error'
    : refreshing || !snapshot
      ? 'text-link'
      : status.toLowerCase().includes('conflict')
        ? 'text-deleted'
        : status === 'Clean'
          ? 'text-muted'
          : 'text-foreground';
  const repositoryName = repository?.name ?? snapshot?.workspace.name ?? 'Workspace';

  return (
    <section aria-label="工作区上下文" className="shrink-0 border-b border-widget bg-surface">
      <div
        className="flex min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 whitespace-nowrap"
        title={[repository?.rootUri, branch, status].filter(Boolean).join(' · ')}
      >
        {snapshot && snapshot.git.repositories.length > 1 ? (
          <select
            aria-label="选择 Git 仓库"
            className="min-w-0 flex-1 truncate rounded-sm bg-input py-0.5 text-[0.8rem] text-input-foreground"
            value={repository?.rootUri ?? ''}
            onChange={(event) => onRepositoryChange(event.target.value)}
          >
            {snapshot.git.repositories.map((item) => (
              <option key={item.rootUri} value={item.rootUri}>
                {item.name}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[0.8rem] font-semibold"
            title={repositoryName}
          >
            {repositoryName}
          </span>
        )}
        <span
          role="group"
          className="flex max-w-[32%] min-w-0 shrink items-center gap-1 text-[0.72rem] text-muted"
          aria-label={`分支 ${branch}`}
        >
          <Icon name="branch" className="size-3 shrink-0" />
          <span className="truncate font-mono">{branch}</span>
        </span>
        <span
          role="status"
          title={status}
          className={cn('max-w-[28%] shrink-0 truncate text-[0.72rem]', statusColor)}
        >
          {status}
        </span>
        {repository && (
          <span
            role="group"
            className="flex shrink-0 gap-1 font-mono text-[0.72rem]"
            aria-label={`新增 ${counts.added}，修改 ${counts.modified}，删除 ${counts.deleted}`}
          >
            <span className="text-added" title="新增文件">
              +{counts.added}
            </span>
            <span className="text-modified" title="修改或重命名文件">
              ~{counts.modified}
            </span>
            <span className="text-deleted" title="删除文件">
              −{counts.deleted}
            </span>
          </span>
        )}
      </div>
    </section>
  );
}
