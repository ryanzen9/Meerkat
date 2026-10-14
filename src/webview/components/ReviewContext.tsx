import type { GitRepositoryInfo, PanelSnapshot } from '../../shared/models';
import { changeCounts } from '../../shared/git';
import { Icon } from './Icon';

interface ReviewContextProps {
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
  refreshing: boolean;
  error: boolean;
  onRepositoryChange(uri: string): void;
}

export function ReviewContext({
  snapshot,
  repository,
  refreshing,
  error,
  onRepositoryChange,
}: ReviewContextProps) {
  const counts = changeCounts(repository);
  const review =
    snapshot?.review?.repositoryUri === repository?.rootUri ? snapshot?.review : undefined;
  const status = error
    ? 'Error'
    : refreshing
      ? 'Refreshing…'
      : !snapshot
        ? 'Connecting…'
        : review?.status === 'analyzing'
          ? 'Analyzing…'
          : review?.issueCount
            ? `${review.issueCount} Issue${review.issueCount === 1 ? '' : 's'}`
            : review?.status === 'ready'
              ? 'Ready'
              : 'Idle';
  const statusColor = error
    ? 'border-error/30 bg-error/10 text-error'
    : review?.status === 'analyzing' || refreshing || !snapshot
      ? 'border-link/30 bg-link/10 text-link'
      : review?.issueCount
        ? 'border-modified/30 bg-modified/10 text-modified'
        : review?.status === 'ready'
          ? 'border-added/30 bg-added/10 text-added'
          : 'border-widget bg-sidebar text-muted';
  const gitStatus = !snapshot
    ? '正在连接扩展'
    : !snapshot.workspace.trusted
      ? '受限模式'
      : !snapshot.git.available
        ? 'Git 不可用'
        : !repository
          ? '无 Git 仓库'
          : counts.conflicts
            ? `${counts.conflicts} conflict${counts.conflicts > 1 ? 's' : ''}`
            : counts.total
              ? `${counts.total} changed`
              : 'Clean';
  return (
    <section
      aria-label="工作区上下文"
      className="flex h-[72px] shrink-0 flex-col justify-center gap-2 border-b border-widget bg-surface px-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        {snapshot && snapshot.git.repositories.length > 1 ? (
          <select
            aria-label="选择 Git 仓库"
            className="min-w-0 flex-1 truncate rounded-sm bg-input py-0.5 text-input-foreground"
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
          <span className="truncate font-semibold" title={repository?.rootUri}>
            {review?.pullRequestNumber
              ? `PR #${review.pullRequestNumber} · ${repository?.branch ?? repository?.name}`
              : (repository?.name ?? snapshot?.workspace.name ?? 'Workspace')}
          </span>
        )}
        <span
          role="status"
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.8rem] ${statusColor}`}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {status}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[0.85rem] text-muted">
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5"
          title={[repository?.branch, ...(repository?.remotes ?? [])].filter(Boolean).join(' · ')}
        >
          <Icon name="branch" className="size-3.5" />
          <span className="truncate font-mono">
            {repository ? (repository.branch ?? 'Detached HEAD') : '—'}
          </span>
        </span>
        <span className="shrink-0">{gitStatus}</span>
        {repository && (
          <span
            className="flex shrink-0 gap-1.5 font-mono text-[0.85rem]"
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
