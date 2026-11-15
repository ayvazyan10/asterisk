// The Bash permission policy — decides whether a command runs unattended,
// needs a human to approve it, or is refused outright.
//
// This is a *consent* boundary; bash-sandbox.ts separately confines execution.
// In ask mode, effects beyond the read-only allowlist need someone's consent.
//
// The rules only ever see the segments `command-parse.ts` extracted, so a
// chained command is judged segment by segment: `git status && rm -rf ~`
// needs approval because `rm` does, even though `git status` is allowlisted.
//
// Relaxed mode allows ordinary commands when the Bash sandbox has a verified
// backend. Destructive commands, code re-entry, opaque syntax, secret reads,
// forbidden arguments and writes to sensitive or outside paths still ask.
// Without an active sandbox, relaxed uses exactly the ask policy.

import { resolve } from 'node:path';
import { resolveWriteTarget, resolvesInside } from '../utils/fs-safe.ts';
import { expandHome } from '../utils/path.ts';
import { type CommandSegment, parseCommand } from './command-parse.ts';
import { workspaceRoot } from './workspace.ts';
import { isAsteriskHomePath, protectedWriteReason } from './write-policy.ts';

export type PermissionMode = 'ask' | 'relaxed' | 'allowlist' | 'unrestricted';

export type PermissionDecision =
  | { action: 'allow'; reason: string }
  | { action: 'ask'; reason: string; segments: readonly CommandSegment[] }
  | { action: 'deny'; reason: string };

export interface PolicyInput {
  mode: PermissionMode;
  /** Rules from config plus anything the user chose "always allow" on. */
  allow: readonly string[];
  /** Deny wins over every allow, including the built-in defaults. */
  deny: readonly string[];
  /** True only when the configured Bash sandbox has a verified backend. */
  sandboxActive?: boolean;
}

export const ASTERISK_HOME_READ_RULE = 'read:asterisk-home';

/**
 * Options that turn an otherwise read-only command into an execution or
 * write primitive. Checked against every argument of a command
 * that would otherwise be auto-approved, keyed by binary; `*` applies to all.
 *
 * These exist because "the binary is read-only" is not a property of the
 * binary. `find` deletes with `-delete`, `rg` runs a preprocessor with
 * `--pre`, and `git -c core.pager=… log` runs whatever the pager is.
 */
const FORBIDDEN_ARGS: Record<string, readonly string[]> = {
  '*': ['-exec', '--exec', '-execdir', '--execdir', '-eval', '--eval'],
  find: [
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-delete',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-fls',
  ],
  rg: ['--pre', '--hostname-bin'],
  grep: ['--devices'],
  // egrep and fgrep are grep under another name, and the lookup is by the
  // binary as written, so the same guard has to be spelled out for each.
  egrep: ['--devices'],
  fgrep: ['--devices'],
  git: [
    '-c',
    '--exec-path',
    '--ext-diff',
    '--textconv',
    '--upload-pack',
    '--receive-pack',
    '-P',
    // `git diff --output=FILE` truncates FILE. Every git subcommand on the
    // allowlist is there as a reader; this flag makes any of them a writer.
    '--output',
    // Both hand git configuration it would not otherwise read, and git config
    // names programs to run — core.pager, core.fsmonitor, diff.external. This
    // is the same hole `-c` is already listed for, reached through a file or
    // an environment variable instead of the command line.
    '--config-env',
    '--git-dir',
  ],
  sort: [
    // Runs PROG on every temporary spill, so a sort of a large enough file is
    // arbitrary execution: `sort --compress-program=/bin/sh big.txt`.
    '--compress-program',
    // `-o FILE` / `--output=FILE` write the sorted result over FILE.
    '-o',
    '--output',
  ],
  // `tree -o FILE` sends the listing to FILE, overwriting it.
  tree: ['-o', '--output'],
  // `date -s` / `--set` set the system clock. A clock reader is on the list;
  // a clock writer is not.
  date: ['-s', '--set'],
  // `file -C` writes a compiled magic database.
  file: ['-C', '--compile'],
  // Script files cannot be inspected here; inline scripts are checked below.
  sed: ['-i', '--in-place', '-f', '--file'],
  ls: [],
};

