# CLI evolution — implementation plan (2026-08-20)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0053](../adr/0053-cli-first-evolution-programme.md),
  [ADR-0054](../adr/0054-command-module-contract-and-hybrid-execution.md),
  [ADR-0055](../adr/0055-declarative-operation-introspection.md),
  [ADR-0056](../adr/0056-cross-script-orchestration-engine.md),
  [ADR-0057](../adr/0057-private-registry-distribution.md), plus 2026-08-20
  Update blocks on ADR-0042 and ADR-0047 and the partial supersession of
  ADR-0020.
- **Trackers:** [`../ROADMAP.md`](../ROADMAP.md) §_CLI evolution wave_ and
  [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §_m3l-cli build-out_ (U-series
  rows) carry the live status; this file carries the detail behind those
  rows.

## Why this plan exists

A five-facet audit (2026-08-20, adversarially verified) of "what separates
this repo from a fully fledged CLI application" found the ADR-0042 launcher
complete (8b–8g all shipped) but architecturally bounded: spawn-only
dispatch, opaque `oneOf`-string operations, no orchestration, no completion,
no distribution story, and no CLI-specific governance gates. A maintainer
interview settled every design fork — including naming the first real
multi-script flow, which fired ADR-0047's revisit trigger. The five ADRs
above record those decisions; this plan decomposes them into the U-series.

## Scope and sequencing

| Phase | Contents                                          | Shape                                          |
| ----- | ------------------------------------------------- | ---------------------------------------------- |
| **A** | U1–U12 — restructure, capabilities, orchestration | One PR per item unless a row says otherwise    |
| **B** | U13 — private-registry publishing                 | Depends on U7 (discovery-over-dependencies)    |
| **C** | U14 — single-file binary                          | Recorded only; gated behind its own future ADR |

**Non-coupling with the codified-procedure wave:** B2 (`core/procedure`) and
W7 remain a separate programme. The U-series neither depends on nor blocks
them — ADR-0056's engine sequences whole scripts over the exit-code +
run-report contract, not procedure steps. Interleaving is a maintainer
priority call made in the trackers.

Library-touching phases (U3, U4, and any U11 seam) and every script/CLI
phase write into `packages/*/src/**` or `**/tests/**`, so each begins with
`/starting-work` and dispatches `code-implementer` / `test-author` — the hub
never writes those paths.

---

## Phase A — restructure and capabilities

### U1. Decisions and governance docs — this change set

ADR-0053…0057, the Update blocks on ADR-0042/0047, ADR-0020's status
annotation, the ADR index rows, this plan, the tracker rows, the
filing-work legend cell, and the config-declaration style rule. No code.

### U2. CLI structure and doc gates

Two new gates, mirroring the script pair:

- `check:cli-scaffold` — validates `packages/m3l-cli`'s required layout
  (bin entry, `src/` module set, README, package-manifest contract) the way
  `bin/check-script-scaffold.mjs` validates `scripts/*`.
- `check:cli-docs` — validates `docs/reference/cli.md` against a canonical
  section structure (see _Target structure of cli.md_ below) the way
  `bin/check-script-docs.mjs` validates script pages.

Wiring: `package.json` scripts, `bin/lib/verify-steps.mjs`,
`bin/lib/command-catalog.mjs`, `.github/workflows/ci.yml`. The gate spec
prose lives in `docs/contributing/` — extend `script-docs-structure.md` or
add `cli-docs-structure.md` (decide at implementation; record in the PR).

### U3. Contract promotion — `core/cli-contract`

**Decision:** ADR-0054. The command-module descriptor types, the exit-code
mapping surface (reusing the ADR-0035 registry — no new codes), and the
output/logger port, as a new Core-barrel submodule (final name settled
here). Submodule wiring is the mechanical set every submodule pays:
`src/core/<name>/index.ts` + barrel line (`check:scaffold`), the seam test
(`check:scaffold-seam`), `docs/reference/core/<name>.md` + provenance
sidecar, an `implementation-status.md` row, and Core count 22 → 23 at every
count site via `pnpm gen:counts` — never hand-edited. **Semver: additive
minor.** `check:api` must not move (barrel-surfaced only).

### U4. Declarative operations — library half

**Decision:** ADR-0055. `core/config` gains the serialisable operation
declaration (name, description, required parameter names) with validation
derived from it. Existing validator-based configs unchanged. **Semver:
additive minor.**

### U5. Declarative operations — fleet retrofit

The multi-operation scripts (`dynamodb-crud`, `s3-objects`, `ecs-ops`,
`eks-ops`, `lambda-ops`, `cloudformation-stacks`, `codepipeline-ops`, and
peers) declare their operation sets, replacing bare `oneOf` closures. The
two-PR library-then-fleet chain precedent applies; the retrofit may split
across PRs by script cluster.

### U6. `commandModule` adoption — template + pilots

**Decision:** ADR-0054. `templates/script/` gains the typed `commandModule`
export (additive; spawn entry untouched); `bin/scaffold-script.mjs` and
`check:script-scaffold` learn the new file as **optional** until the fleet
catches up. Two or three pilot scripts adopt (suggested: `json-etl` — no
AWS surface — then `sqs-etl`, `dynamodb-crud`, the named-flow participants).
The script ESLint zone gains the `process.exit` ban on the command-module
path.

### U7. Hybrid execution in the CLI

**Decision:** ADR-0054. The CLI executes a `commandModule`-exporting script
in-process on an opt-in path (flag or config; spawn stays the default);
parameters bind directly; cancellation forwards the CLI's `AbortSignal`
(ADR-0049); output routes through the port. The CLI's `package.json` begins
declaring script packages as real dependencies, and discovery starts
resolving over the dependency graph (doctor + cache updated). Exit-code and
run-report parity per ADR-0054's guarantee-parity contract.

### U8. Operation introspection surfacing

**Decision:** ADR-0055. `m3l inspect` renders the operation table; the
dynamic `--help` and the wizard scope parameter prompts by chosen
operation. Depends on U4; useful as soon as any U5 script has declared.

### U9. `m3l new` + Lambda scaffold variant

The long-reserved `new` command activates: scaffolding moves from
`bin/scaffold-script.mjs` into the CLI (the bin script may become a thin
delegate for one release). A Lambda variant closes the audit's
template gap (`createLambdaHandler` path in `templates/script/`); whether
that flips C2's (event-source seam) dormant status is decided in this
phase's PR against ADR-0018's Update.

### U10. Orchestration engine + the named flow

**Decision:** ADR-0056. `m3l flow` — spawn-first engine over exit codes +
`run-report.json`, in-process fast path where a step's script offers a
`commandModule`. Two PRs (engine; then the named
sqs-etl → json-etl → dynamodb-crud → sqs-etl flow as acceptance), preceded
by its own dated design plan (definition format, branching algebra, resume
semantics, on-disk artifact convention, and — if needed — a dated ADR-0035
Update for flow-level exit codes). Reserved-name set grows by `flow`
(scaffold manifest, `check:script-scaffold`, doctor — same change).

### U11. Retry/resume/cancellation surfacing

CLI-level exposure of the library's machinery: `--resume` passthrough where
a script checkpoints (ADR-0045 fingerprint-aware), Ctrl-C forwarding as
cooperative cancellation on the in-process path (ADR-0049), and
retry/outcome visibility in `history` and run-report rendering. Spawn-path
parts are standalone; in-process parts depend on U7. If a library seam
proves missing, it gets its own recorded decision (possible minor).

### U12. Shell completion

`m3l completion` (bash/zsh/fish) over static commands, script names,
parameter names, and — via U8 — operation values. Reserved-name set grows
by `completion` (same three sites as U10).

---

## Phase B — distribution

### U13. Private-registry publishing

**Decision:** ADR-0057. GitHub Packages (private): publish
`m3l-common`, `m3l-cli`, and the script fleet in lockstep, hand-managed
versions; a manually-dispatched release workflow holding the repo's first
publish-scoped credential (release-workflow-only — the recorded security
posture change). Security prose in `docs/contributing/` and CLAUDE.md
updates land in this phase. Depends on U7 (discovery must not need a
workspace scan).

---

## Phase C — recorded, not built

### U14. Single-file binary (Node SEA)

Filed **Deferred**. Unblock condition: a dedicated future ADR granting a
scoped bundler exception to ADR-0001/0002 and defining the build matrix.
Nothing in Phases A/B may assume or preclude it.

---

## Target structure of `docs/reference/cli.md`

The canonical section list `check:cli-docs` (U2) will enforce — cli.md
itself is **not** edited until each section's feature actually ships (it
documents shipped behaviour only):

