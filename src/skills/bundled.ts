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
