import { useRef, useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
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

type GroupId = 'changes' | 'staged-changes';
const CHANGE_DRAG_TYPE = 'application/x-meerkat-git-change';

interface ChangeDragPayload {
  repositoryUri: string;
  uri: string;
  source: GroupId;
}

function hasChangeDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(CHANGE_DRAG_TYPE);
}

function readDraggedChange(event: DragEvent<HTMLElement>): ChangeDragPayload | undefined {
  try {
    const value: unknown = JSON.parse(event.dataTransfer.getData(CHANGE_DRAG_TYPE));
    if (typeof value !== 'object' || value === null) return undefined;
    const payload = value as Record<string, unknown>;
    if (
      typeof payload.repositoryUri !== 'string' ||
      typeof payload.uri !== 'string' ||
      (payload.source !== 'changes' && payload.source !== 'staged-changes')
    )
      return undefined;
    return { repositoryUri: payload.repositoryUri, uri: payload.uri, source: payload.source };
  } catch {
    return undefined;
  }
}

function ChangeGroup({
  id,
  title,
  files,
  sourceFiles,
  empty,
  pendingUris,
  repositoryUri,
  disabled,
  dragging,
  onDraggingChange,
  onOpen,
  onMove,
  onMoveAll,
  onDropMove,
}: {
  id: GroupId;
  title: string;
  files: GitFileChange[];
  sourceFiles: GitFileChange[];
  empty: string;
  pendingUris: ReadonlySet<string>;
  repositoryUri: string;
  disabled: boolean;
  dragging: ChangeDragPayload | null;
  onDraggingChange(payload: ChangeDragPayload | null): void;
  onOpen(uri: string): void;
  onMove(uri: string): void;
  onMoveAll(): void;
  onDropMove(uri: string): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const panelId = `change-group-${id}`;
  const sourceId: GroupId = id === 'changes' ? 'staged-changes' : 'changes';
  const moveLabel = id === 'changes' ? '暂存' : '移回 Changes';
  const moveIcon = id === 'changes' ? 'plus' : 'minus';
  const bulkLabel = id === 'changes' ? '暂存全部更改' : '取消全部暂存';
  const bulkCount =
    id === 'changes' ? files.filter(({ kind }) => kind !== 'conflict').length : files.length;
  const canDrop =
    !disabled &&
    dragging?.repositoryUri === repositoryUri &&
    dragging.source === sourceId &&
    sourceFiles.some(({ uri }) => uri === dragging.uri) &&
    !pendingUris.has(dragging.uri);

  const startDrag = (event: DragEvent<HTMLLIElement>, file: GitFileChange) => {
    if (disabled || pendingUris.has(file.uri)) {
      event.preventDefault();
      return;
    }
    const payload = { repositoryUri, uri: file.uri, source: id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CHANGE_DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', file.uri);
    onDraggingChange(payload);
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canDrop || !hasChangeDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!hasChangeDrag(event)) return;
    event.preventDefault();
    setDragOver(false);
    const payload = readDraggedChange(event);
    if (
      !disabled &&
      payload?.repositoryUri === repositoryUri &&
      payload.source === sourceId &&
      sourceFiles.some((file) => file.uri === payload.uri) &&
      !pendingUris.has(payload.uri)
    )
      onDropMove(payload.uri);
    onDraggingChange(null);
  };

  return (
    <section
      aria-label={title}
      data-drop-target={id}
      className={cn(
        'mb-3 rounded-sm transition-colors motion-reduce:transition-none',
        dragOver && canDrop && 'bg-hover/50 ring-1 ring-inset ring-focus',
      )}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left hover:bg-hover"
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
        <button
          type="button"
          className="icon-button size-6"
          aria-label={bulkLabel}
          title={
            id === 'changes' && files.some(({ kind }) => kind === 'conflict')
              ? `${bulkLabel}（冲突文件需单独处理）`
              : bulkLabel
          }
          disabled={disabled || pendingUris.size > 0 || bulkCount === 0}
          onClick={onMoveAll}
        >
          <Icon name={moveIcon} className="size-3.5" />
        </button>
      </div>
      <div id={panelId} hidden={!expanded}>
        {files.length ? (
          <ul className="space-y-px">
            {files.map((file) => {
              const style = presentation[file.kind];
              const separator = file.path.lastIndexOf('/');
              const pending = pendingUris.has(file.uri);
              return (
                <li
                  key={file.uri}
                  draggable={!pending && !disabled}
                  onDragStart={(event) => startDrag(event, file)}
                  onDragEnd={() => {
                    setDragOver(false);
                    onDraggingChange(null);
                  }}
                  className="group flex min-w-0 items-center gap-1 rounded-sm px-1 py-px hover:bg-hover"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] text-left"
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
                  </button>
                  <button
                    type="button"
                    className="icon-button size-6"
                    aria-label={`${moveLabel} ${file.path}`}
                    title={pending ? '正在更新 Git 状态…' : `${moveLabel} ${file.path}`}
                    disabled={pending || disabled}
                    onClick={() => onMove(file.uri)}
                  >
                    <Icon
                      name={moveIcon}
                      className={cn('size-3.5', id === 'changes' ? 'text-added' : 'text-modified')}
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

type RepositoryAction = 'commit' | 'stage-all' | 'unstage-all' | 'push' | 'undo';
interface GitActivity {
  pendingUris: ReadonlySet<string>;
  operation: RepositoryAction | null;
}
const IDLE: GitActivity = { pendingUris: new Set(), operation: null };

export function FileChanges({
  snapshot,
  repository,
  onOpen,
  onStage,
  onUnstage,
  onCommit,
  onStageAll,
  onUnstageAll,
  onPush,
  onUndoCommit,
}: {
  snapshot: PanelSnapshot | null;
  repository: GitRepositoryInfo | undefined;
  onOpen(uri: string): void;
  onStage(repositoryUri: string, uri: string): Promise<void>;
  onUnstage(repositoryUri: string, uri: string): Promise<void>;
  onCommit(repositoryUri: string, message: string): Promise<void>;
  onStageAll(repositoryUri: string): Promise<void>;
  onUnstageAll(repositoryUri: string): Promise<void>;
  onPush(repositoryUri: string, branch: string, head: string): Promise<void>;
  onUndoCommit(repositoryUri: string, branch: string, head: string): Promise<void>;
}) {
  const [activities, setActivities] = useState<ReadonlyMap<string, GitActivity>>(() => new Map());
  const inFlight = useRef(new Map<string, GitActivity>());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [dragging, setDragging] = useState<ChangeDragPayload | null>(null);
  const { pendingUris, operation } = activities.get(repository?.rootUri ?? '') ?? IDLE;
  const busy = operation !== null;
  const commitMessage = drafts.get(repository?.rootUri ?? '') ?? '';
  const hasConflicts = repository?.changes.some(({ kind }) => kind === 'conflict') ?? false;
  const sync = repository?.sync;
  const ahead = sync?.ahead ?? 0;
  const publish = Boolean(sync?.head && !sync.upstream);
  const pushMode = Boolean(
    repository &&
    !repository.stagedChanges.length &&
    (ahead > 0 || (publish && repository.remotes.length)),
  );
  const canPush = Boolean(
    repository?.branch &&
    sync?.head &&
    repository.remotes.length &&
    !(sync.behind && sync.behind > 0),
  );
  const pushTitle = !repository?.remotes.length
    ? '请先在 VS Code 中配置 Git 远程仓库'
    : sync?.behind && sync.behind > 0
      ? `远程有 ${sync.behind} 个新提交，请先拉取并整合`
      : '推送当前分支';

  const updateActivity = (rootUri: string, update: (current: GitActivity) => GitActivity) => {
    const next = update(inFlight.current.get(rootUri) ?? IDLE);
    if (next.operation || next.pendingUris.size) inFlight.current.set(rootUri, next);
    else inFlight.current.delete(rootUri);
    setActivities(new Map(inFlight.current));
  };

  const moveFile = async (uri: string, direction: 'stage' | 'unstage') => {
    if (!repository) return;
    const rootUri = repository.rootUri;
    const activity = inFlight.current.get(rootUri) ?? IDLE;
    if (activity.operation || activity.pendingUris.has(uri)) return;
    updateActivity(rootUri, (current) => ({
      ...current,
      pendingUris: new Set(current.pendingUris).add(uri),
    }));
    try {
      if (direction === 'stage') await onStage(rootUri, uri);
      else await onUnstage(rootUri, uri);
    } catch {
      // usePanel exposes the host error in the shared panel alert.
    } finally {
      updateActivity(rootUri, (current) => {
        const pending = new Set(current.pendingUris);
        pending.delete(uri);
        return { ...current, pendingUris: pending };
      });
    }
  };

  const runAction = async (action: RepositoryAction, execute: () => Promise<void>) => {
    if (!repository) return;
    const rootUri = repository.rootUri;
    const activity = inFlight.current.get(rootUri) ?? IDLE;
    if (activity.operation || activity.pendingUris.size > 0) return;
    updateActivity(rootUri, (current) => ({ ...current, operation: action }));
    setDragging(null);
    try {
      await execute();
    } catch {
      /* usePanel exposes the actual host error; keep drafts and counts intact. */
    } finally {
      updateActivity(rootUri, (current) => ({ ...current, operation: null }));
    }
  };

  const push = () => {
    if (!repository?.branch || !sync?.head || !canPush) return;
    void runAction('push', () => onPush(repository.rootUri, repository.branch!, sync.head!));
  };

  const submitCommit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pushMode) return;
    const message = commitMessage.trim();
    const activity = inFlight.current.get(repository?.rootUri ?? '') ?? IDLE;
    if (
      !repository ||
      !message ||
      !repository.stagedChanges.length ||
      activity.pendingUris.size > 0 ||
      activity.operation ||
      hasConflicts
    )
      return;
    const rootUri = repository.rootUri;
    await runAction('commit', async () => {
      await onCommit(rootUri, message);
      setDrafts((previous) => {
        const next = new Map(previous);
        next.delete(rootUri);
        return next;
      });
    });
  };

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-2">
        <ChangeGroup
          key={`${repository.rootUri}:changes`}
          id="changes"
          title="Changes"
          files={repository.changes}
          sourceFiles={repository.stagedChanges}
          empty="没有未暂存的变更。"
          pendingUris={pendingUris}
          repositoryUri={repository.rootUri}
          disabled={busy}
          dragging={dragging}
          onDraggingChange={setDragging}
          onOpen={onOpen}
          onMove={(uri) => void moveFile(uri, 'stage')}
          onMoveAll={() => void runAction('stage-all', () => onStageAll(repository.rootUri))}
          onDropMove={(uri) => void moveFile(uri, 'unstage')}
        />
        <ChangeGroup
          key={`${repository.rootUri}:staged`}
          id="staged-changes"
          title="Staged Changes"
          files={repository.stagedChanges}
          sourceFiles={repository.changes}
          empty="没有已暂存的变更。"
          pendingUris={pendingUris}
          repositoryUri={repository.rootUri}
          disabled={busy}
          dragging={dragging}
          onDraggingChange={setDragging}
          onOpen={onOpen}
          onMove={(uri) => void moveFile(uri, 'unstage')}
          onMoveAll={() => void runAction('unstage-all', () => onUnstageAll(repository.rootUri))}
          onDropMove={(uri) => void moveFile(uri, 'stage')}
        />
      </div>
      <form
        aria-label={pushMode ? '推送提交' : '提交暂存更改'}
        aria-busy={busy}
        className="flex shrink-0 flex-col gap-2 border-t border-widget bg-surface px-3 py-2"
        onSubmit={(event) => void submitCommit(event)}
      >
        <label className="sr-only" htmlFor="git-commit-message">
          提交消息
        </label>
        <input
          id="git-commit-message"
          type="text"
          maxLength={5000}
          value={commitMessage}
          disabled={busy}
          placeholder="输入提交消息…"
          className="w-full min-w-0 rounded-md border border-input-border bg-input px-2.5 py-2 text-[0.85rem] text-input-foreground placeholder:text-input-placeholder"
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((previous) => new Map(previous).set(repository.rootUri, value));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229))
              event.preventDefault();
          }}
        />
        <div className="flex min-w-0 items-center gap-2">
          <button
            type={pushMode ? 'button' : 'submit'}
            onClick={pushMode ? push : undefined}
            title={pushMode ? pushTitle : undefined}
            disabled={
              busy ||
              pendingUris.size > 0 ||
              (pushMode
                ? !canPush
                : hasConflicts || !commitMessage.trim() || repository.stagedChanges.length === 0)
            }
            className="min-w-0 flex-1 truncate rounded-md bg-button px-3 py-2 text-[0.85rem] font-medium text-button-foreground hover:bg-button-hover"
          >
            {operation === 'commit'
              ? '正在提交…'
              : operation === 'push'
                ? '正在推送…'
                : operation === 'undo'
                  ? '正在撤销提交…'
                  : operation === 'stage-all'
                    ? '正在暂存…'
                    : operation === 'unstage-all'
                      ? '正在取消暂存…'
                      : pushMode
                        ? `${publish ? '发布分支并推送' : '推送'} (${sync?.ahead === null ? '?' : ahead} 个提交)`
                        : hasConflicts
                          ? '请先解决并暂存冲突'
                          : `提交已暂存更改 (${repository.stagedChanges.length})`}
          </button>
          <button
            type="button"
            className="icon-button size-8 shrink-0"
            aria-label="取消上次提交"
            title={
              sync?.canUndo
                ? '取消上次未推送提交，改动恢复到暂存区并保留现有文件内容'
                : '仅可取消当前分支最后一次尚未推送的提交'
            }
            disabled={
              busy || pendingUris.size > 0 || !sync?.canUndo || !repository.branch || !sync.head
            }
            onClick={() => {
              if (repository.branch && sync?.head)
                void runAction('undo', () =>
                  onUndoCommit(repository.rootUri, repository.branch!, sync.head!),
                );
            }}
          >
            <Icon name="undo" />
          </button>
        </div>
      </form>
    </div>
  );
}
