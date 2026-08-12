// `asterisk acp` — serve the Agent Client Protocol on stdio.
//
// Transport only. Everything about the protocol lives in acp/server.ts, which
// is why this file has no tests of its own: what is worth testing is the
// protocol, and that is driven directly in tests/acp.test.ts without a process.
//
// stdout carries protocol frames and nothing else. Anything Asterisk would
// normally print — banners, warnings, a stray console.log — would be read by
// the editor as a malformed frame, so diagnostics go to stderr.

import { createAcpServer } from '../acp/server.ts';
import { loadConfig } from '../config/load.ts';
import { createProviderFromConfig } from '../providers/factory.ts';

function main(): void {
  const server = createAcpServer({
    send: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    createProvider: () => createProviderFromConfig(loadConfig()),
  });

  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    // Frames are newline-delimited, and a chunk boundary can land anywhere —
    // including mid-frame — so the tail is kept until its newline arrives.
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;

      try {
        void server.handle(JSON.parse(line));
      } catch (e) {
        // A frame that is not JSON cannot be answered — there is no id to
        // answer to — so it is reported and dropped rather than killing the
        // connection.
        process.stderr.write(`acp: dropped unparsable frame: ${(e as Error).message}\n`);
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

main();
