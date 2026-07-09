---
name: implementing-submodules
description: >-
  Implement a documented-but-empty Core or AWS submodule of @m3l-automation/m3l-common
  end-to-end, from its docs/reference spec, under a strict TDD + hub-and-spoke workflow.
  Use this whenever the user asks to "implement", "build", "fill in", "flesh out", or
  "write the code for" a submodule, capability, or feature that already has a
  docs/reference/{core,aws}/<name>.md page (e.g. errors, config, polling, logging,
  importers, storage, text, aws credentials, script). Use it even when the user names
  the module casually ("let's do the retry stuff", "wire up the HTTP client") rather
  than saying "submodule". For a brand-new module that has NO spec page yet, use
  scaffolding-submodules first to scaffold, then this skill to implement.
---

# implementing-submodules

This skill is the **hub playbook** for turning a `docs/reference` page into real,
reviewed, tested library code. The library is a fully-documented but empty
scaffold; each `docs/reference/{core,aws}/<module>.md` is the authoritative
contract for what its submodule must export and how it must behave.

## Operating model: you are the hub, not a worker

You (the main agent) **coordinate only**. You do **not** write `src/` code or
test code yourself, and you do **not** review code. Every substantive step runs
in an **isolated spoke subagent** with the right tool grants. This makes
"the writer is never the reviewer" a structural guarantee, not a polite request,
and keeps your context lean across what is often a long loop.

Spokes don't share memory with each other or persist between sessions, so two
things matter: pass each spoke **explicit context** (target module, the contract,
concrete file paths), and record progress in the durable state file
`docs/implementation-status.md` after every phase.

| Phase           | Spoke (subagent)                                                                                                                                                                                                                                   | Writes      | Hand it                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------- |
| 1. Contract     | `spec-conformance-reviewer`                                                                                                                                                                                                                        | nothing     | the doc path                     |
| 2. RED (tests)  | `test-author`                                                                                                                                                                                                                                      | tests only  | the contract + target paths      |
| 3. GREEN (impl) | `code-implementer`                                                                                                                                                                                                                                 | `src/` only | the contract + the failing tests |
| 4. Review       | `code-reviewer` + `spec-conformance-reviewer` (+ `security-reviewer`) (+ `type-design-analyzer` whenever the module introduces or changes public types — every Core/AWS module qualifies) (+ `silent-failure-hunter` when error/async paths exist) | nothing     | the diff + the doc path          |

### Running pipelines concurrently (opt-in)

By default a single pipeline runs in the shared working tree — keep it simple.
When you need **two pipelines at once** (e.g. a Core and an AWS module), isolate
the writer/reviewer spokes so their edits can't collide: pass
`isolation: worktree` when dispatching them (or tell them to "use a worktree"),
which gives each spoke its own checkout branched from `origin/main`. Do **not**
bake `isolation: worktree` into the agent frontmatter — it stays opt-in so the
common single-module loop has no worktree churn. See ADR-0013.

The one shared resource that still needs coordination is the durable state file
`docs/implementation-status.md`: two concurrent pipelines must edit **different
rows** (partition by namespace/phase) and whichever lands second rebases and
re-confirms the counts. This is the concurrent-edit partition rule recorded in
ADR-0013 (its durable home), not a per-plan caveat.

## Progress checklist (copy-paste at the start of each run)

- [ ] Step 0 — Isolate: run `/starting-work` (branch/worktree + PR + push, confirmed)
- [ ] Step 1 — Resolve target; confirm spec page exists
- [ ] Step 2 — Format and commit plan/docs file (if any) before implementation
- [ ] Step 3 — Dep gate: list any required runtime deps and get user approval
      (skip for dep-free modules)
- [ ] Step 4 — Contract: `spec-conformance-reviewer` → extract exact exports +
      behavioral contracts; save the contract text
