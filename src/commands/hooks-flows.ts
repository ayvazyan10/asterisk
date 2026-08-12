// `/hooks` — manage the shell commands fired at agent-loop lifecycle events.
//
// Split out of registry.ts to keep it under the repo's 800-line limit.
// Pure move — no behaviour changed.

import { loadConfig, saveConfig } from '../config/load.ts';
import { type HookConfig, HookConfigSchema } from '../config/schema.ts';
import type { FormSpec, ListSpec } from '../repl/forms/types.ts';
import type { CommandContext, CommandResult, SlashCommand } from './registry.ts';

export const hooksCommand: SlashCommand = {
  name: '/hooks',
  description: 'Manage agent-loop lifecycle hooks',
  usage: '/hooks [list|add|remove|toggle]',
  async execute(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) return hooksActionPicker(ctx);
    const [verb, ...rest] = trimmed.split(/\s+/);
    if (verb === 'list') return formatHookList();
    if (verb === 'add') return hooksAddForm();
    if (verb === 'remove') {
      const name = rest[0];
      if (!name) return hooksRemovePicker();
      return removeHookByName(name);
    }
    if (verb === 'toggle') {
      const name = rest[0];
      if (!name) return hooksTogglePicker();
      return toggleHookByName(name);
    }
    return `unknown /hooks verb: ${verb}`;
  },
};

function hooksActionPicker(_ctx: CommandContext): ListSpec {
  return {
    kind: 'list',
    title: 'Hooks — pick an action',
    items: [
      { value: 'list', label: 'List', description: 'show configured hooks' },
      { value: 'add', label: 'Add', description: 'register a new hook' },
      { value: 'toggle', label: 'Toggle', description: 'enable / disable a hook' },
      { value: 'remove', label: 'Remove', description: 'delete a hook' },
    ],
    onPick: async (v): Promise<CommandResult> => {
      if (v === 'list') return formatHookList();
      if (v === 'add') return hooksAddForm();
      if (v === 'toggle') return hooksTogglePicker();
      if (v === 'remove') return hooksRemovePicker();
      return null;
    },
    onCancel: () => null,
  };
}

function formatHookList(): string {
  const cfg = loadConfig().config;
  if (cfg.hooks.length === 0) {
    return [
      'No hooks configured.',
      '',
      'Hooks fire shell commands at agent-loop events:',
      '  before_turn / after_turn / before_tool / after_tool / on_error',
      '',
      'Add one with /hooks add — your command receives the event payload',
      'as JSON on stdin and can do whatever (lint, log, notify, …).',
    ].join('\n');
  }
  const lines = [`Hooks  ${cfg.hooks.length} configured`];
  for (const h of cfg.hooks) {
    const dot = h.enabled ? '●' : '○';
    const matcher = h.matcher ? `  /${h.matcher}/` : '';
    lines.push(`  ${dot} ${h.name.padEnd(24)} ${h.event.padEnd(12)}${matcher}`);
    lines.push(`    ${h.command}`);
  }
  return lines.join('\n');
}

function hooksAddForm(): FormSpec {
  return {
    kind: 'form',
    title: 'Add a hook',
    fields: [
      { kind: 'text', key: 'name', label: 'Name', placeholder: 'lint-on-write', required: true },
      {
        kind: 'select',
        key: 'event',
        label: 'Event',
        options: [
          {
            value: 'before_turn',
            label: 'before_turn',
            description: 'before the user message goes to the model',
          },
          { value: 'after_turn', label: 'after_turn', description: 'after the agent finishes' },
          { value: 'before_tool', label: 'before_tool', description: 'before each tool call' },
          { value: 'after_tool', label: 'after_tool', description: 'after each tool call' },
          { value: 'on_error', label: 'on_error', description: 'on agent or tool error' },
        ],
        defaultValue: 'after_tool',
      },
      {
        kind: 'text',
        key: 'matcher',
        label: 'Matcher (optional regex on tool/text)',
        placeholder: 'e.g. ^Write|Edit$',
      },
      {
        kind: 'text',
        key: 'command',
        label: 'Shell command',
        placeholder: 'jq -r .tool',
        required: true,
      },
      {
        kind: 'text',
        key: 'timeoutSeconds',
        label: 'Timeout (seconds)',
        defaultValue: '30',
      },
      { kind: 'confirm', key: 'enabled', label: 'Enable now?', defaultValue: 'yes' },
    ],
    onSubmit: (v) => {
      const cfg = loadConfig();
      const name = (v['name'] ?? '').trim();
      if (!name) return 'name is required';
      if (cfg.config.hooks.some((h: HookConfig) => h.name === name)) {
        return `hook "${name}" already exists`;
      }
      const timeoutN = Number.parseInt(v['timeoutSeconds'] ?? '30', 10);
      const matcher = (v['matcher'] ?? '').trim();
      const hook: HookConfig = {
        name,
        event: (v['event'] ?? 'after_tool') as HookConfig['event'],
        command: (v['command'] ?? '').trim(),
        timeoutSeconds: Number.isFinite(timeoutN) && timeoutN > 0 ? timeoutN : 30,
        enabled: (v['enabled'] ?? 'yes') === 'yes',
        ...(matcher ? { matcher } : {}),
      };
      cfg.config.hooks.push(hook);
      saveConfig(cfg.config);
      return `✓ added hook "${hook.name}" (${hook.event}${matcher ? ` / ${matcher}` : ''})`;
    },
    onCancel: () => '(cancelled)',
  };
}

function hooksRemovePicker(): ListSpec {
  const cfg = loadConfig().config;
  return {
    kind: 'list',
    title: 'Remove which hook?',
    items: cfg.hooks.map((h: HookConfig) => ({
      value: h.name,
      label: h.name,
      description: `${h.event} · ${h.command}`,
    })),
    emptyMessage: 'No hooks configured.',
    onPick: (name) => removeHookByName(name),
    onCancel: () => null,
  };
}

function removeHookByName(name: string): FormSpec {
  return {
    kind: 'form',
    title: `Remove hook "${name}"?`,
    fields: [{ kind: 'confirm', key: 'confirm', label: 'Are you sure?', defaultValue: 'no' }],
    onSubmit: (v) => {
      if (v['confirm'] !== 'yes') return '(kept)';
      const cfg = loadConfig();
      const before = cfg.config.hooks.length;
      cfg.config.hooks = cfg.config.hooks.filter((h: HookConfig) => h.name !== name);
      if (cfg.config.hooks.length === before) return `no hook named "${name}"`;
      saveConfig(cfg.config);
      return `✓ removed hook "${name}"`;
    },
    onCancel: () => '(cancelled)',
  };
}

function hooksTogglePicker(): ListSpec {
  const cfg = loadConfig().config;
  return {
    kind: 'list',
    title: 'Toggle which hook?',
    items: cfg.hooks.map((h: HookConfig) => ({
      value: h.name,
      label: h.name,
      description: `${h.event} · ${h.enabled ? 'enabled' : 'disabled'}`,
    })),
    emptyMessage: 'No hooks configured.',
    onPick: (name) => toggleHookByName(name),
    onCancel: () => null,
  };
}

function toggleHookByName(name: string): string {
  const cfg = loadConfig();
  const hook = cfg.config.hooks.find((h: HookConfig) => h.name === name);
  if (!hook) return `no hook named "${name}"`;
  hook.enabled = !hook.enabled;
  saveConfig(cfg.config);
  return `✓ "${name}" is now ${hook.enabled ? 'enabled' : 'disabled'}`;
}
