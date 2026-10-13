import { expect, test } from 'bun:test';
import { createWebviewHtml } from '../src/extension/webview/html';

const resources = {
  scriptUri: 'https://webview.invalid/main.js',
  styleUri: 'https://webview.invalid/style.css',
  cspSource: 'https://webview.invalid',
};

test('webview HTML has a fresh nonce and blocks inline code and network access', () => {
  const first = createWebviewHtml(resources);
  const second = createWebviewHtml(resources);
  const nonce = first.match(/nonce="([^"]+)"/)?.[1];
  expect(nonce).toBeDefined();
  expect(first).toContain(`script-src &#39;nonce-${nonce}&#39;`);
  expect(first).toContain('default-src &#39;none&#39;');
  expect(first).toContain('connect-src &#39;none&#39;');
  expect(first).not.toContain('unsafe-inline');
  expect(first).not.toContain('unsafe-eval');
  expect(second.match(/nonce="([^"]+)"/)?.[1]).not.toBe(nonce);
});

test('resource attributes cannot inject markup', () => {
  const html = createWebviewHtml({ ...resources, scriptUri: 'x" onerror="alert(1)<script>' });
  expect(html).toContain('src="x&quot; onerror=&quot;alert(1)&lt;script&gt;"');
  expect(html).not.toContain('src="x" onerror=');
});
