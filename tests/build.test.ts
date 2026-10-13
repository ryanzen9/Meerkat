import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('repeated Bun builds produce a nonempty entry that loads in Node.js', async () => {
  for (let iteration = 0; iteration < 2; iteration++) {
    const build = Bun.spawn([process.execPath, 'run', 'scripts/build-extension.ts'], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(
      Bun.file(new URL('../dist/extension/extension.cjs', import.meta.url)).size,
    ).toBeGreaterThan(0);
  }
  const node = Bun.spawn(
    [
      'node',
      '--input-type=commonjs',
      '-e',
      `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...args) { return id === 'vscode' ? {} : load.call(this, id, ...args); };
    const extension = require('./dist/extension/extension.cjs');
    assert.equal(typeof extension.activate, 'function');
    assert.equal(typeof extension.deactivate, 'function');
    assert.doesNotMatch(fs.readFileSync('./dist/extension/extension.cjs', 'utf8'), /bun:|Bun\\./);
  `,
    ],
    { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stderr] = await Promise.all([node.exited, new Response(node.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  expect(exitCode).toBe(0);
}, 10000);
