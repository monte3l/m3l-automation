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

4. **Phase 2 — RED.** Dispatch `test-author` with the contract and target paths
   under `scripts/<name>/tests/`. It writes failing tests for each step through
   its **injected deps** (never by booting the `M3LScript` lifecycle or setting
   env vars) and keeps the generated config smoke test honest against the real
   schema. Confirm the new tests fail for the right reason.

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

7. **Gates.** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, then
   `pnpm check:script-scaffold` (shape conformance) and `pnpm knip` (a script
   that declares the `workspace:*` dependency but doesn't exercise the library
   fails — the anti-hollow gate), then the smoke run
   `pnpm --filter @m3l-automation/<name> start`. Deliberately absent: the 80%
   coverage gate (scripts are exempt by ADR-0022 §8), exports-map checks, and
   provenance stamping — do not import them from the submodule pipeline.

8. **Docs and close.** Update the two documentation artifacts to match what
   shipped — `scripts/<name>/README.md` (how to run) and the contract page's
   schema/steps tables (the contract) — then invoke `/syncing-docs` (its script
   pass runs `check:script-scaffold` and regenerates the consumer-scripts
   catalog via `gen:index`). Remind the user the commit is a `feat:` only if it
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
