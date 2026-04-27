// Daemon entrypoint — long-running process body.
// Phase 4 will load bot adapters here. For now it just heartbeats so we can
// exercise lifecycle and log-tailing.

import { createDaemonLogger } from '../daemon/logger.ts';
import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';

const paths = asteriskPaths();
ensurePaths(paths);
const log = createDaemonLogger(paths.daemonLog);

log.info({ pid: process.pid }, 'asterisk daemon starting');

const HEARTBEAT_MS = Number(process.env['ASTERISK_HEARTBEAT_MS'] ?? 60_000);
const interval = setInterval(() => log.info('heartbeat'), HEARTBEAT_MS);
interval.unref();
// Keep the process alive even if interval is unrefd (no other handles yet).
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown(signal: string): void {
  log.info({ signal }, 'shutdown');
  clearInterval(interval);
  clearInterval(keepAlive);
  // Give pino a moment to flush.
  setTimeout(() => process.exit(0), 50);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error({ err: e }, 'uncaught'));
process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandled rejection'));