/**
 * Binaries whose *positional* arguments include an output file, which no
 * pattern over flags can catch. GNU `uniq [INPUT [OUTPUT]]` writes its second
 * operand, so `uniq notes.txt ~/.bashrc` truncates .bashrc — while the form
 * everyone actually uses (`sort … | uniq -c`, `uniq file`) stays within the
 * limit. The number is how many operands the command only reads.
 */
const MAX_OPERANDS: Record<string, number> = { uniq: 1 };

/**
 * Commands that read state and nothing else, with the arguments that would
 * break that promise excluded above. Deliberately short: everything absent
 * from this list simply prompts once and can be remembered by the user.
 *
 * Notably absent, and not by oversight — `awk` (`system()`), `env`/`xargs` (they run
 * another program), `sh`/`bash`/`eval`/`source` (they re-enter the shell),
 * and `curl`/`wget` (network egress is not read-only). Transparent wrappers
 * such as timeout and nohup are judged by their inner command instead.
 */
const DEFAULT_ALLOW: readonly string[] = [
  'ls',
  'pwd',
  'cd',
  'echo',
  'whoami',
  'id',
  'hostname',
  'uname',
  'date',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'realpath',
  'basename',
  'dirname',
  'diff',
  'sort',
  'uniq',
  'cut',
  'sed',
  'column',
  'jq',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'which',
  'true',
  'false',
  'sleep',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git blame',
  'git rev-parse',
  'git ls-files',
  'git shortlog',
  'git describe',
  'node --version',
  'bun --version',
  'npm --version',
  'python3 --version',
  'tsc --version',
];

/** The built-in read-only set, exposed so `/permissions` and the docs can
 *  show exactly what runs without asking. */
export function defaultAllowRules(): readonly string[] {
  return DEFAULT_ALLOW;
}

/**
 * Evaluates a raw command string against the policy.
 *
 * Every guarded mode retains opaque/secret/argument checks. Relaxed with an active
 * sandbox also permits commands outside the allowlist unless dangerous.
 */
