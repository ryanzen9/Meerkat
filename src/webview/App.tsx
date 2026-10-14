import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { changeCounts } from '../shared/git';
import { AgentChat, ChatActionsContext } from './components/AgentChat';
import { FileChanges } from './components/FileChanges';
import { ReviewComposer } from './components/ReviewComposer';
import { ReviewContext } from './components/ReviewContext';
import { ReviewHeader } from './components/ReviewHeader';
import { ReviewTabs } from './components/ReviewTabs';
import { SessionHistory } from './components/SessionHistory';
import { usePanel } from './hooks/usePanel';
import { useReviewChat } from './hooks/useReviewChat';

export function App() {
  const panel = usePanel();
  const chat = useReviewChat();
  const repositories = panel.snapshot?.git.repositories ?? [];
  const repository =
    repositories.find(({ rootUri }) => rootUri === chat.repositoryUri) ?? repositories[0];
  return (
    <AssistantRuntimeProvider runtime={chat.runtime}>
      <ChatActionsContext.Provider value={panel}>
        <ThreadPrimitive.Root
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
            <section
              id="panel-chat"
              role="tabpanel"
              aria-labelledby="tab-chat"
              hidden={chat.activeTab !== 'chat'}
              className="min-h-0 flex-1 overflow-hidden"
              tabIndex={0}
            >
              <AgentChat
                empty={!chat.session.messages.length}
                onFiles={() => chat.setTab('files')}
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
          <ReviewComposer
            sessionId={chat.session.id}
            draft={chat.session.draft}
            onDraftChange={chat.setDraft}
            onNew={chat.newSession}
          />
        </ThreadPrimitive.Root>
      </ChatActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}
