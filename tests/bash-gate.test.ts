// End-to-end: the Bash tool itself, with the permission gate in front of it.
//
// tests/bash-permissions.test.ts proves the policy reaches the right verdict.
// This file proves the verdict is actually enforced — that a refused command
// never reaches execa, that an approved one does, and that "allow always"
// survives into the next call.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { permissionsCommand } from '../src/commands/permissions.ts';
import { loadConfig, saveConfig } from '../src/config/load.ts';
import { type AsteriskConfig, ConfigSchema } from '../src/config/schema.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import { grantedAllowRules } from '../src/db/permissions.ts';
import {
  _resetApprovalsForTesting,
  onApprovalRequest,
  resolveApproval,
} from '../src/tools/approval.ts';
import { bashTool } from '../src/tools/bash.ts';

let home: string;
let prevHome: string | undefined;

/** A marker file the command under test would create if it ever ran. */
function proofOfExecution(dir: string): string {
  return join(dir, 'ran');
}

function withPermissions(over: Partial<AsteriskConfig['permissions']>): void {
  const config = ConfigSchema.parse({});
  saveConfig({ ...config, permissions: { ...config.permissions, ...over } });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-gate-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
});

afterEach(async () => {
  _resetApprovalsForTesting();
  closeDb();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('Bash tool with the permission gate', () => {
  it('runs an allowlisted read-only command without asking', async () => {
    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });

    const r = await bashTool.execute({ command: 'echo hello' });

    expect(asked).toBe(0);
    expect(r.isError).toBe(false);
    expect(r.output).toContain('hello');
  });

  it('refuses an unattended command and never executes it', async () => {
    const marker = proofOfExecution(home);

    const r = await bashTool.execute({ command: `touch ${marker}` });

    expect(r.isError).toBe(true);
    expect(r.output).toContain('no one was available to approve it');
    // The refusal has to be actionable — the model relays it, the user acts on it.
    expect(r.output).toContain('permissions.allow');
    const check = await bashTool.execute({ command: `ls ${home}` });
    expect(check.output).not.toContain('ran');
  });

  it('refuses a chained command because of its dangerous half', async () => {
    const marker = proofOfExecution(home);

    const r = await bashTool.execute({ command: `echo hi && touch ${marker}` });

    expect(r.isError).toBe(true);
    const check = await bashTool.execute({ command: `ls ${home}` });
    expect(check.output).not.toContain('ran');
  });

  it('runs the command when a human allows it once', async () => {
    onApprovalRequest((req) => resolveApproval(req.id, 'allow-once'));

    const r = await bashTool.execute({ command: 'printf approved' });

    expect(r.isError).toBe(false);
    expect(r.output).toContain('approved');
    expect(grantedAllowRules(getDb())).toEqual([]);
  });

  it('does not execute when a human denies it', async () => {
    const marker = proofOfExecution(home);
    onApprovalRequest((req) => resolveApproval(req.id, 'deny'));

    const r = await bashTool.execute({ command: `touch ${marker}` });

    expect(r.isError).toBe(true);
    expect(r.output).toContain('refused by the user');
    const check = await bashTool.execute({ command: `ls ${home}` });
    expect(check.output).not.toContain('ran');
  });

  it('remembers "allow always" so the next call runs unprompted', async () => {
    let asked = 0;
    const stop = onApprovalRequest((req) => {
      asked += 1;
      resolveApproval(req.id, 'allow-always');
    });

    const first = await bashTool.execute({ command: 'printf one' });
    expect(first.isError).toBe(false);
    expect(asked).toBe(1);
    expect(grantedAllowRules(getDb())).toEqual(['printf one']);

    // The grant is scoped to `printf one`, so the same rule matches again…
    const second = await bashTool.execute({ command: 'printf one' });
    expect(second.isError).toBe(false);
    expect(asked).toBe(1);

    // …but a different subcommand is still a fresh decision.
    const third = await bashTool.execute({ command: 'printf two' });
    expect(third.isError).toBe(false);
    expect(asked).toBe(2);
    stop();
  });

  it('honours permissions.deny ahead of everything, without prompting', async () => {
    withPermissions({ deny: ['echo'] });
    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });

    const r = await bashTool.execute({ command: 'echo hello' });

    expect(r.isError).toBe(true);
    expect(r.output).toContain('deny rule');
    expect(asked).toBe(0);
  });

  it('applies a deny rule to a path-qualified spelling of the same binary', async () => {
    // Deny used to compare the binary exactly, so `deny: ["echo"]` stopped
    // `echo` and waved `/bin/echo` through to the prompt — where one "allow
    // always" would have written `/bin/echo` into the allowlist and lifted the
    // user's ban. Allow stays exact; only deny reads through the path.
    withPermissions({ deny: ['echo'] });
    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });

    for (const command of ['/bin/echo hello', 'command echo hello']) {
      const r = await bashTool.execute({ command });
      expect(r.isError).toBe(true);
      expect(r.output).toContain('deny rule');
    }
    expect(asked).toBe(0);
  });

  it('asks before running an allowlisted binary that carries an environment prefix', async () => {
    // `LD_PRELOAD=./payload.so ls` used to be judged as bare `ls` and run
    // unattended; the assignment is the part that does something.
    let asked = 0;
    onApprovalRequest((req) => {
      asked += 1;
      resolveApproval(req.id, 'deny');
    });

    const prefixed = await bashTool.execute({ command: 'LD_PRELOAD=./payload.so echo hi' });
    expect(asked).toBe(1);
    expect(prefixed.isError).toBe(true);

    // The same command without the prefix still runs unattended.
    const plain = await bashTool.execute({ command: 'echo hi' });
    expect(asked).toBe(1);
    expect(plain.isError).toBe(false);
  });

  it('remembers the payload, not the binary, when a flag leads the command', async () => {
    // The suggested rule used to collapse to the bare binary whenever the
    // first word was a flag, so one "allow always" on `node -e "…"` granted
    // every future `node` invocation.
    let asked = 0;
    onApprovalRequest((req) => {
      asked += 1;
      resolveApproval(req.id, 'allow-always');
    });

    const first = await bashTool.execute({ command: 'printf -- one' });
    expect(first.isError).toBe(false);
    expect(grantedAllowRules(getDb())).toEqual(['printf -- one']);

    // The grant covers the invocation it was given for…
    await bashTool.execute({ command: 'printf -- one' });
    expect(asked).toBe(1);

    // …and not the next payload behind the same flag.
    await bashTool.execute({ command: 'printf -- two' });
    expect(asked).toBe(2);
  });

  it('honours permissions.allow from config', async () => {
    withPermissions({ allow: ['printf'] });
    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });

    const r = await bashTool.execute({ command: 'printf configured' });

    expect(asked).toBe(0);
    expect(r.output).toContain('configured');
  });

  it('lets an unattended run through when headless is set to allow', async () => {
    withPermissions({ headless: 'allow' });

    const r = await bashTool.execute({ command: 'printf unattended' });

    expect(r.isError).toBe(false);
    expect(r.output).toContain('unattended');
  });

  it('drops the boundary entirely in unrestricted mode', async () => {
    withPermissions({ mode: 'unrestricted' });

    const r = await bashTool.execute({ command: 'printf anything' });

    expect(r.isError).toBe(false);
    expect(r.output).toContain('anything');
  });

  it('refuses without prompting in allowlist mode', async () => {
    withPermissions({ mode: 'allowlist' });
    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });

    const r = await bashTool.execute({ command: 'printf nope' });

    expect(r.isError).toBe(true);
    expect(asked).toBe(0);
    expect(r.output).toContain('allowlist');
  });

  it('still applies the denylist before anyone is asked to approve', async () => {
    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });

    const r = await bashTool.execute({ command: 'mkfs.ext4 /dev/sda1' });

    expect(r.isError).toBe(true);
    expect(r.output).toContain('safety check');
    expect(asked).toBe(0);
  });
});

