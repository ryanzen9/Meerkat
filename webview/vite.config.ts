import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const builtins = new Set(builtinModules);

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('./', import.meta.url)),
  publicDir: false,
  plugins: [
    {
      name: 'webview-browser-boundary',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'vscode' || id === 'bun' || /^(node|bun):/.test(id) || builtins.has(id)) {
          this.error(`Webview cannot import host module: ${id}`);
        }
      },
    },
    react(),
    tailwindcss(),
  ],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  // The provider owns HTML, CSP, nonce, and entry resource URIs. A normal browser
  // build emits imported assets as files rather than library-mode data URLs.
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/webview', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? 'style.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
  },
}));
