import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { fileReferenceSchema } from '../../../shared/review';
import { BridgeError } from '../errors';
import { MAX_FILE_BYTES, reviewPath } from '../tools/reviewGit';
import type { FileReference } from '../tools/reviewWorkspace';

export interface ReferenceDocument {
  reference: FileReference;
  content: string;
}

export interface SessionFileReferences {
  read(referenceId: string): Promise<ReferenceDocument | undefined>;
  write(documents: ReferenceDocument[]): Promise<void>;
}

const sessionIdSchema = z.string().uuid();
const referenceIdPattern = /^ref_[a-f0-9]{64}$/;
const manifestSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  documents: z
    .array(
      z.object({
        reference: fileReferenceSchema,
        contentId: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(20000),
});
type Manifest = z.infer<typeof manifestSchema>;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

function validateReference(reference: FileReference): void {
  reviewPath(reference.path);
  if (!isAbsolute(reference.repository) || reference.repository.includes('\0'))
    throw new BridgeError('reference_corrupt', '已保存的代码引用无效，请重新生成引用。');
  const identity =
    reference.scope === 'file'
      ? [reference.reviewId, reference.path, reference.version, 'file']
      : [
          reference.reviewId,
          reference.path,
          reference.version,
          reference.startLine,
          reference.endLine,
        ];
  if (reference.referenceId !== `ref_${hash(JSON.stringify(identity))}`)
    throw new BridgeError('reference_corrupt', '已保存的代码引用无效，请重新生成引用。');
}

function validateContent({ reference, content }: ReferenceDocument): void {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0'))
    throw new BridgeError('reference_corrupt', '已保存的代码快照无效，请重新生成引用。');
  if (reference.scope === 'range') {
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (
      reference.endLine < reference.startLine ||
      reference.endLine - reference.startLine >= 500 ||
      reference.endLine > lines.length
    )
      throw new BridgeError('reference_corrupt', '已保存的代码范围无效，请重新生成引用。');
  }
}

// Full source text belongs in extension storage, outside the repository and the
// Webview state. Identical file versions share a blob within each conversation.
// Only the atomic manifest publishes a batch, after all of its blobs are saved.
export class FileReferenceArchive {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly deleted = new Set<string>();
  private closed = false;
  constructor(private readonly directory: string) {}

  session(sessionId: string): SessionFileReferences {
    this.assertSessionId(sessionId);
    return {
      read: (referenceId) => this.read(sessionId, referenceId),
      write: (documents) => this.write(sessionId, documents),
    };
  }

  has(sessionId: string): Promise<boolean> {
    return this.exclusive(sessionId, async () => {
      if (this.deleted.has(sessionId)) return false;
      try {
        // Also recognize partial/corrupt archives so deleting a conversation can
        // clean up blobs left by an interrupted first manifest write.
        return (await stat(join(this.directory, sessionId))).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  delete(sessionId: string): Promise<void> {
    return this.exclusive(sessionId, async () => {
      await rm(join(this.directory, sessionId), { recursive: true, force: true });
      this.deleted.add(sessionId);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
  }

  private assertSessionId(sessionId: string): void {
    if (!sessionIdSchema.safeParse(sessionId).success)
      throw new BridgeError('reference_not_found', 'Invalid reference conversation.', 404);
  }

  private exclusive<T>(sessionId: string, action: () => Promise<T>, writing = false): Promise<T> {
    this.assertSessionId(sessionId);
    if (this.closed)
      return Promise.reject(new BridgeError('bridge_closed', 'Reference archive is closed.', 503));
    const operation = (this.pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(action)
      .catch((error: unknown) => {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(
          writing ? 'reference_save_failed' : 'reference_unavailable',
          writing ? '代码引用保存失败，请重试。' : '无法读取已保存的代码引用，请重试。',
          503,
        );
      });
    this.pending.set(sessionId, operation);
    void operation
      .finally(() => {
        if (this.pending.get(sessionId) === operation) this.pending.delete(sessionId);
      })
      .catch(() => {});
    return operation;
  }

  private async manifest(sessionId: string): Promise<Manifest | undefined> {
    if (this.deleted.has(sessionId)) return undefined;
    let text: string;
    try {
      text = await readFile(join(this.directory, sessionId, 'manifest.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BridgeError('reference_corrupt', '已保存的代码引用损坏，请重新生成引用。');
    }
    const parsed = manifestSchema.safeParse(data);
    if (!parsed.success || parsed.data.sessionId !== sessionId)
      throw new BridgeError('reference_corrupt', '已保存的代码引用损坏，请重新生成引用。');
    for (const { reference } of parsed.data.documents) validateReference(reference);
    return parsed.data;
  }

  private read(sessionId: string, referenceId: string): Promise<ReferenceDocument | undefined> {
    return this.exclusive(sessionId, async () => {
      if (!referenceIdPattern.test(referenceId)) return undefined;
      const manifest = await this.manifest(sessionId);
      const saved = manifest?.documents.find((item) => item.reference.referenceId === referenceId);
      if (!saved) return undefined;
      let content: string;
      try {
        content = await readFile(join(this.directory, sessionId, `${saved.contentId}.txt`), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new BridgeError('reference_corrupt', '已保存的代码快照缺失，请重新生成引用。');
        throw error;
      }
      if (hash(content) !== saved.contentId)
        throw new BridgeError('reference_corrupt', '已保存的代码快照损坏，请重新生成引用。');
      const document = { reference: saved.reference, content };
      validateContent(document);
      return document;
    });
  }

  private write(sessionId: string, documents: ReferenceDocument[]): Promise<void> {
    // Freeze caller-owned input before waiting for another citation or deletion.
    const batch = structuredClone(documents);
    return this.exclusive(
      sessionId,
      async () => {
        if (this.deleted.has(sessionId))
          throw new BridgeError('reference_not_found', 'Reference conversation was deleted.', 404);
        for (const document of batch) {
          document.reference = fileReferenceSchema.parse(document.reference);
          validateReference(document.reference);
          validateContent(document);
        }
        const manifest = (await this.manifest(sessionId)) ?? {
          version: 1,
          sessionId,
          documents: [],
        };
        const entries = new Map(
          manifest.documents.map((item) => [item.reference.referenceId, item]),
        );
        const knownContents = new Set(manifest.documents.map((item) => item.contentId));
        const blobs = new Map<string, string>();
        for (const { reference, content } of batch) {
          const contentId = hash(content);
          const existing = entries.get(reference.referenceId);
          if (existing && existing.contentId !== contentId)
            throw new BridgeError('reference_corrupt', 'Code references are immutable.');
          entries.set(reference.referenceId, { reference, contentId });
          if (!knownContents.has(contentId)) blobs.set(contentId, content);
        }
        if (entries.size > 20000)
          throw new BridgeError('reference_limit', '引用数量达到当前对话上限，请新建对话。');
        if (entries.size === manifest.documents.length) return;
        const folder = join(this.directory, sessionId);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        for (const [contentId, content] of blobs)
          await this.atomicWrite(join(folder, `${contentId}.txt`), content);
        await this.atomicWrite(
          join(folder, 'manifest.json'),
          JSON.stringify({ version: 1, sessionId, documents: [...entries.values()] }),
        );
      },
      true,
    );
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
