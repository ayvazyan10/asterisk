// Exercise the dispatch registry, not the raw tool bodies: this is the shared
// permission boundary for the agent loop and RunCode. All HTTP/MCP I/O is fake.

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { permissionsCommand } from '../src/commands/permissions.ts';
import { loadConfig, saveConfig } from '../src/config/load.ts';
import { type AsteriskConfig, ConfigSchema } from '../src/config/schema.ts';
import { PROJECT_ROOT } from '../src/daemon/project-root.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import { grantRules, grantedAllowRules } from '../src/db/permissions.ts';
import { type ConnectedMcpServer, asLocalTool } from '../src/mcp/client.ts';
import {
  type ApprovalOutcome,
  _resetApprovalsForTesting,
  automaticDenialCount,
  onApprovalRequest,
  resolveApproval,
} from '../src/tools/approval.ts';
import { evaluateCommand } from '../src/tools/bash-permissions.ts';
import { getTool, setExtraTools } from '../src/tools/registry.ts';
import { _resetWorkspaceForTesting } from '../src/tools/workspace.ts';
import type { Provider } from '../src/types/messages.ts';

vi.mock('undici', () => ({ request: vi.fn() }));

let workspace: string;
let home: string;

function configure(permissions: Partial<AsteriskConfig['permissions']>): void {
  const { config } = loadConfig();
  saveConfig({ ...config, permissions: { ...config.permissions, ...permissions } });
}

function execute(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const tool = getTool(name);
  if (!tool) throw new Error(`missing test tool ${name}`);
  return tool.execute(input, signal ? { signal } : {});
}

function answer(outcome: ApprovalOutcome = 'allow-once') {
  const seen = vi.fn((req: Parameters<Parameters<typeof onApprovalRequest>[0]>[0]) => {
    resolveApproval(req.id, outcome);
  });
  onApprovalRequest(seen);
  return seen;
}

function mcpTool(server = 'fake', name = 'send') {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] });
  const connected = {
    config: { name: server },
    client: { callTool },
  } as unknown as ConnectedMcpServer;
  const tool = asLocalTool(connected, {
    name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  });
  return { tool, callTool };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'asterisk-tool-permissions-'));
  home = join(workspace, '.assistant');
  vi.stubEnv('ASTERISK_WORKSPACE', workspace);
  vi.stubEnv('ASTERISK_HOME', home);
  vi.stubEnv('ASTERISK_NO_WORKSPACE_GUARD', '');
  vi.stubEnv('ASTERISK_ALLOW_LOCAL_FETCH', '');
  _resetWorkspaceForTesting();
  const config = ConfigSchema.parse({ sandbox: { mode: 'off' } });
  saveConfig(config);
  vi.mocked(request).mockReset();
  vi.mocked(request).mockResolvedValue({
    statusCode: 200,
    body: { text: async () => 'ok' },
  } as Awaited<ReturnType<typeof request>>);
});

afterEach(async () => {
  _resetApprovalsForTesting();
  setExtraTools([]);
  closeDb();
  vi.unstubAllEnvs();
  _resetWorkspaceForTesting();
  await rm(workspace, { recursive: true, force: true });
});

