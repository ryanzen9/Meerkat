import type { GitFileChange, GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { Icon } from './Icon';

const presentation = {
  added: { color: 'text-added', label: '新增', badge: 'A' },
  modified: { color: 'text-modified', label: '修改', badge: 'M' },
  deleted: { color: 'text-deleted', label: '删除', badge: 'D' },
  renamed: { color: 'text-modified', label: '重命名', badge: 'R' },
  conflict: { color: 'text-deleted', label: '冲突', badge: 'U' },
};

function ChangeGroup({
  title,
  files,
  onOpen,
}: {
  title: string;
  files: GitFileChange[];
  onOpen(uri: string): void;
}) {
  return (
    <section aria-label={title} className="mb-5">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-[0.85rem] font-semibold">{title}</h2>
        <span className="rounded-full bg-badge px-1.5 text-[0.75rem] text-badge-foreground">
          {files.length}
        </span>
      </div>
      {files.length ? (
        <ul className="space-y-0.5">
          {files.map((file) => {
            const style = presentation[file.kind];
            const separator = file.path.lastIndexOf('/');
            return (
              <li key={file.uri}>
                <button
                  type="button"
                  className="group flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-2 text-left hover:bg-hover"
                  onClick={() => onOpen(file.uri)}
                  title={`${file.path} · ${style.label}`}
                  aria-label={`${style.label} ${file.path}`}
                >
                  <Icon name="file" className={`size-3.5 ${style.color}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[0.9rem] ${style.color}`}>
                      {file.path.slice(separator + 1)}
                    </span>
                    {separator >= 0 && (
                      <span className="block truncate font-mono text-[0.75rem] text-muted">
                        {file.path.slice(0, separator)}
                      </span>
                    )}
                  </span>
                  <span className={`font-mono text-[0.8rem] ${style.color}`}>{style.badge}</span>
                  <Icon
                    name="open"
                    className="size-3 text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-widget px-3 py-4 text-[0.85rem] text-muted">
          {title === 'Changes' ? '没有未暂存的变更。' : '没有已暂存的变更。'}
        </p>
      )}
    </section>
  );
}

export function FileChanges({
  snapshot,
  repository,
  onOpen,
}: {
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
  onOpen(uri: string): void;
}) {
  if (!repository)
    return (
      <div className="px-4 py-8">
        <Icon name="branch" className="mb-3 size-6 text-muted" />
        <h2 className="mb-2 font-semibold">
          {!snapshot
            ? '正在读取 Git 状态…'
            : !snapshot.workspace.trusted
              ? '工作区处于受限模式'
              : !snapshot.git.available
                ? 'Git 不可用'
                : '未找到 Git 仓库'}
        </h2>
        <p className="text-[0.9rem] leading-relaxed text-muted">
          {snapshot && !snapshot.workspace.trusted
            ? '信任工作区后即可查看 Git 文件变更。'
            : '打开 Git 工作区并启用 VS Code 内置 Git 扩展后，变更会显示在这里。'}
        </p>
      </div>
    );
  return (
    <div className="p-3">
      <p className="mb-4 text-[0.8rem] text-muted">与 Source Control 同步 · 点击文件打开</p>
      <ChangeGroup title="Changes" files={repository.changes} onOpen={onOpen} />
      <ChangeGroup title="Staged Changes" files={repository.stagedChanges} onOpen={onOpen} />
    </div>
  );
}
