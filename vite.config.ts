import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  base: './',
  // Library mode avoids a second HTML template and runtime module-preload helpers.
  // The provider owns the HTML, CSP, and resource URIs.
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
  },
  build: {
    outDir: 'dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL('./src/webview/main.tsx', import.meta.url)),
      formats: ['es'],
      fileName: () => 'main.js',
      cssFileName: 'style',
    },
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
  },
}));
