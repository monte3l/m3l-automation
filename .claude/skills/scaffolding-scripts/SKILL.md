---
name: scaffolding-scripts
description: >-
  Scaffold a brand-new automation script package under scripts/<name>/ that consumes
  @m3l-automation/m3l-common via workspace:* — the greenfield entry point for a consumer
  script that has no directory yet. Runs the deterministic generator (pnpm scaffold:script),
  which emits the ratified modular skeleton (thin main.ts composition root + config.ts +
  hooks.ts + starter steps/ module + config smoke test + README + contract page) from
  templates/script/ and wires the root tsconfig reference; then installs, builds, smoke-runs,
  and hands off to implementing-scripts for the real logic. Use this whenever the user asks
  to add, create, or scaffold a new automation/consumer script, job, or CLI under scripts/ —
  even phrased casually like "set up a new export script", "add a report-generator
  automation", or "create a script that syncs S3 to Dynamo", and even if they never say
  "scaffold". This is for consumer scripts under scripts/, NOT library code: for a new
  Core/AWS library module use scaffolding-submodules, and to fill in an existing documented
  submodule use implementing-submodules.
---

# scaffolding-scripts

Scaffold a new automation script under the monorepo's `scripts/*` workspace —
the _greenfield_ entry point for a **net-new** consumer that has no
`scripts/<name>/` directory yet. The heavy lifting is deterministic: the
generator `pnpm scaffold:script <name>` emits every file from
`templates/script/` (package manifest, tsconfigs, the modular `src/` skeleton,
the ADR-0022 §8 config smoke test, a README, and the contract page under
`docs/reference/scripts/`) and wires the root tsconfig project reference. The
skill's job is the orchestration around it: the pre-work gate, the required
parameters, install/build/smoke, doc fill-in, index regeneration, and hand-off.
The fleet conventions are ratified in
[ADR-0022](../../../docs/adr/0022-reintroduce-scripts-workspace.md); the API the
script builds against is
[`docs/reference/core/script.md`](../../../docs/reference/core/script.md); the
CI backstop is `pnpm check:script-scaffold`, which verifies every script
package against the same shared manifest (`bin/lib/script-scaffold.mjs`) the
generator emits from.

## Role boundaries (hub-and-spoke)

This skill runs in the **hub** (main agent) and only lays down the scaffold
seam — the generated skeleton whose step bodies do nothing real yet. It does
**not** implement the script's business logic or review it: implementation is
handed to the `implementing-scripts` skill, whose spokes (`test-author` RED,
`code-implementer` GREEN, `code-reviewer` + `security-reviewer` review) keep
"the agent that writes code is never the one that reviews it" structural. Keep
that separation by handing off rather than implementing inline.

## Steps

0. **Run `/starting-work` first.** Scaffolding writes guarded paths
   (`scripts/<name>/src/**`), which `guard-branch-isolation.mjs` blocks while
   `HEAD` is `main`. `/starting-work` is the single source of truth for the
   branch/worktree, PR, and push decisions — it infers and confirms them up front
   so you branch proactively instead of hitting the block mid-scaffold.
1. Ask for the **script name** (kebab-case → `@m3l-automation/<name>`), a
   **one-line purpose**, and whether it **touches AWS** and is **CLI-only or
   CLI+Lambda**. These are required-parameter asks, exempt from the 5–7
   clarifying-question rule. First check `scripts/<name>/` does not already
   exist — if it does, **stop and redirect**: the script is already scaffolded,
   so implement/edit it directly (via `implementing-scripts`) instead of
   re-scaffolding.
2. **Run the generator:**

   ```bash
   pnpm scaffold:script <name> --purpose "<one-line purpose>"
   ```

   It refuses a non-kebab-case name or an existing `scripts/<name>/`, emits
   every template with token substitution (prettier-formatted, so
   `format:check` stays green), and inserts the root `tsconfig.json` project
   reference (sorted, idempotent). Never hand-write the skeleton files — the
   templates under `templates/script/` are the single source of the shape, and
   `check:script-scaffold` fails CI on any drift from them.

3. Run `pnpm install` (the workspace glob picks up the new package), then
   `pnpm build` (turbo orders `m3l-common` first), then the smoke run
   `pnpm --filter @m3l-automation/<name> start`, then `pnpm test` (the
   generated config smoke test must pass).
4. **Fill in the two documentation artifacts** the generator created, keeping
   their responsibilities disjoint:
   - `scripts/<name>/README.md` — **how to run**: invocation, `.env` secrets,
     the `M3L_*_DIR` isolation overrides, data directories.
   - `docs/reference/scripts/<name>.md` — **the contract**: purpose/scope, the
     config schema table (keep it in sync with `src/config.ts`), the steps
     table, inputs/outputs.

   If the script **touches AWS**, add the `Core.AWS_PROFILE_PARAM_NAME`
   parameter to `src/config.ts` and document it in the schema table. Then run
   `pnpm gen:index` so the consumer-scripts catalog in
   `docs/reference/README.md` picks the script up, and
   `pnpm check:script-scaffold` as the local conformance check.

5. Hand off implementation to the **`implementing-scripts`** skill: it runs the
   script TDD loop (contract → RED step tests → GREEN `steps/` implementation →
   review) with the right spokes and gates, landing via PR. knip fails an
   unused `workspace:*` import, so the script must actually exercise the
   library to go green.
6. When the scaffold lands as its own PR (rather than folded into the
   implementation PR), close with `/writing-work-logs` so decisions and
   divergences are recorded while the context is live.

## What "good" looks like

**Thin composition root, logic in an injected-deps step:**

```ts
// good — main.ts only wires + runs; runExport takes its deps as parameters
// (run's main function takes no arguments — reach the library through the
// script instance and inject what the step needs)
await script.run(async () => {
  const config = await script.getConfiguration();
  await runExport({ logger: script.logger, config });
});
// bad — business logic inlined into main.ts (a loop, I/O, branching)
await script.run(async () => {
  for (const row of await readAll()) await writeOne(row); // reviewers reject this
});
```

**Config through the seam, never `process.env`:**

```ts
// good — declared parameter + validator; the loader is the only input seam
new Core.M3LConfigParameter({
  name: "batchSize",
  type: Core.M3LConfigParameterType.INT,
  defaultValue: BATCH_SIZE_DEFAULT,
  validate: Core.M3LConfigValidators.range(BATCH_SIZE_MIN, BATCH_SIZE_MAX),
});
// bad — reading the environment directly bypasses validation and redaction
const batchSize = Number(process.env.BATCH_SIZE);
```

## Rules

- `main.ts` is a composition root only — any conditional, loop, or I/O beyond
  wiring belongs in a `steps/` module. Reviewers reject logic in `main.ts`.
- I/O only through `M3LPaths`; isolate a script's data with the `M3L_*_DIR` env
  overrides pointing at `data/<name>/…` (ADR-0022), never hardcoded paths.
- Secrets only via the gitignored `.env` or config `secretNames`, never literals.
- AWS access via the `aws.profile` seam (`AWS_PROFILE_PARAM_NAME` → `script.aws`),
  not hand-constructed SDK clients.
- Don't implement the business logic here; hand off to `implementing-scripts`.
- Never edit a generated file's _shape_ by hand (add files, drop `hooks.ts`,
  rename `main.ts`): the shape belongs to `templates/script/` +
  `bin/lib/script-scaffold.mjs`, and `check:script-scaffold` enforces it in CI.
  To evolve the shape, change the templates + manifest together in their own PR.
- See `.claude/rules/scripts.md` and ADR-0022 for the full fleet conventions.