export function evaluateCommand(command: string, input: PolicyInput): PermissionDecision {
  const parsed = parseCommand(command);

  if (input.mode === 'unrestricted') {
    return { action: 'allow', reason: 'permissions.mode is unrestricted' };
  }
  const relaxed = input.mode === 'relaxed' && input.sandboxActive === true;

  const segments = parsed.segments.map((segment) => {
    const inner = unwrapSegment(segment);
    if (inner) return inner;
    parsed.opaque.push(`an unrecognised ${segment.bin} wrapper`);
    return segment;
  });
  const reads = secretReads(segments);

  // Deny is absolute — it outranks the defaults, the user's allow list and
  // anything previously remembered, and it never reaches a prompt.
  const denied = firstDenied([...parsed.segments, ...segments], input.deny);
  if (denied) {
    return {
      action: 'deny',
      reason: `"${denied.segment.raw}" matches the deny rule "${denied.rule}"`,
    };
  }
  if (
    input.deny.includes(ASTERISK_HOME_READ_RULE) &&
    [...reads.values()].some((read) => read.rule === ASTERISK_HOME_READ_RULE)
  ) {
    return {
      action: 'deny',
      reason: `reading the Asterisk home matches "${ASTERISK_HOME_READ_RULE}"`,
    };
  }

  const refuse = (reason: string): PermissionDecision =>
    input.mode === 'allowlist'
      ? { action: 'deny', reason: `${reason} (permissions.mode is allowlist, so nothing is asked)` }
      : { action: 'ask', reason, segments: parsed.segments };

  const opaque = parsed.opaque.filter(
    (reason) => !relaxed || !reason.startsWith('output redirection to '),
  );
  if (opaque.length > 0) {
    return refuse(`the command contains ${opaque.join(', ')}`);
  }

  if (parsed.segments.length === 0) {
    return refuse('the command could not be resolved into anything runnable');
  }

  const allow = [...DEFAULT_ALLOW, ...input.allow];
  let directories = [process.cwd()];
  let networkPipe = false;
  for (const segment of segments) {
    const secret = reads.get(segment);
    if (secret && (!secret.rule || !input.allow.includes(secret.rule))) {
      return refuse(`"${segment.raw}" ${secret.reason}`);
    }

    // Only the inner command decides. An old grant for a wrapper invocation
    // (`timeout 240`) must not cover whatever is wrapped: it would have
    // approved `timeout 240 rm -rf ~` as readily as the test run it was for.
    const rule = matchingRule(segment, allow);
    if (!rule && !relaxed) return refuse(`"${segment.raw}" is not on the allowlist`);

    const forms: CommandSegment[] = [];
    for (const form of relaxed ? denyForms(segment) : [segment]) {
      const inner = relaxed ? unwrapSegment(form) : form;
      if (!inner) return refuse(`an unrecognised ${form.bin} wrapper`);
      forms.push(...(relaxed ? denyForms(inner) : [inner]));
    }
    const forbidden = forms.map(forbiddenArg).find((reason) => reason !== null);
    if (forbidden) {
      return refuse(`"${segment.raw}" uses ${forbidden}, which can run commands or write files`);
    }

    if (relaxed) {
      networkPipe = segment.piped === true && networkPipe;
      for (const form of forms) {
        if (form.bin === 'cd') {
          const path = form.args.find((arg) => !arg.startsWith('-')) ?? '~';
          directories = [
            ...directories,
            ...directories.map((dir) => resolve(dir, expandHome(path))),
          ];
        }
        if (form.bin === 'curl' || form.bin === 'wget') networkPipe = true;
        if (networkPipe && INTERPRETERS.has(form.bin)) {
          return refuse(`"${segment.raw}" runs code received from curl or wget`);
        }
        if (form.bin === 'tee') {
          for (const target of form.args.filter((arg) => !arg.startsWith('-'))) {
            const reason = outputWriteReason(target, directories);
            if (reason) return refuse(`"${segment.raw}" ${reason}`);
          }
        }
        if (!rule) {
          const danger = dangerousCommand(form);
          if (danger) return refuse(`"${segment.raw}" ${danger}`);
        }
      }
      for (const target of segment.outputs ?? []) {
        const reason = outputWriteReason(target, directories);
        if (reason) return refuse(`the output redirection ${reason}`);
      }
    }
  }

  return {
    action: 'allow',
    reason: relaxed
      ? 'the sandbox is active and no part needs approval'
      : 'every part of the command is allowlisted',
  };
}

/** Shared by shell redirects and tee; configured extra roots still need consent. */
function outputWriteReason(target: string, directories: readonly string[]): string | null {
  if (target === '/dev/null') return null;
  for (const directory of directories) {
    const path = resolve(directory, expandHome(target));
    const protectedReason = protectedWriteReason(path);
    if (protectedReason) return `writes "${target}" (${protectedReason})`;
    if (![workspaceRoot(), '/tmp'].some((root) => resolvesInside(root, path))) {
      return `writes "${target}" outside the workspace and /tmp`;
    }
  }
  return null;
}

