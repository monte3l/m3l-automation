---
name: implementing-scripts
description: >-
  Implement the real business logic of an already-scaffolded consumer script under
  scripts/<name>/ — the TDD + hub-and-spoke loop that turns the script's contract page
  (docs/reference/scripts/<name>.md) into reviewed, tested steps/ modules. Use this
  whenever the user asks to "implement", "fill in", "wire up", "finish", or "write the
  logic for" an automation script, job, or CLI that already has a scripts/<name>/
  directory — even phrased casually like "make the data-sync script actually sync" or
  "hook the export script up to S3", and even if they never say "script". For a script
  with NO directory yet, run scaffolding-scripts first; for library submodules under
  packages/m3l-common, use implementing-submodules instead.
---

# implementing-scripts

This skill is the **hub playbook** for turning a scaffolded consumer script into
real, reviewed, tested automation. The scaffold (from `scaffolding-scripts` /
`pnpm scaffold:script`) ships a skeleton whose `steps/` bodies do nothing; the
script's contract page `docs/reference/scripts/<name>.md` plus the ADR-0022
fleet conventions define what it must actually do.

It is the thin counterpart to `implementing-submodules`: same operating model
and spokes, but script-scale gates — there is **no coverage threshold, no
exports-map/semver concern, and no provenance-count bookkeeping**; the
deterministic backstop is `pnpm check:script-scaffold` and the anti-hollow gate
is `pnpm knip`.

## Operating model: you are the hub, not a worker

You (the main agent) **coordinate only**. You do not write `scripts/*/src` or
test code yourself, and you do not review code — every substantive step runs in
an isolated spoke with the right grants, so "the writer is never the reviewer"
stays structural. Pass each spoke explicit context: the script name, the
contract text, and concrete file paths.

| Phase           | Spoke (subagent)                                                                                                                 | Writes                 | Hand it                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------- |
| 1. Contract     | `spec-conformance-reviewer`                                                                                                      | nothing                | `docs/reference/scripts/<name>.md` + ADR-0022 |
| 2. RED (tests)  | `test-author`                                                                                                                    | `scripts/<name>/tests` | the contract + target test paths              |
| 3. GREEN (impl) | `code-implementer`                                                                                                               | `scripts/<name>/src`   | the contract + the failing tests              |
| 4. Review       | `code-reviewer` + `security-reviewer` (+ `silent-failure-hunter` when steps carry try/catch, async fan-out, or retry/poll logic) | nothing                | the diff + the contract page                  |

`security-reviewer` is **always** in the fan-out, not conditional: every script
touches the `.env` secrets seam, and any AWS work flows through the
`aws.profile` provisioning seam it audits.

## Progress checklist (copy-paste at the start of each run)

