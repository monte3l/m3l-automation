# V10 — `packages/m3l-mcp` runtime MCP surface (2026-09-14)

- **Status:** in flight. This wave delivers the **skeleton half** of V10 —
  the package, its governance registration, the policy/audit dispatch spine,
  and one tool (`fleet_health`). The three remaining intent groups
  (`fleet_describe`, `fleet_run`, `fleet_flow`) and the `core/process`
  promotion they depend on are recorded below as later slices, deliberately
  out of this wave's scope. The V10 tracker row stays **To Do** until they
  land.
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0062](../adr/0062-runtime-mcp-surface.md) (as amended
  by its 2026-09-14 Update — tool grouping, the `isError` redefinition, the
  retired `m3l-cli`-internals clause),
  [ADR-0057](../adr/0057-private-registry-distribution.md) (its 2026-09-14
  Update settles publish-set membership). Enforces
  [ADR-0060](../adr/0060-agent-policy-layer.md) and
  [ADR-0061](../adr/0061-agent-decision-log.md); consumes
  [ADR-0063](../adr/0063-cli-structured-run-results.md) envelopes and
  [ADR-0055](../adr/0055-declarative-operation-introspection.md) operation
  schemas.
- **Why this plan exists:** issue
  [547](https://github.com/monte3l/m3l-automation/issues/547) (V10) asks for
  a new workspace package exposing the m3l fleet to any MCP client under the
  same policy and audit trail as the `agent-operator` script. Every declared
  dependency has shipped (V2, V6, V7, V8, U10, and ADR-0055's U4/U5/U8), so
  nothing blocks it. Investigating it surfaced three things the issue body
  does not carry: ADR-0062 owes an ADR-0057 Update now that U13 landed
  first; two of ADR-0062's own clauses are unrealizable as written; and the
  SDK cannot produce the JSON-RPC error the ADR's escalation rule describes.
  All three are settled in the two ADR Updates this wave's first slice
  carries, so no later slice has to contradict an accepted ADR silently.

## Scope and sequencing

| Stage | Contents                                                                | Shape                                                              |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **1** | The two ADR Updates + this plan doc                                     | Docs only; records the corrections before any code depends on them |
| **2** | Package skeleton, governance registration, process port, empty registry | New package; no tool exists yet, by construction                   |
| **3** | Policy + audit dispatch spine, and `fleet_health`                       | The first tool, reachable only through the gate                    |
| **4** | Contract page, Tooling row, `check:mcp` scoping, tracker pointers       | Docs + one gate assertion; V10 row stays To Do                     |

## Landing plan

ADR-0072's durable slice record for this non-submodule multi-PR wave — the
same `## Landing plan` heading and `| Slice | Branch | Scope | Status |`
table a submodule's reference page carries, gated by
`pnpm check:landing-plans`.

| Slice | Branch                      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status            |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| V10a  | `feat/v10-mcp-adr-updates`  | The ADR-0062 Update (tool grouping settled; `isError` redefinition; retired `m3l-cli`-internals clause; corrected library specifier; `zod` as a second own dependency) + the ADR-0057 Update (publish-set membership) + this plan doc                                                                                                                                                                                                                                                            | Landed (PR #1253) |
| V10b  | `feat/v10-mcp-scaffold`     | `packages/m3l-mcp` skeleton: `package.json`, both tsconfigs, `bin/`, `README.md`, composition root, error type, env config, the narrow CLI process port, doctor argv/parser, and a brand-gated **empty** tool registry. Governance registration: root `tsconfig.json` reference, `knip.json` workspace, three `eslint.config.js` edits, matching `bin/check-eslint-zones.mjs` assertions (plus the missing reverse `packages/*` to `scripts/*` zone), the `mcp:serve` script and its catalog row | To Do             |
| V10c  | `feat/v10-mcp-policy-spine` | `src/policy/{load,identity,recorder,session}.ts`, `src/tools/gate.ts`, `src/tools/health.ts`; the seven-step gate contract; the verdict-to-response mapping; `fleet_health` registered through `gateTool`                                                                                                                                                                                                                                                                                        | To Do             |
| V10d  | `feat/v10-mcp-docs`         | `docs/reference/mcp.md`, the third `docs/reference/README.md` **Tooling** row, one new `bin/check-mcp.mjs` assertion (the runtime server is not self-registered) plus its dev-time relabelling, tracker pointers, work log                                                                                                                                                                                                                                                                       | To Do             |

### Recorded as later slices, not built here

| Slice | Scope                                                                                                                                 | Gate on it                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| V10e  | Promote `scripts/agent-operator/src/lib/cli-process.ts` to a new `core/process` Core leaf; retrofit agent-operator off its local copy | **Hard precondition of V10g.** See "The process seam" below           |
| V10f  | `fleet_describe` — list + inspect, carrying ADR-0055 operation descriptors                                                            | Needs V10e only for its spawn path, not its parsing                   |
| V10g  | `fleet_run` — the ADR-0063 envelope, dry-run-first enforced through the ledger                                                        | **Blocked on V10e**: a mutation path needs the bounded-kill invariant |
| V10h  | `fleet_flow` — flow list + run, nesting one run envelope per step                                                                     | **Blocked on V10e**, plus V13's process-group teardown                |
| V10i  | Close-out: flip V10 to Done in the tracker, `docs/ROADMAP.md`, and the agent-operator plan doc                                        | Last                                                                  |

## The process seam, and why the promotion is sequenced rather than skipped

`scripts/agent-operator/src/lib/cli-process.ts` already implements bounded
child-process execution — per-stream byte caps, a timeout, `AbortSignal`
support, POSIX-gated process-group teardown with SIGKILL escalation. It
imports only `node:child_process` and `node:string_decoder`, and its own
`@example` blocks cite a shared subpath that does not exist, so it was
written to be shared. `packages/m3l-console-server/src/runs/executor.ts` is
a second, independent implementation of the same idea. This package needs a
third.

Promoting it into `Core` is the right end state and the repo's own rule
(ADR-0060 rejected keeping the policy layer script-local on exactly this
reasoning: two consumers exist, so it belongs in the library). It is not
sequenced first, because the invariants that make it load-bearing —
teardown, escalation, grandchild reaping — are only exercised by `fleet_run`
and `fleet_flow`. `fleet_health` is `m3l doctor --json`: read-only, no
preset, no mutation, no grandchild process.

So V10b builds a **narrow injected port** — argv array with `shell: false`,
byte caps, timeout, injectable `spawnImpl`, and nothing else — and V10e
replaces that port's body with a delegation to `Core`. The port is one file,
which is what keeps this a deferral rather than a third permanent copy. The
promotion is a hard gate on V10g, recorded here so it cannot quietly become
optional.

Rejected alternatives, for the record: giving `m3l-cli` an `exports` map
(contradicts ADR-0063, which already designates the `--json` envelope as
this surface's result shape, and makes the server the direct parent of every
spawned script with no bounded-kill owner); and depending on
`@m3l-automation/agent-operator` (turns a consumer script into a library —
what ADR-0029 exists to prevent — and inherits its exemption from
`check:file-budget` and the coverage lane).

## Two contract gaps this wave inherits

Both are recorded in ADR-0062's Update and must be documented on the
contract page, because each reads as a bug to an operator who does not know
it is deliberate:

- **No model identity.** MCP's `initialize` handshake carries `clientInfo`
  (name, version) but nothing identifying the model, so ADR-0061 log entries
  from this surface carry `identity.name` as `mcp:<client>@<version>` and
  omit `modelId`. The client-supplied string is untrusted input on a path
  into an audit line — length-capped and stripped of control characters
  before use.
- **Unobservable budgets.** A policy declaring `budgets.tokensPerRun`,
  `costPerRun` or `loopIterations` escalates every call under the matching
  `.unobservable` rule, because a stdio server has no model loop to measure.
  Correct fail-closed behaviour, not a defect.

## Constraints re-derived at wave start

Each of these was measured against the current gate sources, not inferred
from prose. Re-derive them again at each slice's start rather than trusting
this paraphrase.

- `bin/check-file-budget.mjs` caps every `packages/*/src/**` file at 25,000
  bytes. `scripts/*/src` is out of scope, which is exactly why the
  agent-operator precedent is allowed to be a 77 KB file and a port of it
  cannot be. The gate runs no earlier than `pre-push`.
- `vitest.config.ts`'s coverage `include` is already `packages/*/src/**/*.ts`
  with `perFile: true`, so every non-`index.ts` file this package adds is
  gated at lines 90 / functions 83 / branches 80 / statements 89 from its
  first commit. No config change is needed — and none is a safety net either.
- `check:dup` (jscpd) scans `agent-operator` and `m3l-mcp` in the same run,
  so a copy-paste port is what it exists to catch. Re-derive shapes from the
  contract instead of copying, and run the gate locally at the slices that
  add parser code.
- `bin/check-eslint-zones.mjs` asserts a hard-coded list of zones, so a new
  package zone is **unenforced** unless the gate gains a matching assertion
  in the same change. V10b adds both, and mutation-tests them.
- **`knip` forces a dependency to land with its first importer, not before.**
  It flags a declared-but-unimported workspace dependency as unused, so V10b
  ships with `@modelcontextprotocol/sdk` and `zod` only — the skeleton
  imports neither the library nor anything from it. **V10c must re-add
  `"@monte3l/m3l-common": "workspace:*"` to `packages/m3l-mcp/package.json`
  in the same change as `src/policy/load.ts`**, its first real consumer;
  otherwise that import will not resolve. The `tsconfig` project reference to
  `m3l-common` is deliberately left in place (it fixes build order and is not
  a package dependency). An `ignoreDependencies` exemption was rejected: the
  `m3l-cli` precedent exists for packages resolved dynamically at runtime,
  which is a different reason from "not imported yet", and the exemption
  would mute the signal permanently.
- `bin/check-mcp.mjs` currently validates the dev-time server only, and
  asserts `readOnlyHint: true` on every tool — true of all six ADR-0096
  tools, and false of `fleet_run`/`fleet_flow`. It is therefore **not**
  widened to cover both servers; V10d adds one assertion in the other
  direction (the runtime server is not self-registered in `.mcp.json`) and
  relabels the existing prose as dev-time.

## Definition of done for this wave

`pnpm verify` green on each slice; `check:review-size` measured **before**
each push, not after; the V10 row still `To Do` with a pointer to this doc;
`pnpm sync:hub` run with `closingIssuesReferences` asserted empty before
merge, since issue 547 must survive this wave; a work log under `docs/logs/`.
