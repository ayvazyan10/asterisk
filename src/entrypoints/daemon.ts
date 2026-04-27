// Daemon entrypoint — Phase 2 lands real lifecycle here. For now the body just
// logs a heartbeat so the build target exists and the bin dispatcher has
// something to bundle.

const HEARTBEAT_MS = 60_000;

function log(line: string) {
  // Pino integration is added in Phase 2; plain stderr is fine for a stub.
  process.stderr.write(`[asterisk-daemon ${new Date().toISOString()}] ${line}\n`);
}

log('starting (stub — Phase 2 wires real lifecycle)');

const interval = setInterval(() => log('heartbeat'), HEARTBEAT_MS);

function shutdown(signal: string) {
  log(`received ${signal}, exiting`);
  clearInterval(interval);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
