import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same alias as tsconfig.json, so routes that import "@/..." can be loaded in tests.
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    include: ['**/__tests__/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
