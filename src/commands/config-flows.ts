// `/config` — the interactive configuration flows.
//
// One entry per config section; each returns a FormSpec the REPL renders.
// Split out of registry.ts, which was over 2000 lines against the repo's own
// 800-line limit. Pure move — no behaviour changed.

import { loadConfig, saveConfig, saveSecrets } from '../config/load.ts';
import type { AsteriskConfig } from '../config/schema.ts';
import type { FormSpec, ListSpec } from '../repl/forms/types.ts';
import { listAnthropicModels } from './models.ts';
import type { CommandContext, CommandResult, SlashCommand } from './registry.ts';

export const configCommand: SlashCommand = {
  name: '/config',
  description: 'Edit configuration sections',
  usage: '/config [section]',
  execute(ctx, args) {
    const target = args.trim().toLowerCase();
    if (target) {
      const section = configSectionByKey(target);
      if (section) return openConfigSection(ctx, section);
      return `unknown config section: ${target}`;
    }
    const list: ListSpec = {
      kind: 'list',
      title: 'Edit which section?',
      items: CONFIG_SECTIONS.map((s) => ({
        value: s.key,
        label: s.label,
        description: s.summary,
      })),
      onPick: (v) => {
        const section = configSectionByKey(v);
        return section ? openConfigSection(ctx, section) : `unknown config section: ${v}`;
      },
      onCancel: () => null,
    };
    return list;
  },
};

// ─────────────────────────────────────────────────────────────────────────
//  /config sections
// ─────────────────────────────────────────────────────────────────────────

interface ConfigSection {
  key: string;
  label: string;
  summary: string;
  open(ctx: CommandContext): Promise<FormSpec | string> | FormSpec | string;
}

