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
      // Measured now: 64.07 / 64.42 / 56.72 / 65.39, up from 49 / 47 / 41 / 50.
      // `src/repl` went from 7.45% to 77.14% and was most of that gap.
      //
      // The old 60/60/50/60 target is met on statements, functions and lines.
      // Branches at 56.72 is the one still short, and the remaining mass is
      // nameable rather than mysterious: the bot transports (telegram ~25%,
      // whatsapp ~12%) and the command modules.
      thresholds: {
        lines: 64,
        functions: 63,
        branches: 55,
        statements: 63,
      },
    },
  },
});
