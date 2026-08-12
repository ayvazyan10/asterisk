// SOUL.md — the agent's persona + your relationship description, loaded
// into every system prompt. Modelled on OpenClaw's per-agent identity
// cards. Up to three locations, all optional, all used if present:
//
//   ~/.asterisk/SOUL.md                       user-global persona
//                                             ("how the assistant should be")
//   ~/.asterisk/souls/<scope>-<sid>.md        per-chat persona — the bot
//                                             user's own soul, written via
//                                             /soul set in chat
//   <cwd>/.asterisk/SOUL.md                   project-local persona
//   <cwd>/SOUL.md                             project root marker
//
// Resolution order: user → session → project. Later blocks get the last
// word in the prompt so a personal "call me Levon, reply in Russian"
// overrides a generic operator persona, and a project soul can still
// pin down repo-specific tone on top of that.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentSession } from '../agent/context.ts';

export interface Soul {
  scope: 'user' | 'session' | 'project';
  path: string;
  content: string;
}

function asteriskHome(): string {
  return process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
}

/** Filesystem-safe filename for a session's per-chat SOUL.md. We never use
 *  the raw chatId (it can contain `:`, `+`, `/`) — just letters, digits, and
 *  a few harmless punctuation characters. */
export function sessionSoulPath(session: AgentSession): string {
  const safe = `${session.scope}-${session.id}`.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return join(asteriskHome(), 'souls', `${safe}.md`);
}

export function loadSouls(cwd: string = process.cwd(), session?: AgentSession): Soul[] {
  const userRoot = asteriskHome();
  const candidates: { scope: Soul['scope']; path: string }[] = [
    { scope: 'user', path: join(userRoot, 'SOUL.md') },
  ];
  if (session) candidates.push({ scope: 'session', path: sessionSoulPath(session) });
  candidates.push(
    { scope: 'project', path: join(cwd, '.asterisk', 'SOUL.md') },
    { scope: 'project', path: join(cwd, 'SOUL.md') },
  );

  const seenScopes = new Set<Soul['scope']>();
  const out: Soul[] = [];
  for (const c of candidates) {
    if (seenScopes.has(c.scope)) continue;
    if (!existsSync(c.path)) continue;
    if (!statSync(c.path).isFile()) continue;
    const content = readFileSync(c.path, 'utf8').trim();
    if (!content) continue;
    out.push({ ...c, content });
    seenScopes.add(c.scope);
  }
  return out;
}

/** Replace (or create) the per-session soul. Returns the absolute path written. */
export function writeSessionSoul(session: AgentSession, content: string): string {
  const path = sessionSoulPath(session);
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, { mode: 0o644 });
  return path;
}

/** Drop a per-session soul. Idempotent — fine if the file doesn't exist. */
export function clearSessionSoul(session: AgentSession): boolean {
  const path = sessionSoulPath(session);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Read the raw per-session soul content (untrimmed), or null if absent. */
export function readSessionSoul(session: AgentSession): string | null {
  const path = sessionSoulPath(session);
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) return null;
  return readFileSync(path, 'utf8');
}

export function soulsToPromptSection(souls: readonly Soul[]): string {
  if (souls.length === 0) return '';
  const blocks = souls.map((s) => {
    const label =
      s.scope === 'user' ? 'user soul' : s.scope === 'session' ? 'your soul' : 'project soul';
    return `## ${label} (${s.path.split('/').slice(-2).join('/')})\n${s.content}`;
  });
  return [
    '# Soul — who you are and who you are talking to',
    'These instructions describe your identity, tone, and the user. Honour',
    'them in every response unless they would conflict with safety or with',
    "the user's explicit current instructions.",
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** Default template the /soul init command writes when no SOUL.md exists.
 *  Kept as plain markdown so the user can edit by hand. */
export const DEFAULT_SOUL_TEMPLATE = `# Asterisk Soul

## You (the assistant)
You are friendly, concise, and direct. You speak like a senior engineer
talking to another senior engineer — no patronising explanations of
well-known concepts, no filler.

You always:
- Lead with the action, not the preamble.
- Show your work briefly (one sentence per step) when running tools.
- Push back politely when the user asks for something likely to be a
  mistake — better than silently doing the wrong thing.

You never:
- Invent file paths, URLs, or function names — verify with a tool first.
- Apologise unnecessarily ("Sorry for any confusion…").
- Pad replies with restated context the user already gave.

## Me (the user)
- Name: (your name)
- Native language: (your language)
- Time zone: (your tz)
- Preferences:
  - (e.g. terse over verbose)
  - (e.g. always run typecheck + tests before claiming done)
  - (e.g. don't add comments unless they explain *why*)
`;