describe('/permissions', () => {
  // The command ignores its context entirely; it reads config and the database.
  const ctx = {} as Parameters<typeof permissionsCommand.execute>[0];
  const run = async (args: string) => await permissionsCommand.execute(ctx, args);

  it('reports the effective policy and says what it is not', async () => {
    const out = await run('');
    expect(out).toContain('mode ask');
    expect(out).toContain('unattended runs deny');
    expect(out).toContain('not a sandbox');
  });

  it('lists the built-in read-only rules', async () => {
    const out = await run('builtin');
    expect(out).toContain('git status');
    expect(out).toContain('ls');
  });

  it('adds an allow rule that the gate then honours', async () => {
    expect(await run('allow printf')).toContain('Added "printf"');
    const r = await bashTool.execute({ command: 'printf viacommand' });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('viacommand');
  });

  it('adds a deny rule that the gate then honours', async () => {
    expect(await run('deny echo')).toContain('Added "echo"');
    const r = await bashTool.execute({ command: 'echo nope' });
    expect(r.isError).toBe(true);
  });

  it('refuses to add the same rule twice', async () => {
    await run('allow printf');
    expect(await run('allow printf')).toContain('already in');
  });

  it('surfaces remembered grants and revokes them', async () => {
    onApprovalRequest((req) => resolveApproval(req.id, 'allow-always'));
    await bashTool.execute({ command: 'printf remembered' });

    expect(await run('')).toContain('printf remembered');
    expect(await run('revoke printf remembered')).toContain('Revoked');
    expect(grantedAllowRules(getDb())).toEqual([]);
  });

  it('stores a quoted rule without its quotes, so it can actually match', async () => {
    // The documented form quotes rules that contain a space. Keeping the
    // quotes stored `"npm test"` as the rule, which is matched against the
    // command's first word and can never hit — the rule looked added and the
    // prompt kept coming back.
    expect(await run('allow "printf ok"')).toContain('Added "printf ok"');
    expect(loadConfig().config.permissions.allow).toEqual(['printf ok']);

    let asked = 0;
    onApprovalRequest(() => {
      asked += 1;
    });
    const r = await bashTool.execute({ command: 'printf ok' });
    expect(asked).toBe(0);
    expect(r.isError).toBe(false);
    expect(r.output).toContain('ok');
  });

  it('rejects revoking something that was never granted', async () => {
    expect(await run('revoke nonesuch')).toContain('not a remembered rule');
  });

  it('offers a picker when revoke is called with no argument', async () => {
    onApprovalRequest((req) => resolveApproval(req.id, 'allow-always'));
    await bashTool.execute({ command: 'printf pickme' });

    const spec = await run('revoke');
    expect(typeof spec).toBe('object');
    expect(spec).toMatchObject({ kind: 'list' });
  });

  it('says so plainly when there is nothing to revoke', async () => {
    expect(await run('revoke')).toContain('Nothing to revoke');
  });
});

