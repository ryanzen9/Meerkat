import { expect, test } from 'bun:test';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectFixture, runBuild, runCommand } from './projectFixture';

test('repeated Vite builds load in Node and preserve the other output directory', async () => {
  const root = await createProjectFixture();
  try {
    await runBuild(root, 'webview');
    const webviewFile = join(root, 'dist/webview/main.js');
    const webview = await Bun.file(webviewFile).text();
    const extensionFile = join(root, 'dist/extension/extension.cjs');
    for (let iteration = 0; iteration < 2; iteration++) {
      await runBuild(root, 'extension');
      expect(Bun.file(extensionFile).size).toBeGreaterThan(0);
      expect(await Bun.file(webviewFile).text()).toBe(webview);
    }
    const extension = await Bun.file(extensionFile).text();
    await runBuild(root, 'webview');
    expect(await Bun.file(extensionFile).text()).toBe(extension);
    expect(await Bun.file(join(root, 'dist/webview/style.css')).text()).toContain('--vscode-');
    expect(await readdir(join(root, 'dist/extension'))).not.toContain('extension.cjs.map');
    expect(await readdir(join(root, 'dist/webview'))).not.toContain('main.js.map');
    expect(webview).not.toMatch(/__vite-browser-external|@vite\/client|Bun\./);
    const node = await runCommand(root, [
      'node',
      '--input-type=commonjs',
      '-e',
      `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const Module = require('node:module');
        const load = Module._load;
        Module._load = function(id, ...args) {
          return id === 'vscode' ? {} : load.call(this, id, ...args);
        };
        const entry = require('./package.json').main;
        const extension = require(entry);
        assert.equal(typeof extension.activate, 'function');
        assert.equal(typeof extension.deactivate, 'function');
        assert.doesNotMatch(fs.readFileSync(entry, 'utf8'), /bun:|Bun\\./);
      `,
    ]);
    if (node.exitCode !== 0) throw new Error(node.stdout + node.stderr);
    expect(node.exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test('small images, CSS fonts, and lazy chunks use packaged local resource paths', async () => {
  const root = await createProjectFixture();
  try {
    const source = join(root, 'src/webview');
    await Bun.write(
      join(source, 'main.tsx'),
      `import image from './fixture.svg';
       import './fixture.css';
       document.body.dataset.image = image;
       void import('./fixture-lazy').then(({ value }) => { document.body.dataset.lazy = value; });`,
    );
    await Bun.write(join(source, 'fixture.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await Bun.write(join(source, 'fixture.woff2'), new Uint8Array([119, 79, 70, 50, 0, 0, 0, 0]));
    await Bun.write(join(source, 'fixture-lazy.ts'), 'export const value = "lazy fixture";');
    await Bun.write(
      join(source, 'fixture.css'),
      `@font-face { font-family: Fixture; src: url('./fixture.woff2'); }
       .fixture { background-image: url('./fixture.svg'); }`,
    );
    await runBuild(root, 'webview', true);
    const output = join(root, 'dist/webview');
    const files = await readdir(output, { recursive: true });
    const image = files.find((file) => file.endsWith('.svg'));
    const font = files.find((file) => file.endsWith('.woff2'));
    const lazy = files.find((file) => file.startsWith('chunks/') && file.endsWith('.js'));
    expect(image).toBeDefined();
    expect(font).toBeDefined();
    expect(lazy).toBeDefined();
    const script = await Bun.file(join(output, 'main.js')).text();
    const css = await Bun.file(join(output, 'style.css')).text();
    expect(script).toContain(image!);
    expect(script).toContain(lazy!);
    expect(script).toContain('import.meta.url');
    expect(css).toContain(font!);
    expect(css).toContain(image!);
    expect(script + css).not.toContain('data:');
    expect(script).not.toMatch(/@vite\/client|react-refresh|__vite-browser-external/);
    expect(files).toContain('main.js.map');
    const listing = await runCommand(root, [
      'node',
      'node_modules/@vscode/vsce/vsce',
      'ls',
      '--no-dependencies',
    ]);
    if (listing.exitCode !== 0) throw new Error(listing.stdout + listing.stderr);
    for (const file of files.filter((candidate) => !candidate.endsWith('.map'))) {
      if ((await stat(join(output, file))).isFile())
        expect(listing.stdout).toContain(`dist/webview/${file}\n`);
    }
    expect(listing.stdout).not.toContain('.map');
    expect(listing.stdout).not.toMatch(/src\/|node_modules\/|vite\.config/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test('Webview builds reject Node, Bun, and VS Code imports', async () => {
  const root = await createProjectFixture();
  try {
    for (const id of ['node:fs', 'fs/promises', 'bun:test', 'bun', 'vscode']) {
      await Bun.write(
        join(root, 'src/webview/main.tsx'),
        `import * as host from '${id}'; console.log(host);`,
      );
      const result = await runCommand(root, [process.execPath, 'run', 'build:webview']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(`Webview cannot import host module: ${id}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