/** Commands that need consent in relaxed mode unless explicitly allowlisted. */
function dangerousCommand({ bin, args }: CommandSegment): string | null {
  const dangerous: Record<string, string> = {
    rmdir: 'removes directories',
    shred: 'destroys file contents',
    truncate: 'discards file contents',
    sudo: 'runs with elevated privileges',
    su: 'changes user privileges',
    doas: 'runs with elevated privileges',
    pkexec: 'runs with elevated privileges',
    chroot: 'changes the process root',
    chmod: 'changes file permissions',
    chown: 'changes file ownership',
    chgrp: 'changes file ownership',
    setfacl: 'changes file permissions',
    chattr: 'changes file attributes',
    dd: 'overwrites files or devices',
    fdisk: 'changes disk partitions',
    sfdisk: 'changes disk partitions',
    parted: 'changes disk partitions',
    wipefs: 'erases filesystem signatures',
    mount: 'changes mounted filesystems',
    umount: 'changes mounted filesystems',
    swapon: 'changes system swap',
    swapoff: 'changes system swap',
    shutdown: 'shuts down the system',
    reboot: 'restarts the system',
    poweroff: 'shuts down the system',
    halt: 'halts the system',
    init: 'changes system state',
    telinit: 'changes system state',
    kill: 'signals processes',
    pkill: 'signals processes',
    killall: 'signals processes',
    service: 'changes system services',
    crontab: 'changes scheduled commands',
    at: 'schedules commands',
    apt: 'changes installed packages',
    'apt-get': 'changes installed packages',
    dpkg: 'changes installed packages',
    snap: 'changes installed packages',
    flatpak: 'changes installed packages',
    npx: 'downloads and executes packages',
    bunx: 'downloads and executes packages',
    docker: 'controls containers and host resources',
    podman: 'controls containers and host resources',
    ssh: 'runs commands on a remote host',
    scp: 'copies files to or from a remote host',
    sftp: 'transfers files to or from a remote host',
    rsync: 'synchronises files locally or remotely',
    nc: 'opens a network connection',
    ncat: 'opens a network connection',
    netcat: 'opens a network connection',
    socat: 'opens a network connection',
    telnet: 'opens a remote connection',
    ftp: 'transfers files over the network',
    eval: 'executes shell code',
    source: 'executes a shell file',
    '.': 'executes a shell file',
  };
  const reason = dangerous[bin];
  if (reason) return reason;
  if (bin.startsWith('mkfs')) return 'creates a filesystem';

  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  let subcommandIndex = 0;
  while (args[subcommandIndex]?.startsWith('-')) {
    const option = args[subcommandIndex] as string;
    subcommandIndex += [
      '-C',
      '--work-tree',
      '--namespace',
      '--cwd',
      '--prefix',
      '--dir',
      '--directory',
      '--host',
      '-H',
      '--machine',
      '-M',
    ].includes(option)
      ? 2
      : 1;
    if (option === '--') break;
  }
  const subcommand = args[subcommandIndex];
  if (
    bin === 'rm' &&
    options.some((arg) => /^-[^-]*[rRf]|^--(?:recursive|force)(?:=|$)/.test(arg))
  ) {
    return 'deletes recursively or forcibly';
  }
  if (
    bin === 'systemctl' &&
    !['status', 'show', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'cat'].includes(
      subcommand ?? '',
    )
  ) {
    return 'changes system services';
  }
  if (bin === 'kubectl' && !['get', 'describe', 'logs'].includes(subcommand ?? '')) {
    return 'changes cluster resources';
  }
  if (['bash', 'sh', 'zsh'].includes(bin) && options.some((arg) => /^-[^-]*c/.test(arg))) {
    return 'executes inline shell code';
  }
  if (bin === 'git') {
    const [sub, ...rest] = args.slice(subcommandIndex);
    if (sub === 'push') return 'changes a remote';
    if (['clean', 'rebase', 'filter-branch', 'filter-repo', 'restore'].includes(sub ?? '')) {
      return 'discards files or rewrites Git history';
    }
    if (sub === 'reset' && rest.includes('--hard')) return 'discards tracked changes';
    if (sub === 'branch' && rest.some((arg) => /^-[^-]*[dD]|^--delete(?:=|$)/.test(arg))) {
      return 'deletes Git branches';
    }
    if (sub === 'tag' && rest.some((arg) => /^-[^-]*d|^--delete(?:=|$)/.test(arg))) {
      return 'deletes Git tags';
    }
    if (sub === 'checkout' && rest.some((arg) => arg === '--' || arg === '.')) {
      return 'discards working tree changes';
    }
    if (sub === 'stash' && rest.some((arg) => arg === 'drop' || arg === 'clear')) {
      return 'discards stashed changes';
    }
    if (sub === 'remote' && rest.some((arg) => ['add', 'remove', 'rm', 'set-url'].includes(arg))) {
      return 'changes Git remotes';
    }
    if (sub === 'config') {
      const reads = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
      const read =
        rest.some((arg) => reads.includes(arg)) || ['get', 'list'].includes(rest[0] ?? '');
      const write =
        rest.some((arg) =>
          /^--(?:add|replace-all|unset|unset-all|rename-section|remove-section|edit)$|^-e$/.test(
            arg,
          ),
        ) ||
        ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(rest[0] ?? '') ||
        rest.filter((arg) => !arg.startsWith('-')).length > 1;
      if (!read && write) return 'writes Git configuration';
    }
    if (sub === 'commit' && rest.includes('--amend')) return 'rewrites the previous commit';
  }
  if (
    (bin === 'brew' && ['install', 'uninstall', 'remove', 'upgrade'].includes(subcommand ?? '')) ||
    (['pip', 'pip3', 'uv', 'pipx'].includes(bin) &&
      args.some((arg) => ['install', 'uninstall'].includes(arg))) ||
    (['npm', 'pnpm', 'yarn', 'bun'].includes(bin) &&
      ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'publish', 'link', 'unlink'].includes(
        subcommand ?? '',
      )) ||
    (['cargo', 'go', 'gem'].includes(bin) && subcommand === 'install')
  ) {
    return 'installs, removes or publishes packages';
  }
  if (bin === 'curl') {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      if (arg === '--') break;
      if (/^--(?:data[^=]*|form|form-string|upload-file|json)(?:=|$)/.test(arg)) {
        return 'sends data over the network';
      }
      if (arg === '--request' || arg.startsWith('--request=')) {
        const method = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
        if (!['GET', 'HEAD'].includes((method ?? '').toUpperCase())) {
          return 'sends a network request that can change remote state';
        }
      }
      if (!arg.startsWith('-') || arg.startsWith('--')) continue;
      for (let j = 1; j < arg.length; j += 1) {
        const flag = arg[j] as string;
        if ('dFT'.includes(flag)) return 'sends data over the network';
        if (flag === 'X') {
          const method = arg.slice(j + 1) || args[++i] || '';
          if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
            return 'sends a network request that can change remote state';
          }
          break;
        }
        // These short options consume the rest of their word or the next one;
        // an X/d/F/T inside a header or output filename is not another flag.
        if ('oHAuxbcewmryYzKDEPtUQ'.includes(flag)) {
          if (j === arg.length - 1) i += 1;
          break;
        }
      }
    }
  }
  if (bin === 'wget' && args.some((arg) => /^--(?:post-data|post-file|method)(?:=|$)/.test(arg))) {
    return 'sends data over the network';
  }
  return null;
}

