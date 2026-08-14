// The bridge between the approval channel and a chat transport.
//
// This is the piece that was missing entirely: the policy asked, nobody was
// subscribed in the daemon, and the request resolved from permissions.headless.
// The tests below pin down who gets asked, who does not, and what happens when
// the transport cannot answer.

import { afterEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import type { ApprovalPrompt } from '../src/bots/adapter.ts';
import { attachChatApprovals } from '../src/bots/approval-bridge.ts';
import {
  type ApprovalOutcome,
  _resetApprovalsForTesting,
  hasApprover,
  requestApproval,
} from '../src/tools/approval.ts';

interface FakeManager {
  canPromptApproval(): boolean;
  promptApproval(chatId: string, prompt: ApprovalPrompt): Promise<ApprovalOutcome>;
  calls: Array<{ chatId: string; prompt: ApprovalPrompt }>;
}

function fakeManager(
  answer: ApprovalOutcome | Error,
  opts: { canPrompt?: boolean } = {},
): FakeManager {
  const calls: Array<{ chatId: string; prompt: ApprovalPrompt }> = [];
  return {
    calls,
    canPromptApproval: () => opts.canPrompt ?? true,
    async promptApproval(chatId, prompt) {
      calls.push({ chatId, prompt });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const REQUEST = { command: 'npm ci', reason: 'not on the allowlist', rules: ['npm ci'] };
const OPTS = { timeoutMs: 2_000, headless: 'deny' as const };

afterEach(() => {
  _resetApprovalsForTesting();
});

describe('chat approval bridge', () => {
  it('asks the chat that raised the request and returns its answer', async () => {
    const manager = fakeManager('allow-always');
    const detach = attachChatApprovals({ manager, enabled: () => true, timeoutMs: () => 1_000 });

    const result = await runWithSession({ id: 'bot:275805082', scope: 'telegram' }, () =>
      requestApproval(REQUEST, OPTS),
    );

    expect(result.outcome).toBe('allow-always');
    expect(result.automatic).toBeUndefined();
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.chatId).toBe('275805082');
    expect(manager.calls[0]?.prompt).toMatchObject({ command: 'npm ci', timeoutMs: 1_000 });
    detach();
  });

  it('leaves scheduled runs unattended', async () => {
    const manager = fakeManager('allow-once');
    const detach = attachChatApprovals({ manager, enabled: () => true, timeoutMs: () => 1_000 });

    // A cron job firing at 04:00 has nobody to prompt, so the headless default
    // decides — and it must not be routed into somebody's chat.
    expect(hasApprover('scheduled:cron')).toBe(false);
    const result = await runWithSession({ id: 'scheduled:cron', scope: 'scheduled' }, () =>
      requestApproval(REQUEST, OPTS),
    );

    expect(result).toEqual({ outcome: 'deny', automatic: true });
    expect(manager.calls).toHaveLength(0);
    detach();
  });

  it('stays out of the way when chat approvals are switched off', async () => {
    const manager = fakeManager('allow-once');
    const detach = attachChatApprovals({ manager, enabled: () => false, timeoutMs: () => 1_000 });

    expect(hasApprover('bot:1')).toBe(false);
    const result = await runWithSession({ id: 'bot:1', scope: 'telegram' }, () =>
      requestApproval(REQUEST, OPTS),
    );

    expect(result).toEqual({ outcome: 'deny', automatic: true });
    expect(manager.calls).toHaveLength(0);
    detach();
  });

  it('does not claim an approver when no transport can show a prompt', async () => {
    const manager = fakeManager('allow-once', { canPrompt: false });
    const detach = attachChatApprovals({ manager, enabled: () => true, timeoutMs: () => 1_000 });

    expect(hasApprover('bot:1')).toBe(false);
    detach();
  });

  it('treats a config that cannot be read as nobody being there', async () => {
    const manager = fakeManager('allow-once');
    const detach = attachChatApprovals({
      manager,
      enabled: () => {
        throw new Error('database is locked');
      },
      timeoutMs: () => 1_000,
    });

    expect(hasApprover('bot:1')).toBe(false);
    detach();
  });

  it('denies when the transport fails to deliver the question', async () => {
    const manager = fakeManager(new Error('chat not found'));
    const logged: string[] = [];
    const detach = attachChatApprovals({
      manager,
      enabled: () => true,
      timeoutMs: () => 1_000,
      log: (_fields, msg) => logged.push(msg),
    });

    const result = await runWithSession({ id: 'bot:1', scope: 'telegram' }, () =>
      requestApproval(REQUEST, OPTS),
    );

    // A transport error is a refusal, and one the daemon log records —
    // silently denying would look identical to the user saying no.
    expect(result.outcome).toBe('deny');
    expect(logged).toContain('approval prompt failed');
    detach();
  });

  it('stops answering once detached', async () => {
    const manager = fakeManager('allow-once');
    const detach = attachChatApprovals({ manager, enabled: () => true, timeoutMs: () => 1_000 });
    detach();

    const result = await runWithSession({ id: 'bot:1', scope: 'telegram' }, () =>
      requestApproval(REQUEST, OPTS),
    );

    expect(result).toEqual({ outcome: 'deny', automatic: true });
    expect(manager.calls).toHaveLength(0);
  });
});
