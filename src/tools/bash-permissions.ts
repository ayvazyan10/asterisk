// The Bash permission policy — decides whether a command runs unattended,
// needs a human to approve it, or is refused outright.
//
// This is a *consent* boundary, not a sandbox. An approved command runs with
// the full privileges of the user who started Asterisk. What the policy buys
// is that nothing with unreviewed effects runs without someone saying yes.
//
// The rules only ever see the segments `command-parse.ts` extracted, so a
// chained command is judged segment by segment: `git status && rm -rf ~`
// needs approval because `rm` does, even though `git status` is allowlisted.

import { type CommandSegment, parseCommand } from './command-parse.ts';

export type PermissionMode = 'ask' | 'allowlist' | 'unrestricted';

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
}

/**
 * Argument patterns that turn an otherwise read-only command into an
 * arbitrary-execution primitive. Checked against every argument of a command
 * that would otherwise be auto-approved, keyed by binary; `*` applies to all.
 *
 * These exist because "the binary is read-only" is not a property of the
 * binary. `find` deletes with `-delete`, `rg` runs a preprocessor with
 * `--pre`, and `git -c core.pager=… log` runs whatever the pager is.
 */
const FORBIDDEN_ARGS: Record<string, readonly RegExp[]> = {
  '*': [/^--?exec(dir)?$/i, /^-{1,2}eval$/i],
  find: [/^-exec(dir)?$/, /^-ok(dir)?$/, /^-delete$/, /^-fprint/, /^-fls$/],
  rg: [/^--pre(=|$)/, /^--hostname-bin(=|$)/],
  grep: [/^--devices(=|$)/],
  // egrep and fgrep are grep under another name, and the lookup is by the
  // binary as written, so the same guard has to be spelled out for each.
  egrep: [/^--devices(=|$)/],
  fgrep: [/^--devices(=|$)/],
  git: [
    /^-c$/,
    /^--exec-path(=|$)/,
    /^--ext-diff$/,
    /^--(upload|receive)-pack(=|$)/,
    /^-P$/,
    // `git diff --output=FILE` truncates FILE. Every git subcommand on the
    // allowlist is there as a reader; this flag makes any of them a writer.
    /^--output(=|$)/,
    // Both hand git configuration it would not otherwise read, and git config
    // names programs to run — core.pager, core.fsmonitor, diff.external. This
    // is the same hole `-c` is already listed for, reached through a file or
    // an environment variable instead of the command line.
    /^--config-env(=|$)/,
    /^--git-dir(=|$)/,
  ],
  sort: [
    // Runs PROG on every temporary spill, so a sort of a large enough file is
    // arbitrary execution: `sort --compress-program=/bin/sh big.txt`.
    /^--compress-program(=|$)/,
    // `-o FILE` / `--output=FILE` write the sorted result over FILE.
    /^-o$/,
    /^--output(=|$)/,
  ],
  // `tree -o FILE` sends the listing to FILE, overwriting it.
  tree: [/^-o$/, /^--output(=|$)/],
  // `date -s` / `--set` set the system clock. A clock reader is on the list;
  // a clock writer is not.
  date: [/^-s$/, /^--set(=|$)/],
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
 * Notably absent, and not by oversight — `sed` (`-i` writes, GNU `e`
 * executes), `awk` (`system()`), `env`/`xargs`/`timeout`/`nohup` (they run
 * another program), `sh`/`bash`/`eval`/`source` (they re-enter the shell),
 * and `curl`/`wget` (network egress is not read-only).
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
  'git branch --list',
  'git rev-parse',
  'git ls-files',
  'git shortlog',
  'git describe',
  'git remote --verbose',
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
 * Returns `allow` only when every segment is independently allowlisted, no
 * segment carries a forbidden argument, and the command contains nothing the
 * parser could not statically resolve.
 */
export function evaluateCommand(command: string, input: PolicyInput): PermissionDecision {
  const parsed = parseCommand(command);

  if (input.mode === 'unrestricted') {
    return { action: 'allow', reason: 'permissions.mode is unrestricted' };
  }

  // Deny is absolute — it outranks the defaults, the user's allow list and
  // anything previously remembered, and it never reaches a prompt.
  const denied = firstDenied(parsed.segments, input.deny);
  if (denied) {
    return {
      action: 'deny',
      reason: `"${denied.segment.raw}" matches the deny rule "${denied.rule}"`,
    };
  }

  const refuse = (reason: string): PermissionDecision =>
    input.mode === 'allowlist'
      ? { action: 'deny', reason: `${reason} (permissions.mode is allowlist, so nothing is asked)` }
      : { action: 'ask', reason, segments: parsed.segments };

  if (parsed.opaque.length > 0) {
    return refuse(`the command contains ${parsed.opaque.join(', ')}`);
  }

  if (parsed.segments.length === 0) {
    return refuse('the command could not be resolved into anything runnable');
  }

  const allow = [...DEFAULT_ALLOW, ...input.allow];
  for (const segment of parsed.segments) {
    const rule = matchingRule(segment, allow);
    if (!rule) return refuse(`"${segment.raw}" is not on the allowlist`);

    const forbidden = forbiddenArg(segment);
    if (forbidden) {
      return refuse(`"${segment.raw}" uses ${forbidden}, which can run commands or write files`);
    }
  }

  return { action: 'allow', reason: 'every part of the command is allowlisted' };
}

/**
 * The rules a "always allow this" answer would store, one per segment.
 *
 * Granularity is binary plus its first non-flag word, so approving
 * `npm test --run` remembers `npm test` rather than either the exact
 * invocation (useless — the next one differs) or bare `npm` (too broad, it
 * would cover `npm publish`). A command that starts with a flag has no such
 * word and is handled below, where the exact invocation is the right answer
 * rather than the useless one. The prompt shows these back to the user, so
 * what gets remembered is never a surprise — and a segment that cannot be
 * expressed as a rule contributes none, which the prompt renders as a plain
 * "allow always" with nothing listed.
 */
export function suggestRules(segments: readonly CommandSegment[]): string[] {
  return [...new Set(segments.flatMap(suggestRule))];
}

/**
 * A flag-led command has no subcommand to narrow to, and the binary alone is
 * no narrowing at all: `bash -lc "make"` used to be remembered as `bash` — the
 * binary DEFAULT_ALLOW excludes by name because it re-enters the shell — and
 * `node -e "console.log(1)"` as `node`. One keystroke handed over exactly the
 * arbitrary execution the allowlist exists to withhold.
 *
 * Stopping one word later would not fix it: because rules match a prefix of
 * the argument vector, `node -e` still covers every future `-e` payload. What
 * the user approved was the payload, so the payload is what gets remembered —
 * the whole invocation becomes the rule. It stays reusable for the commands
 * people actually repeat (`tsc --noEmit`, `ls -la`, `python3 -m pytest`) and
 * authorises nothing else.
 *
 * A word containing whitespace cannot be written as a rule at all (rules are
 * whitespace-separated), so those get no suggestion rather than one that
 * silently never matches — which is also the right answer for the shell
 * one-liners that reach this branch.
 */
function suggestRule(segment: CommandSegment): string[] {
  const first = segment.args[0];
  if (first === undefined) return [segment.bin];
  if (!first.startsWith('-')) return [`${segment.bin} ${first}`];
  const words = [segment.bin, ...segment.args];
  return words.some((w) => /\s/.test(w)) ? [] : [words.join(' ')];
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
  const words = rule.trim().split(/\s+/).filter(Boolean);
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
    current = { ...current, bin: current.args[0] as string, args: current.args.slice(1) };
    forms.push(current);
  }
  const slash = current.bin.lastIndexOf('/');
  const base = slash === -1 ? current.bin : current.bin.slice(slash + 1);
  if (base !== current.bin && base !== '') forms.push({ ...current, bin: base });
  return forms;
}

/** The first argument that disqualifies this segment, described for a human. */
function forbiddenArg(segment: CommandSegment): string | null {
  const patterns = [...(FORBIDDEN_ARGS['*'] ?? []), ...(FORBIDDEN_ARGS[segment.bin] ?? [])];
  for (const arg of segment.args) {
    for (const pattern of patterns) {
      if (pattern.test(arg)) return `the argument "${arg}"`;
    }
  }
  const operand = writtenOperand(segment);
  return operand === null ? null : `"${operand}" as an output file`;
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
