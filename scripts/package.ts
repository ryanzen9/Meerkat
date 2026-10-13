import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
// Use Node for vsce; Bun remains the dependency manager and script runner.
// vsce invokes vscode:prepublish, which performs the complete typed production build.
const processHandle = Bun.spawn(
  [
    'node',
    'node_modules/@vscode/vsce/vsce',
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--out',
    `artifacts/${manifest.name}-${manifest.version}.vsix`,
  ],
  { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await processHandle.exited);
