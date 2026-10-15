import { expect, test } from 'bun:test';
import type { PanelSnapshot } from '../../src/shared/models';
import { panelReducer, initialPanelState } from '../src/state/panelReducer';

const snapshot: PanelSnapshot = {
  workspace: { name: null, folders: [], trusted: false },
  settings: { greeting: 'Hello', showWorkspacePaths: true },
  state: { messageCount: 0 },
  git: { available: false, repositories: [] },
};

test('a hello response updates persisted state without losing workspace data', () => {
  const loaded = panelReducer(initialPanelState, { type: 'host/snapshot', snapshot });
  const replied = panelReducer(loaded, {
    type: 'host/hello',
    requestId: '1',
    message: 'Hello',
    messageCount: 2,
  });
  expect(replied.snapshot?.workspace).toEqual(snapshot.workspace);
  expect(replied.snapshot?.state.messageCount).toBe(2);
  expect(replied.reply).toBe('Hello');
});
