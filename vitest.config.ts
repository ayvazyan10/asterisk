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
      // A ratchet, not an aspiration: each number sits just under what was
      // actually measured, so the gate blocks regressions rather than stating
      // a hope. These once read 60/60/50/60 while @vitest/coverage-v8 was not
      // even installed and `--coverage` errored out, so they had never been
      // checked once.
      //
      // Measured now: 78.95 lines / 80.72 functions / 69.76 branches /
      // 77.26 statements. The Telegram transport is no longer the hole this
      // comment used to name — the fake Bot API landed and `src/bots/telegram`
      // now measures 98.95 / 95.40 / 97.36 / 100. What remains uncovered there
      // is defensive: `?? fallback` arms behind arrays that are never empty,
      // and `stopped` re-checks on timers that were already cleared. Reaching
      // them would mean reaching past the module's surface, so they stay.
      //
      // What is left is nameable: `src/web` (0%, no HTTP-level tests) and
      // `src/tools/code` (~3%, the interpreter).
      thresholds: {
        lines: 78,
        functions: 80,
        branches: 69,
        statements: 77,
      },
    },
  },
});
