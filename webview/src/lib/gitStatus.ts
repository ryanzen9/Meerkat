import type { GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { changeCounts } from '@shared/git';

// One summary line shared by the Thread status bar and the Files context panel.
export function gitStatusText(
  snapshot: PanelSnapshot | null,
  repository: GitRepositoryInfo | undefined,
): string {
  if (!snapshot) return '正在连接扩展';
  if (!snapshot.workspace.trusted) return '受限模式';
  if (!snapshot.git.available) return 'Git 不可用';
  if (!repository) return '无 Git 仓库';
  const counts = changeCounts(repository);
  if (counts.conflicts) return `${counts.conflicts} conflict${counts.conflicts > 1 ? 's' : ''}`;
  return counts.total ? `${counts.total} changed` : 'Clean';
}