/** Binary grants never cover secrets. Home reads have their own grant;
 *  environment dumps still require fresh consent. */
function secretReads(
  segments: readonly CommandSegment[],
): Map<CommandSegment, { reason: string; rule: string | null }> {
  const reads = new Map<CommandSegment, { reason: string; rule: string | null }>();
  let directories = [process.cwd()];
  for (const segment of segments) {
    // cd itself reads no file. Keep possible earlier directories too: a cd
    // can fail or run in a pipeline, so later relative reads may use either.
    if (segment.bin === 'cd') {
      const path = segment.args.find((arg) => !arg.startsWith('-')) ?? '~';
      directories = [
        ...new Set([...directories, ...directories.map((dir) => resolve(dir, expandHome(path)))]),
      ];
      continue;
    }
    let reason: string | null = null;
    let homeRead = false;
    for (const form of denyForms(segment)) {
      if (
        form.bin === 'env' ||
        form.bin === 'printenv' ||
        form.bin === 'set' ||
        (form.bin === 'jq' && form.args.some((arg) => /\benv\b|\$ENV\b/.test(arg))) ||
        (form.bin === 'export' && form.args.some((arg) => /^-[^-]*p/.test(arg))) ||
        (form.bin === 'declare' && form.args.some((arg) => /^-[^-]*x/.test(arg)))
      ) {
        reason = 'can dump environment variables';
      }
    }
    for (const arg of segment.args) {
      // Include option values such as grep --file=PATH and jq --from-file=PATH.
      const rawValue =
        arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      // Simple quoted variables are safe syntax, but may still name secrets.
      const value = rawValue.replace(
        /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
        (_match, braced: string | undefined, bare: string | undefined) =>
          process.env[braced ?? bare ?? ''] ?? '',
      );
      for (const directory of directories) {
        const path = resolve(directory, expandHome(value));
        if (isAsteriskHomePath(path)) homeRead = true;
        if ([path, resolveWriteTarget(path)].some((p) => /^\/proc\/[^/]+\/environ$/.test(p))) {
          reason = 'reads a process environment';
        }
      }
    }
    if (reason) reads.set(segment, { reason, rule: null });
    else if (homeRead) {
      reads.set(segment, {
        reason: 'reads the Asterisk home, which can contain secrets',
        rule: ASTERISK_HOME_READ_RULE,
      });
    }
  }
  return reads;
}

