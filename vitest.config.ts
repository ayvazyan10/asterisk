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
      // Measured now: 79.47 lines / 81.23 functions / 70.45 branches /
      // 77.67 statements. Branches is the one with almost no slack, and the
      // connector work proved it: four pushes in a row went red on this gate
      // alone, at 69.76%, while typecheck, lint and the suite were all green
      // locally. New code with many small `?? …` and `? … :` arms moves this
      // number faster than it moves the other three — run `bun run
      // test:coverage`, not just `bun run test`, before pushing such a change.
      //
      // The Telegram transport is no longer the hole this
      // comment used to name — the fake Bot API landed and the whole of
      // `src/bots` is now covered: adapter.ts, commands.ts and manager.ts at
      // 100% statements/functions/branches, telegram/format.ts at 100/100/98,
      // telegram/index.ts at 98/96/94. What stays uncovered there is
      // defensive: `?? fallback` arms behind arrays that are never empty, and
      // `stopped` re-checks on timers that were already cleared. Reaching them
      // would mean reaching past the module's surface, so they stay.
      //
      // What is left is nameable: `src/tools/code` (the interpreter, ~66%
      // branches and the largest single block of them) and the entrypoints,
      // which are process wiring nothing calls. `src/web` was listed here as
      // 0%; that was wrong even when written — it has had HTTP-level tests all
      // along, and the render layer joined them.
      thresholds: {
        lines: 79,
        functions: 81,
        branches: 70,
        statements: 77,
      },
    },
  },
});
