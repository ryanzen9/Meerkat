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
  test('reference navigation requires a session and an opaque registered-region ID', () => {
    const message = {
      type: 'reference/open',
      requestId: 'click',
      sessionId: 'session-1',
      referenceId: `ref_${'a'.repeat(64)}`,
    };
    expect(isWebviewMessage(message)).toBe(true);
    for (const invalid of [
      { ...message, requestId: '' },
      { ...message, sessionId: '' },
      { ...message, sessionId: 'a'.repeat(129) },
      { ...message, sessionId: '../other' },
      { ...message, referenceId: 'ref_invented' },
      { ...message, referenceId: 'file:///etc/passwd' },
      { ...message, referenceId: `ref_${'a'.repeat(65)}` },
      { ...message, referenceId: null },
    ])
      expect(isWebviewMessage(invalid)).toBe(false);
  });
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

  test('validates stage, unstage and commit requests', () => {
    const repositoryUri = 'file:///workspace/repo';
    const uri = 'file:///workspace/repo/src/file.ts';
    expect(isWebviewMessage({ type: 'git/stage', requestId: 'stage', repositoryUri, uri })).toBe(
      true,
    );
    expect(
      isWebviewMessage({ type: 'git/unstage', requestId: 'unstage', repositoryUri, uri }),
    ).toBe(true);
    expect(
      isWebviewMessage({ type: 'git/commit', requestId: 'commit', repositoryUri, message: 'fix' }),
    ).toBe(true);
    for (const invalid of [
      { type: 'git/stage', requestId: '1', repositoryUri, uri: '' },
      { type: 'git/unstage', requestId: '', repositoryUri, uri },
      { type: 'git/commit', requestId: '1', repositoryUri, message: '  ' },
      { type: 'git/commit', requestId: '1', repositoryUri, message: 'a'.repeat(5001) },
    ])
      expect(isWebviewMessage(invalid)).toBe(false);
  });

  test('bulk actions and synchronization requests validate repository, branch and pinned commit', () => {
    const base = { requestId: 'git', repositoryUri: 'file:///repo' };
    for (const type of ['git/stage-all', 'git/unstage-all']) {
      expect(isWebviewMessage({ ...base, type })).toBe(true);
      expect(isWebviewMessage({ ...base, type, repositoryUri: '' })).toBe(false);
    }
    for (const type of ['git/push', 'git/undo-commit']) {
      const message = { ...base, type, branch: 'main', head: 'a'.repeat(40) };
      expect(isWebviewMessage(message)).toBe(true);
      for (const invalid of [
        { ...message, head: 'HEAD' },
        { ...message, head: '' },
        { ...message, branch: '' },
        { ...message, requestId: '' },
      ])
        expect(isWebviewMessage(invalid)).toBe(false);
    }
    const repository = {
      rootUri: 'file:///repo',
      name: 'repo',
      branch: 'main',
      remotes: ['origin'],
      changes: [],
      stagedChanges: [],
    };
    const sync = {
      head: 'a'.repeat(40),
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      canUndo: true,
    };
    const message = (value: unknown) => ({
      type: 'host/snapshot',
      snapshot: {
        ...snapshot,
        git: { available: true, repositories: [{ ...repository, sync: value }] },
      },
    });
    expect(isExtensionMessage(message(sync))).toBe(true);
    for (const invalid of [
      { ...sync, ahead: -1 },
      { ...sync, ahead: Infinity },
      { ...sync, head: 'HEAD' },
      { ...sync, canUndo: 'yes' },
      { ...sync, behind: 0.1 },
    ])
      expect(isExtensionMessage(message(invalid))).toBe(false);
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