/**
 * The rules an "always allow this" answer would store for parts still needing
 * approval. Ordinary programs are remembered by binary, so changing a flag or
 * filename does not prompt again. Subcommand tools keep `npm test` rather than
 * bare `npm`, which would also cover `npm publish`. The prompt shows exactly
 * what gets remembered; defaults and existing grants contribute no noise.
 *
 * Interpreters keep their first argument even when it is a flag (`node --test`,
 * `python3 -m`). Inline code and command re-entry need the payload pinned below.
 */
export function suggestRules(
  segments: readonly CommandSegment[],
  granted: readonly string[] = [],
): string[] {
  const inner = segments.map(unwrapSegment);
  const reads = secretReads(inner.filter((segment) => segment !== null));
  const allow = [...DEFAULT_ALLOW, ...granted];
  const rules: string[] = [];
  for (const [index, segment] of inner.entries()) {
    if (!segment) continue;
    if (!matchingRule(segment, allow)) {
      rules.push(...suggestRule(segment));
    }
    const readRule = reads.get(segment)?.rule;
    if (readRule && !granted.includes(readRule)) rules.push(readRule);
  }
  return [...new Set(rules)];
}

const SUBCOMMAND_TOOLS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'docker',
  'kubectl',
  'systemctl',
  'gh',
  'go',
  'pip',
  'apt',
]);

const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'node',
  'deno',
  'bun',
  'python',
  'python3',
  'perl',
  'ruby',
  'php',
  'lua',
  'Rscript',
  'osascript',
  'pwsh',
  'eval',
  'exec',
  'xargs',
  'env',
  'sudo',
  'su',
  'ssh',
]);

const COMMAND_REENTRY = new Set(['sudo', 'su', 'ssh', 'env', 'xargs', 'eval']);

/**
 * For inline code, the binary alone is no narrowing at all:
 * `bash -lc "make"` used to be remembered as `bash` — the
 * binary DEFAULT_ALLOW excludes by name because it re-enters the shell — and
 * `node -e "console.log(1)"` as `node`. One keystroke handed over exactly the
 * arbitrary execution the allowlist exists to withhold.
 *
 * Stopping one word later would not fix it: because rules match a prefix of
 * the argument vector, `node -e` still covers every future `-e` payload. What
 * the user approved was the payload, so the payload is what gets remembered —
 * the whole invocation becomes the rule. Re-entry through sudo, ssh, env or
 * xargs has the same problem, regardless of its first argument.
 *
 * A word containing whitespace cannot be written as a rule at all (rules are
 * whitespace-separated), so those get no suggestion rather than one that
 * silently never matches — which is also the right answer for the shell
 * one-liners that reach this branch.
 */
