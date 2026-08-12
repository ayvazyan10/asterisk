// Eval entrypoint — invoked by bin/asterisk for `asterisk eval`.
//
// A separate process rather than a slash command, for three reasons. CI needs a
// process exit code, and a REPL command cannot produce one. The runner
// re-points the Write/Edit workspace guard at a temp fixture, and doing that
// inside a live REPL session would silently move the user's own workspace
// boundary mid-conversation. And it is a flag-shaped tool (--live, --filter,
// --json), which fights the REPL's visual-form convention head-on.
//
// The body lives in src/eval/cli.ts so it can be tested without a module-level
// main() firing on import.

import { runEvalCli } from '../eval/cli.ts';

runEvalCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `asterisk eval error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
