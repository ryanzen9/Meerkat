import { randomBytes } from 'node:crypto';

interface WebviewResources {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function createWebviewHtml({ scriptUri, styleUri, cspSource }: WebviewResources): string {
  const nonce = randomBytes(24).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource}; img-src ${cspSource}; font-src ${cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escapeAttribute(styleUri)}">
  <title>Meerkat</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${escapeAttribute(scriptUri)}"></script>
</body>
</html>`;
}