describe('protected file access', () => {
  it('asks for .git/config and allows an ordinary workspace write without asking', async () => {
    const seen = answer();
    const configPath = join(workspace, '.git/config');
    expect((await execute('Write', { path: configPath, content: '[core]' })).isError).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0].command).toContain(configPath);
    expect(await readFile(configPath, 'utf8')).toBe('[core]');

    const ordinary = join(workspace, 'src/a.ts');
    expect((await execute('Write', { path: ordinary, content: 'export {};' })).isError).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(await readFile(ordinary, 'utf8')).toBe('export {};');
  });

  it.each(['.git/hooks/pre-commit', 'other-repo/.git/config', 'other-repo/.git/hooks/sub/hook'])(
    'denying %s prevents the write',
    async (relative) => {
      const seen = answer('deny');
      const path = join(workspace, relative);
      expect((await execute('Write', { path, content: 'payload' })).isError).toBe(true);
      expect(seen).toHaveBeenCalledTimes(1);
      await expect(readFile(path)).rejects.toThrow();
    },
  );

  it('asks before editing inside ASTERISK_HOME, even when the workspace contains it', async () => {
    const path = join(home, 'secrets.env');
    await writeFile(path, 'old secret');
    const seen = answer();
    expect((await execute('Edit', { path, oldString: 'old', newString: 'new' })).isError).toBe(
      false,
    );
    expect(seen).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe('new secret');
  });

  it('asks before reading secrets, including through a workspace symlink', async () => {
    const path = join(home, 'secrets.env');
    await writeFile(path, 'fake-secret');
    await symlink(home, join(workspace, 'alias'));
    const seen = answer('deny');
    const result = await execute('Read', { path: join(workspace, 'alias/secrets.env') });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('fake-secret');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('recognises a symlink to Git config before a write', async () => {
    await mkdir(join(workspace, '.git'));
    await symlink(join(workspace, '.git/config'), join(workspace, 'config-alias'));
    const seen = answer('deny');
    expect(
      (await execute('Write', { path: join(workspace, 'config-alias'), content: 'x' })).isError,
    ).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('asks for install-directory writes even with the workspace guard disabled', async () => {
    vi.stubEnv('ASTERISK_NO_WORKSPACE_GUARD', '1');
    const seen = answer('deny');
    const result = await execute('Write', {
      path: join(PROJECT_ROOT, 'permission-test-must-not-exist'),
      content: 'never written',
    });
    expect(result.isError).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('install directory');
  });

  it('requires fresh consent for protected paths after allow-always', async () => {
    const seen = answer('allow-always');
    const input = { path: join(workspace, '.git/config'), content: '[core]' };
    await execute('Write', input);
    await execute('Write', input);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(grantedAllowRules(getDb())).toEqual([]);
  });
});

describe('network sends', () => {
  it.each(['RemoteTrigger', 'PushNotification'])(
    'refuses loopback for %s before asking or sending',
    async (name) => {
      const seen = answer();
      grantRules(getDb(), ['network:http://127.0.0.1']);
      const result = await execute(name, { url: 'http://127.0.0.1', message: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('loopback');
      expect(seen).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('asks for RemoteTrigger and remembers only the exact origin', async () => {
    const seen = answer('allow-always');
    expect(
      (await execute('RemoteTrigger', { url: 'https://example.com/first', bodyText: 'data' }))
        .isError,
    ).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(grantedAllowRules(getDb())).toEqual(['network:https://example.com']);
    expect((await execute('RemoteTrigger', { url: 'https://example.com/second' })).isError).toBe(
      false,
    );
    expect(seen).toHaveBeenCalledTimes(1);
    for (const url of [
      'http://example.com',
      'https://example.com:8443',
      'https://sub.example.com',
    ]) {
      await execute('RemoteTrigger', { url });
    }
    expect(seen).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('never sends a denied request', async () => {
    answer('deny');
    const result = await execute('RemoteTrigger', {
      url: 'https://example.com',
      method: 'DELETE',
      headers: { 'x-test': 'yes' },
      bodyText: 'private',
    });
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('guards explicit and configured PushNotification URLs and shares origin grants', async () => {
    vi.stubEnv('ASTERISK_NOTIFY_URL', 'http://localhost');
    expect((await execute('PushNotification', { message: 'hello' })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    vi.stubEnv('ASTERISK_NOTIFY_URL', 'https://example.com/notify');
    const seen = answer('allow-always');
    expect((await execute('PushNotification', { message: 'hello' })).isError).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0].command).toContain('https://example.com/notify');
    await execute('PushNotification', { url: 'https://example.com/other', message: 'again' });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('MCP grants', () => {
  it('asks on the first call and remembers server + tool across registration', async () => {
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    const seen = answer('allow-always');
    expect((await execute(tool.name, { message: 'one' })).isError).toBe(false);
    setExtraTools([tool]);
    expect((await execute(tool.name, { message: 'two' })).isError).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(grantedAllowRules(getDb())).toEqual(['mcp:fake/send']);
    const otherServer = mcpTool('other');
    const otherTool = mcpTool('fake', 'delete');
    setExtraTools([otherServer.tool, otherTool.tool]);
    await execute(otherServer.tool.name, {});
    await execute(otherTool.tool.name, {});
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it('does not execute a denied tool', async () => {
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    const seen = answer('deny');
    expect((await execute(tool.name, {})).isError).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('lists and revokes network/MCP grants through /permissions', async () => {
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    const seen = answer('allow-always');
    await execute(tool.name, {});
    await execute('RemoteTrigger', { url: 'https://example.com' });
    const ctx = {} as Parameters<typeof permissionsCommand.execute>[0];
    const summary = await permissionsCommand.execute(ctx, '');
    expect(summary).toContain('mcp:fake/send');
    expect(summary).toContain('network:https://example.com');
    await permissionsCommand.execute(ctx, 'revoke mcp:fake/send');
    await permissionsCommand.execute(ctx, 'revoke network:https://example.com');
    expect(grantedAllowRules(getDb())).toEqual([]);
    await execute(tool.name, {});
    await execute('RemoteTrigger', { url: 'https://example.com' });
    expect(seen).toHaveBeenCalledTimes(4);
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});

describe('shared policy and dispatch', () => {
  it('bypasses consent in unrestricted mode for files, network, MCP and Bash secrets', async () => {
    configure({ mode: 'unrestricted' });
    const seen = answer('deny');
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    const path = join(home, 'secrets.env');
    expect((await execute('Write', { path, content: 'old' })).isError).toBe(false);
    expect((await execute('Edit', { path, oldString: 'old', newString: 'new' })).isError).toBe(
      false,
    );
    expect((await execute('Read', { path })).isError).toBe(false);
    expect(
      (await execute('Write', { path: join(workspace, '.git/config'), content: '[core]' })).isError,
    ).toBe(false);
    expect((await execute('RemoteTrigger', { url: 'https://example.com' })).isError).toBe(false);
    expect(
      (await execute('PushNotification', { url: 'https://example.com', message: 'hi' })).isError,
    ).toBe(false);
    expect((await execute(tool.name, {})).isError).toBe(false);
    for (const command of [
      'cat ~/.asterisk/secrets.env',
      'env',
      'printenv',
      'jq -n env',
      'cat /proc/self/environ',
    ]) {
      expect(evaluateCommand(command, { mode: 'unrestricted', allow: [], deny: [] }).action).toBe(
        'allow',
      );
    }
    expect(seen).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('uses headless defaults and the same per-session override as Bash', async () => {
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    expect((await execute(tool.name, {})).isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
    const result = await runWithSession(
      { id: 'scheduled:test', scope: 'scheduled', headlessOverride: 'allow' },
      () => execute(tool.name, {}),
    );
    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
    configure({ headless: 'allow' });
    expect((await execute('RemoteTrigger', { url: 'https://example.com' })).isError).toBe(false);
    expect(grantedAllowRules(getDb())).toEqual([]);
  });

  it('refuses ungranted actions without prompting in allowlist mode', async () => {
    configure({ mode: 'allowlist' });
    const seen = answer();
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    expect((await execute(tool.name, {})).isError).toBe(true);
    expect((await execute('RemoteTrigger', { url: 'https://example.com' })).isError).toBe(true);
    expect(
      (await execute('Write', { path: join(workspace, '.git/config'), content: 'x' })).isError,
    ).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    grantRules(getDb(), ['mcp:fake/send']);
    expect((await execute(tool.name, {})).isError).toBe(false);
  });

  it('applies exact deny rules before remembered grants', async () => {
    configure({ deny: ['mcp:fake/send', 'network:https://example.com'] });
    grantRules(getDb(), ['mcp:fake/send', 'network:https://example.com']);
    const seen = answer();
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    expect((await execute(tool.name, {})).isError).toBe(true);
    expect((await execute('RemoteTrigger', { url: 'https://example.com' })).isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not execute when an approval is aborted', async () => {
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    const ctrl = new AbortController();
    onApprovalRequest(() => ctrl.abort());
    expect((await execute(tool.name, {}, ctrl.signal)).isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('routes a loop dispatch to its own bot session', async () => {
    const path = join(workspace, '.git/config');
    const seen = answer('deny');
    let turn = 0;
    const provider: Provider = {
      name: 'fake',
      async send() {
        return turn++ === 0
          ? {
              content: [
                {
                  type: 'tool_use',
                  id: 'write',
                  name: 'Write',
                  input: { path, content: 'payload' },
                },
              ],
              stopReason: 'tool_use',
            }
          : { content: [{ type: 'text', text: 'refused' }], stopReason: 'end_turn' };
      },
    };
    await runAgentTurn(provider, createAgentState(), 'write', {
      session: { id: 'bot:42', scope: 'telegram' },
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0].sessionId).toBe('bot:42');
    await expect(readFile(path)).rejects.toThrow();
  });

  it('does not send one bot session the approval for another', async () => {
    const seen = vi.fn();
    onApprovalRequest(seen, { accepts: (id) => id === 'bot:7' });
    const result = await runWithSession({ id: 'bot:42', scope: 'telegram' }, () =>
      execute('RemoteTrigger', { url: 'https://example.com' }),
    );
    expect(result.isError).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(automaticDenialCount('bot:42')).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('enforces file, network and MCP approval inside RunCode', async () => {
    const { tool, callTool } = mcpTool();
    setExtraTools([tool]);
    const seen = answer('deny');
    const path = join(workspace, '.git/config');
    const program = `
      const a = tool('Write', { path: ${JSON.stringify(path)}, content: 'payload' });
      const b = tool('RemoteTrigger', { url: 'https://example.com' });
      const c = tool('fake__send', {});
      return [a.ok, b.ok, c.ok];
    `;
    const result = await execute('RunCode', { program });
    expect(result.output).toContain('3 failed');
    expect(seen).toHaveBeenCalledTimes(3);
    expect(callTool).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toThrow();
  });
});