function suggestRule(segment: CommandSegment): string[] {
  const bin = segment.bin.slice(segment.bin.lastIndexOf('/') + 1);
  const first = segment.args[0];
  const words = [segment.bin];
  if (INTERPRETERS.has(bin)) {
    const inline = segment.args.some(
      (arg) =>
        /^-[ecpE]|^--(?:eval|print)(?:=|$)|^-[A-Za-z]*c$/.test(arg) ||
        ((bin === 'perl' || bin === 'ruby') && /^-[^-]*[eEp]/.test(arg)) ||
        (bin === 'perl' && /^-[^-]*i/.test(arg)) ||
        (bin === 'php' && /^-r/.test(arg)) ||
        (bin === 'pwsh' && /^-(?:command|encodedcommand|c|ec)$/i.test(arg)) ||
        (bin === 'deno' && arg === 'eval'),
    );
    if (inline || COMMAND_REENTRY.has(bin)) words.push(...segment.args);
    else if (first !== undefined) words.push(first);
    else return [];
  } else if (SUBCOMMAND_TOOLS.has(bin) && first !== undefined && !first.startsWith('-')) {
    words.push(first);
  }
  return words.some((w) => /\s/.test(w)) ? [] : [words.join(' ')];
}

const TRANSPARENT_WRAPPERS = new Set(['timeout', 'nice', 'nohup', 'time', 'stdbuf']);

/** Only unwrap option forms we understand; an unknown wrapper must still ask. */
function unwrapSegment(segment: CommandSegment): CommandSegment | null {
  let inner = segment;
  while (TRANSPARENT_WRAPPERS.has(inner.bin)) {
    const { bin, args } = inner;
    let i = 0;
    while (i < args.length && args[i]?.startsWith('-')) {
      const arg = args[i] as string;
      i += 1;
      if (arg === '--') break;
      if (bin === 'timeout') {
        if (['--foreground', '--preserve-status', '--verbose', '-v'].includes(arg)) continue;
        if (['--signal', '--kill-after', '-s', '-k'].includes(arg)) {
          if (!args[i] || args[i]?.startsWith('-')) return null;
          i += 1;
          continue;
        }
        if (/^--(?:signal|kill-after)=.+$|^-[sk].+$/.test(arg)) continue;
      } else if (bin === 'nice') {
        if (arg === '-n' || arg === '--adjustment') {
          if (!/^[+-]?\d+$/.test(args[i] ?? '')) return null;
          i += 1;
          continue;
        }
        if (/^(?:-n|--adjustment=)[+-]?\d+$|^-\d+$/.test(arg)) continue;
      } else if (bin === 'time') {
        if (arg === '-p') continue;
      } else if (bin === 'stdbuf') {
        if (/^-[ioe]$|^--(?:input|output|error)$/.test(arg)) {
          if (!args[i] || args[i]?.startsWith('-')) return null;
          i += 1;
          continue;
        }
        if (/^-[ioe].+$|^--(?:input|output|error)=.+$/.test(arg)) continue;
      }
      return null;
    }
    if (bin === 'timeout') {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(args[i] ?? '')) return null;
      i += 1;
    }
    if (bin === 'stdbuf' && i === 0) return null;
    const command = args[i];
    if (!command || command.startsWith('-')) return null;
    inner = { ...inner, bin: command, args: args.slice(i + 1), raw: segment.raw };
  }
  return inner;
}

/**
 * Rule syntax: whitespace-separated words matched positionally against
 * `[bin, ...args]`. `*` matches exactly one word. A rule matches when all of
 * its words match, so `git log` covers `git log --oneline` but not
 * `git push`, and `ls` covers `ls -la`.
 *
 * Matching on `bin` is exact and path-sensitive on purpose: a rule for `git`
 * must not hand approval to `./git`, which is a file the agent can create.
 */
export function ruleMatches(rule: string, segment: CommandSegment): boolean {
  // These grants share the table, not the shell matcher. A local executable
  // named `mcp:server/tool` must not inherit an MCP grant.
  const trimmed = rule.trim();
  if (trimmed.startsWith('mcp:') || trimmed.startsWith('network:') || trimmed.startsWith('read:'))
    return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const argv = [segment.bin, ...segment.args];
  if (words.length > argv.length) return false;
  return words.every((w, i) => w === '*' || w === argv[i]);
}

function matchingRule(segment: CommandSegment, rules: readonly string[]): string | null {
  for (const rule of rules) {
    if (ruleMatches(rule, segment)) return rule;
  }
  return null;
}

