// The Bash permission boundary.
//
// The bulk of this file is adversarial: a list of commands that must never be
// auto-approved. That list is the actual specification. A permission model is
// only worth having if the obvious ways around it are closed, and every entry
// in `BYPASS_ATTEMPTS` is a way around a naive prefix allowlist — the design
// this replaced. Two of them (`rm -r -f /` and `sh -c '…'`) also walk straight
// through the 14-regex denylist in bash-safety.ts, which is why that denylist
// is documented as defence in depth rather than as the boundary.

import { spawnSync } from 'node:child_process';
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
    ['echo {a,b}', 'brace expansion'],
    ['echo {a..b}', 'brace expansion'],
    ['find . -delet?', 'pathname expansion'],
    ['find . -name zz -e*', 'pathname expansion'],
    ['find . -delet[ex]', 'pathname expansion'],
  ])('marks %s opaque', (command, reason) => {
    expect(parseCommand(command).opaque).toContain(reason);
  });

  it.skipIf(spawnSync('bash', ['-c', 'exit 0']).status !== 0)(
    'agrees with bash argv for auto-approved literal words',
    () => {
      for (const command of [
        'ls -la',
        'git log --oneline -5',
        'grep -rn foo src',
        "grep -r 'foo*' src",
        'grep -r "foo*" src',
        "find . -name '*.ts'",
        'echo "{a,b}"',
        'echo \\{a,b\\}',
        'find . -name \\*.ts',
      ]) {
        expect(decide(command).action).toBe('allow');
        const parsed = parseCommand(command);
        expect(parsed.opaque).toEqual([]);
        expect(parsed.segments).toHaveLength(1);
        const segment = parsed.segments[0];
        const bash = spawnSync('bash', ['-c', `printf '%s\\0' ${command}`], {
          encoding: 'utf8',
        });
        expect(bash.status).toBe(0);
        expect(bash.stdout.split('\0').slice(0, -1)).toEqual([
          segment?.bin,
          ...(segment?.args ?? []),
        ]);
      }
    },
  );
});

