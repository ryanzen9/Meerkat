import { DemoActions } from './components/DemoActions';
import { WorkspaceSummary } from './components/WorkspaceSummary';
import { usePanel } from './hooks/usePanel';

export function App() {
  const panel = usePanel();
  return (
    <main className="mx-auto max-w-[640px]" aria-label="Review Bot 面板" aria-busy={panel.busy}>
      <header className="mb-4">
        <h1 className="mb-1 text-[1.1rem] font-semibold">Review Bot</h1>
        <p className="my-1.5 leading-normal text-muted">工作区概览与消息示例</p>
      </header>
      {panel.snapshot && <WorkspaceSummary snapshot={panel.snapshot} />}
      {!panel.snapshot && (
        <p className="my-1.5 leading-normal text-muted" role="status">
          正在连接扩展…
        </p>
      )}
      <DemoActions
        draftName={panel.draftName}
        onNameChange={panel.setDraftName}
        onHello={panel.sayHello}
        onRefresh={panel.refresh}
        busy={panel.busy}
        connected={panel.snapshot !== null}
      />
      {panel.error && (
        <p className="my-1.5 leading-normal text-error" role="alert">
          {panel.error}
        </p>
      )}
      <div
        className="min-h-10 py-2.5 leading-normal wrap-anywhere"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {panel.busy ? '正在读取…' : (panel.reply ?? '点击“发送问候”接收扩展回复。')}
      </div>
      {panel.snapshot && (
        <footer className="border-t border-widget pt-2 text-[0.9rem] text-muted">
          已通信 {panel.snapshot.state.messageCount} 次 · 已保存
        </footer>
      )}
    </main>
  );
}
