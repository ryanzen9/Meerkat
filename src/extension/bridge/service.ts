import * as vscode from 'vscode';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { ChatGPTAuth } from './auth/chatgpt';
import { fileMutex } from './auth/storage';
import { OpenAIChatGPTProvider } from './providers/openai/provider';
import { ProviderRegistry } from './providers/registry';
import { BridgeRuntime } from './runtime/bridgeRuntime';
import { resolveInteractionMode } from './runtime/modeRouter';
import { createBridgeApi } from './server/api';
import { BridgeHttpServer } from './server/httpServer';
import { BridgeError } from './errors';
import { ReviewContext } from './tools/reviewContext';
import { VSCodeReviewWorkspace } from './tools/vscodeReviewWorkspace';
import { FileReferenceArchive } from './sessions/fileReferenceArchive';
import {
  reviewFindingSchema,
  type FindingStatus,
  type FindingUpdate,
  type ReviewFindingChange,
} from '../../shared/review';

export class BridgeService implements vscode.Disposable {
  private readonly findingChanges = new vscode.EventEmitter<ReviewFindingChange>();
  readonly onDidChangeFinding = this.findingChanges.event;
  private startPromise: Promise<void> | undefined;
  private server: BridgeHttpServer | undefined;
  private runtime: BridgeRuntime | undefined;
  private reviewWorkspace: VSCodeReviewWorkspace | undefined;
  private disposed = false;
  private closing: Promise<void> | undefined;
  private connectionFile: string | undefined;
  private api: ((request: Request) => Promise<Response>) | undefined;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new BridgeError('bridge_closed', 'Bridge has been disposed.', 503);
    if (!vscode.workspace.isTrusted)
      throw new BridgeError(
        'workspace_untrusted',
        'Trust the workspace before using Agent Bridge.',
        403,
      );
    // OAuth's loopback browser callback belongs to the user's local machine.
    if (vscode.env.remoteName)
      throw new BridgeError(
        'remote_unsupported',
        'This version supports local VS Code windows only.',
        422,
      );
    this.startPromise ??= this.start().catch(async (error: unknown) => {
      await this.server?.close();
      this.server = undefined;
      await this.runtime?.dispose();
      this.runtime = undefined;
      this.reviewWorkspace?.dispose();
      this.reviewWorkspace = undefined;
      this.startPromise = undefined;
      throw error;
    });
    await this.startPromise;
    if (this.disposed) throw new BridgeError('bridge_closed', 'Bridge has been disposed.', 503);
  }
  private async start(): Promise<void> {
    const registry = new ProviderRegistry();
    const auth = new ChatGPTAuth({
      secrets: this.context.secrets,
      exclusive: fileMutex(join(this.context.globalStorageUri.fsPath, 'oauth.lock')),
    });
    registry.register(() => new OpenAIChatGPTProvider(auth));
    this.reviewWorkspace = new VSCodeReviewWorkspace(this.output);
    this.runtime = new BridgeRuntime(
      registry,
      {},
      (references) => new ReviewContext(this.reviewWorkspace!, references),
      {
        read: (id) => this.context.workspaceState.get(`reviewJournal.v1.${id}`),
        write: async (id, state) => {
          await this.context.workspaceState.update(`reviewJournal.v1.${id}`, state);
        },
      },
      new FileReferenceArchive(
        join(
          (this.context.storageUri ?? this.context.globalStorageUri).fsPath,
          'file-references-v1',
        ),
      ),
    );
    await registry.initialize();
    let baseUrl = '';
    this.api = createBridgeApi({
      runtime: this.runtime,
      callbackUri: () => `${baseUrl}/auth/callback`,
      openBrowser: async (url) => {
        if (!(await vscode.env.openExternal(vscode.Uri.parse(url))))
          throw new BridgeError('browser_unavailable', 'Unable to open the system browser.', 503);
      },
      log: (code, status) => this.output.warn(`Bridge ${code} (${status})`),
      onFindingChanged: (change) => this.findingChanges.fire(change),
      // The reviewed model and the user's selected reasoning effort also drive
      // routing, so the automatic mode cannot drift from what the user chose.
      decideMode: async ({ sessionId, text, reasoningEffort, signal }) => {
        const runtime = this.runtime!;
        const session = runtime.sessions.get(sessionId);
        const decision = await resolveInteractionMode(
          runtime.registry.get(session.providerId),
          session,
          text,
          reasoningEffort,
          signal,
        );
        const detail = decision.reason
          ? `: ${decision.reason.replace(/\s+/g, ' ').slice(0, 300)}`
          : '';
        this.output.info(
          `Interaction mode ${decision.mode} (${decision.latencyMs}ms${decision.fallback ? `, fallback ${decision.fallback}` : ''})${detail}`,
        );
        return decision.mode;
      },
    });
    this.server = new BridgeHttpServer({ handle: this.api });
    baseUrl = (await this.server.start()).baseUrl;
    this.output.info('Agent Bridge loopback listener started');
  }
  async request(
    path: string,
    method: string,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    await this.ensureStarted();
    if (!/^\/v1\/[\w/-]+$/.test(path) || !['GET', 'POST', 'DELETE'].includes(method))
      throw new BridgeError('request_invalid', 'Invalid Bridge request.');
    return this.api!(
      new Request(`http://127.0.0.1${path}`, {
        method,
        signal,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body } : {}),
      }),
    );
  }
  async readFileReference(sessionId: string, referenceId: string) {
    await this.ensureStarted();
    return this.runtime!.readFileReference(sessionId, referenceId);
  }
  setFindingStatus(sessionId: string, findingId: string, status: FindingStatus) {
    return this.updateFinding(sessionId, findingId, { status });
  }
  setFindingArchived(sessionId: string, findingId: string, editorArchived: boolean) {
    return this.updateFinding(sessionId, findingId, { editorArchived });
  }
  private async updateFinding(sessionId: string, findingId: string, update: FindingUpdate) {
    if (!/^[\w-]{1,128}$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(findingId))
      throw new BridgeError('request_invalid', 'Invalid review finding.');
    const response = await this.request(
      `/v1/sessions/${sessionId}/reviews/${findingId}`,
      'POST',
      JSON.stringify(update),
      new AbortController().signal,
    );
    if (!response.ok)
      throw new BridgeError('review_save_failed', '审查状态保存失败，请重试。', response.status);
    return reviewFindingSchema.parse(await response.json());
  }
  // Explicit developer command only: export a short-lived *local Bridge*
  // capability for curl, never OAuth tokens. Removed on extension shutdown.
  async exportConnection(): Promise<string> {
    await this.ensureStarted();
    const connection = await this.server!.start();
    const folder = this.context.globalStorageUri.fsPath;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    this.connectionFile = join(folder, `bridge-${process.pid}.json`);
    await writeFile(this.connectionFile, JSON.stringify(connection), { mode: 0o600 });
    return this.connectionFile;
  }
  async close(): Promise<void> {
    this.disposed = true;
    this.closing ??= (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.server?.close();
      await this.runtime?.dispose();
      this.reviewWorkspace?.dispose();
      if (this.connectionFile) await rm(this.connectionFile, { force: true });
    })().finally(() => this.findingChanges.dispose());
    await this.closing;
  }
  dispose(): void {
    void this.close().catch(() => this.output.warn('Bridge shutdown failed'));
  }
}
