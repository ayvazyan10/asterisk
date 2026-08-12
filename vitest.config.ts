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
      // Measured now: 73.18 / 76.11 / 66.15 / 74.34, up from 49 / 47 / 41 / 50
      // at the start of the day. `src/repl` went 7.45% → 77%, `src/commands`
      // 18% → 97%, and the old 60/60/50/60 target is now clear on all four.
      //
      // What is left is nameable rather than mysterious: the Telegram
      // transport (~32%), which needs a fake Bot API to test properly.
      thresholds: {
        lines: 73,
        functions: 75,
        branches: 65,
        statements: 72,
      },
    },
  },
});