describe('policy — commands that run without asking', () => {
  it.each([
    'ls -la',
    'pwd',
    'cd /some/path',
    'cd ~/.asterisk',
    'cat package.json',
    'git status',
    'git status --short',
    'git log --oneline -20',
    'git log --oneline -5',
    'git diff',
    'git diff HEAD~1',
    'rg -n "TODO" src/',
    'find . -name "*.ts"',
    "find . -name '*.ts'",
    "grep -r 'foo*' src",
    'grep -rn foo src',
    'sort file',
    'sort -u file',
    'echo "{a,b}"',
    "echo '{a..b}'",
    'echo \\{a,b\\}',
    'find . -name \\*.ts',
    "find . -name '[ab]?.ts'",
    'git diff -- src/file.ts',
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

describe('transparent command wrappers', () => {
  it.each([
    'nice -n 5 git status',
    'nice --adjustment=-5 git status',
    'nice -n5 git status',
    'timeout --signal=KILL 5 ls',
    'timeout -s TERM -k 2s --preserve-status 5s ls',
    'timeout -sKILL -k1 0.5m ls',
    'nohup ls',
    'nohup -- ls',
    'time ls',
    'time -p ls',
    'stdbuf -oL ls',
    'stdbuf -i 0 -e0 --output=L ls',
    'timeout 5 nice -n 5 nohup stdbuf -oL git status',
  ])('judges the inner command in %s', (command) => {
    expect(decide(command).action).toBe('allow');
    expect(suggestRules(parseCommand(command).segments)).toEqual([]);
  });

  it('uses inner grants and suggests only the inner program', () => {
    expect(decide('timeout 100 node --test other.ts', { allow: ['node --test'] }).action).toBe(
      'allow',
    );
    expect(decide('timeout 100 node -e "1"', { allow: ['node --test'] }).action).toBe('ask');
    expect(decide('timeout 5s rm -rf x').action).toBe('ask');
    expect(suggestRules(parseCommand('timeout 5s rm -rf x').segments)).toEqual(['rm']);
  });

  it.each([
    'timeout --unknown 5 ls',
    'timeout -s',
    'timeout later ls',
    'timeout 5',
    'nice -n nope ls',
    'nice -n',
    'nohup --help ls',
    'time -o /tmp/timing ls',
    'stdbuf ls',
    'stdbuf -o',
  ])('keeps an unparseable wrapper opaque: %s', (command) => {
    expect(decide(command, { allow: ['timeout', 'nice', 'nohup', 'time', 'stdbuf'] }).action).toBe(
      'ask',
    );
    expect(suggestRules(parseCommand(command).segments)).toEqual([]);
  });

  it('keeps deny rules and forbidden arguments effective through wrappers', () => {
    expect(decide('timeout 5 git status', { deny: ['git'] }).action).toBe('deny');
    expect(decide('timeout 5 git status', { deny: ['timeout'] }).action).toBe('deny');
    expect(decide('nice -n 5 rg --pre=sh x', { allow: ['rg'] }).action).toBe('ask');
    expect(decide('timeout 5 ./git status').action).toBe('ask');
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
  ['brace-expanded find exec', 'find . -maxdepth 0 {-exec,touch,/tmp/PWNED,\\;}'],
  ['brace-expanded ripgrep preprocessor', 'rg {--pre,/tmp/x.sh} foo'],
  ['brace-expanded words', 'echo {a,b}'],
  ['brace-expanded range', 'echo {a..b}'],
  ['glob-expanded find delete', 'find . -delet?'],
  ['glob-expanded find exec', 'find . -name zz -e*'],
  ['bracket-glob-expanded find option', 'find . -delet[ex]'],
  ['glob-expanded ripgrep arguments', 'rg * foo'],
  ['glob-expanded sort arguments', 'sort *'],
  ['glob-expanded git arguments', 'git diff *'],
  ['glob-expanded tree arguments', 'tree *'],
  ['sort attached output', 'sort -o/tmp/out /etc/hostname'],
  ['sort clustered output', 'sort -uo /tmp/out x'],
  ['sort longer clustered output', 'sort -ruo /tmp/out x'],
  ['tree attached output', 'tree -o/tmp/x'],
  ['tree clustered output', 'tree -ao/tmp/x'],
  ['date attached set', 'date -s2020'],
  ['date clustered set', 'date -us2020'],
  ['git remote prefix adding a remote', 'git remote --verbose add x y'],
  ['git remote prefix fetching updates', 'git remote --verbose update'],
  ['git branch prefix editing descriptions', 'git branch --list --edit-description'],
  ['git branch prefix deleting branches', 'git branch --list -D foo'],
  ['git diff abbreviated output', 'git diff --outpu=/tmp/x'],
  ['git log abbreviated output', 'git log --outp=/tmp/x'],
  ['git show abbreviated output', 'git show --outp=/tmp/zzz HEAD'],
  ['git textconv execution', 'git diff --no-index --textconv a b'],
  ['git abbreviated textconv execution', 'git diff --textc a b'],
  ['git abbreviated external diff', 'git diff --ext a b'],
  ['git abbreviated upload-pack', 'git ls-files --upload=/tmp/x'],
  ['git abbreviated receive-pack', 'git ls-files --receive=/tmp/x'],
  ['date abbreviated set', 'date --se=2020'],
  ['file compiling magic', 'file -C -m /tmp/x'],
  ['file clustered compile', 'file -vC -m /tmp/x'],
  ['file abbreviated compile', 'file --comp -m /tmp/x'],
  ['sort abbreviated compress program', 'sort --compress-prog=/bin/sh big.txt'],
  ['sort abbreviated output', 'sort --out=/tmp/x file'],
  ['tree abbreviated output', 'tree --out=/tmp/x'],
  ['ripgrep abbreviated preprocessor', 'rg --pr=/tmp/x.sh foo'],
  ['ripgrep abbreviated hostname program', 'rg --hostname-b=/tmp/x.sh foo'],
  ['grep abbreviated devices', 'grep --dev=read x /dev/zero'],
  ['egrep abbreviated devices', 'egrep --dev=read x /dev/zero'],
  ['fgrep abbreviated devices', 'fgrep --dev=read x /dev/zero'],
];

describe('policy — bypass attempts', () => {
  it.each(BYPASS_ATTEMPTS)('never silently allows: %s', (_label, command) => {
    expect(decide(command).action).toBe('ask');
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
    expect(decide('git -ccore.pager=sh log', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git -Pc core.pager=sh log', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git --git-d=/tmp/evil.git status', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git --config-e=core.pager=EVIL log', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git --exe=/tmp/x status', { allow: ['git'] }).action).toBe('ask');
    expect(decide('git status', { allow: ['git'] }).action).toBe('allow');
  });

  it('names the argument that cost the auto-approval', () => {
    const d = decide('sort --compress-program=/bin/sh big.txt');
    expect(d.reason).toContain('--compress-program=/bin/sh');
  });

  it.each([
    ['find', 'find . -name x', "find . -exec rm '{}' \\;", '-exec'],
    ['sort', 'sort file', 'sort -o /tmp/out file', '-o'],
    ['git log', 'git log --oneline', 'git log -c core.pager=sh', '-c'],
    ['rg', 'rg x file', 'rg --pre=sh x file', '--pre'],
  ])('keeps forbidden arguments above a remembered %s grant', (rule, safe, unsafe, flag) => {
    expect(decide(safe, { allow: [rule] }).action).toBe('allow');
    const decision = decide(unsafe, { allow: [rule] });
    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain(flag);
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
      '/usr/bin/curl',
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

  it('does not interpret tool grants as Bash rules', () => {
    for (const rule of ['mcp:fake/send', 'network:https://example.com', 'read:asterisk-home']) {
      expect(decide(rule, { allow: [rule] }).action).toBe('ask');
    }
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

describe('policy — secret reads', () => {
  it.each([
    'cat ~/.asterisk/secrets.env',
    'cat ~/.asterisk/key=backup',
    'grep --file=~/.asterisk/secrets.env README.md',
    'grep -a sk- ~/.asterisk/asterisk.db',
    'cd ~/.asterisk && cat secrets.env',
  ])('requires a separate home-read grant for %s', (command) => {
    expect(decide(command, { allow: ['cat', 'grep'] }).action).toBe('ask');
    expect(decide(command, { allow: ['read:asterisk-home'] }).action).toBe('allow');
    expect(decide(command, { mode: 'allowlist', allow: ['read:asterisk-home'] }).action).toBe(
      'allow',
    );
    expect(decide(command, { mode: 'allowlist' }).action).toBe('deny');
    expect(
      decide(command, { allow: ['read:asterisk-home'], deny: ['read:asterisk-home'] }).action,
    ).toBe('deny');
  });

  it.each([
    'env',
    'printenv',
    'jq -n env',
    "jq -n '$ENV'",
    'export -p',
    'set',
    'declare -x',
    'cat /proc/self/environ',
    'cat /proc/123/environ',
    'command /usr/bin/env',
  ])('requires fresh approval for %s, even with a matching allow rule', (command) => {
    expect(decide(command).action).toBe('ask');
    expect(
      decide(command, {
        allow: ['read:asterisk-home', command, ...suggestRules(parseCommand(command).segments)],
      }).action,
    ).toBe('ask');
    expect(decide(command, { mode: 'allowlist' }).action).toBe('deny');
    expect(decide(command, { mode: 'unrestricted' }).action).toBe('allow');
  });

  it('does not let a home argument hide an environment read', () => {
    expect(
      decide('cat ~/.asterisk/x /proc/self/environ', { allow: ['read:asterisk-home'] }).action,
    ).toBe('ask');
    expect(decide('cd ~/.asterisk && jq -n env', { allow: ['read:asterisk-home'] }).action).toBe(
      'ask',
    );
  });

  it('still considers earlier directories when cd runs conditionally or in a pipeline', () => {
    expect(decide('cd ~/.asterisk && cd /tmp || cat secrets.env').action).toBe('ask');
    expect(decide('cd ~/.asterisk && cd /tmp | cat secrets.env').action).toBe('ask');
  });

  it('still allows ordinary reads and jq filters', () => {
    expect(decide('cat README.md').action).toBe('allow');
    expect(decide("jq '.name' package.json").action).toBe('allow');
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
    expect(suggestRules(parseCommand('pwd').segments)).toEqual([]);
  });

  it.each([
    ['ps -eo pid,etime,cmd --sort=-etime', ['ps']],
    ['sqlite3 -json asterisk.db "select 1"', ['sqlite3']],
    ['sqlite3 asterisk.db "select 1"', ['sqlite3']],
    ['tsc --noEmit', ['tsc']],
    ['docker ps -a', ['docker ps']],
    ['docker -H tcp://10.0.0.1:2375 ps', ['docker']],
    ['python3 -m pytest -q', ['python3 -m']],
    ['node --test lib/x.test.ts', ['node --test']],
    ['bun test lib/x.test.ts', ['bun test']],
    ['ls -la', []],
    ['cd /some/path', []],
    ['cd ~/.asterisk', []],
    ['git log --oneline -5 | wc -l', []],
  ])('suggests useful program rules for %s', (command, rules) => {
    expect(suggestRules(parseCommand(command).segments)).toEqual(rules);
  });

  it.each([
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
  ])('keeps the subcommand for %s', (bin) => {
    expect(suggestRules(parseCommand(`${bin} custom extra`).segments)).toEqual([`${bin} custom`]);
  });

  it('suggests only missing grants in the observed pipelines', () => {
    const ps =
      "ps -eo pid,etime,cmd --sort=-etime | grep -E 'next|bun|node|playwright' | grep -v grep | head -12";
    expect(suggestRules(parseCommand(ps).segments)).toEqual(['ps']);
    expect(suggestRules(parseCommand(ps).segments, ['ps'])).toEqual([]);
    expect(decide('ps aux | head -5', { allow: ['ps'] }).action).toBe('allow');
    const sqlite = 'cd ~/.asterisk && sqlite3 asterisk.db "select id from memories limit 1"';
    expect(suggestRules(parseCommand(sqlite).segments)).toEqual(['sqlite3', 'read:asterisk-home']);
    expect(suggestRules(parseCommand(sqlite).segments, ['sqlite3'])).toEqual([
      'read:asterisk-home',
    ]);
    expect(suggestRules(parseCommand(sqlite).segments, ['read:asterisk-home'])).toEqual([
      'sqlite3',
    ]);
    expect(decide(sqlite, { allow: ['sqlite3', 'read:asterisk-home'] }).action).toBe('allow');
    const node =
      'cd /tmp/mission-control-app && timeout 240 node --test --experimental-strip-types lib/x.test.ts 2>&1 | tail -25';
    expect(suggestRules(parseCommand(node).segments)).toEqual(['node --test']);
    expect(suggestRules(parseCommand(node).segments, ['node --test'])).toEqual([]);
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
    expect(suggestRules(parseCommand('bash -lc "ls"').segments)).toEqual(['bash -lc ls']);
    expect(suggestRules(parseCommand('node -e "1"').segments)).toEqual(['node -e 1']);
  });

  it.each([
    ['node --test -e "1"', ['node --test -e 1']],
    ['node --eval=1', ['node --eval=1']],
    ['node -p "1"', ['node -p 1']],
    ['python3 -c "print(1)"', ['python3 -c print(1)']],
    ['perl -E "1"', ['perl -E 1']],
    ['perl -ne "1"', ['perl -ne 1']],
    ['ruby -ne "1"', ['ruby -ne 1']],
    ['perl -i backup file', ['perl -i backup file']],
    ['php -r "1"', ['php -r 1']],
    ['deno eval "1"', ['deno eval 1']],
    ['pwsh -Command "1"', ['pwsh -Command 1']],
    ['eval echo hi', ['eval echo hi']],
    ['sudo ls /tmp', ['sudo ls /tmp']],
    ['su owner -c ls', ['su owner -c ls']],
    ['ssh host ls /tmp', ['ssh host ls /tmp']],
    ['env FOO=1 node file.js', ['env FOO=1 node file.js']],
    ['xargs -n 1 rm', ['xargs -n 1 rm']],
    ['/usr/bin/node -e "1"', ['/usr/bin/node -e 1']],
    ['bash -lc "make test"', []],
  ])('pins command-line code and re-entry in %s', (command, rules) => {
    expect(suggestRules(parseCommand(command).segments)).toEqual(rules);
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

  it('never suggests a bare interpreter for code or script execution', () => {
    // The rule the prompt offers must never widen to the binary itself.
    const forbidden = new Set(['bash', 'sh', 'node', 'python3']);
    for (const command of [
      'node -e "console.log(1)"',
      'bash -lc "make"',
      'sh -c "id"',
      'python3 -m pytest',
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

  it('keeps existing invocation grants working without a migration', () => {
    const db = fresh();
    const oldRules = [
      'ps -eo pid,etime,cmd --sort=-etime',
      'sqlite3 asterisk.db',
      'python3 -m pytest -q',
    ];
    grantRules(db, oldRules);
    for (const command of oldRules) {
      expect(decide(command, { allow: grantedAllowRules(db) }).action).toBe('allow');
    }
    expect(decide('ps aux', { allow: grantedAllowRules(db) }).action).toBe('ask');
    expect(grantedAllowRules(db)).toEqual([...oldRules].sort());
  });

  it('does not let an old wrapper grant cover whatever the wrapper runs', () => {
    const db = fresh();
    grantRules(db, ['timeout 240']);
    const allow = grantedAllowRules(db);
    const command = 'timeout 240 node --test x.test.ts';
    expect(decide(command, { allow }).action).toBe('ask');
    expect(suggestRules(parseCommand(command).segments, allow)).toEqual(['node --test']);
    expect(decide('timeout 240 rm -rf /tmp/x', { allow }).action).toBe('ask');
    expect(decide('timeout 240 ls', { allow }).action).toBe('allow');
    expect(decide("timeout 240 find . -exec rm '{}' \\;", { allow }).action).toBe('ask');
    expect(decide('timeout 240 cat ~/.asterisk/x', { allow }).action).toBe('ask');
    expect(decide('timeout 240 env', { allow: [...allow, 'read:asterisk-home'] }).action).toBe(
      'ask',
    );
    expect(decide('timeout --unknown 240 ls', { allow }).action).toBe('ask');
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
