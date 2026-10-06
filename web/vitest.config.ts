import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig has `jsx: preserve` (for Next); tests import .tsx visual modules, so transform JSX here.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