const CONFIG_SECTIONS: ConfigSection[] = [
  {
    key: 'provider',
    label: 'Default provider',
    summary: 'ollama or anthropic at startup',
    open() {
      const cfg = loadConfig().config;
      return {
        kind: 'form',
        title: 'Default provider',
        fields: [
          {
            kind: 'select',
            key: 'provider',
            label: 'Provider',
            // All three, because SelectRow clamps an out-of-options value to
            // index 0 — so omitting openai-compatible did not merely hide it,
            // it silently moved anyone using it onto Ollama the moment they
            // touched the arrow keys.
            options: [
              { value: 'ollama', label: 'Ollama (local)' },
              { value: 'openai-compatible', label: 'OpenAI-compatible (llama.cpp, LM Studio, …)' },
              { value: 'anthropic', label: 'Anthropic API' },
            ],
            defaultValue: cfg.provider,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig().config;
          next.provider = (v['provider'] ?? next.provider) as AsteriskConfig['provider'];
          saveConfig(next);
          return `✓ default provider set to ${next.provider} (restart REPL or use /reset to apply)`;
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'ollama',
    label: 'Ollama settings',
    summary: 'base URL, default model, context window',
    open() {
      const cfg = loadConfig().config.ollama;
      return {
        kind: 'form',
        title: 'Ollama settings',
        fields: [
          {
            kind: 'text',
            key: 'baseUrl',
            label: 'Base URL',
            defaultValue: cfg.baseUrl,
            required: true,
          },
          {
            kind: 'text',
            key: 'model',
            label: 'Default model',
            defaultValue: cfg.model,
            required: true,
          },
          {
            kind: 'text',
            key: 'contextWindow',
            label: 'Context window (tokens)',
            defaultValue: String(cfg.contextWindow),
            required: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig().config;
          next.ollama.baseUrl = (v['baseUrl'] ?? next.ollama.baseUrl).trim();
          next.ollama.model = (v['model'] ?? next.ollama.model).trim();
          const ctxN = Number.parseInt(v['contextWindow'] ?? '', 10);
          if (Number.isFinite(ctxN) && ctxN > 0) next.ollama.contextWindow = ctxN;
          saveConfig(next);
          return '✓ Ollama settings saved (use /reset to apply)';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'anthropic',
    label: 'Anthropic settings',
    summary: 'default model + API key (chmod-600 secrets file)',
    async open() {
      const cfg = loadConfig();
      const apiKey = cfg.secrets.ANTHROPIC_API_KEY ?? '';
      const models = await listAnthropicModels(apiKey);
      const defaultModel = models.some((m) => m.id === cfg.config.anthropic.model)
        ? cfg.config.anthropic.model
        : (models[0]?.id ?? cfg.config.anthropic.model);
      return {
        kind: 'form',
        title: apiKey
          ? `Anthropic settings (${models.length} models from /v1/models)`
          : 'Anthropic settings (offline list — set API key for live)',
        fields: [
          {
            kind: 'select',
            key: 'model',
            label: 'Default model',
            options: models.map((m) => {
              const opt: { value: string; label: string; description?: string } = {
                value: m.id,
                label: m.label,
              };
              if (m.label !== m.id) opt.description = m.id;
              return opt;
            }),
            defaultValue: defaultModel,
          },
          {
            kind: 'text',
            key: 'apiKey',
            label: 'API key (leave empty to keep existing)',
            placeholder: apiKey ? '(set)' : '(unset)',
            secret: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig();
          next.config.anthropic.model = (v['model'] ?? next.config.anthropic.model).trim();
          saveConfig(next.config);
          const newKey = (v['apiKey'] ?? '').trim();
          if (newKey) {
            saveSecrets({ ...next.secrets, ANTHROPIC_API_KEY: newKey });
            return '✓ Anthropic settings saved (key updated)';
          }
          return '✓ Anthropic settings saved';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'telegram',
    label: 'Telegram bot',
    summary: 'enable, allowed user IDs, token, reply mode',
    open() {
      const cfg = loadConfig();
      return {
        kind: 'form',
        title: 'Telegram bot',
        fields: [
          {
            kind: 'confirm',
            key: 'enabled',
            label: 'Enable Telegram bot?',
            defaultValue: cfg.config.bots.telegram.enabled ? 'yes' : 'no',
          },
          {
            kind: 'text',
            key: 'allowedUserIds',
            label: 'Allowed Telegram user IDs (comma-separated)',
            defaultValue: cfg.config.bots.telegram.allowedUserIds.join(','),
          },
          {
            kind: 'text',
            key: 'token',
            label: 'Bot token (leave empty to keep existing)',
            placeholder: cfg.secrets.ASTERISK_TELEGRAM_BOT_TOKEN ? '(set)' : '(unset)',
            secret: true,
          },
          {
            kind: 'select',
            key: 'streamMode',
            label: 'Reply delivery mode',
            options: [
              { value: 'final', label: 'final — one message at end (cheapest)' },
              { value: 'status', label: 'status — live tool-call status, replaced by final reply' },
              { value: 'stream', label: 'stream — text streams as it arrives' },
            ],
            defaultValue: cfg.config.bots.telegram.streamMode,
          },
          {
            kind: 'text',
            key: 'streamThrottleMs',
            label: 'Edit throttle (ms, 250–10000) · only used by status/stream',
            defaultValue: String(cfg.config.bots.telegram.streamThrottleMs),
          },
          {
            kind: 'select',
            key: 'parseMode',
            label: 'Text formatting',
            options: [
              {
                value: 'html',
                label: 'html — render **bold**, *italic*, `code`, links (recommended)',
              },
              { value: 'plain', label: 'plain — show markdown markers as literal text' },
            ],
            defaultValue: cfg.config.bots.telegram.parseMode,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig();
          next.config.bots.telegram.enabled = (v['enabled'] ?? 'no') === 'yes';
          next.config.bots.telegram.allowedUserIds = (v['allowedUserIds'] ?? '')
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          const rawMode = (v['streamMode'] ?? 'final').trim().toLowerCase();
          next.config.bots.telegram.streamMode =
            rawMode === 'status' || rawMode === 'stream' ? rawMode : 'final';
          const throttle = Number.parseInt(v['streamThrottleMs'] ?? '', 10);
          if (Number.isFinite(throttle) && throttle >= 250 && throttle <= 10000) {
            next.config.bots.telegram.streamThrottleMs = throttle;
          }
          const rawParse = (v['parseMode'] ?? 'html').trim().toLowerCase();
          next.config.bots.telegram.parseMode = rawParse === 'plain' ? 'plain' : 'html';
          saveConfig(next.config);
          const token = (v['token'] ?? '').trim();
          if (token) {
            saveSecrets({ ...next.secrets, ASTERISK_TELEGRAM_BOT_TOKEN: token });
            return '✓ Telegram settings saved (token updated; restart daemon to apply)';
          }
          return '✓ Telegram settings saved (restart daemon to apply)';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'daemon',
    label: 'Daemon',
    summary: 'log level, heartbeat interval',
    open() {
      const cfg = loadConfig().config.daemon;
      return {
        kind: 'form',
        title: 'Daemon settings',
        fields: [
          {
            kind: 'select',
            key: 'logLevel',
            label: 'Log level',
            options: [
              { value: 'fatal', label: 'fatal' },
              { value: 'error', label: 'error' },
              { value: 'warn', label: 'warn' },
              { value: 'info', label: 'info' },
              { value: 'debug', label: 'debug' },
              { value: 'trace', label: 'trace' },
            ],
            defaultValue: cfg.logLevel,
          },
          {
            kind: 'text',
            key: 'heartbeatSeconds',
            label: 'Heartbeat (seconds)',
            defaultValue: String(cfg.heartbeatSeconds),
            required: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig().config;
          next.daemon.logLevel = (v['logLevel'] ?? next.daemon.logLevel) as
            | 'fatal'
            | 'error'
            | 'warn'
            | 'info'
            | 'debug'
            | 'trace';
          const hb = Number.parseInt(v['heartbeatSeconds'] ?? '', 10);
          if (Number.isFinite(hb) && hb >= 5) next.daemon.heartbeatSeconds = hb;
          saveConfig(next);
          return '✓ Daemon settings saved (restart daemon to apply)';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
];

function configSectionByKey(key: string): ConfigSection | undefined {
  return CONFIG_SECTIONS.find((s) => s.key === key);
}

async function openConfigSection(
  ctx: CommandContext,
  section: ConfigSection,
): Promise<CommandResult> {
  return await section.open(ctx);
}