1. Title + purpose/invocation preamble
2. `## Design invariants`
3. `## Commands` — one `###` per command, grouped per shipped phase
4. `## Flows` — added when U10 ships
5. `## Completion` — added when U12 ships
6. `## Exit codes` — consolidated registry mapping (today threaded through
   command sections; consolidated when U2's gate lands)

## Documentation reconciliation

Per shipped item: update the touched contract pages
(`docs/reference/cli.md`, `docs/reference/core/{config,script}.md`, the new
`docs/reference/core/<cli-contract>.md`, retrofitted
`docs/reference/scripts/*.md`), flip the matching U-row, then run
`/syncing-docs` — it owns provenance re-stamping, count regeneration
(Core 22 → 23 lands with U3, never hand-edited), the reference index, and
markdown lint. Reserved-name sites (`bin/lib/script-scaffold.mjs`,
`check-script-scaffold.mjs`, doctor) change only in the PR that ships the
command claiming the name.

## Definition of done

- Per code phase: `pnpm typecheck`, `lint`, `test` (+ coverage thresholds),
  `build`, `check:zones` (no zone widened), `check:api` and `check:exports`
  unchanged, `check:scaffold`/`check:scaffold-seam`/`check:script-scaffold`/
  `check:script-deps` clean, `pnpm verify` reproducing CI.
- U2's two new gates green in CI and in `pnpm verify`'s step list
  (`check:verify-parity`).
- Trackers flipped; `pnpm sync:hub` dry-run reviewed and applied.
- A work log per shipped phase cluster under `docs/logs/`.
