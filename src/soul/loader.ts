// SOUL.md — the agent's persona + your relationship description, loaded
// into every system prompt. Modelled on OpenClaw's per-agent identity
// cards. Two locations, both optional, both used if present:
//
//   ~/.asterisk/SOUL.md            user-global persona ("how the assistant
//                                  should be with me")
//   <cwd>/.asterisk/SOUL.md        project-local persona (overrides /
//   <cwd>/SOUL.md                  augments the user-level one for work
//                                  in this repo)
//
// Resolution order: user first, then project — the project soul gets the
// last word in the system prompt so it overrides on conflict.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Soul {
  scope: 'user' | 'project';
  path: string;
  content: string;
}

export function loadSouls(cwd: string = process.cwd()): Soul[] {
  const userRoot = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  const candidates: { scope: Soul['scope']; path: string }[] = [
    { scope: 'user', path: join(userRoot, 'SOUL.md') },
    { scope: 'project', path: join(cwd, '.asterisk', 'SOUL.md') },
    { scope: 'project', path: join(cwd, 'SOUL.md') },
  ];

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

export function soulsToPromptSection(souls: readonly Soul[]): string {
  if (souls.length === 0) return '';
  const blocks = souls.map((s) => {
    const label = s.scope === 'user' ? 'user soul' : 'project soul';
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
