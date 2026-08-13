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
      // Measured now: 79.36 lines / 81.12 functions / 70.25 branches /
      // 77.63 statements. The Telegram transport is no longer the hole this
      // comment used to name — the fake Bot API landed and the whole of
      // `src/bots` is now covered: adapter.ts, commands.ts and manager.ts at
      // 100% statements/functions/branches, telegram/format.ts at 100/100/98,
      // telegram/index.ts at 98/96/94. What stays uncovered there is
      // defensive: `?? fallback` arms behind arrays that are never empty, and
      // `stopped` re-checks on timers that were already cleared. Reaching them
      // would mean reaching past the module's surface, so they stay.
      //
      // What is left is nameable: `src/web` (0%, no HTTP-level tests) and
      // `src/tools/code` (~3%, the interpreter).
      thresholds: {
        lines: 79,
        functions: 81,
        branches: 70,
        statements: 77,
      },
    },
  },
});