- [ ] Step 5 — RED: `test-author` → writes failing tests; update status file → 🧪
- [ ] Step 6 — GREEN: `code-implementer` → writes `src/` until tests pass;
      update status file → 🟢
- [ ] Step 7 — Review: select every applicable reviewer first, then dispatch the
      whole set in **one message** so they run in parallel (Phase 4) —
      `code-reviewer` + `spec-conformance-reviewer` (always); + `security-reviewer` for the aws/secrets/logging surface; + `type-design-analyzer` whenever the module introduces or changes public types (every Core/AWS module qualifies); + `silent-failure-hunter` when the module has error-handling or async paths;
      iterate until clean; update status file → ✅
- [ ] Step 8 — Final verify: `pnpm build && pnpm test && pnpm lint && pnpm typecheck`;
      generate provenance sidecar (exported symbols only); then invoke `/syncing-docs`
      (after the status file flips to ✅) for the full doc-reconciliation stack
- [ ] Report: new exports, review verdict, deps (if any), state-file transitions
- [ ] Write work log: `/writing-work-logs` → `docs/logs/YYYY-MM-DD-<ns>-<module>.md`

## Steps

0. **Isolate the working context — run `/starting-work` before any spoke is
   dispatched.** `/starting-work` is the single source of truth for the
   branch/worktree, PR, and push decisions: it infers, recommends, and confirms
   them with the user. This pipeline always writes guarded paths (`src/**`,
   `tests/**`), so the answer is always "isolate + land via PR" — the gate just
   makes it explicit up front. Building on `main` left its working tree dirty for
   a whole run once already (`docs/logs/2026-07-01-core-analysis.md`, divergence
   7), and `guard-branch-isolation.mjs` blocks those writes while `HEAD` is
   `main`; running the gate first means the hub branches proactively instead of
   discovering the block mid-dispatch.

1. **Resolve the target.** Read `docs/implementation-status.md`, confirm the
   module and its `docs/reference/<ns>/<module>.md` spec page exist. If there is
   no spec page, stop and point the user at `scaffolding-submodules` (greenfield modules
   must be scaffolded and specced first). If the module is already ✅, ask before
   redoing it. When unsure which to pick, prefer the _Suggested implementation
   order_ in the state file (foundational, dep-free modules first).

2. **Re-validate, then format and commit plan docs before implementation
   begins.** If a `docs/plans/` file was created for this module, **first
   re-validate every factual claim in it against the live repo** — counts, line
   numbers, file lists, and "what already exists" premises all rot between
   authoring and execution. A stored plan is a hypothesis, not ground truth: the
   core/json plan claimed a doc-count inconsistency that had already been fixed
   and missed two count-bearing files (see
   `docs/logs/2026-07-01-core-json.md`, divergence 1). Verify each claim before
   acting on it, and **delegate any count reconciliation to `/syncing-docs`**, which
   owns the authoritative list of count sites rather than a hand-written edit
   list. Then run `pnpm exec prettier --write <path>` on the plan and commit it
   before any implementation work starts. Untracked or uncommitted docs files
   that drift out of prettier compliance block the `pre-push` lefthook. The cost
   of formatting up front is zero; the cost of a blocked push is an out-of-band
   commit mid-review.

3. **Dependency gate — pause before adding any runtime dependency.** Several
   submodules imply a runtime dep (e.g. `config` → a YAML parser, `network` →
   `undici`, `importers` → `csv-parse`, `storage` → `better-sqlite3`, `text` →
   `unpdf`/`mammoth`/…, aws → `@aws-sdk/*`). CLAUDE.md makes minimal runtime deps
   a non-negotiable constraint and the pnpm lockfile authoritative. So **stop,
   list each dependency with a one-line rationale, and wait for explicit user
   approval** before anyone runs `pnpm add`. Never hand-edit `pnpm-lock.yaml`.
   Dep-free modules skip this gate.

