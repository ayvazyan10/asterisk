// Bundled skills — ship with Asterisk, available out of the box. Mirrors
// the bundled-skill pattern in Claude Code (see claude-code-main
// src/skills/bundled/index.ts) but the *content* of each prompt is
// authored fresh from public guidance — no copying.
//
// Resolution order in src/skills/loader.ts:
//   project-local  >  user-global  >  bundled (this file)
// so the user can override any bundled skill by creating a same-named one
// under .asterisk/skills/<name>/SKILL.md.

import type { Skill } from './loader.ts';

export const BUNDLED_SKILLS: Skill[] = [
  {
    name: 'simplify',
    description: 'Review your recent changes for reuse, quality, and efficiency, then fix what you find',
    scope: 'bundled',
    path: 'bundled:simplify',
    prompt: `You are reviewing the user's recent changes.

Steps:
1. Run \`git status\` and \`git diff\` to see what's changed.
2. For each modified hunk, look for:
   - **Reuse**: is there existing code (utils/helpers) the new code duplicates? Grep for similar names/shapes.
   - **Naming**: are variables, functions, files clearly named?
   - **Efficiency**: any obvious perf issues — N+1 loops, redundant work, missing memoization?
   - **Correctness**: missing edge cases, unhandled errors?
   - **Cohesion**: does this belong in the file it's in, or should it be split out?
3. For each finding, decide: fix now, leave a comment, or flag for follow-up.
4. Apply fixes via Edit. Run typecheck / lint / tests if available.
5. Summarise: what you found, what you fixed, what you flagged.

Be specific and concrete. Don't invent issues that aren't there.`,
  },
  {
    name: 'batch',
    description: 'Apply the same operation to many targets in one pass',
    scope: 'bundled',
    path: 'bundled:batch',
    prompt: `Apply an operation across many targets — files, modules, branches, services, … — without losing track of progress.

Steps:
1. State the operation and the target set in one sentence each. Confirm with the user via AskUserQuestion if any are ambiguous.
2. Enumerate targets — Glob / Grep / Bash if they aren't given explicitly. Cap at a sane number; if there are too many, ask.
3. Create a TaskCreate entry per target so progress is visible. Mark each in_progress before working on it, completed when done, cancelled if you skipped it (with a reason).
4. Process targets one at a time:
   - Read → apply change → save.
   - If something looks risky or destructive, stop and AskUserQuestion before continuing on that target.
5. After the batch:
   - Run verification (typecheck/lint/tests) once for the whole set, not per target.
   - Summarise: N processed, N succeeded, N failed (with reasons), N skipped.

Don't fan-out for very small batches (≤3); just do them sequentially without TaskList overhead.`,
  },
  {
    name: 'stuck',
    description: 'Diagnose why a task is blocked and propose concrete alternatives',
    scope: 'bundled',
    path: 'bundled:stuck',
    prompt: `Something isn't working. Stop, diagnose, propose alternatives.

Steps:
1. **Restate the goal** in one sentence. If you can't, that's the problem — ask the user.
2. **Inventory what's been tried**: review recent assistant messages, \`git log -20 --oneline\`, recently-modified files (\`find . -mmin -60\` or \`git status\`).
3. **Identify the gap**:
   - **Missing info** — read more code, fetch docs (WebFetch), AskUserQuestion.
   - **Wrong approach** — the current path has a structural problem (e.g. you're fighting the framework).
   - **Tooling issue** — a build/test/dependency is failing in a way that's distracting from the real work.
   - **Scope creep** — you've drifted from the goal.
4. **Propose 2-3 alternatives**, ranked by probability of success. Each should be one paragraph: what to try, why it might work, what would tell you quickly if it doesn't.
5. **Recommend the best one** and start there.

Don't guess at unknowns — go investigate them. The whole point of "stuck" is that you stopped guessing.`,
  },
  {
    name: 'dream',
    description: 'Free-form roam — find something interesting in this codebase and improve it',
    scope: 'bundled',
    path: 'bundled:dream',
    prompt: `Roam the codebase. Find one small improvement the user would thank you for.

Steps:
1. **Get oriented**: read README.md and CLAUDE.md if they exist. \`git log --oneline -20\`. \`ls\` the top-level dirs.
2. **Find candidates** — pick from this priority list (highest-leverage first):
   - A failing test or a recent regression
   - A TODO/FIXME comment that's actually solvable now
   - Code that's clearly harder to read than it needs to be
   - A missing test for important behaviour
   - A small UX rough edge in the user-facing surface (slash command, output formatting, error message)
   - Documentation that's out of date with the code
3. **Pick exactly ONE.** Don't over-scope. Stay under ~100 lines of changed code.
4. **Implement.** Use TaskCreate to track sub-steps if there are more than two.
5. **Verify** — typecheck, tests, build. Don't ship if anything fails.
6. **Summarise** what you did, why, and what you considered but skipped.

Be opinionated about what counts as worthwhile. Don't pick something pedantic (formatting nits, comment polishing). Pick the kind of thing the user would notice and appreciate.`,
  },
  {
    name: 'skillify',
    description: "Turn the current conversation's workflow into a reusable Asterisk skill",
    scope: 'bundled',
    path: 'bundled:skillify',
    prompt: `Capture the recurring workflow from the current conversation as a reusable skill.

Steps:
1. **Identify the pattern.** Re-read the conversation history. What set of steps did you follow that would apply to *similar future tasks*? If nothing recurring is visible, tell the user — there's nothing to skillify.
2. **Name + describe.** Propose a kebab-case name (e.g. "release-notes", "dep-audit") and a one-line description. AskUserQuestion if you're unsure.
3. **Pick scope.** AskUserQuestion: project-local (\`.asterisk/skills/<name>/SKILL.md\` in the current cwd) or user-global (\`~/.asterisk/skills/<name>/SKILL.md\`)?
4. **Write the SKILL.md.** The format is:

   \`\`\`
   ---
   name: <name>
   description: <one-line description>
   ---
   <imperative prompt body — concrete steps, tools to use, success criteria>
   \`\`\`

   Write the body in the same voice as the bundled skills you can see via \`/skills\`. Be specific about which tools to use; assume the future agent has zero context.
5. **Save** via Write to the chosen path.
6. **Verify** by listing \`/skills\` (you'll need to ask the user to run it; you can't trigger slash commands from inside an agent turn).
7. **Summarise**: name, scope, file path, one-line description, and a one-sentence pitch for when to use it.`,
  },
  {
    name: 'verify',
    description: 'Run the project\'s checks (typecheck, lint, tests, build) and report what passed, what failed, and what to fix',
    scope: 'bundled',
    path: 'bundled:verify',
    prompt: `Verify the current project is in a healthy state. The goal is to give the user a clear "green / yellow / red" verdict, not just dump command output.

Steps:
1. **Detect the toolchain.** Read package.json / pyproject.toml / Cargo.toml / go.mod to find the project type. Pick the relevant scripts:
   - JS/TS: \`bun run typecheck\` / \`tsc --noEmit\`, \`bun run lint\` / \`eslint .\` / \`biome check .\`, \`bun run test\` / \`vitest run\`, \`bun run build\`.
   - Python: \`mypy .\`, \`ruff check\`, \`pytest -q\`, \`python -m build\`.
   - Rust: \`cargo check\`, \`cargo clippy\`, \`cargo test\`, \`cargo build --release\`.
   - Go: \`go vet ./...\`, \`golangci-lint run\`, \`go test ./...\`, \`go build ./...\`.
   - If multiple toolchains are present (mono-repo), pick the most relevant one for the user's recent work; ask via AskUserQuestion if it's ambiguous.
2. **Run the checks in parallel** where safe — typecheck and lint can run together, tests separately. Cap each command at a sane timeout.
3. **Classify each result** as ✓ pass, ⚠ warn (lint, deprecation), or ✗ fail (compile/test error).
4. **For each failure, isolate the root cause.** Read the cited file:line, look at the actual code, and explain in one sentence what's wrong. Don't just paste the error.
5. **Summarise** at the end:
   - One-line verdict: "✓ green · all checks pass" or "✗ red · 3 failures, 1 warn".
   - Each failure: file:line · one-sentence cause · proposed fix.
   - If the user asks "fix it", apply the fix and re-run only the affected check.

Honesty rule: don't soften "red" into "yellow" because the user might be sad. If the build is broken, say so plainly.`,
  },
  {
    name: 'debug',
    description: 'Diagnose a specific failure end-to-end — read the error, hunt for the root cause across files, propose a fix',
    scope: 'bundled',
    path: 'bundled:debug',
    prompt: `Diagnose a specific failure the user has hit. The output is a root cause + fix recipe, not a generic checklist.

Steps:
1. **Get the failing input.** Ask the user (via AskUserQuestion) for the exact command, log line, stack trace, or screenshot. If they already pasted it in chat, skip the question.
2. **Reproduce.** Run the failing command yourself if possible (Bash). If it can't be reproduced (intermittent, environmental), capture as much state as you can: \`git status\`, \`git log -1\`, env vars relevant to the error, recent file changes.
3. **Read the error literally.** Don't guess — find the file:line the error names, Read it, and look at the actual code. If the error mentions a function name, Grep for it across the project to see all callers.
4. **Hypothesise + verify, in that order.** Form a one-sentence hypothesis ("the value is undefined here because the upstream call returns null when X"). Then look at the code that would prove or disprove it. Reject a hypothesis as soon as the code contradicts it; don't try to make the code fit your guess.
5. **Check recent changes.** \`git log --oneline -20\` and \`git diff HEAD~1\` for the file in question often surface "this broke at commit X" cheaply.
6. **Propose the fix** as a concrete diff (or call Edit if the user has already authorised it). Explain *why* it fixes the cause, not just what it changes.
7. **Verify.** Re-run the failing command. If it now passes, summarise: cause · fix · how to spot it next time. If it still fails, you missed something — go back to step 3 with the new error.

Don't propose "more logging" as the fix unless the user explicitly asks. The point is to find the cause, not delegate the search to runtime.`,
  },
  {
    name: 'prp-plan',
    description: 'PRP step 1 — capture a one-page Plan-Requirements-Pitch doc the implementer can build against.',
    scope: 'bundled',
    path: 'bundled:prp-plan',
    prompt: `You're producing the planning doc for a feature in the PRP
(Plan / Requirements / Pitch) style. Stay in Plan Mode the whole time —
only read, don't write code. Drop the doc when you're done.

Steps:
1. Restate the request in one sentence. AskUserQuestion if anything is
   ambiguous (target file, surface area, must-have vs nice-to-have).
2. Enter Plan Mode (EnterPlanMode) so you literally can't write anything
   until the plan is approved.
3. Map the codebase touch-points by Read / Grep / Glob — files,
   functions, schemas. Cite each with file:line.
4. Write the doc to PRP-<kebab-name>.md in the current dir (or wherever
   the user pins). Sections:
   - **Pitch** (3 sentences): what · for whom · why now.
   - **Requirements**: must-have list · nice-to-have list · explicit
     non-goals (what we're NOT doing).
   - **Plan**: numbered steps in apply order, with a one-sentence
     rationale per step and the target file(s).
   - **Risks**: tests that might break · rollback strategy · migration
     story for any persisted data or public API.
   - **Test plan**: which existing tests cover this · what's needed new.
5. Save the file via Write. ExitPlanMode. Hand off the path to the user.

Don't apply the changes. The implementer (prp-implement) does that next.`,
  },
  {
    name: 'prp-implement',
    description: 'PRP step 2 — implement against an existing PRP-*.md doc, then verify.',
    scope: 'bundled',
    path: 'bundled:prp-implement',
    prompt: `You implement against a PRP doc. The plan exists; your job is
to execute it without redesigning along the way.

Steps:
1. Find the doc — Glob \`PRP-*.md\` (or read whichever path the user
   passed). Read it.
2. Re-confirm with the user via AskUserQuestion if anything in the doc
   looks stale or ambiguous given the current code.
3. Create a TaskCreate entry per Plan step so progress is visible.
4. For each step in the doc's Plan section, in order:
   - Read the affected file.
   - Apply the change via Edit (use replaceAll:true for repeated
     swaps). Emit independent Edits in the same turn rather than
     sequencing them across turns.
   - Mark the task in_progress while working, completed when done,
     cancelled if you skipped (with a reason).
5. Run the project's checks (use the \`verify\` skill or run
   typecheck / lint / tests directly). Don't claim done until they're
   green.
6. Summarise: what shipped · what was deferred · what's left as
   follow-up. Call out any deviation from the doc and why.

If a Plan step turns out to be wrong (the doc was stale, the code
changed underneath you), STOP and re-plan via prp-plan. Don't barrel
through.`,
  },
  {
    name: 'prp-pr',
    description: 'PRP step 3 — open a pull request from the current branch with a real summary + test plan.',
    scope: 'bundled',
    path: 'bundled:prp-pr',
    prompt: `You open a pull request for the current branch's work. Goal: a
PR description a reviewer can act on without re-deriving context.

Steps:
1. Verify the branch is ready: \`git status\` (no uncommitted local
   changes), \`git log --oneline -20\`, \`git diff <base>...HEAD\` to
   see the full delta. Pick the right base (\`main\` or \`master\` or
   the parent feature branch).
2. Find the PRP doc if there is one (Glob PRP-*.md) — its Pitch /
   Requirements feed the PR summary.
3. Push the branch if it doesn't have a remote tracking branch
   (\`git push -u origin <branch>\`).
4. Open the PR via \`gh pr create\` with:
   - Title: imperative mood, ≤ 72 chars, no emoji unless the project
     uses them, no Co-Authored-By unless explicitly authorised.
   - Body sections: **Summary** (1-3 bullets · what changed and why) ·
     **Test plan** (markdown checklist · what reviewer should verify) ·
     **Notes** (if any: migration, follow-up, deferred items).
5. Return the PR URL.

Never \`gh pr create --no-edit\` your way around a missing description.
A blank PR description is a regression on every reviewer.`,
  },
  {
    name: 'prp-commit',
    description: 'PRP step 4 — commit the current staged + unstaged work with a real WHY message.',
    scope: 'bundled',
    path: 'bundled:prp-commit',
    prompt: `You write a commit for the current state of the working tree.

Steps:
1. \`git status\` — list staged + unstaged + untracked.
2. \`git diff\` (staged) and \`git diff HEAD\` (unstaged) — read what's
   actually changing. Don't commit blind.
3. If there are untracked files that look like artifacts (build outputs,
   logs, secrets), STOP — ask the user to add them to .gitignore first.
   Never \`git add -A\` something that might leak credentials.
4. Stage the right files explicitly (\`git add <path> <path>\`). If
   uncommitted work spans multiple concerns, propose splitting into N
   commits and ask the user.
5. Commit with a real message:
   - First line: ≤ 72 chars, imperative mood, no leading emoji.
   - Body: WHY this change exists, WHAT it deliberately doesn't address,
     any follow-ups. Ground references in file:line where useful.
   - No Co-Authored-By unless explicitly authorised.
6. \`git status\` after to confirm clean. Output the new commit hash.

If a pre-commit hook fails, FIX the underlying issue and retry — never
\`--no-verify\` your way past a hook unless the user explicitly says so.`,
  },
  {
    name: 'santa-loop',
    description: 'Adversarial dual-review — two reviewer sub-agents must both approve before the work is "done".',
    scope: 'bundled',
    path: 'bundled:santa-loop',
    prompt: `You drive a dual-review convergence loop: two independent
reviewer sub-agents look at the same change with different lenses, and
the work is only done when both approve. Stops drift toward any single
reviewer's blind spots.

Steps:
1. Capture the work to review: a diff (\`git diff main...HEAD\`), a
   specific file, or whatever the user pointed at. Stash the contents
   so the loop can re-fetch without re-running expensive setup.
2. Round 1 — dispatch two sub-agents IN PARALLEL via the Agent tool:
   - Agent({prompt:"<change>", subagent_type:"code-reviewer"}) — quality,
     reuse, naming, correctness.
   - Agent({prompt:"<change>", subagent_type:"security-reviewer"}) —
     OWASP, secrets, auth, injection.
   Wait for both. Collect findings.
3. If both reviewers say PASS (no CRITICAL or HIGH issues), you're done.
   Summarise their feedback and stop.
4. If either reports issues, apply the fixes (Edit) and go back to
   step 2. Cap at 5 rounds — if the loop hasn't converged by then,
   surface the remaining disagreement to the user and let them decide.
5. Final output: per-round summary · what changed · final reviewer
   verdicts · the user-decision pivot if any.

Don't argue with the reviewers — fix what's flagged or note explicitly
why you disagree (with reasoning). The loop only converges if you act
on feedback.`,
    // The harness needs more rounds than a typical sub-agent budget.
  },
  {
    name: 'youtube-summarizer',
    description: 'Summarise a YouTube video — title, description, key points, sentiment.',
    scope: 'bundled',
    path: 'bundled:youtube-summarizer',
    prompt: `You summarise a YouTube video. Asterisk doesn't ship with a
transcript fetcher, so you'll lean on what's reachable via WebFetch and
(if installed) yt-dlp / yt-dlp via Bash.

Steps:
1. Get the URL. AskUserQuestion if it's not in the prompt.
2. Try yt-dlp first (\`yt-dlp --get-description --get-title --skip-download
   <url>\`). If yt-dlp is on PATH, also try
   \`yt-dlp --write-auto-subs --skip-download --sub-format srv1 -o '%(id)s' <url>\`
   and then read the resulting .srv1 / .vtt file for the auto-caption
   transcript. This gives you the full content.
3. If yt-dlp isn't available, fall back to WebFetch on the watch URL —
   you'll only see the rendered HTML title + description, not the
   transcript.
4. Produce:
   - **Title** + uploader + duration if known.
   - **TL;DR** (1-2 sentences).
   - **Key points** (5-10 bullets, in the video's order).
   - **Notable quotes** (≤3, with timestamps if you have them).
   - **Sentiment / tone** (one line: explanatory / opinionated / promotional / news / tutorial / …).
   - **Caveat** if you only had the description (not the transcript) —
     say so plainly so the user knows the summary's depth.

Don't fabricate timestamps or quotes that you didn't actually read in
the source.`,
  },
  {
    name: 'loop',
    description: 'Run a recurring task in a controlled loop with explicit stop conditions.',
    scope: 'bundled',
    path: 'bundled:loop',
    prompt: `You drive a recurring task in a loop. The loop is only safe with
explicit stop conditions — open-ended loops aren't allowed.

Steps:
1. Confirm the loop spec via AskUserQuestion if anything is missing:
   what's one iteration · what's the stop condition (count cap, time cap,
   convergence test) · cadence (immediate / interval / cron) · failure
   budget (e.g. "stop after 3 consecutive failures").
2. If a recurring schedule fits better than a tight loop, dispatch via
   the CronCreate tool instead of looping inside this turn — cron survives
   daemon restarts.
3. For an in-turn loop:
   - TaskCreate one task per iteration if bounded; otherwise track a
     single rolling task whose description updates per round.
   - Per iteration: run the work · classify success / soft-fail /
     hard-fail · update the task · check the stop condition.
4. Stop conditions are non-negotiable. If the user said "stop after 5
   failures", you stop at the 5th — even if iteration 6 would have worked.
5. Summarise: ran N iterations · M succeeded · K failed · time spent ·
   last error if any.

Never loop forever. If the parent didn't give a stop condition, ask before
starting.`,
  },
  {
    name: 'schedule',
    description: 'Schedule a future or recurring task via ScheduleWakeup / CronCreate. Friendly wrapper.',
    scope: 'bundled',
    path: 'bundled:schedule',
    prompt: `You set up a future or recurring task. Pick the right tool:

- One-shot delay → ScheduleWakeup(delayMs, prompt). Asterisk fires once
  when the delay elapses.
- Specific time of day or recurring → CronCreate(expression, prompt).
  Standard 5-field cron ("0 9 * * 1-5" = weekdays 9am).

Steps:
1. Get the task description in plain English ("remind me to review the PR
   tomorrow morning"). AskUserQuestion if it's vague.
2. Translate the human time into a delay or cron expression. Show the
   user the parsed schedule + what'll happen at fire time, get explicit
   confirmation before creating.
3. Use the right tool. Capture the returned id.
4. Confirm with CronList / TaskList so the user sees it landed.

Time-zone discipline: assume the user's local TZ unless they specified
otherwise. If they say "9am UTC" use UTC. If unspecified and ambiguous,
ask.

Don't fabricate cron expressions. If you're not sure how to spell
"every other Tuesday", say so and propose an approximation.`,
  },
  {
    name: 'dep-audit',
    description: 'Run the language\'s dependency-vulnerability scanner, classify findings, propose upgrades.',
    scope: 'bundled',
    path: 'bundled:dep-audit',
    prompt: `You audit the project's dependencies for known vulnerabilities.

Steps:
1. Detect the language from the manifest: package.json → \`bun audit\` /
   \`npm audit --json\` / \`pnpm audit\`; pyproject / requirements →
   \`pip-audit\` / \`safety check\`; Cargo.toml → \`cargo audit\`;
   go.mod → \`govulncheck ./...\`; composer.json → \`composer audit\`.
2. Run the scanner. Capture JSON output where the tool supports it.
3. Classify each finding by severity: CRITICAL / HIGH / MEDIUM / LOW.
   Drop findings the project already explicitly silenced (.npmrc audit
   exceptions, cargo-audit ignore lists).
4. For each CRITICAL + HIGH:
   - Show the package · current version · fixed-in version · CVE id ·
     one-line attack summary.
   - Propose the upgrade as a concrete command (\`bun update <pkg>\`,
     \`cargo update -p <pkg>\`, etc.) and check if it requires a
     major-version bump (breaking changes possible).
5. If the parent asked you to fix, apply the upgrade for safe (patch /
   minor) bumps; flag major bumps for explicit user approval first.
6. Verify nothing broke — run the project's tests after upgrades.

Don't apply major-version upgrades autonomously. The fix isn't worth
breaking the build.`,
  },
  {
    name: 'release-notes',
    description: 'Generate release notes from git log between two refs, grouped by type.',
    scope: 'bundled',
    path: 'bundled:release-notes',
    prompt: `You generate release notes between two refs (default: last
tag → HEAD).

Steps:
1. Determine the range. Default base: \`git describe --tags --abbrev=0\`
   (last tag). Default head: \`HEAD\`. AskUserQuestion if the project
   doesn't tag or the user wants a different range.
2. Pull commit log: \`git log <base>..<head> --pretty='%h%x09%s%x09%b'\`.
3. Parse Conventional Commits if present (feat: / fix: / chore: / etc.).
   If the project doesn't use them, classify by keyword + diff inspection
   (commits touching tests → "Tests"; commits in docs/ → "Docs").
4. Group:
   - **Added** — feat: + new functionality.
   - **Changed** — refactor: + behaviour-affecting changes.
   - **Fixed** — fix: + bug fixes.
   - **Security** — anything CVE-mentioning, security: prefix.
   - **Removed** — removals + deprecations.
   - **Internal** — chore: / build: / ci: (collapsed at end).
5. For each entry, write a one-line user-facing summary. Drop "fix typo"
   / "format file" / merge commits unless aggregated.
6. Surface breaking changes prominently — search commit bodies for
   "BREAKING CHANGE:" and put them in their own ⚠ section at top.

Don't invent a version number. If the user wants a version line at the
top, ask which one.`,
  },
  {
    name: 'pr-review',
    description: 'Review an open GitHub PR end-to-end via gh — diff, classify findings, post a summary comment.',
    scope: 'bundled',
    path: 'bundled:pr-review',
    prompt: `You review an open pull request. The parent will give you a PR
number or URL.

Steps:
1. Fetch context: \`gh pr view <num> --json title,body,baseRefName,headRefName,additions,deletions,files\`
   plus \`gh pr diff <num>\`.
2. Read the description and the diff. Skim the file-list to understand
   surface area.
3. Apply the standard review checklist (use the \`code-reviewer\` agent
   pattern):
   a. Correctness — wrong behaviour, off-by-one, missing case.
   b. Security — secrets, unsanitised input, missing auth, unsafe SQL/HTML.
   c. Reuse — duplication of utilities the project already has.
   d. Test coverage — does the diff add tests for the new behaviour?
4. For complex PRs (>500 LOC or touching auth/payments/migrations),
   dispatch the \`security-reviewer\` sub-agent in parallel via the
   Agent tool for a second pass.
5. Build the comment:
   - One-paragraph verdict: approve / request-changes / comment-only.
   - Numbered findings: severity · file:line · cause · suggested fix.
   - Compliments: anything notable the author got right (don't pad,
     but don't omit either).
6. Either return the draft for the user to post manually, or with
   confirmation post via \`gh pr review <num> --comment --body "..."\`
   or \`--request-changes\` / \`--approve\`.

Don't approve a PR you didn't actually read. Don't request changes for
stylistic preferences the project's formatter already enforces.`,
  },
  {
    name: 'audit-memory',
    description: 'Inventory all rules / souls / hooks currently loaded into the agent and flag stale entries.',
    scope: 'bundled',
    path: 'bundled:audit-memory',
    prompt: `You audit what's currently shaping the agent's behaviour
beyond the codebase itself: rules, soul, hooks. The point is to surface
stale entries the user has forgotten about.

Steps:
1. Read the rules: list every file under ~/.asterisk/rules/, the project's
   .asterisk/rules/, and ASTERISK.md. Show the full file paths.
2. Read the souls: ~/.asterisk/SOUL.md (operator), ~/.asterisk/souls/*.md
   (per-chat), <cwd>/.asterisk/SOUL.md or <cwd>/SOUL.md (project).
3. Read hooks: from ~/.asterisk/config.json under \`hooks\`. Show name,
   event, command, enabled flag.
4. For each entry, judge:
   - **Active**: matches the agent's current work; clearly load-bearing.
   - **Probably-stale**: references concepts/files/projects that no
     longer exist (Grep for the cited paths/symbols; if absent, flag).
   - **Outdated**: contradicts what the project actually does now (e.g.
     a rule pinning Node 16 in a Bun project).
5. For each probably-stale or outdated item, propose: keep / archive /
   remove. Don't delete autonomously — show the proposal.
6. Summary at the end: counts by status, plus a one-liner per
   probably-stale item.

Don't be aggressive. A rule the user wrote 2 weeks ago and hasn't
referenced since is still probably load-bearing.`,
  },
  {
    name: 'skill-stocktake',
    description: 'Inventory installed skills + agents and identify dead weight (rarely / never invoked).',
    scope: 'bundled',
    path: 'bundled:skill-stocktake',
    prompt: `You take stock of the agent's skill + agent catalogue. Goal:
surface dead weight so the user can prune.

Steps:
1. List skills: bundled (from src/skills/bundled.ts via /skills) plus
   user (~/.asterisk/skills/) plus project (.asterisk/skills/). Show
   name · scope · path · description.
2. List agents the same way (~/.asterisk/agents/, .asterisk/agents/).
3. For each USER-installed entry (skip bundled — those ship with
   Asterisk and aren't the user's choice to prune):
   - Has the entry been edited recently? \`stat\` mtime; entries
     untouched for >90 days are candidates for review.
   - Does the description still match a workflow the user does? If you
     can tell from the user's recent task list / git log, infer; otherwise
     flag for the user to decide.
4. Output:
   - Counts (bundled / user / project).
   - User entries grouped by "active" (likely useful) and "stale"
     (candidate for prune).
   - Per stale entry: name · last touched · proposed action (keep /
     archive / remove).

Don't auto-delete. The user's skill they wrote 2 years ago might still
be load-bearing; the audit just surfaces candidates.`,
  },
  {
    name: 'ai-regression-testing',
    description: 'Catch behaviour drift in LLM outputs: golden-trace regression, semantic deltas, prompt-change diffs.',
    scope: 'bundled',
    path: 'bundled:ai-regression-testing',
    prompt: `You set up regression testing for LLM-driven code paths. Goal:
catch when a prompt or model change degrades output quality.

Steps:
1. Identify the LLM calls in scope: \`grep\` for the project's chat /
   completion call sites. Cluster by purpose (summariser, classifier,
   retriever, etc.).
2. For each cluster, build a small golden set:
   - 5–20 representative inputs covering happy path, edge cases, and
     adversarial cases.
   - For each input, the *expected shape* of the output, not the exact
     string. LLM outputs aren't deterministic word-for-word; assert on
     structure, fields, key claims, length range.
3. Build the test harness:
   - One test per (input, expected-shape) tuple.
   - Compare via either: structural assertions (JSON shape, keys
     present, ranges), embedding-similarity vs a reference output, or
     LLM-as-judge with an explicit rubric.
   - Save a results-by-run JSON so you can diff one run against
     another (the "golden trace").
4. Wire into CI as a separate job (these tests are slower + flakier
   than unit tests). Allow the team to set acceptance thresholds per
   metric so CI can fail on real regression but tolerate normal noise.
5. When a prompt changes, the user runs the harness and compares: pass
   rate · per-input deltas · which inputs flipped from pass to fail.

Don't assert exact-string equality on LLM outputs. That's flake guaranteed.`,
  },
  {
    name: 'eval-harness',
    description: 'Score LLM outputs against a rubric — graded eval, not just regression.',
    scope: 'bundled',
    path: 'bundled:eval-harness',
    prompt: `You build an evaluation harness that scores LLM outputs against
a rubric. Different from ai-regression-testing: regression catches drift
between runs; eval scores absolute quality.

Steps:
1. Define the rubric. Each criterion: name · description · scale (1-5
   typical) · weight · what 1/3/5 looks like (concrete examples). The
   rubric is the contract — if the user can't write one, the system
   isn't ready to be evaluated.
2. Build the eval set: 20-100 representative inputs. The variety
   matters more than the volume.
3. Pick the judge:
   - Programmatic (preferred): structural checks, presence of required
     fields, length / format.
   - LLM-as-judge: cheaper but biased and noisy. If you go this route,
     use a stronger model than the one being evaluated, run each input
     2-3x with the judge, and average.
   - Human-in-the-loop: highest signal, lowest throughput; reserve for
     calibration runs.
4. Run + score: per-input score, per-criterion average, weighted total.
   Save with a run id so you can compare runs over time.
5. Output:
   - Headline: overall score and per-criterion breakdown.
   - Outliers: the 5 lowest-scoring inputs, with the judge's reasoning.
   - Trend: vs the previous run, where did things move?

Don't trust a single eval run as ground truth. Always look at outliers
manually before declaring "this version is better".`,
  },
  {
    name: 'mcp-server-patterns',
    description: 'Build an MCP server with @modelcontextprotocol/sdk — tools, resources, prompts, transport.',
    scope: 'bundled',
    path: 'bundled:mcp-server-patterns',
    prompt: `You build (or audit) a Model Context Protocol server. Asterisk
ships @modelcontextprotocol/sdk in deps already.

Workflow:
1. Pick the transport. stdio (default — spawned by the client, simplest)
   for desktop integrations; Streamable HTTP for hosted services. Avoid
   SSE — deprecated in newer MCP versions.
2. Define what the server exposes:
   - **Tools** (the most common): name, description, inputSchema (JSON
     Schema), and the function. Keep tool descriptions punchy — that's
     what the model reads to decide whether to call.
   - **Resources** (URI-addressed read-only data): list endpoint +
     read-by-uri endpoint. Use for files, query results, etc.
   - **Prompts** (templated user prompts): list + get-with-args.
3. Implement against the SDK:
   - Server constructor with name + version.
   - Register handlers via \`server.setRequestHandler(<schema>, fn)\`.
   - For stdio: \`StdioServerTransport\`, then \`server.connect(transport)\`.
   - For HTTP: \`StreamableHTTPServerTransport\` mounted on an HTTP
     framework of choice.
4. Test:
   - Run the MCP Inspector (\`bunx @modelcontextprotocol/inspector\`) —
     a UI that talks to your server, listing tools / calling them /
     showing the JSON wire format.
   - Add it to Asterisk's config.json mcpServers[] and verify
     /mcp list shows it connected.
5. Common pitfalls:
   - Tool descriptions too vague → model never calls them.
   - inputSchema mismatch with what the function actually expects →
     runtime errors instead of validation errors.
   - Long-running tools without progress reporting → client times out.

Cite the spec when in doubt: https://modelcontextprotocol.io/specification`,
  },
  {
    name: 'regex-vs-llm-structured-text',
    description: 'Tactical guide — when to reach for regex / parser vs ask the model to extract structure.',
    scope: 'bundled',
    path: 'bundled:regex-vs-llm-structured-text',
    prompt: `You're choosing between a regex / parser and an LLM call for
structured text extraction. The right answer changes by case.

**Reach for regex / a real parser when:**
- The format is well-defined and stable (logs with a known schema, ISO
  timestamps, semver, file paths, JSON / XML / CSV).
- The volume is high (millions of lines) — LLM calls are slow and
  expensive at that scale.
- Latency matters (<10ms budget).
- You need 100% deterministic output.
- A parser already exists for the format (use it, don't re-derive in
  regex).

**Reach for an LLM call when:**
- The input is natural language with variation (user emails, support
  tickets, product reviews).
- The schema is fuzzy ("extract any mention of a price, even when
  written as 'around fifty bucks'").
- The cost-per-extraction is low and the volume is manageable
  (hundreds, not millions).
- You want graceful failure on novel inputs (regex throws, LLM degrades).

**The tricky middle:**
- HTML / markup with quirks → use the parser (cheerio, BeautifulSoup),
  not regex; LLM is overkill but works as a last resort.
- Mostly-structured logs with occasional free-text fields → regex
  for the structured parts, LLM for the free-text fields.
- Code parsing → use a real parser (tree-sitter, AST libs). Regex
  on code is a smell. LLM only when the structure is so non-standard
  no parser exists.

**Hybrid pattern:** regex pre-filter → LLM only on the survivors.
Cuts cost by 90%+ when most inputs are uninteresting.

Tell the user the recommendation, the reasoning, and the rough
cost/throughput tradeoff in one paragraph.`,
  },
  {
    name: 'prompt-optimizer',
    description: 'Iterate on a prompt — run, score, refine. Hill-climb until quality plateaus.',
    scope: 'bundled',
    path: 'bundled:prompt-optimizer',
    prompt: `You optimize a prompt by running it, scoring outputs, and
refining. The goal is measurable quality lift, not "feels nicer".

Steps:
1. Get the starting prompt + the eval set (5-20 representative inputs)
   + the success criterion (rubric). Use the eval-harness skill if
   none of these exist yet.
2. Run baseline: execute the prompt on every input, score each,
   compute the headline metric. Record this as round 0.
3. Diagnose: look at the lowest-scoring 3 inputs. What's the failure
   mode? Cluster: ambiguity in instructions · missing context ·
   format violations · tone mismatch · refusal / over-caution.
4. Propose ONE change per round, targeting the most-frequent failure
   mode:
   - Make implicit constraints explicit ("respond in JSON" → "respond
     in JSON with these exact keys: …").
   - Add 1-2 few-shot examples for the failure cluster.
   - Trim wordy preambles that aren't earning their tokens.
   - Adjust voice / persona if the tone is off.
5. Run round 1 on the same eval set. Compare per-input scores. Did
   the targeted failures improve without regression elsewhere?
   - If yes: keep the change, repeat from step 3.
   - If mixed: roll back, try a different angle.
   - Stop when 2 consecutive rounds show no meaningful lift (within
     noise).
6. Output: round-by-round metric trace, the final prompt, the prompt
   diff vs. baseline, and the one or two examples per round that
   moved the needle.

Don't change two things at once — you won't know which helped.
Don't fall in love with a "more complete" prompt; longer isn't better.`,
  },
  {
    name: 'data-scraper-agent',
    description: 'Build a one-shot or recurring scraper using BrowserNavigate + Snapshot. Robust to JS-heavy sites.',
    scope: 'bundled',
    path: 'bundled:data-scraper-agent',
    prompt: `You build a scraper for a target site. Asterisk's browser tools
(BrowserNavigate / Snapshot / Click / Type) handle JS-heavy pages plain
HTTP can't.

Steps:
1. Get the target URL and the data shape from the user. AskUserQuestion
   if the data shape is fuzzy.
2. **Recon (read-only).** BrowserNavigate to the URL → BrowserSnapshot.
   Read the snapshot: numbered interactive elements, visible text. Find
   the selectors that anchor the data you want (CSS, role=, text=).
3. **Decide static vs dynamic.** Try WebFetch first — if the data is in
   the initial HTML you don't need a browser. If WebFetch returns a
   shell page (SPA / dynamic content), use the browser.
4. **Pagination / interaction.** If the data spans pages or requires
   clicks (cookie banner, "load more", login), script the interaction
   with BrowserClick + BrowserWait. Cap iterations explicitly.
5. **Robustness.**
   - Use stable selectors (role/text > CSS class > nth-child).
   - Wrap each extraction in a try and surface what's missing rather
     than crashing the whole run.
   - Don't hammer — sleep 500-2000ms between pages. Respect robots.txt.
6. **Output.** Save to JSONL / CSV via Write — one record per row, with
   a "scraped_at" timestamp and the source URL.
7. **Recurring?** If the user wants this on a schedule, hand off to the
   \`schedule\` skill so the daemon runs it via Cron.

Two non-negotiables: rate-limit politely, and never bypass authentication
the user doesn't have rights to.`,
  },
  {
    name: 'security-scan',
    description: 'Active vulnerability scanning — gitleaks, trivy, npm audit, gosec, etc. Different from review.',
    scope: 'bundled',
    path: 'bundled:security-scan',
    prompt: `You actively scan the project for security issues using
external tools. Different from the security-reviewer agent: that's a
human-style review of the diff. This is automated tooling that catches
things review misses (committed secrets, vulnerable dependencies,
container CVEs).

Steps:
1. Detect what tools to run based on the project:
   - Always: \`gitleaks detect --no-banner -v\` (committed secrets in
     git history) if gitleaks is on PATH.
   - Containers: \`trivy fs .\` (vulnerable system + lang deps in
     manifest files) if trivy is on PATH; otherwise lang-specific deps
     scanner (see dep-audit skill).
   - Go: \`gosec ./...\` (Go-specific code patterns).
   - Python: \`bandit -r src\` (Python-specific code patterns).
   - JS / TS: \`semgrep --config=auto src\` if semgrep is installed.
   - IaC: \`tfsec\` / \`checkov\` for Terraform.
2. Run them in parallel where safe (independent tools).
3. Classify findings: CRITICAL · HIGH · MEDIUM · LOW. Drop
   well-known false positives the project has already accepted (find
   the .gitleaksignore / .trivyignore / etc. and respect it).
4. For each CRITICAL + HIGH:
   - File:line · the rule that flagged it · the fix as a concrete diff
     (rotate this secret · upgrade this package · sanitise this input).
   - If the finding is a leaked credential in git history, surface it
     with TOP urgency — that secret is compromised even after the file
     is deleted; rotation is mandatory.
5. If a tool isn't installed, surface the install command as a
   suggestion — don't silently skip the category.

Output: a single grouped report with a one-line verdict at the top
(red / yellow / green) and the prioritised action list.`,
  },
  {
    name: 'cloud-infrastructure-security',
    description: 'Cloud-focused security review — IAM, secrets, network, supply chain. AWS / GCP / Azure / K8s / Terraform.',
    scope: 'bundled',
    path: 'bundled:cloud-infrastructure-security',
    prompt: `You audit cloud infrastructure code (Terraform, Pulumi, CDK,
Helm, raw YAML, CloudFormation) for security issues. This is narrower than
the general security-reviewer — it's about the *infrastructure* surface,
not application code.

Checklist (run Grep across the relevant directories):
- **IAM / RBAC.** Wildcard actions ("Action": "*"), wildcard resources,
  cross-account trust without an external-id, K8s ServiceAccounts with
  cluster-admin, GCP allUsers / allAuthenticatedUsers bindings.
- **Secrets at rest.** Hardcoded keys/passwords in tfvars, environment
  blocks, or YAML. Plaintext secrets that should be in Secrets Manager /
  Key Vault / Sealed Secrets / SOPS.
- **Network exposure.** SecurityGroups / NSGs with 0.0.0.0/0 on admin
  ports (22, 3389, 5432, 27017, etc.). Storage buckets public when they
  shouldn't be (S3, GCS, Azure Blob). Internal services with public
  load balancers.
- **Encryption.** Storage / volumes / databases without encryption at
  rest. TLS termination at LB but plaintext to backend without
  justification.
- **Logging / audit.** Missing CloudTrail / Cloud Audit Logs / K8s audit
  policy. Logs that capture full request bodies (PII / secrets risk).
- **Supply chain.** Container images pulled by tag instead of digest,
  unverified Helm chart sources, Terraform modules from untrusted
  registries.
- **Drift / least-privilege.** Service accounts with project-level
  Owner/Editor instead of narrow roles. IRSA / Workload Identity not
  used where it should be.

For each finding: severity (CRITICAL / HIGH / MEDIUM / LOW), the file:line,
the specific resource name (so the user can grep), the exact attack vector
in one sentence, and the remediation as a concrete diff.

If you find ZERO issues, say so plainly. Don't manufacture findings.`,
  },
  {
    name: 'feature',
    description: 'Plan → implement → review → commit, the full feature pipeline. Adapted from PRP / agentic-eng style.',
    scope: 'bundled',
    path: 'bundled:feature',
    prompt: `Drive a feature end-to-end with discipline: plan first, implement next, review in detail, commit cleanly. Don't shortcut steps.

Steps:
1. **Understand the request.** Restate the feature in one sentence. AskUserQuestion if anything is ambiguous (target file, surface area, must-have vs nice-to-have, breaking-change tolerance).
2. **Plan.** Enter Plan Mode (EnterPlanMode) so all your investigation tools are read-only. Then:
   - Identify the touch points (files, functions, schemas) by Grep / Glob / Read.
   - Write a plan: bullet list of changes per file, in apply order, with a one-sentence rationale per bullet.
   - Surface risks: tests that might break, public API changes, migration needs.
   - Show the plan to the user. Get explicit confirmation before exiting Plan Mode.
3. **Implement.** ExitPlanMode. Apply changes:
   - Use TaskCreate to track each plan bullet so progress is visible.
   - Edit files in the order from the plan. If a change becomes obviously wrong mid-flight, stop and re-plan rather than barrelling through.
   - Emit independent Edits in the same turn rather than one per turn.
4. **Review your own work.** Use the \`simplify\` skill — i.e. read your diff, look for reuse / naming / efficiency issues, fix them in place.
5. **Verify.** Run the project's checks (use the \`verify\` skill or run typecheck / lint / tests directly). Don't claim done until they're green.
6. **Commit.** Group changes into a single coherent commit (or several if they belong to distinct concerns). Write a real commit message:
   - First line: ≤ 72 chars, imperative mood, no Co-Authored-By unless explicitly asked.
   - Body: WHY the change exists, what it doesn't address, any follow-ups.
7. **Summarise to the user.** What shipped · what didn't · what's left as follow-up · whether tests are green.

Plan Mode discipline is non-negotiable — exit it BEFORE writing, not before planning. If you find yourself writing during planning, you're skipping step 2.`,
  },
];
