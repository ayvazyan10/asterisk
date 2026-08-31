// Run entrypoint — invoked by bin/asterisk for `asterisk run`.
//
// One non-interactive agent turn against a prompt, then exit — the shape a
// script or another program needs to spawn Asterisk as a worker, which the
// REPL, the daemon, ACP and MCP don't offer: all four either stay resident or
// expect a protocol handshake before doing anything.
//
// The body lives in src/run/cli.ts so it can be tested without a module-level
// main() firing on import, same split as src/entrypoints/eval.ts.

import { EXIT_CODES, runRunCli } from '../run/cli.ts';

runRunCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `asterisk run: unexpected error — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(EXIT_CODES.UNKNOWN_ERROR);
  });
