import type { PanelSnapshot } from '../../shared/models';

export function WorkspaceSummary({ snapshot }: { snapshot: PanelSnapshot }) {
  const { workspace, settings, git } = snapshot;
  return (
    <section aria-labelledby="workspace-heading" className="border-t border-section py-3.5">
      <h2 className="mb-3 text-base font-semibold" id="workspace-heading">
        工作区
      </h2>
      <dl>
        <div className="my-2 grid grid-cols-[80px_minmax(0,1fr)] gap-2">
          <dt className="text-muted">名称</dt>
          <dd className="wrap-anywhere">{workspace.name ?? '未打开工作区'}</dd>
        </div>
        <div className="my-2 grid grid-cols-[80px_minmax(0,1fr)] gap-2">
          <dt className="text-muted">信任状态</dt>
          <dd className="wrap-anywhere">{workspace.trusted ? '已信任' : '受限模式'}</dd>
        </div>
        <div className="my-2 grid grid-cols-[80px_minmax(0,1fr)] gap-2">
          <dt className="text-muted">Git 仓库</dt>
          <dd className="wrap-anywhere">{git.available ? git.repositories.length : '不可用'}</dd>
        </div>
      </dl>
      {workspace.folders.length > 0 ? (
        <ul className="mt-3 list-none p-0">
          {workspace.folders.map((folder) => (
            <li className="py-1.5" key={folder.uri}>
              <strong>{folder.name}</strong>
              {settings.showWorkspacePaths && (
                <span className="mt-1 block font-mono text-[0.9rem] wrap-anywhere text-muted">
                  {folder.path}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="my-1.5 leading-normal text-muted">打开文件夹后，这里会显示工作区信息。</p>
      )}
      {git.repositories.map((repository) => (
        <p
          className="my-1.5 leading-normal wrap-anywhere text-muted"
          key={repository.rootUri}
          title={repository.rootUri}
        >
          分支：{repository.branch ?? '游离 HEAD / 尚无提交'}
        </p>
      ))}
    </section>
  );
}
