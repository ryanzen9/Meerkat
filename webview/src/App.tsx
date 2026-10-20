import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { changeCounts } from '@shared/git';
import { AgentChat, ChatActionsContext, reviewToolConfig } from './components/AgentChat';
import { FileChanges } from './components/FileChanges';
import { ReviewContext } from './components/ReviewContext';
import { ReviewActions } from './components/ReviewActions';
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
    <AssistantRuntimeProvider runtime={chat.runtime} config={reviewToolConfig}>
      <ChatActionsContext.Provider
        value={{
          openFile: panel.openFile,
          openReference: (referenceId) =>
            panel.openReference(chat.session.bridgeSessionId, referenceId),
          openCode: panel.openCode,
          copy: panel.copy,
          findings: chat.session.reviews?.findings ?? [],
          setFindingStatus: chat.setFindingStatus,
          setFindingArchived: chat.setFindingArchived,
        }}
      >
        <div
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          aria-label="Meerkat 面板"
        >
          <div className="flex h-10 shrink-0 items-stretch border-b border-widget px-2">
            <ReviewTabs
              activeTab={chat.activeTab}
              fileCount={changeCounts(repository).total}
              onChange={chat.setTab}
            />
            <ReviewActions
              refreshing={panel.refreshing}
              canExport={chat.session.messages.length > 0}
              authenticated={connection.authenticated}
              activeAccountId={connection.activeAccountId}
              accounts={connection.accounts}
              waiting={connection.waiting}
              chatRunning={chat.isRunning}
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
              onLogin={() => {
                void connection.login(connection.accounts[0]?.id);
              }}
              onLogout={() => {
                void connection.logout();
              }}
              onAddAccount={() => {
                void connection.login();
                chat.newSession();
              }}
              onAccountChange={(accountId) => {
                void connection.login(accountId);
                chat.newSession();
              }}
            />
          </div>
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {panel.error && (
              <p
                role="alert"
                className="shrink-0 border-b border-error/30 bg-error/10 px-3 py-2 text-[0.85rem] text-error"
              >
                {panel.error}
              </p>
            )}
            {(connection.error || chat.cleanupError) && (
              <p
                role="alert"
                className="shrink-0 border-b border-error/30 px-3 py-2 text-[0.85rem] text-error"
              >
                {connection.error || chat.cleanupError}
                {connection.modelsFailed && (
                  <button
                    type="button"
                    className="ml-2 text-link"
                    onClick={() => {
                      void connection.retryModels();
                    }}
                  >
                    重新加载模型
                  </button>
                )}
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
                snapshot={panel.snapshot}
                repository={repository}
                sessionId={chat.session.id}
                draft={chat.session.draft}
                onDraftChange={chat.setDraft}
                onNew={chat.newSession}
                models={connection.models}
                modelsReady={connection.modelsReady}
                modelsLoading={connection.modelsLoading}
                reasoningEffort={chat.reasoningEffort}
                onReasoningEffortChange={chat.setReasoningEffort}
                model={chat.model}
                modelDisabled={
                  !connection.authenticated || !connection.modelsReady || chat.isRunning
                }
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
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              tabIndex={0}
            >
              <ReviewContext
                snapshot={panel.snapshot}
                repository={repository}
                refreshing={panel.refreshing}
                error={!!panel.error}
                onRepositoryChange={chat.selectRepository}
              />
              <div className="min-h-0 flex-1 overflow-hidden">
                <FileChanges
                  snapshot={panel.snapshot}
                  repository={repository}
                  onStage={panel.stageFile}
                  onUnstage={panel.unstageFile}
                  onCommit={panel.commit}
                  onStageAll={panel.stageAll}
                  onUnstageAll={panel.unstageAll}
                  onPush={panel.push}
                  onUndoCommit={panel.undoCommit}
                  onOpen={(uri) => {
                    void panel.openFile(uri).catch(() => {});
                  }}
                />
              </div>
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