- [ ] Step 0 — Isolate: run `/starting-work` (branch/worktree + PR + push, confirmed)
- [ ] Step 1 — Precondition: `scripts/<name>/` exists and `pnpm check:script-scaffold` is green
- [ ] Step 2 — Dep gate: list any new runtime deps for user approval (skip if none)
- [ ] Step 3 — Contract: `spec-conformance-reviewer` → exact steps, config schema, inputs/outputs
- [ ] Step 4 — RED: `test-author` → failing step tests + honest config smoke test
- [ ] Step 5 — GREEN: `code-implementer` → fills `steps/` (+ config/hooks wiring) to green
- [ ] Step 6 — Review fan-out (one message, parallel); iterate Must-fix until clean
- [ ] Step 7 — Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`,
      `pnpm check:script-scaffold`, `pnpm knip`, smoke run
- [ ] Step 8 — Docs: fill README + contract page, then `/syncing-docs`, then `/writing-work-logs`

## Steps

0. **Isolate first — run `/starting-work` before any spoke is dispatched.** This
   pipeline always writes guarded paths (`scripts/*/src/**`, `tests/**`), which
   `guard-branch-isolation.mjs` blocks on `main`; the gate settles
   branch/PR/push up front instead of mid-dispatch.

   **Resuming a script paused on a library dependency: rebuild before trusting
   a test failure.** If this script was blocked on a library submodule that
   has since merged to `main` (e.g. a W2 script waiting on a new `aws/*`
   wrapper), rebasing the worktree pulls in the new source but not
   necessarily a fresh `dist/`. A stale/first-warm turbo cache can replay a
   build from _before_ the new submodule existed, producing a spurious
   `X is not a constructor`-style test failure that looks like a real
   regression (`docs/logs/2026-07-13-sqs-etl.md`, divergence 2). Run `pnpm
build` once after the rebase and confirm the new submodule's `dist/`
   output actually exists before diagnosing a downstream test failure as
   code drift.

1. **Verify the precondition.** `scripts/<name>/` must exist and
   `pnpm check:script-scaffold` must be green. If the directory is missing, stop
   and run `scaffolding-scripts` first — this skill never lays down skeletons.
   If the contract page `docs/reference/scripts/<name>.md` is still template
   placeholders, get its content settled (with the user) before writing tests
   against it: tests written against an empty contract test nothing.

2. **Dependency gate.** A script may need its own runtime deps (an SDK, a
   parser). List each with a one-line rationale and wait for explicit user
   approval before anyone runs `pnpm add` — the lockfile is authoritative and
   never hand-edited. Prefer reaching the need through
   `@m3l-automation/m3l-common` seams (config, paths, `script.aws`) before
   adding anything.

3. **Phase 1 — Contract.** Dispatch `spec-conformance-reviewer` in contract
   mode against the script's contract page: have it return the exact step list
   (names + responsibilities), the config schema (parameter names, types,
   defaults, validators), and the declared inputs/outputs. Front-load the
   nuances verbatim into the next two hand-offs — which `M3LError` subclass a
   step throws, what is written to `M3L_OUTPUT_DIR`, which parameters are
   secrets.

   **Size the dispatch now, before RED/GREEN.** A script with many planned
   steps (roughly more than 6–8 step/test files) is exactly the shape that
   exhausts a writer spoke's turn budget on exploration before it writes
   anything — the worst logged case (`docs/logs/2026-07-11-scripts-json-etl.md`
   §1, a 6-test/8-module script) had `test-author` burn its entire 150k-token
   budget and write **zero files**. Plan RED and GREEN as multiple bounded
   sub-dispatches (e.g. GREEN per step-group) for a script this size, rather
   than one open-ended turn per phase, and say so explicitly when dispatching.
   See `docs/contributing/subagent-context-management.md`.

   **Treat the contract page as a hypothesis, not a finished spec, for any
   script with several operations or cross-parameter requirements.** A
   hub-authored contract page written in one pass tends to under-specify
   exactly the decisions `test-author`/`code-implementer` would otherwise
   guess divergently (e.g. an unspecified not-found behavior, an
   unspecified failure-summary shape, an unnamed error-code family, an
   unspecified soft-land-vs-propagate decision). Run
   `spec-conformance-reviewer` in **contract mode** against the page before
   RED and treat any ambiguity it flags as blocking — close it by amending
   the doc, not by letting two downstream spokes pick their own
   interpretation (`docs/logs/2026-07-18-s3-objects.md`, divergence 1,
   surfaced 5 real gaps this way).

4. **Phase 2 — RED.** Dispatch `test-author` with the contract and target paths
   under `scripts/<name>/tests/`. It writes failing tests for each step through
   its **injected deps** (never by booting the `M3LScript` lifecycle or setting
   env vars) and keeps the generated config smoke test honest against the real
   schema. Confirm the new tests fail for the right reason.

   **A multi-step script's RED tests will trip the `pre-commit` eslint hook.**
   `scaffolding-scripts` lays down only one starter step file, not one
   placeholder per planned command — unlike `scaffolding-submodules`, which
   pre-creates a throwing placeholder per export so RED imports resolve.
   RED tests for a script with N > 1 planned steps (`docs/logs/2026-07-13-
sqs-etl.md`, divergence 1: a 6-command/8-step script) will fail
   `import-x/no-unresolved` on every not-yet-existing step file, cascading
   into `@typescript-eslint/no-unsafe-*` errors that block a normal `git
commit`. Don't fight this: either scaffold a throwing placeholder per
   planned step before RED, or simply commit RED tests and the GREEN
   implementation together in one commit instead of trying to land a
   separate RED commit.

5. **Phase 3 — GREEN.** Dispatch `code-implementer` with the contract and the
   failing tests. It fills the `steps/` modules (and the `config.ts`/`hooks.ts`
   wiring the contract requires) to green — injected deps, `M3LError` chaining
   with `cause`, all I/O through `M3LPaths`, config as the only input seam,
   `main.ts` stays a composition root. Hand it a journal path
   (`<scratchpad>/code-implementer-<name>.md`), and **verify its state
   directly** when it reports (or truncates): run `typecheck`/`test` yourself
   and diff the tree — resume the same spoke via `SendMessage` on a concrete
   gap rather than re-dispatching.

6. **Phase 4 — Review (fan out in parallel, one message).** `code-reviewer` +
   `security-reviewer` always; add `silent-failure-hunter` when steps carry
   try/catch, async fan-out, or retry/poll logic. Route Must-fix findings back
   to `code-implementer` and re-run until clean.

   **Re-review every substantive fix round with a bounded confirmation pass.**
   A fix round is new writer code with no reviewer between it and the commit —
   post-review fix batches introduced fresh Must-fix defects in at least four
   pipelines (see `.claude/rules/subagent-dispatch.md`). After the fixes land,
   dispatch a **focused confirmation re-review scoped to the changed files
   only** — typically just the reviewer(s) whose findings drove the fixes —
   not a fresh full fan-out, and not hub self-verification alone.

   **Size this dispatch too, the same as RED/GREEN above.** Give each reviewer
   a tight per-spoke file list rather than the whole diff plus "explore the
   repo" latitude — an unbounded review scope stalled spokes for 30-60+
   minutes in `docs/logs/2026-07-18-aws-athena.md`,
   `2026-07-18-aws-eventbridge.md`, and `2026-07-18-aws-s3.md`, all fixed by
   narrowing the file list. Split by concern (e.g. one reviewer per new file
   group) once the diff exceeds ~3–4 files.

7. **Gates.** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, then
   `pnpm check:script-scaffold` (shape conformance) and `pnpm knip` (a script
   that declares the `workspace:*` dependency but doesn't exercise the library
   fails — the anti-hollow gate), then the smoke run
   `pnpm --filter @m3l-automation/<name> start`. **Run the script-specific
   gates (`check:script-scaffold`, `knip`) again after every fix/remediation
   round, not once** — knip's static-reachability check catches
   hollow/consumer-less exports that review spokes structurally don't look
   for, and it has flagged real drift introduced by fix rounds three times
   (`docs/logs/2026-07-18-eventbridge-schedules.md`,
   `2026-07-18-scripts-athena-query.md`,
   `2026-07-17-adr-0030-workflow-tooling-mcp.md`). Deliberately absent: the 80%
   coverage gate (scripts are exempt by ADR-0022 §8), exports-map checks, and
   provenance stamping — do not import them from the submodule pipeline.

8. **Docs and close.** Update the two documentation artifacts to match what
   shipped — `scripts/<name>/README.md` (how to run) and the contract page's
   schema/steps tables (the contract) — then invoke `/syncing-docs` (its script
   pass runs `check:script-scaffold` and regenerates the consumer-scripts
   catalog via `gen:index`).

   **Before shipping a doc that describes a runtime mechanism (a flag, a seam,
   a consumption path), run it once end-to-end** — "the utility exists and is
   exported" ≠ "the feature is wired". The json-etl preset loader shipped fully
   documented yet unreachable from `M3LScriptOptions`
   (`docs/logs/2026-07-11-scripts-json-etl.md`), and the athena contract page
   shipped `script.aws.athena` for what is really `script.aws.clients.athena`,
   caught only by the first consumer
   (`docs/logs/2026-07-18-scripts-athena-query.md`). The smoke run is the
   acceptance test for the doc, not just the code. Remind the user the commit is a `feat:` only if it
   changes what consumers of the _script_ get; plain `chore:`/`fix:` otherwise.
   Then invoke `/writing-work-logs` while the context is live. **Finally, update
   the living trackers**: flip this script's status in `docs/ROADMAP.md` +
   `docs/plans/IMPLEMENTATION.md` (`pending` → `in-review`/`done`), pull the
   next-priority item up, and file any new library-friction the log recorded
   into `IMPLEMENTATION.md` (not log-narrative-only). See `CLAUDE.md` →
   _Agent Operating Model_ → _Live status_.

## What "good" looks like

**Step module: injected deps + typed errors, never env reads:**

```ts
// bad — reads the environment, hardcodes a path, untestable without the lifecycle
export async function runExport(): Promise<void> {
  const batchSize = Number(process.env.BATCH_SIZE);
  await writeFile("data/output/report.json", await render(batchSize));
}
// good — deps injected, paths from M3LPaths, failures typed and chained
export async function runExport(deps: {
  readonly correlationId: string;
  readonly batchSize: number;
  readonly paths: Core.M3LPaths;
}): Promise<void> {
  try {
    await writeFile(
      join(deps.paths.outputDir, "report.json"),
      await render(deps.batchSize),
    );
  } catch (cause) {
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(
      `report export failed (run ${deps.correlationId})`,
      { cause },
    );
  }
}
```

**Config smoke test: assert the declaration, not resolution:**

```ts
// good — importing config.ts already exercises eager default validation;
// assert the declared shape (unique names, M3LConfigParameter instances)
const names = configParameters.map((parameter) => parameter.getName());
expect(new Set(names).size).toBe(names.length);
// bad — resolving values through a reader re-tests the library's config
// pipeline (already covered in packages/m3l-common) instead of this script
```

## Boundaries

- You never edit `scripts/*/src/**` or `tests/**` directly — that is what the
  spokes are for. Filling in the two documentation artifacts (README + contract
  page) is the bookkeeping write the hub owns.
- Never change the scaffold _shape_ here (add/rename/drop skeleton files): the
  shape belongs to `templates/script/` + `bin/lib/script-scaffold.mjs`, and
  `check:script-scaffold` will fail the PR. Evolve the shape in its own PR.
- See also `.claude/skills/scaffolding-scripts/SKILL.md` (greenfield entry),
  `.claude/rules/scripts.md`, and ADR-0022 for the fleet conventions.
