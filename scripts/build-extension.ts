import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function buildExtension(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../src/extension/index.ts', import.meta.url))],
    outdir: fileURLToPath(new URL('../dist/extension/', import.meta.url)),
    naming: 'extension.cjs',
    target: 'node',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: 'external',
    minify: false,
  });
  if (!result.success) throw new AggregateError(result.logs, 'Extension build failed');
  // outdir writes artifacts to disk. Never rewrite a file-backed BuildArtifact
  // onto itself: that can truncate the file before Bun reads its contents.
  for (const output of result.outputs) {
    if (output.size === 0) throw new Error(`Empty build output: ${output.path}`);
  }
  console.log('[extension] built');
}

if (import.meta.main) await buildExtension();
