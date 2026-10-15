import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { changeCounts } from '@shared/git';
import { AgentChat, ChatActionsContext } from './components/AgentChat';
import { FileChanges } from './components/FileChanges';
import { ReviewContext } from './components/ReviewContext';
import { ReviewHeader } from './components/ReviewHeader';
import { ReviewTabs } from './components/ReviewTabs';
import { SessionHistory } from './components/SessionHistory';
import { usePanel } from './hooks/usePanel';
import { useReviewChat } from './hooks/useReviewChat';
import { useAgentConnection } from './hooks/useAgentConnection';

export function App() {
  const panel = usePanel();
  const connection = useAgentConnection();
  const chat = useReviewChat(connection);
  const repositories = panel.snapshot?.git.repositories ?? [];
  const repository =
    repositories.find(({ rootUri }) => rootUri === chat.repositoryUri) ?? repositories[0];
  return (
    <AssistantRuntimeProvider runtime={chat.runtime}>
      <ChatActionsContext.Provider value={panel}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          aria-label="Review Bot 面板"
        >
          <ReviewHeader
            refreshing={panel.refreshing}
            canExport={chat.session.messages.length > 0}
            onRefresh={() => {
              void panel.refresh();
            }}
            onSettings={() => {
              void panel.openSettings().catch(() => {});
            }}
            onHistory={() => chat.setTab('history')}
            onExport={() => {
              void panel.openCode(chat.exportMarkdown(), 'markdown').catch(() => {});
            }}
          />
          <ReviewContext
            snapshot={panel.snapshot}
            repository={repository}
            refreshing={panel.refreshing}
            error={!!panel.error}
            onRepositoryChange={chat.selectRepository}
          />
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-widget px-3 py-2 text-[0.8rem]">
              {connection.authenticated ? (
                <>
                  <span className="max-w-40 truncate" title={connection.activeAccountId}>
                    {connection.accounts.find((a) => a.id === connection.activeAccountId)?.email ??
                      'ChatGPT'}
                  </span>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      void connection.logout();
                    }}
                  >
                    登出
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="rounded-sm bg-button px-2 py-1 text-button-foreground"
                  disabled={connection.waiting}
                  onClick={() => {
                    void connection.login(connection.accounts[0]?.id);
                  }}
                >
                  {connection.waiting ? '等待浏览器授权…' : 'Continue with ChatGPT'}
                </button>
              )}
              <button
                type="button"
                className="text-link"
                disabled={chat.isRunning || connection.waiting}
                onClick={() => {
                  void connection.login();
                  chat.newSession();
                }}
              >
                添加账户
              </button>
              {connection.accounts.length > 1 && (
                <select
                  aria-label="切换 ChatGPT 账户"
                  value={connection.activeAccountId ?? ''}
                  disabled={chat.isRunning}
                  className="min-w-0 bg-input text-input-foreground"
                  onChange={(event) => {
                    void connection.login(event.target.value);
                    chat.newSession();
                  }}
                >
                  <option value="" disabled>
                    选择账户
                  </option>
                  {connection.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.email ?? account.subject} · {account.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <ReviewTabs
              activeTab={chat.activeTab}
              fileCount={changeCounts(repository).total}
              onChange={chat.setTab}
            />
            {panel.error && (
              <p
                role="alert"
                className="shrink-0 border-b border-error/30 bg-error/10 px-3 py-2 text-[0.85rem] text-error"
              >
                {panel.error}
              </p>
            )}
            {(connection.error || chat.error) && (
              <p
                role="alert"
                className="shrink-0 border-b border-error/30 px-3 py-2 text-[0.85rem] text-error"
              >
                {connection.error || chat.error}
              </p>
            )}
            <section
              id="panel-chat"
              role="tabpanel"
              aria-labelledby="tab-chat"
              hidden={chat.activeTab !== 'chat'}
              className="min-h-0 flex-1 overflow-hidden"
              tabIndex={0}
            >
              <AgentChat
                authenticated={connection.authenticated}
                onFiles={() => chat.setTab('files')}
                sessionId={chat.session.id}
                draft={chat.session.draft}
                onDraftChange={chat.setDraft}
                onNew={chat.newSession}
                models={connection.models}
                reasoningEffort={chat.reasoningEffort}
                onReasoningEffortChange={chat.setReasoningEffort}
                model={chat.model}
                modelDisabled={!connection.authenticated || chat.isRunning}
                onModelChange={(model) => {
                  connection.setModel(model);
                  chat.newSession();
                }}
              />
            </section>
            <section
              id="panel-files"
              role="tabpanel"
              aria-labelledby="tab-files"
              hidden={chat.activeTab !== 'files'}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
              tabIndex={0}
            >
              <FileChanges
                snapshot={panel.snapshot}
                repository={repository}
                onOpen={(uri) => {
                  void panel.openFile(uri).catch(() => {});
                }}
              />
            </section>
            <section
              id="panel-history"
              role="tabpanel"
              aria-labelledby="tab-history"
              hidden={chat.activeTab !== 'history'}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
              tabIndex={0}
            >
              <SessionHistory
                sessions={chat.sessions}
                activeSessionId={chat.activeSessionId}
                onSelect={chat.selectSession}
                onNew={chat.newSession}
              />
            </section>
          </main>
        </div>
      </ChatActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}
