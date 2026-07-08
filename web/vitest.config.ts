import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/__tests__/*.test.ts'],
    // Pre-vitest jest-globals file; relies on implicit describe/test/expect
    // and stale types. Fix imports before re-enabling.
    exclude: ['**/node_modules/**', 'utils/__tests__/templateChangeDetection.test.ts'],
  },
});
