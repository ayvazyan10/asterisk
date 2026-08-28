// The Bash permission boundary.
//
// The bulk of this file is adversarial: a list of commands that must never be
// auto-approved. That list is the actual specification. A permission model is
// only worth having if the obvious ways around it are closed, and every entry
// in `BYPASS_ATTEMPTS` is a way around a naive prefix allowlist — the design
// this replaced. Two of them (`rm -r -f /` and `sh -c '…'`) also walk straight
// through the 14-regex denylist in bash-safety.ts, which is why that denylist
// is documented as defence in depth rather than as the boundary.

import { afterEach, describe, expect, it } from 'vitest';

import { openDriver } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrations.ts';
import {
  grantRules,
  grantedAllowRules,
  listGrantedRules,
  revokeAllRules,
  revokeRule,
} from '../src/db/permissions.ts';
import {
  _resetApprovalsForTesting,
  onApprovalRequest,
  requestApproval,
  resolveApproval,
} from '../src/tools/approval.ts';
import {
  type PolicyInput,
  evaluateCommand,
  ruleMatches,
  suggestRules,
} from '../src/tools/bash-permissions.ts';
import { parseCommand } from '../src/tools/command-parse.ts';

const ASK: PolicyInput = { mode: 'ask', allow: [], deny: [] };

function decide(command: string, over: Partial<PolicyInput> = {}) {
  return evaluateCommand(command, { ...ASK, ...over });
}

describe('command parser', () => {
  it('splits on every separator bash treats as one', () => {
    for (const sep of [';', '&&', '||', '|', '&', '\n']) {
      const parsed = parseCommand(`ls ${sep} pwd`);
      expect(parsed.segments.map((s) => s.bin)).toEqual(['ls', 'pwd']);
    }
  });

  it('keeps quoted words whole and strips the quotes', () => {
    const parsed = parseCommand('grep -n "foo bar" src/');
    expect(parsed.segments[0]?.args).toEqual(['-n', 'foo bar', 'src/']);
    expect(parsed.opaque).toEqual([]);
  });

  it('treats $ inside single quotes as literal but expanded in double quotes', () => {
    expect(parseCommand("echo 'literal $VAR'").opaque).toEqual([]);
    expect(parseCommand('echo "expanded $VAR"').opaque).toContain('variable expansion');
  });

  it('strips leading environment assignments but records them as opaque', () => {
    // Contract change. The prefix used to be dropped silently, which judged
    // `GIT_EXTERNAL_DIFF=./x git diff` and `LD_PRELOAD=./x.so ls` as the bare
    // allowlisted binary and auto-approved them — the assignment is exactly
    // what those commands do. The words are still stripped so the prompt shows
    // the command that runs, but the segment is no longer statically
    // resolvable, so it can never be auto-approved.
    const parsed = parseCommand('FOO=1 BAR=2 npm test');
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.bin).toBe('npm');
    expect(parsed.segments[0]?.args).toEqual(['test']);
    expect(parsed.opaque).toContain('environment assignment');
  });

  it('does not decode ANSI-C quoting, so it refuses to read it', () => {
    // `bash -c "printf '%s\n' $'-\x65xec'"` prints `-exec`. The tokenizer
    // copies the run verbatim instead, so `-\x65xec` reached FORBIDDEN_ARGS
    // undecoded and its /^-exec(dir)?$/ never fired.
    const parsed = parseCommand("find . $'-\\x65xec' touch /tmp/marker \\;");
    expect(parsed.opaque).toContain('ANSI-C quoted string');
    expect(parsed.segments[0]?.args).not.toContain('-\\x65xec');
  });

  it('accepts harmless redirections and flags real ones', () => {
    expect(parseCommand('npm test 2>&1').opaque).toEqual([]);
    expect(parseCommand('npm test > /dev/null').opaque).toEqual([]);
    expect(parseCommand('cat x > /etc/passwd').opaque).toContain(
      'output redirection to /etc/passwd',
    );
  });

  it.each([
    ['$(id)', 'command substitution'],
    ['`id`', 'backtick command substitution'],
    ['cat <<EOF\nhi\nEOF', 'here-document'],
    ['cat <<<"hi"', 'here-string'],
    ['(cd /tmp && ls)', 'subshell grouping'],
    ['echo $((1+1))', 'arithmetic expansion'],
    ['echo ${HOME}', 'variable expansion'],
    ["echo $'\\x41'", 'ANSI-C quoted string'],
    ['echo $"hi"', 'locale-translated string'],
    ['FOO=1 ls', 'environment assignment'],
  ])('marks %s opaque', (command, reason) => {
    expect(parseCommand(command).opaque).toContain(reason);
  });
});

