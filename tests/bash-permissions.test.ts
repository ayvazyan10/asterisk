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

  it('drops leading environment assignments', () => {
    const parsed = parseCommand('FOO=1 BAR=2 npm test');
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.bin).toBe('npm');
    expect(parsed.segments[0]?.args).toEqual(['test']);
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
    expect(suggestRules(parseCommand('ls -la').segments)).toEqual(['ls']);
    expect(suggestRules(parseCommand('npm test && npm test').segments)).toEqual(['npm test']);
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
