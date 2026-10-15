import { describe, expect, test } from 'bun:test';
import { isExtensionMessage, isWebviewMessage } from '../src/shared/protocol';
import type { PanelSnapshot } from '../src/shared/models';

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

  test('validates file groups and bounds the editor and clipboard action payloads', () => {
    const repository = {
      rootUri: 'file:///repo',
      name: 'repo',
      branch: 'main',
      remotes: ['origin'],
      changes: [{ uri: 'file:///repo/file.ts', path: 'file.ts', kind: 'added' }],
      stagedChanges: [],
    };
    const message = {
      type: 'host/snapshot',
      snapshot: { ...snapshot, git: { available: true, repositories: [repository] } },
    };
    expect(isExtensionMessage(message)).toBe(true);
    const review = {
      repositoryUri: 'file:///repo',
      pullRequestNumber: 123,
      status: 'analyzing',
      issueCount: 0,
    };
    expect(isExtensionMessage({ ...message, snapshot: { ...message.snapshot, review } })).toBe(
      true,
    );
    expect(
      isExtensionMessage({
        ...message,
        snapshot: { ...message.snapshot, review: { ...review, issueCount: -1 } },
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({
        ...message,
        snapshot: { ...message.snapshot, review: { ...review, pullRequestNumber: 0 } },
      }),
    ).toBe(false);
    expect(
      isExtensionMessage({
        ...message,
        snapshot: {
          ...message.snapshot,
          git: {
            available: true,
            repositories: [
              { ...repository, changes: [{ ...repository.changes[0], kind: 'unknown' }] },
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      isWebviewMessage({ type: 'file/open', requestId: '1', uri: 'file:///repo/file.ts' }),
    ).toBe(true);
    expect(
      isWebviewMessage({
        type: 'code/open',
        requestId: '1',
        code: 'const x=1;',
        language: 'typescript',
      }),
    ).toBe(true);
    expect(
      isWebviewMessage({ type: 'code/open', requestId: '1', code: '', language: '../../bad' }),
    ).toBe(false);
    expect(
      isWebviewMessage({ type: 'clipboard/write', requestId: '1', text: 'a'.repeat(100001) }),
    ).toBe(false);
    expect(isWebviewMessage({ type: 'settings/open', requestId: '1' })).toBe(true);
    expect(isExtensionMessage({ type: 'host/action', requestId: '1' })).toBe(true);
  });
});