function firstDenied(
  segments: readonly CommandSegment[],
  rules: readonly string[],
): { segment: CommandSegment; rule: string } | null {
  for (const segment of segments) {
    for (const form of denyForms(segment)) {
      const rule = matchingRule(form, rules);
      if (rule) return { segment, rule };
    }
  }
  return null;
}

/** Words that run the command named after them rather than a command of their
 *  own, so a deny rule has to see through them. */
const COMMAND_WRAPPERS = new Set(['command', 'builtin', 'exec']);

/**
 * The spellings of a segment a deny rule also has to catch. Allow stays exact
 * — a rule for `git` must never be claimed by `./git`, a file the agent can
 * create — but deny inherits the opposite requirement: a ban the user wrote as
 * `curl` has to hold for `/usr/bin/curl` and `command curl`, or "deny is
 * absolute" is one `which` away from meaningless. Widening here can only ever
 * refuse more, so it cannot open anything the exact form was closing.
 */
function denyForms(segment: CommandSegment): CommandSegment[] {
  const forms = [segment];
  let current = segment;
  while (COMMAND_WRAPPERS.has(current.bin) && current.args.length > 0) {
    let i = 0;
    while (['--', '-p', '-c', '-l'].includes(current.args[i] ?? '')) i += 1;
    if (current.bin === 'exec' && current.args[i] === '-a') i += 2;
    const bin = current.args[i];
    if (!bin || bin.startsWith('-')) break;
    current = { ...current, bin, args: current.args.slice(i + 1) };
    forms.push(current);
  }
  const slash = current.bin.lastIndexOf('/');
  const base = slash === -1 ? current.bin : current.bin.slice(slash + 1);
  if (base !== current.bin && base !== '') forms.push({ ...current, bin: base });
  return forms;
}

/** The first argument that disqualifies this segment, described for a human. */
function forbiddenArg(segment: CommandSegment): string | null {
  const options = [...(FORBIDDEN_ARGS['*'] ?? []), ...(FORBIDDEN_ARGS[segment.bin] ?? [])];
  for (const arg of segment.args) {
    const flag = arg.split('=')[0] as string;
    for (const option of options) {
      // Long options may be abbreviated, with an attached or detached value.
      // Short options may carry a value (-oFILE) or appear in a cluster (-uo).
      if (
        arg === option ||
        (flag.startsWith('--') && flag.length > 2 && option.startsWith(flag)) ||
        (option.length === 2 &&
          arg.startsWith('-') &&
          !arg.startsWith('--') &&
          arg.slice(1).includes(option[1] as string))
      ) {
        return `the argument "${arg}"`;
      }
    }
  }
  if (segment.bin === 'sed') {
    let hasScript = false;
    for (let i = 0; i < segment.args.length; i += 1) {
      const arg = segment.args[i] as string;
      let script: string | undefined;
      if (arg === '-e' || arg === '--expression') script = segment.args[++i];
      else if (arg.startsWith('--expression=')) script = arg.slice('--expression='.length);
      else if (/^-[^-]*e/.test(arg)) script = arg.slice(arg.indexOf('e') + 1) || segment.args[++i];
      else if (!arg.startsWith('-') && !hasScript) script = arg;
      if (script === undefined) continue;
      hasScript = true;
      if (/(^|[;\n{}])\s*[wWe]\b|s(.).*\2.*\2[gpiImM0-9]*[ew]/.test(script)) {
        return `the sed script "${script}"`;
      }
    }
  }
  const operand = writtenOperand(segment);
  if (operand === null) return null;
  const protectedReason = protectedWriteReason(expandHome(operand));
  return `"${operand}" as an output file${protectedReason ? ` (${protectedReason})` : ''}`;
}

/** The operand past this binary's read-only limit, if it has one. */
function writtenOperand(segment: CommandSegment): string | null {
  const limit = MAX_OPERANDS[segment.bin];
  if (limit === undefined) return null;
  // A bare `-` is stdin, an operand rather than a flag: `uniq - out` writes
  // `out` exactly as `uniq in out` does.
  const operands = segment.args.filter((a) => a === '-' || !a.startsWith('-'));
  return operands[limit] ?? null;
}
