import { describe, expect, test } from 'bun:test';
import { isExtensionMessage, isWebviewMessage } from '../src/shared/protocol';
import type { PanelSnapshot } from '../src/shared/models';
import { panelReducer, initialPanelState } from '../src/webview/state/panelReducer';

const snapshot: PanelSnapshot = {
  workspace: { name: null, folders: [], trusted: false },
  settings: { greeting: 'Hello', showWorkspacePaths: true },
  state: { messageCount: 0 },
  git: { available: false, repositories: [] },
};

describe('postMessage boundary validation', () => {
  test('accepts only supported requests with bounded payloads', () => {
    expect(isWebviewMessage({ type: 'webview/ready' })).toBe(true);
    expect(isWebviewMessage({ type: 'demo/hello', requestId: 'request-1', name: '开发者' })).toBe(
      true,
    );
    for (const message of [
      null,
      [],
      { type: 'runCommand', command: 'anything' },
      { type: 'workspace/refresh' },
      { type: 'workspace/refresh', requestId: '' },
      { type: 'demo/hello', requestId: '1', name: 'a'.repeat(81) },
      { type: 'demo/hello', requestId: '1', name: 123 },
    ]) {
      expect(isWebviewMessage(message)).toBe(false);
    }
  });

  test('validates nested snapshots and rejects malformed responses', () => {
    expect(isExtensionMessage({ type: 'host/snapshot', snapshot })).toBe(true);
    expect(
      isExtensionMessage({
        type: 'host/snapshot',
        snapshot: { ...snapshot, workspace: { folders: [] } },
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({
        type: 'host/snapshot',
        snapshot: { ...snapshot, git: { available: true, repositories: [{ rootUri: 1 }] } },
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({
        type: 'host/hello',
        requestId: '1',
        message: 'Hello',
        messageCount: -1,
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({
        type: 'host/hello',
        requestId: '1',
        message: 'Hello',
        messageCount: Infinity,
      }),
    ).toBe(false);
  });
});

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
