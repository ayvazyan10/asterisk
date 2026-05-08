// Self-update entrypoint — invoked by `bin/asterisk update`.
// Fetches the latest from the remote, compares versions, rebuilds if needed.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function step(msg: string): void {
  process.stdout.write(`${CYAN}  →${RESET} ${msg}\n`);
}
function ok(msg: string): void {
  process.stdout.write(`${GREEN}  ✓${RESET} ${msg}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`${YELLOW}  !${RESET} ${msg}\n`);
}
function fail(msg: string): never {
  process.stderr.write(`${RED}  ✗${RESET} ${msg}\n`);
  process.exit(1);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout: 120_000 }).trim();
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const installDir = process.env['ASTERISK_INSTALL_DIR']
    ?? resolve(process.env['HOME'] ?? '~', '.local/share/asterisk');
  const branch = process.env['ASTERISK_BRANCH'] ?? 'master';

  process.stdout.write('\n');
  process.stdout.write(`${BOLD}  ✱  Asterisk — self-update${RESET}\n`);
  process.stdout.write('\n');

  try {
    run('git rev-parse --git-dir', installDir);
  } catch {
    fail(`${installDir} is not a git repository. Run install.sh first.`);
  }

  const currentVersion = readVersion(installDir);
  const localHead = run('git rev-parse HEAD', installDir).slice(0, 10);

  step(`Current: v${currentVersion} (${localHead})`);
  step('Fetching latest...');

  try {
    run(`git fetch --tags origin ${branch}`, installDir);
  } catch {
    fail('git fetch failed — check your network connection.');
  }

  const remoteHead = run(`git rev-parse origin/${branch}`, installDir).slice(0, 10);

  if (localHead === remoteHead) {
    ok(`Already up to date — v${currentVersion} (${localHead})`);
    process.stdout.write('\n');
    process.exit(0);
  }

  const commitCount = run(
    `git rev-list HEAD..origin/${branch} --count`,
    installDir,
  );
  const changelog = run(
    `git log HEAD..origin/${branch} --oneline --no-decorate -20`,
    installDir,
  );

  step(`${commitCount} new commit${commitCount === '1' ? '' : 's'}:`);
  for (const line of changelog.split('\n')) {
    if (line) process.stdout.write(`${DIM}    ${line}${RESET}\n`);
  }

  step('Updating...');
  try {
    run(`git checkout -q ${branch}`, installDir);
    run(`git reset --hard origin/${branch}`, installDir);
  } catch {
    fail('git reset failed.');
  }

  const newVersion = readVersion(installDir);
  ok(`Source updated: v${currentVersion} → v${newVersion} (${remoteHead})`);

  step('Installing dependencies...');
  try {
    run('bun install --silent', installDir);
  } catch {
    fail('bun install failed.');
  }
  ok('Dependencies installed');

  step('Building...');
  try {
    run('bun run build', installDir);
  } catch {
    fail('bun run build failed.');
  }
  ok('Build complete');

  process.stdout.write('\n');
  process.stdout.write(`${BOLD}${GREEN}  Updated to v${newVersion}${RESET}\n`);
  process.stdout.write('\n');
}

main().catch((e) => {
  process.stderr.write(`asterisk update error: ${(e as Error).message}\n`);
  process.exit(1);
});
