import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/types/**', 'src/**/*.d.ts'],
      // A ratchet, not an aspiration. These thresholds were 60/60/50/60 while
      // @vitest/coverage-v8 was not installed, so `--coverage` errored out and
      // the numbers were never once checked — actual coverage is roughly ten
      // points below what was declared. They now sit just under the measured
      // values so the gate is real and blocks regressions; raise them as
      // coverage improves. Target remains 60/60/50/60.
      // Ratcheted up with the Bash permission work (measured 49.01 / 47.51 /
      // 41.54 / 50.08); the new modules sit at 87–100%.
      thresholds: {
        lines: 48,
        functions: 46,
        branches: 40,
        statements: 49,
      },
    },
  },
});