4. **Phase 1 — Contract.** Dispatch `spec-conformance-reviewer` in _contract
   mode_: have it read the spec page (and the relevant contracts in
   `docs/m3l-common-architecture.md`) and return the exact list of promised
   exports (names + shapes) plus the behavioral contracts (e.g. handler-error
   isolation, per-call backoff, `toJSON()` on errors, MONOREPO path anchoring).
   Keep this contract text — you'll hand it to the next two spokes. **Front-load
   the exact contract nuances** verbatim into those hand-offs: weakly-typed
   params (e.g. `cause: unknown`, not `Error`), pass-through vs. normalizing
   semantics, and which specific error a function throws (e.g. what `unwrap`
   throws on an `Err`). Precision here prevents the tests from over-constraining
   a type and saves a re-work round — especially for weaker routed models.

5. **Phase 2 — RED.** Dispatch `test-author` with the contract and the target
   test path (`packages/m3l-common/tests/<module>.test.ts`). It writes happy +
   failure + `expectTypeOf` tests against the contract and confirms they **fail
   for the right reason** (the symbols don't exist yet). Update the state file:
   that module → 🧪 tests-written.

6. **Phase 3 — GREEN.** Dispatch `code-implementer` with the contract and
   the failing tests. It writes the minimal `src/<ns>/<module>/index.ts`
   (private helpers under `src/internal/`), re-exports from the namespace barrel
   `src/<ns>/index.ts`, and drives `pnpm test` + `pnpm typecheck` to green
   **without** touching the `exports` map. Update the state file: → 🟢 implemented.
   When dispatching, explicitly state: **`@example` blocks must use project
   error-handling conventions (`M3LError` or a subclass), even when the spec doc
   shows bare `new Error()`** — do not assume the implementer resolves a
   spec-doc / project-rule conflict in the right direction. Also **hand the spoke
   a journal path** (e.g. `<scratchpad>/code-implementer-<module>.md`) and
   ask it to append progress there before each major step — this is the durable
   trace you read if its turn is cut short.

   **Verify the writer spoke's state directly — do not trust its final report.**
   A long implementer run (bounded-I/O rework is token-heavy) can hit its turn
   limit and return a mid-thought instead of a completion summary; in the
   core/json run this hid a missing barrel re-export and an internal helper
   leaking as a public export (`docs/logs/2026-07-01-core-json.md`, divergence
   5). If the return looks truncated, **read the spoke's journal file first** to
   locate exactly where it stopped and what it intended next, then confirm the
   actual state: list the created files, `grep` the namespace barrel for the
   expected `export * from "./<module>/…"` line, and run `typecheck`/`lint`/`test`
   yourself. If something concrete is missing, **resume the same spoke via
   `SendMessage`** with the specific gap (point it back at its journal) rather
   than trusting the summary or re-dispatching a fresh spoke.

   **Sweep for stray debug artifacts before review.** A writer spoke that ended
   abruptly can leave a reproduction file behind — the core/analysis run left
   `packages/m3l-common/scratch.repro.test.ts`, which tripped `pnpm lint` and
   would have polluted the commit (`docs/logs/2026-07-01-core-analysis.md`,
   divergence 3). Run `git status --porcelain -- 'packages/**'` and delete any
   untracked `scratch*` / stray `*.test.ts` debug files before the review
   fan-out. (The `Stop` hook also flags these, but sweep proactively here.)

7. **Phase 4 — Review (fan out in parallel).** In one message, dispatch
   `code-reviewer` and `spec-conformance-reviewer` (now in _conformance mode_),
   plus `security-reviewer` if the surface is security-sensitive (anything under
   `aws`, or touching secrets, credentials, deserialization, or logging),
   plus `type-design-analyzer` whenever the module introduces or changes public
   types (every Core/AWS module qualifies), and `silent-failure-hunter` whenever
   the module has error-handling or async paths. Collect their findings, send
   **Must-fix** items back to `code-implementer`, and re-run tests/review
   until clean.

   **Adversarial refute pass (high-risk surface only).** When the diff touches
   `aws/**` or code that redacts secrets or resolves credentials, and the
   first-pass `security-reviewer` came back clean, dispatch a **second**
   `security-reviewer` in _refute mode_ (see its agent definition): it assumes the
   surface is unsafe and tries to construct a concrete leak/bypass, defaulting to a
   finding when uncertain. Confirm the surface only when refutation **fails**; if
   it succeeds, route the finding back to `code-implementer` like any
   Must-fix. Skip this pass entirely for non-security surfaces — it is deliberately
   not run on every module, to avoid the over-review cost.

   Update the state file: → ✅ reviewed/done.

8. **Final verify, reconcile docs, and report.** Run
   `pnpm -C packages/m3l-common build && pnpm test && pnpm lint && pnpm typecheck`.
   Generate or update the module's provenance sidecar
   (`docs/reference/<ns>/<name>.provenance.json`). **Every `symbol` entry must
   reference a named export of its source file — never a private constant,
   internal helper, or unexported type.** For sections that describe private
   implementation details, use the exported function or type that exposes that
   behavior.
   **Any public type added beyond the original spec (a new error subclass, a
   branded type, an extra result shape) must land in the `.md` reference page
   AND the provenance sidecar in the _same_ change set** — otherwise
   spec-conformance reads it as undocumented drift and provenance has no heading
   to map it to (`docs/logs/2026-07-01-core-json.md`, divergence 2).

   Once the status file reflects the true ✅ count, **invoke `/syncing-docs`** to run
   the full doc-reconciliation stack in one pass — provenance re-stamp,
   `check:doc-counts`, `check:doc-exports`, index regeneration
   (`gen:index` → `check:index`, in the right order relative to prettier),
   `check:impl-counts`, `check:test-counts`, and markdown lint. `/syncing-docs` is
   the single authority for these gates; running them by hand here risks the
   `gen:index`-before-format ordering trap and lets the "N of 22" sites drift.
   All of them are **mandatory** for a new submodule — omitting the
   reference-index regeneration is a CI failure the core/json plan nearly shipped.

   Then report the new exports, the review verdict, any deps added (with
   approval), and the state-file transitions. Remind the user the commit should
   be a `feat:` (a new submodule surfaced through the barrel is a minor, not a
   breaking change, because the three-entry `exports` map is unchanged). Finally
   invoke `/writing-work-logs` to write `docs/logs/YYYY-MM-DD-<ns>-<module>.md` while
   the conversation context is intact — this is the durable record of what
   shipped, what diverged, and the lessons for the next submodule.

## What "good" looks like (the spokes already carry these)

The good/bad code contrasts and test-tooling gotchas that used to live here now
live in the path-scoped rules, which **auto-load into the exact writer spokes**
that act on them — so you don't need to relay them by hand:

- `src/**` conventions (ESM `.js` imports, typed errors + `cause`, named
  exports, CLI-over-IDE authority) → `.claude/rules/library-src.md`, loaded when
  `code-implementer` edits `src/**`.
- Test discipline (test-first, error-channel `eslint-disable` rationale,
  eslint-in-loop, reading coverage from `coverage-final.json`) →
  `.claude/rules/tests.md`, loaded when `test-author` edits `tests/**`.

You still front-load the module-specific **contract nuances** (Step 4) into the
hand-offs — those are per-module and no rule can carry them.

## Boundaries

- You never edit `src/**` or `tests/**` directly — that is what the spokes are
  for. Editing `docs/implementation-status.md` is the one bookkeeping write the
  hub owns.
- Do not add an `exports`-map entry; new submodules surface through the namespace
  barrel (adding a subpath is a semver event — see `.claude/rules/library-src.md`).
- See also `.claude/skills/scaffolding-submodules/SKILL.md` (scaffolding) and
  `docs/contributing/coding-standards.md`.
