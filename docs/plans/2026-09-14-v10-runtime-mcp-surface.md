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

| Stage | Contents                                                              | Shape                                                              |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **1** | The two ADR Updates + this plan doc                                   | Docs only; records the corrections before any code depends on them |
| **2** | Package skeleton, governance registration, brand-gated empty registry | New package; no tool exists yet, by construction                   |
| **3** | Policy + audit dispatch spine, and `fleet_health`                     | The first tool, reachable only through the gate                    |
| **4** | Contract page, Tooling row, `check:mcp` scoping, tracker pointers     | Docs + one gate assertion; V10 row stays To Do                     |

## Landing plan

ADR-0072's durable slice record for this non-submodule multi-PR wave — the
same `## Landing plan` heading and `| Slice | Branch | Scope | Status |`
table a submodule's reference page carries, gated by
`pnpm check:landing-plans`.

| Slice  | Branch                      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status            |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| V10a   | `feat/v10-mcp-adr-updates`  | The ADR-0062 Update (tool grouping settled; `isError` redefinition; retired `m3l-cli`-internals clause; corrected library specifier; `zod` as a second own dependency) + the ADR-0057 Update (publish-set membership) + this plan doc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Landed (PR #1253) |
| V10b   | `feat/v10-mcp-scaffold`     | `packages/m3l-mcp` skeleton: `package.json`, both tsconfigs, `bin/`, `README.md`, the composition root, the error type (on `Core.M3LError`, matching both sibling packages), and a brand-gated **empty** tool registry whose `unique symbol` key is never exported, so `gateTool` can be its only producer. Governance registration: root `tsconfig.json` reference, `knip.json` workspace, four `eslint.config.js` edits, matching `bin/check-eslint-zones.mjs` assertions (plus the missing reverse `packages/*` to `scripts/*` zone), the `mcp:serve` script and its catalog row. **Env config, the CLI process port and the doctor argv/parser moved to V10c**: `knip` flags an unreachable export, and none of them has a caller until a tool exists | Landed (PR #1258) |
| V10c   | `feat/v10-mcp-cli-leaves`   | `src/config/settings.ts` (boot configuration from the environment) and `src/cli/envelopes.ts` (the `doctor --json` parser). The two leaves of the CLI facade — neither imports anything else this wave adds, so they land first and stand alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Landed (PR #1269) |
| V10c2  | `feat/v10-mcp-cli-process`  | `src/cli/process.ts` only: the bounded subprocess port — `shell: false` and an argv array, a per-stream byte cap that bounds every chunk, an own-timer timeout, an injectable `spawn` seam. No process-group teardown and no SIGKILL escalation; those arrive with V10e. Imports nothing from this package, so it stands alone                                                                                                                                                                                                                                                                                                                                                                                                                            | To Do             |
| V10c2b | `feat/v10-mcp-cli-facade`   | `src/cli/surface.ts` (the argv table and invocation) plus `ERR_MCP_CLI` on `M3LMcpErrorCode`. Depends on V10c's two leaves and on V10c2's port, which it composes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | To Do             |
| V10c3  | `feat/v10-mcp-policy-spine` | `src/policy/{load,identity,recorder,session}.ts`, `src/tools/gate.ts`, `src/tools/health.ts`; the seven-step gate contract; the verdict-to-response mapping; `fleet_health` registered through `gateTool`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | To Do             |
| V10d   | `feat/v10-mcp-docs`         | `docs/reference/mcp.md`, the third `docs/reference/README.md` **Tooling** row, one new `bin/check-mcp.mjs` assertion (the runtime server is not self-registered) plus its dev-time relabelling, tracker pointers, work log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | To Do             |

### Why the original V10c became four rows

The committed V10c covered nine `src` modules — the policy spine plus the
three files V10b pushed forward. Measured, not estimated: the CLI facade
alone is **115,981 reviewable chars**, against ADR-0072's 75,000 soft
target. The first split (facade / spine) was sized from V10b's 52,878 chars
for three modules, which was wrong — V10b's modules total 14,186 bytes and
the facade's total 49,495, so per-module size tripled and the tests scaled
with them. `config/settings.ts` + its test is 32,199 chars on its own;
`cli/process.ts` + its test is 41,660.

Split along the dependency grain rather than by file count, because
`cli/surface.ts` imports the other three: the two leaves that import
nothing from this wave (`config/settings.ts`, `cli/envelopes.ts`) land as
V10c at ~49k, and the two that compose them (`cli/process.ts`,
`cli/surface.ts`) land as V10c2 at ~64k. A src-versus-tests split was
rejected outright — `vitest.config.ts`'s perFile thresholds (lines 90 /
functions 83 / branches 80 / statements 89) would fail the first PR, since
the modules would arrive with no tests at all.

Then V10c2 itself split again, for a reason worth recording because it will
recur: the slice measured 66,590 chars when its code was transplanted, and
a re-review of the two modules found two Must-fix defects whose fixes and
tests took it to 85,768 — past the soft target. Review findings are not
free, and a slice sized to just fit before review has no room to absorb
what review finds. The split follows the same dependency grain as the
first: `cli/process.ts` is the true leaf, importing only
`node:child_process` and `node:string_decoder`, so it lands as V10c2
(50,353 chars) and `cli/surface.ts`, which composes it, lands as V10c2b
(34,330). Verified before splitting that `process.ts` and its test name
neither `M3LMcpError` nor `ERR_MCP_CLI`, so the error-union change stays
wholly with the facade.

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
byte caps, timeout, an injectable `spawn` seam, and nothing else — and V10e
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
- **`knip` forces a _dependency_ to land with its first importer — but not a
  _module_.** Re-measured at V10c's start, because V10b's own row cites
  "`knip` flags an unreachable export" as the reason the config and CLI files
  moved to V10c, and that reason is wrong. `knip --debug` resolves this
  package's `**/*.{bench,test,test-d,spec,spec-d}.?(c|m)[jt]s?(x)` glob as an
  entry pattern (its vitest plugin adds it; `knip.json`'s own `entry` is not
  the whole set), so a `src` module reached only by its own test is a
  reachable entry and is never flagged. V10b already proves it in-repo:
  `isM3LMcpError` is exported, imported by no `src` module, imported only by
  `tests/mcp-error.test.ts`, and `knip` is green. That is what makes both
  facade slices landable before any tool calls them. A
  declared-but-unimported **dependency** is still flagged, which is the real
  constraint —
  it flags a declared-but-unimported workspace dependency as unused. This
  fired on `@monte3l/m3l-common` during V10b, and the first answer (drop the
  dependency until V10c's `src/policy/load.ts` needed it) was wrong for a
  reason the code review then found independently: `M3LMcpError` was
  extending the native `Error`, while **both** sibling packages that define
  an error type extend `Core.M3LError`. Rebasing it on `Core.M3LError` fixes
  that divergence _and_ makes the dependency genuinely used, so `knip` goes
  green for the right reason. An `ignoreDependencies` exemption was rejected
  either way: the `m3l-cli` precedent covers packages resolved dynamically at
  runtime, a different reason from "not imported yet", and the exemption
  would mute the signal permanently. The codes are deliberately **not**
  registered in `m3l-common`'s `M3L_ERROR_CODES` tuple, matching the explicit
  statement in `packages/m3l-console-server/src/errors/console-error.ts`.
- `bin/check-mcp.mjs` currently validates the dev-time server only, and
  asserts `readOnlyHint: true` on every tool — true of all six ADR-0096
  tools, and false of `fleet_run`/`fleet_flow`. It is therefore **not**
  widened to cover both servers; V10d adds one assertion in the other
  direction (the runtime server is not self-registered in `.mcp.json`) and
  relabels the existing prose as dev-time.

## Carried into V10c by V10b's review

V10b's pre-push fan-out (`code-reviewer`, `type-design-analyzer`,
`silent-failure-hunter`) raised five findings that are correct but not
actionable until `gateTool` exists. They are recorded here rather than left
in a review transcript, because each one is invisible in the code as it
stands:

- **Deep-freeze entries at mint time.** `GatedToolRegistration` promises
  `config.annotations.readOnlyHint` is `readonly`, but `Object.freeze` on
  `TOOL_REGISTRY` is shallow — so once entries exist, a JavaScript caller can
  mutate a registered tool's annotations. `gateTool` should deep-freeze what
  it mints.
- **Add the runtime brand check at the registration boundary.** With the
  brand now carrying a real (still unexported) symbol value,
  `entries.every(isGatedToolRegistration)` becomes possible and is the only
  thing that stops a _JavaScript_ caller — the type system stops only
  TypeScript ones, and `bin/m3l-mcp.mjs` is unchecked `.mjs`. Deliberately
  **not** added in V10b: the tests inject fakes through
  `as unknown as GatedToolRegistration[]` because they cannot mint (no
  producer exists yet and the brand is unexported by design), so the check
  would break the seam it depends on. It lands with `gateTool`, at which
  point the tests mint for real and the casts go away.
- **Never parse external input into the branded type.** An `any`-typed
  boundary launders straight through the brand cast-free — a
  `JSON.parse(raw) as readonly GatedToolRegistration[]` compiles, and only
  ESLint's `no-unsafe-return`/`no-unsafe-assignment` stand in the way. Policy
  and tool config must be validated into their own shapes and then passed to
  `gateTool`, never asserted into the registration type.
- **`isM3LMcpError` is `instanceof`-based, so it is realm-sensitive.** Two
  copies of the module (a `dist`-vs-`src` import, a duplicated install) would
  make it return `false` for a genuine error, silently misclassifying it.
  Inert today — nothing throws `M3LMcpError` or calls the guard yet — but
  V10c adds both, so verify it at the first real call site.
- **Re-verify the `process.exitCode` choice once boot grows steps.**
  `bin/m3l-mcp.mjs` sets `process.exitCode = 1` rather than calling
  `process.exit`, which is safe only because the single awaited step today
  (`connect` → `StdioServerTransport.start`) registers its `stdin` listener
  as its last synchronous, non-throwing act. V10c's policy load and
  decision-log preflight add steps that can open a handle _before_ they can
  throw, which would leave the process alive with a dangling handle.

PR #1258's second CI review round added three more. Two were taken in that
same PR — the missing `coversMcp` term in `bin/check-eslint-zones.mjs`'s
no-cycle conjunction (which made the guard decorative for exactly the package
the PR added) and the unguarded relative import into
`packages/m3l-common/src/internal` (ADR-0004's own sealing zone is scoped
`target: "./packages/m3l-common/src"` and is therefore blind to a consumer
reaching in from outside). The remaining three land in V10c:

- **Spawn-test the bin entry's two stderr branches.** `bin/m3l-mcp.mjs`
  separates a missing `dist/` from a failed boot, and neither branch has a
  regression test — `vitest.config.ts` scopes coverage to
  `packages/*/src/**/*.ts`, so `bin/**/*.mjs` is outside the gate entirely
  and its 100% figure says nothing about the entry. Both branches were
  verified by hand before V10b's push (exit 1, one stderr line, zero
  host-path occurrences), which is a one-off check, not a guard. A real test
  spawns the entry as a child process.
- **Directory-bound the SDK's `import-x/no-unresolved` ignore.** The entry is
  `"^@modelcontextprotocol/sdk"`, which is repo-wide — it silences the rule
  for every file, not just this package's. Narrowing it needs a second
  block, so it belongs with a slice already editing that region.
- **Annotate the empty registry's freeze.**
  `Object.freeze<readonly GatedToolRegistration[]>([])` states the intended
  type at the call site instead of relying on the declaration's annotation to
  widen `never[]`. Cosmetic while the array is empty; worth doing in the
  slice that first puts an entry in it.

## Carried out of the V10c facade by its reviews

The facade's slices each run a pre-push review fan-out plus a CI round.
Findings that were fixed in their own slice are not listed here; these are
the ones deliberately **not** fixed, with the reason, because each is
invisible in the code as it stands. Each slice appends its own set as it
lands, so this section grows rather than being rewritten. `cli/surface.ts`'s
own set arrives with V10c2b.

Two entries below are findings a reviewer raised as suspected defects that
mutation testing then reclassified — a guard that turned out to be
unreachable, and a guard whose property `Promise` already provides. They are
recorded rather than "fixed" because in both cases the code is right and
only its comments were wrong.

From V10c (`config/settings.ts`, `cli/envelopes.ts`):

- **`parseDoctorChecks` freezes the array but not the rows.** Harmless today
  — they are fresh literals built field by field, with no other reference
  held — so the TSDoc's "cannot be mutated out from under a later reader"
  guarantee holds at the array level only. The `readonly` field types make
  it compile-time safe, so it matters solely for a JavaScript caller. The
  asymmetry is not deliberate and should be closed when something else
  edits that function.
- **`EnvelopeParseFailure`'s `missing-field` and `field-not-a-string` could
  name the field.** A field name is schema-owned and never caller data, so
  it does not breach the never-echo-input rule, and it would materially
  improve diagnosability — right now a malformed row reports only _that_ a
  string field was wrong, not which. Deferred because V10f adds the
  `list`/`inspect` parsers and should settle the shape once for all three
  rather than twice.

From V10c2 (`cli/process.ts`):

- **Reshape `CliRunResult` into a discriminated union on `disposition`.** A
  hard precondition of V10e. The flat record admits three combinations the
  implementation never produces: `"spawn-failed"` with a non-null
  `exitCode`, `"exited"` with a `failureCode`, `"exited"` with a null
  `exitCode`. The union also lets V10c2b's `assertExited` become an
  `asserts` signature, which deletes a `null` branch that is unreachable in
  practice. Deferred to V10e deliberately: that slice is where the type
  becomes a published `Core` semver surface, so fixing it there keeps the
  bad shape out of the library rather than merely postponing it.
- **Brand `timeoutMs` and `maxOutputBytes`.** Also a V10e precondition.
  `config/settings.ts` validates both ranges at load, so the brand would be
  earned rather than cast — but nothing stops a direct caller of
  `runCliProcess` passing `0` or `-1`. Validation-at-the-edge is correct
  while `settings.ts` is provably the only producer, and that premise dies
  with the promotion.
- **`ingest`'s `if (breached) return;` cannot currently fire.** Established
  by mutation, not by reading: deleting it leaves the whole suite green.
  `detachAll()` removes the `"data"` listener synchronously with breach
  detection — same call stack, no microtask boundary — so no later chunk
  re-enters `ingest`, and the per-chunk slice that now bounds the cap does
  not change that. Kept as defence-in-depth carrying the reachability
  argument, so a later refactor that defers detach cannot quietly remove the
  only real protection. The test that reads like its guard keeps its name: it
  pins the detach mechanism, which is what actually holds in production.
- **The `settled` flag is not what stops a settled disposition being
  overwritten.** A `Promise`'s `resolve` is already idempotent, so the
  settle-once property of the _result_ is free and those tests stay green
  with the guard deleted. The flag's real value is not re-running
  `cleanup`/`finalize` on a second terminal event. The guard stays, the
  misleading comments are corrected, and one test now asserts that
  observable effect through the `"error"` listener — the one never detached,
  and so the only place a second settle genuinely re-enters.
- **The injectable `spawn` seam's default is never exercised.** Coverage
  confirms `defaultSpawn` is never called; driving it would spawn a real
  process. Optional-with-default is the house pattern here
  (agent-operator's, console-server's executor seam) and all carry the same
  gap. V10c3's composition root and the end-to-end smoke test are the first
  things to exercise it for real.

Inherited and still open:

- **Spawn-test `bin/m3l-mcp.mjs`'s two stderr branches**, open since V10b.
  The entry separates a missing `dist/` from a failed boot and neither
  branch has a regression test. `vitest.config.ts` scopes coverage to
  `packages/*/src/**/*.ts`, so `bin/**/*.mjs` is outside the gate entirely
  and its coverage figure says nothing about the entry. A real test spawns
  it as a child process; the behaviour was hand-verified once (exit 1, one
  stderr line, zero host-path occurrences), which is a check and not a guard.

## Definition of done for this wave

`pnpm verify` green on each slice; `check:review-size` measured **before**
each push, not after; the V10 row still `To Do` with a pointer to this doc;
`pnpm sync:hub` run with `closingIssuesReferences` asserted empty before
merge, since issue 547 must survive this wave; a work log under `docs/logs/`.