// A prompt is only worth raising if it reaches the person whose turn raised it.
// The daemon serves many chats from one process, so "is anyone there" has to be
// asked about the running session, not about the process.
describe('approval routing by session', () => {
  it('carries the session id, so a UI can tell whose turn asked', async () => {
    const seen: string[] = [];
    onApprovalRequest((req) => {
      seen.push(req.sessionId);
      resolveApproval(req.id, 'allow-once');
    });

    const r = await runWithSession({ id: 'bot:42', scope: 'telegram' }, () =>
      bashTool.execute({ command: 'printf routed' }),
    );

    expect(r.isError).toBe(false);
    expect(seen).toEqual(['bot:42']);
  });

  it('does not show one chat the question another chat raised', async () => {
    const seen: string[] = [];
    onApprovalRequest(
      (req) => {
        seen.push(req.sessionId);
        resolveApproval(req.id, 'allow-once');
      },
      { accepts: (id) => id === 'bot:7' },
    );

    const marker = proofOfExecution(home);
    const r = await runWithSession({ id: 'bot:42', scope: 'telegram' }, () =>
      bashTool.execute({ command: `touch ${marker}` }),
    );

    // Nobody could answer for bot:42, so the headless default decides — and
    // the refusal says exactly that rather than blaming the user.
    expect(seen).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('no one was available to approve it');
  });

  it('falls back to the headless default without waiting out the timeout', async () => {
    withPermissions({ headless: 'allow', timeoutSeconds: 600 });
    onApprovalRequest(() => undefined, { accepts: () => false });

    const started = Date.now();
    const r = await runWithSession({ id: 'scheduled:cron', scope: 'scheduled' }, () =>
      bashTool.execute({ command: 'printf unattended' }),
    );

    expect(r.isError).toBe(false);
    expect(r.output).toContain('unattended');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
