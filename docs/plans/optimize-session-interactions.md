# Plan: Add four Claude Code automations derived from session-history mining

## Context

Six parallel `Explore` agents mined ~70 session transcripts (June 27–29) plus
the global prompt history for this repo, looking for recurring manual work,
repeated corrections, and command sequences worth automating. Their raw output
contained many suggestions that are **already implemented** — those were
verified against the repo and discarded:

- ESLint is already the 2nd step in `.claude/hooks/post-edit-verify.mjs`
  (prettier → eslint → typecheck → related-vitest, per `.ts` edit).
- `guard-doc-counts.mjs` + `guard-provenance-staleness.mjs` already run
  PostToolUse (doc-drift is covered).
- `write-commit`, `create-pr`, `sync-docs`, `release-dry-run` skills and the
  `remind-create-pr.mjs` hook already cover the git/PR/commit/doc-sync asks.
- `bin/check-scaffold.mjs` already exists (CI step `pnpm check:scaffold`).

After deduping, four genuine gaps remain — the user confirmed all four for
implementation. They are ranked by how strongly the history pointed at them.

---

## 1. `/audit` skill — the audit→plan loop (highest signal)

**Why:** All six agents independently flagged this as the single most repeated
pattern (50+ instances; this very session is one): the user types some variant
of _"spawn Explore subagents to audit X, aggregate findings, ask N focused
questions, then plan."_ It is hand-assembled every time with no reusable
scaffold.

**Build:** A new skill `.claude/skills/audit/SKILL.md` modeled on the existing
skill anatomy (`.claude/skills/sync-docs/SKILL.md`: YAML frontmatter `name` +
trigger-rich `description`, then numbered steps). The skill encodes the loop:

1. Take a free-text **audit target** (e.g. "release config", "scaffolding",
   "README consistency") and optional scope hints.
2. Fan out parallel `Explore` agents (read-only) over the relevant areas, each
   with a focused brief and a fixed report format — exactly the hub-and-spoke
   pattern in `CLAUDE.md`.
3. Aggregate findings, dedupe against existing repo state.
4. Ask the user a small set of focused clarifying questions
   (`AskUserQuestion`).
5. Enter plan mode with a structured plan; do not edit code.

**Trigger wording** in `description` must cover: "audit the codebase", "spawn
Explore subagents to audit", "review the current state of", and `/audit`.
Mirror the trigger-density of `sync-docs`'s description so it fires reliably.

---

## 2. Markdown edit-loop hook (closes the doc-lint gap)

**Why:** `post-edit-verify.mjs` exits early on any non-`.ts` file
(`post-edit-verify.mjs:56`), so `.md` edits get **no** format/lint feedback
until the CI gate — `lint:md` (rumdl) and `format:check` (prettier) are
**CI-only**, absent from lefthook `pre-push`. Doc-heavy sessions (batches 1 & 2)
burned ~15 min on the manual rumdl/prettier dance.

**Build:** New hook `.claude/hooks/post-edit-md-verify.mjs`, structurally
mirroring `post-edit-verify.mjs`:

- Read tool-input JSON from stdin; resolve `file_path` to a repo-relative path.
- Scope guard: only `*.md`; skip `node_modules/`, `dist/`, `.claude/`, and the
  paths `lint:md` already excludes (`CHANGELOG.md`,
  `.github/pull_request_template.md`, `docs/adr/template.md`, `docs/plans/**`)
  to stay consistent with the `lint:md` script in `package.json`.
- Run `pnpm exec prettier --write <file>` then `pnpm exec rumdl check <file>`
  (single-file; same engines as the CI scripts).
- On failure, `process.exit(2)` with a concise advisory stderr summary (nudge,
  not a hard gate) — identical contract to `post-edit-verify.mjs`.

**Wire:** add it to the existing `PostToolUse` `Write|Edit` matcher array in
`.claude/settings.json` alongside `post-edit-verify.mjs`.

---

## 3. CI-failure triage skill

**Why:** Session `f17d6121` shows *"investigate the failure reason for run

# …"* — done by hand with ad-hoc `gh` calls. CI is the mandatory blocking gate,

so this recurs.

**Build:** New skill `.claude/skills/ci-triage/SKILL.md`:

1. Resolve the run: explicit run-id if given, else
   `gh run list --branch <current> --limit 1` for the latest.
2. `gh run view <id> --log-failed` (falls back to `--log`) to pull only failing
   job logs.
3. Map the failure to the offending pipeline step (the 13-step `ci.yml`:
   audit → lint → format:check → lint:md → typecheck → check:api →
   test:coverage → build → check:exports → check:scaffold → knip) and summarize
   root cause + the exact local command to reproduce (e.g. `pnpm lint:md`).
4. Stop at a diagnosis; do not auto-fix unless asked.

**Note:** GitHub MCP is blocked by enterprise policy — the skill MUST use the
`gh` CLI (see memory `feedback-github-mcp-not-allowed`).

---

## 4. Dependency-gating bin/ script

**Why:** Across 4 day-27/28 sessions the user repeatedly ran
`pnpm outdated` / `pnpm audit` / `pnpm peers check`, and in session `845d80be`
explicitly asked for a gating mechanism that was never built. CI **already**
gates vulnerabilities (`pnpm audit --audit-level=high`, `ci.yml:44`), so this
script must cover the **un-gated** dimensions only, to avoid duplication.

**Build:** New `bin/check-deps.mjs` (ESM, `.js`-extension imports, no `any`,
matching the existing `bin/*.mjs` style — see `bin/check-scaffold.mjs`):

- Parse `pnpm outdated --format json` and flag majors / pinned-but-stale deps.
- Detect deprecated installed packages.
- Surface peer-dependency mismatches.
- Exit non-zero with a structured report when policy is violated; exit 0 clean.
- Expose as `pnpm check:deps` in root `package.json` `scripts`.

**Wire:** add a `check:deps` step to `ci.yml` (near the existing audit step). Do
**not** add to lefthook `pre-push` (keep the local loop fast); CI is the gate.

---

## Minor (fold in if cheap): barrel-drift on edit

`check-scaffold.mjs` runs only in CI/manually. Optionally extend the new
PostToolUse wiring to run `pnpm check:scaffold` after edits to
`src/**/index.ts`, surfacing barrel/export drift in the edit loop. Low effort;
include only if it doesn't bloat the hook latency.

---

## Verification

- **Hook (#2):** edit a `.md` with a known rumdl violation (e.g. a bare URL or
  over-long line) and a `.ts` file; confirm the `.md` hook fires with advisory
  stderr and the `.ts` path is untouched by it. Confirm it skips
  `docs/plans/**` and `CHANGELOG.md`.
- **Skills (#1, #3):** dry-run each via its slash trigger; confirm `/audit`
  fans out Explore agents and ends in plan mode without editing code, and
  `ci-triage` summarizes a real recent failed run via `gh`. If skill evals are
  used elsewhere (`sync-docs/evals`), add a minimal eval.
- **bin script (#4):** `pnpm check:deps` exits 0 on the current clean tree;
  temporarily pin an outdated dep to confirm non-zero + readable report. Run
  `node bin/check-deps.mjs` directly and via the new CI step.
- **Global gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  and `pnpm lint:md` all pass. New `.mjs` files clear the repo's own
  ESM/no-CommonJS hook guards.
- Commit per Conventional Commits: `feat:` for the skills/script (new
  capability), `chore:` for the hook wiring — split into small, meaningful
  commits.
