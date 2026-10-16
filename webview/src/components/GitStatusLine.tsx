import { createContext, useContext } from 'react';
import type { GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { changeCounts } from '@shared/git';
import { gitStatusText } from '../lib/gitStatus';
import { Icon } from './Icon';

export interface ReviewGitState {
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
}

export const ReviewGitContext = createContext<ReviewGitState>({
  snapshot: null,
  repository: undefined,
});

/**
 * Single-line Git summary below the Thread composer. The dense workspace
 * context lives in the Files tab, so the chat only keeps branch, status and
 * change counts on one row that never wraps.
 */
export function GitStatusLine() {
  const { snapshot, repository } = useContext(ReviewGitContext);
  const counts = changeCounts(repository);
  const status = gitStatusText(snapshot, repository);
  const changes = repository
    ? `新增 ${counts.added}，修改 ${counts.modified}，删除 ${counts.deleted}`
    : '';
  return (
    <p
      data-slot="review-git-status"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[0.72rem] whitespace-nowrap text-muted"
      title={[repository?.branch, status, changes].filter(Boolean).join(' · ')}
    >
      <Icon name="branch" className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono">
        {repository ? (repository.branch ?? 'Detached HEAD') : '—'}
      </span>
      <span className="shrink-0">{status}</span>
      {repository && (
        <span className="flex shrink-0 gap-1 font-mono" aria-label={changes}>
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
    </p>
  );
}