describe('policy — commands that run without asking', () => {
  it.each([
    'ls -la',
    'pwd',
    'cat package.json',
    'git status',
    'git status --short',
    'git log --oneline -20',
    'git diff HEAD~1',
    'rg -n "TODO" src/',
    'find . -name "*.ts"',
    'wc -l README.md',
    'ls && pwd',
    'git status; ls',
    'cat README.md | grep -n TODO | head -20',
  ])('allows %s', (command) => {
    expect(decide(command).action).toBe('allow');
  });

  it('asks when one stage of an otherwise read-only pipeline is not allowlisted', () => {
    // `head` is allowlisted, `npm` is not, and a pipeline is only as
    // auto-approvable as its least approvable stage.
    expect(decide('npm test 2>&1 | head -50').action).toBe('ask');
  });
});

/**
 * Every one of these defeats a prefix-matching allowlist. None may reach
 * `allow` without a human in the loop.
 */
const BYPASS_ATTEMPTS: ReadonlyArray<[label: string, command: string]> = [
  ['chained with ;', 'git status; rm -rf ~'],
  ['chained with &&', 'git status && rm -rf /'],
  ['chained with newline', 'ls\nrm -rf ~'],
  ['chained with |', 'git status | tee /etc/passwd'],
  ['backgrounded', 'ls & rm -rf ~'],
  ['command substitution', '$(echo rm) -rf /'],
  ['backticks', 'ls `rm -rf ~`'],
  ['piped into a shell', 'echo cm0gLXJmIC8= | base64 -d | sh'],
  ['explicit shell', 'sh -c "rm -rf /"'],
  ['explicit bash', 'bash -c "rm -rf /"'],
  ['eval', 'eval "rm -rf /"'],
  ['spaced rm flags', 'rm -r -f /'],
  ['path-disguised binary', './git status'],
  ['absolute-path binary', '/usr/bin/git status'],
  ['find -delete', 'find . -delete'],
  ['find -exec', 'find . -name "*.ts" -exec rm {} ;'],
  ['ripgrep preprocessor', 'rg --pre sh pattern'],
  ['git pager injection', 'git -c core.pager="sh -c id" log'],
  ['redirect over a real file', 'cat x > /etc/passwd'],
  ['env wrapper', 'env rm -rf /'],
  ['xargs wrapper', 'ls | xargs rm'],
  ['substituted assignment', 'FOO=$(id) ls'],
  // ANSI-C quoting hides a forbidden argument from the pattern that bans it:
  // bash expands $'-\x65xec' to -exec, the tokenizer does not.
  ['ANSI-C quoted forbidden argument', "find . $'-\\x65xec' touch /tmp/marker \\;"],
  // An environment prefix is what these commands do, not decoration around
  // them: each one runs or loads something of the caller's choosing.
  ['env-prefixed external diff', 'GIT_EXTERNAL_DIFF=./payload.sh git diff'],
  ['env-prefixed git config', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager git diff'],
  ['env-prefixed LD_PRELOAD', 'LD_PRELOAD=./payload.so ls'],
  ['env-prefixed PATH', 'PATH=/tmp/bin ls'],
  ['env-prefixed BASH_ENV', 'BASH_ENV=./payload.sh ls'],
  // Exec and write primitives on binaries the list calls read-only.
  ['sort spilling through a program', 'sort --compress-program=/bin/sh payload.txt'],
  ['git diff writing a file', 'git diff --output=/home/administrator/.bashrc'],
  ['tree writing a file', 'tree -o /home/administrator/.bashrc'],
  ['uniq writing its second operand', 'uniq notes.txt /home/administrator/.bashrc'],
  ['git reading a chosen config file', 'git --git-dir=/tmp/evil.git status'],
  ['git reading config from the environment', 'git --config-env=core.pager=EVIL log'],
  ['date setting the clock', 'date -s "2000-01-01"'],
  ['egrep reading devices', 'egrep --devices=read x /dev/zero'],
];

describe('policy — bypass attempts', () => {
  it.each(BYPASS_ATTEMPTS)('never silently allows: %s', (_label, command) => {
    expect(decide(command).action).not.toBe('allow');
  });

  it.each(BYPASS_ATTEMPTS)('refuses outright in allowlist mode: %s', (_label, command) => {
    expect(decide(command, { mode: 'allowlist' }).action).toBe('deny');
  });

  it('still allows the safe prefix on its own', () => {
    // Proving the refusals above come from the dangerous half, not from the
    // policy being uselessly strict about `git status`.
    expect(decide('git status').action).toBe('allow');
  });
});

describe('policy — arguments that break a read-only promise', () => {
  // Every binary on DEFAULT_ALLOW is there because it reads and nothing else.
  // These are the flags that make that untrue: one runs a program, the rest
  // write a file the caller names or take configuration from a file the caller
  // controls. Each pair is the dangerous form and the ordinary form, so the
  // guard is shown to be about the argument and not about the binary.
  it.each([
    ['sort --compress-program=/bin/sh big.txt', 'sort big.txt'],
    ['sort -o /home/administrator/.bashrc big.txt', 'sort big.txt'],
    ['sort --output=/home/administrator/.bashrc big.txt', 'sort big.txt'],
    ['git diff --output=/home/administrator/.bashrc', 'git diff'],
    ['tree -o /home/administrator/.bashrc', 'tree'],
    ['tree --output=/home/administrator/.bashrc', 'tree'],
    ['date -s "2000-01-01"', 'date'],
    ['date --set="2000-01-01"', 'date'],
    ['egrep --devices=read x /dev/zero', 'egrep x file.txt'],
    ['fgrep --devices=read x /dev/zero', 'fgrep x file.txt'],
    ['uniq notes.txt /home/administrator/.bashrc', 'uniq notes.txt'],
    ['uniq - /home/administrator/.bashrc', 'uniq -c'],
  ])('refuses %s but still allows %s', (dangerous, ordinary) => {
    expect(decide(dangerous).action).toBe('ask');
    expect(decide(ordinary).action).toBe('allow');
  });

  it('keeps git away from configuration of the caller’s choosing', () => {
    // A global option lands before the subcommand, so the built-in `git log` /
    // `git status` rules already miss it. These matter once the user allows
    // `git` outright — which is exactly why `-c` is on the list already. Both
    // additions reach the same config, and the programs named in it
    // (core.pager, core.fsmonitor, diff.external), through a directory and
    // through the environment instead of the command line.
    expect(decide('git -c core.pager=sh log', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git --git-dir=/tmp/evil.git status', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git --config-env=core.pager=EVIL log', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git status', { allow: ['git'] }).action).toBe('allow');
  });

  it('names the argument that cost the auto-approval', () => {
    const d = decide('sort --compress-program=/bin/sh big.txt');
    expect(d.reason).toContain('--compress-program=/bin/sh');
  });

  it('names the operand a read-only command would have written', () => {
    // `uniq [INPUT [OUTPUT]]` writes its second operand — a write primitive
    // with no flag to key on, which is why the operand count is checked too.
    const d = decide('uniq notes.txt /home/administrator/.bashrc');
    expect(d.reason).toContain('/home/administrator/.bashrc');
  });
});

describe('policy — deny covers the spellings a ban has to reach', () => {
  // "Deny is absolute" was true only of the exact spelling the user typed, so
  // `deny: ["curl"]` stopped `curl x` and waved through `/usr/bin/curl x`.
  // Worse, the path-qualified form then reached the prompt, where one "always
  // allow" wrote it into the allowlist and lifted the ban outright.
  it.each([
    ['/usr/bin/curl http://x', 'curl'],
    ['command curl http://x', 'curl'],
    ['exec /usr/bin/curl http://x', 'curl'],
    ['/bin/rm -rf /', 'rm'],
    ['curl http://x', 'curl'],
  ])('denies %s against the rule %s', (command, rule) => {
    expect(decide(command, { deny: [rule] }).action).toBe('deny');
  });

  it('denies before anything can be remembered under another spelling', () => {
    expect(suggestRules(parseCommand('/usr/bin/curl http://x').segments)).toEqual([
      '/usr/bin/curl http://x',
    ]);
    expect(decide('/usr/bin/curl http://x', { deny: ['curl'] }).action).toBe('deny');
  });

  it('leaves allow exact, so a local file cannot claim a rule', () => {
    // The widening is deny-only on purpose: `./git` is a file the agent can
    // create, and it must never inherit the user's rule for `git`.
    expect(decide('./git status', { allow: ['git'] }).action).toBe('ask');
    expect(decide('/usr/bin/git status', { allow: ['git'] }).action).toBe('ask');
    expect(ruleMatches('git', { bin: './git', args: ['status'], raw: './git status' })).toBe(false);
  });
});

describe('policy — modes and rule precedence', () => {
  it('unrestricted turns the boundary off entirely', () => {
    expect(decide('rm -rf /', { mode: 'unrestricted' }).action).toBe('allow');
  });

  it('allowlist mode never asks', () => {
    expect(decide('npm test', { mode: 'allowlist' }).action).toBe('deny');
  });

  it('deny beats the built-in allowlist', () => {
    expect(decide('git status', { deny: ['git'] })).toMatchObject({ action: 'deny' });
  });

  it('deny beats an explicit allow', () => {
    expect(decide('npm test', { allow: ['npm test'], deny: ['npm'] }).action).toBe('deny');
  });

  it('user rules extend the built-in set', () => {
    expect(decide('npm test').action).toBe('ask');
    expect(decide('npm test', { allow: ['npm test'] }).action).toBe('allow');
  });

  it('a user rule does not leak to a sibling subcommand', () => {
    expect(decide('npm publish', { allow: ['npm test'] }).action).toBe('ask');
  });

  it('an allowed command still fails on a dangerous argument', () => {
    expect(decide('find . -delete', { allow: ['find'] }).action).toBe('ask');
  });

  it('explains itself in terms the user can act on', () => {
    const d = decide('git status; rm -rf ~');
    expect(d.action).toBe('ask');
    expect(d.reason).toContain('rm -rf ~');
  });
});

describe('rule matching', () => {
  const segment = { bin: 'git', args: ['log', '--oneline'], raw: 'git log --oneline' };

  it('matches a prefix of the argument vector', () => {
    expect(ruleMatches('git', segment)).toBe(true);
    expect(ruleMatches('git log', segment)).toBe(true);
    expect(ruleMatches('git log --oneline', segment)).toBe(true);
  });

  it('does not match a different subcommand or a longer rule', () => {
    expect(ruleMatches('git push', segment)).toBe(false);
    expect(ruleMatches('git log --oneline --graph', segment)).toBe(false);
  });

  it('supports a single-word wildcard', () => {
    expect(ruleMatches('git * --oneline', segment)).toBe(true);
  });

  it('is path-sensitive, so a rule cannot be claimed by a local file', () => {
    expect(ruleMatches('git', { bin: './git', args: [], raw: './git' })).toBe(false);
  });

  it('suggests binary-plus-subcommand granularity', () => {
    expect(suggestRules(parseCommand('npm test --run').segments)).toEqual(['npm test']);
    expect(suggestRules(parseCommand('npm test && npm test').segments)).toEqual(['npm test']);
    expect(suggestRules(parseCommand('pwd').segments)).toEqual(['pwd']);
  });

  it('remembers a trailing flag as written instead of collapsing to the binary', () => {
    // Contract change: `ls -la` used to suggest bare `ls`. A flag-led command
    // has no subcommand to narrow to, and the binary alone is not a narrowing.
    // A flag with nothing after it is the whole command, so it is remembered
    // exactly as the user read it.
    expect(suggestRules(parseCommand('ls -la').segments)).toEqual(['ls -la']);
    expect(suggestRules(parseCommand('tsc --noEmit').segments)).toEqual(['tsc --noEmit']);
  });

  it('pins the payload a flag carries instead of collapsing to the binary', () => {
    // One keystroke used to store the bare binary: `node -e "console.log(1)"`
    // remembered `node`, and `bash -lc "make"` remembered `bash` — the binary
    // DEFAULT_ALLOW excludes by name because it re-enters the shell. Stopping
    // at `node -e` would not help either: rules match a prefix of the argument
    // vector, so that covers every later payload too.
    expect(suggestRules(parseCommand('node -e "console.log(1)"').segments)).toEqual([
      'node -e console.log(1)',
    ]);
    expect(suggestRules(parseCommand('bash -lc make').segments)).toEqual(['bash -lc make']);
    expect(suggestRules(parseCommand('python3 -m pytest').segments)).toEqual(['python3 -m pytest']);
    expect(suggestRules(parseCommand('docker -H tcp://10.0.0.1:2375 ps').segments)).toEqual([
      'docker -H tcp://10.0.0.1:2375 ps',
    ]);
  });

  it('remembers only the payload that was approved', () => {
    // The point of pinning it: the grant the user gave for one script must not
    // cover the next one.
    const granted = suggestRules(parseCommand('node -e "console.log(1)"').segments);
    expect(decide('node -e "console.log(1)"', { allow: granted }).action).toBe('allow');
    expect(decide('node -e "process.exit(1)"', { allow: granted }).action).toBe('ask');
    expect(decide('node bad.js', { allow: granted }).action).toBe('ask');
  });

  it('offers nothing when the invocation cannot be written as a rule', () => {
    // Rules are whitespace-separated words, so a payload containing a space
    // can only be stored as a rule that never matches. The shell one-liners
    // that land here are exactly the ones worth asking about every time.
    expect(suggestRules(parseCommand('bash -lc "make test"').segments)).toEqual([]);
    expect(suggestRules(parseCommand('sh -c "rm -rf /"').segments)).toEqual([]);
  });

  it('never suggests a bare interpreter or container runtime', () => {
    // The rule the prompt offers must never widen to the binary itself.
    const forbidden = new Set(['bash', 'sh', 'node', 'python3', 'docker']);
    for (const command of [
      'node -e "console.log(1)"',
      'bash -lc "make"',
      'sh -c "id"',
      'python3 -m pytest',
      'docker -H tcp://10.0.0.1:2375 ps',
      'bash --norc',
      'node --experimental-vm-modules',
    ]) {
      for (const rule of suggestRules(parseCommand(command).segments)) {
        expect(forbidden.has(rule)).toBe(false);
      }
    }
  });
});

describe('approval channel', () => {
  afterEach(() => _resetApprovalsForTesting());

  it('denies without asking when nobody is listening', async () => {
    const r = await requestApproval(
      { command: 'npm test', reason: 'not allowlisted', rules: ['npm test'] },
      { timeoutMs: 1000, headless: 'deny' },
    );
    expect(r).toEqual({ outcome: 'deny', automatic: true });
  });

  it('honours an explicit headless allow', async () => {
    const r = await requestApproval(
      { command: 'npm test', reason: 'not allowlisted', rules: [] },
      { timeoutMs: 1000, headless: 'allow' },
    );
    expect(r).toEqual({ outcome: 'allow-once', automatic: true });
  });

  it('delivers the request to a listener and returns its answer', async () => {
    const seen: string[] = [];
    onApprovalRequest((req) => {
      seen.push(req.command);
      resolveApproval(req.id, 'allow-always');
    });
    const r = await requestApproval(
      { command: 'npm test', reason: 'not allowlisted', rules: ['npm test'] },
      { timeoutMs: 1000, headless: 'deny' },
    );
    expect(seen).toEqual(['npm test']);
    expect(r.outcome).toBe('allow-always');
    expect(r.automatic).toBeUndefined();
  });

  it('denies when the prompt times out', async () => {
    onApprovalRequest(() => {
      /* a UI that never answers */
    });
    const r = await requestApproval(
      { command: 'npm test', reason: 'not allowlisted', rules: [] },
      { timeoutMs: 20, headless: 'allow' },
    );
    // headless:'allow' must not rescue a live prompt that expired — the
    // listener existed, so the default never applies.
    expect(r).toEqual({ outcome: 'deny', automatic: true });
  });

  it('denies when the turn is aborted', async () => {
    onApprovalRequest(() => {
      /* never answers */
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const r = await requestApproval(
      { command: 'npm test', reason: 'not allowlisted', rules: [] },
      { timeoutMs: 5000, headless: 'allow', signal: ctrl.signal },
    );
    expect(r).toEqual({ outcome: 'deny', automatic: true });
  });

  it('denies immediately when the signal is already aborted', async () => {
    onApprovalRequest(() => resolveApproval('never', 'allow-once'));
    const r = await requestApproval(
      { command: 'npm test', reason: 'not allowlisted', rules: [] },
      { timeoutMs: 5000, headless: 'allow', signal: AbortSignal.abort() },
    );
    expect(r).toEqual({ outcome: 'deny', automatic: true });
  });
});

describe('remembered grants', () => {
  function fresh() {
    const db = openDriver(':memory:');
    migrate(db);
    return db;
  }

  it('persists rules and feeds them back to the policy', () => {
    const db = fresh();
    grantRules(db, ['npm test']);
    expect(grantedAllowRules(db)).toEqual(['npm test']);
    expect(decide('npm test', { allow: grantedAllowRules(db) }).action).toBe('allow');
  });

  it('is idempotent and keeps the original grant time', () => {
    const db = fresh();
    grantRules(db, ['npm test']);
    const first = listGrantedRules(db)[0]?.createdAt;
    grantRules(db, ['npm test', 'npm test ']);
    expect(grantedAllowRules(db)).toEqual(['npm test']);
    expect(listGrantedRules(db)[0]?.createdAt).toBe(first);
  });

  it('records who granted the rule', () => {
    const db = fresh();
    grantRules(db, ['docker ps'], 'web');
    expect(listGrantedRules(db)[0]?.grantedBy).toBe('web');
  });

  it('ignores blank rules', () => {
    const db = fresh();
    grantRules(db, ['', '   ']);
    expect(grantedAllowRules(db)).toEqual([]);
  });

  it('revokes one rule and all of them', () => {
    const db = fresh();
    grantRules(db, ['npm test', 'docker ps']);
    revokeRule(db, 'npm test');
    expect(grantedAllowRules(db)).toEqual(['docker ps']);
    revokeAllRules(db);
    expect(grantedAllowRules(db)).toEqual([]);
  });
});
