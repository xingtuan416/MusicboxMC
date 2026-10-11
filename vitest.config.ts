import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Without this, vitest scans the whole repository and tries to run any
    // *.test.ts it finds — including copies under the gitignored output
    // directories. Keep the test surface explicit.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'release/**', 'out/**'],
  },
});
