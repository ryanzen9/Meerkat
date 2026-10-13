import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const builtins = new Set(builtinModules);

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('./', import.meta.url)),
  publicDir: false,
  build: {
    outDir: 'dist/extension',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: mode === 'development',
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/extension/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'extension.cjs',
    },
    rolldownOptions: {
      platform: 'node',
      external: (id) => id === 'vscode' || id.startsWith('node:') || builtins.has(id),
    },
  },
}));
