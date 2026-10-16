import { useState } from 'react';
import type { GitFileChange, GitRepositoryInfo, PanelSnapshot } from '@shared/models';
import { cn } from '../lib/utils';
import { Icon } from './Icon';

const presentation = {
  added: { color: 'text-added', label: '新增', badge: 'A' },
  modified: { color: 'text-modified', label: '修改', badge: 'M' },
  deleted: { color: 'text-deleted', label: '删除', badge: 'D' },
  renamed: { color: 'text-modified', label: '重命名', badge: 'R' },
  conflict: { color: 'text-deleted', label: '冲突', badge: 'U' },
};

function ChangeGroup({
  id,
  title,
  files,
  empty,
  onOpen,
}: {
  id: string;
  title: string;
  files: GitFileChange[];
  empty: string;
  onOpen(uri: string): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const panelId = `change-group-${id}`;
  return (
    <section aria-label={title} className="mb-3">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-1 text-left hover:bg-hover"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon
          name="chevron"
          className={cn(
            'size-3 text-muted transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
        <span className="text-[0.85rem] font-semibold">{title}</span>
        <span className="ml-auto rounded-full bg-badge px-1.5 text-[0.7rem] leading-4 text-badge-foreground">
          {files.length}
        </span>
      </button>
      <div id={panelId} hidden={!expanded}>
        {files.length ? (
          <ul className="space-y-px">
            {files.map((file) => {
              const style = presentation[file.kind];
              const separator = file.path.lastIndexOf('/');
              return (
                <li key={file.uri}>
                  <button
                    type="button"
                    className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-[3px] text-left hover:bg-hover"
                    onClick={() => onOpen(file.uri)}
                    title={`${file.path} · ${style.label}`}
                    aria-label={`${style.label} ${file.path}`}
                  >
                    <Icon name="file" className={cn('size-3.5 shrink-0', style.color)} />
                    <span className={cn('min-w-0 flex-1 truncate text-[0.85rem]', style.color)}>
                      {file.path.slice(separator + 1)}
                    </span>
                    {separator >= 0 && (
                      <span className="max-w-[45%] min-w-0 shrink truncate font-mono text-[0.72rem] text-muted">
                        {file.path.slice(0, separator)}
                      </span>
                    )}
                    <span className={cn('shrink-0 font-mono text-[0.75rem]', style.color)}>
                      {style.badge}
                    </span>
                    <Icon
                      name="open"
                      className="size-3 shrink-0 text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-widget px-2 py-2 text-[0.8rem] text-muted">
            {empty}
          </p>
        )}
      </div>
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
    <div className="px-2 py-2">
      <p className="mb-2 text-[0.75rem] text-muted">与 Source Control 同步 · 点击文件打开</p>
      <ChangeGroup
        id="changes"
        title="Changes"
        files={repository.changes}
        empty="没有未暂存的变更。"
        onOpen={onOpen}
      />
      <ChangeGroup
        id="staged-changes"
        title="Staged Changes"
        files={repository.stagedChanges}
        empty="没有已暂存的变更。"
        onOpen={onOpen}
      />
    </div>
  );
}
