# Agent-operator wave — implementation plan (2026-08-20)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0058](../adr/0058-agent-operator-programme.md),
  [ADR-0059](../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md),
  [ADR-0060](../adr/0060-agent-policy-layer.md),
  [ADR-0061](../adr/0061-agent-decision-log.md),
  [ADR-0062](../adr/0062-runtime-mcp-surface.md),
  [ADR-0063](../adr/0063-cli-structured-run-results.md),
  [ADR-0085](../adr/0085-cli-secret-delivery-via-spawn-env.md) (V3's gate,
  fired 2026-09-01), plus 2026-08-20 Update blocks on ADR-0039 (gate fired)
  and ADR-0035 (third artifact class), the 2026-08-20 amendment on ADR-0030
  (dev-time vs runtime MCP split), and the 2026-09-01 Update block on
  ADR-0058 (secrets gate fired).
- **Research:** [`../research/agent-cli-integration.md`](../research/agent-cli-integration.md).
- **Trackers:** [`../ROADMAP.md`](../ROADMAP.md) §_Agent-operator wave_ and
  [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §_m3l-cli build-out_ (V-series
  rows) carry the live status; this file carries the detail behind those
  rows.

## Why this plan exists

The maintainer named the CLI-first programme's successor: AI agents (Claude
via AWS Bedrock) operating the m3l fleet to replace the human for daily
repetitive tasks. A five-facet audit plus an official-Anthropic-guidance
research pass settled the ground truth: ADR-0039's gate now has its named
consumer; the CLI's machine surface is real but incomplete (no structured
run result); and — the programme's central safety driver — ADR-0048's gate
is by its own words "an operator-safety prompt, not an authorization
control", so bounded autonomy requires a policy layer the repo owns and
tests. Six ADRs record the decisions; this plan decomposes them into the
V-series.

## Scope and sequencing

| Stage | Contents                                                                            | Shape                                           |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| **1** | V2, V4–V9 — machine surface, wrapper/loop, policy, log, operator script + workloads | Repo-native; independently shippable rows       |
| **2** | V10 — `packages/m3l-mcp` stdio surface                                              | Depends on V2; informed by Stage-1 experience   |
| **3** | V11 — headless/scheduled operation                                                  | Depends on V8; V3's secrets decision has landed |
| Gated | V12 (remote MCP ADR)                                                                | Recorded; nothing built until that ADR exists   |

**Non-coupling.** The U-series proceeds independently — the only hard edge
is U10 (`m3l flow`) for the queue-reconciliation workload; U4/U8
(declarative operations) merely enrich agent tool schemas when they land.
W7/B2 (`core/procedure`) stay uncoupled: the log-triage workload _relates
to_ the future codified procedure but runs against
`cloudwatch-logs-insights` directly until then. Cross-programme: the
codified wave's **A2** retrofit is the fleet-wide sensitivity-grading
prerequisite; ADR-0060's ungraded-target-is-sensitive default keeps the
programme safe ahead of it.

Library-touching rows (V4–V7) and every script/CLI/package row write into
`packages/*/src/**`, `scripts/*/src/**` or `**/tests/**`, so each begins
with `/starting-work` and dispatches `code-implementer` / `test-author` —
the hub never writes those paths.

---

## Stage 1 — repo-native operator

### V1. Decisions and governance docs — this change set

ADR-0058…0063, the ADR-0039/0035 Update blocks, the ADR-0030 amendment,
index rows, the research snapshot, this plan, the tracker rows, and the
filing-work legend cell. No code.

### V2. CLI machine-surface hardening

**Decision:** ADR-0063. Operative `--json` on `run` emitting the
allowlisted-scalar envelope (script, startedAt, duration, exit code +
registry name, outcome discriminant, timeline scalar counts, report path —
never free-form report content; read-tolerant with a named
`reportUnavailable` reason); `jsonOutput` plumbed through dynamic dispatch
(removes the hardcoded `false` at `packages/m3l-cli/src/main.ts:347`);
`m3l run <script> --help` routed to the inspect table like the dynamic
form. Envelope schema joins `docs/reference/cli.md` when shipped.
Coordinate with any in-flight U-rows touching `main.ts`.

### V3. Secrets-delivery hardening

**Decision:** [ADR-0085](../adr/0085-cli-secret-delivery-via-spawn-env.md)
(the gate ADR-0058 recorded, fired 2026-09-01). Mechanism: **environment
injection at spawn**. `translateArgv` returns both halves of the invocation
(`{ argv, secretEnv }`) so "a value is in exactly one of these" lives in one
place; a `secret: true` parameter's value is **dropped from argv** — required,
not optional, since argv outranks env in `M3LScriptConfigLoader`'s chain and a
value emitted both ways would resolve from argv and leave the hardening
silently inert — and injected into the child's environment under
`Core.deriveEnvVarName(descriptor.name)`, the SCREAMING_SNAKE_CASE key
`M3LEnvironmentConfigProvider` already reads at precedence level 4. **No
consumer-script change**: the resolution path already exists. `spawnScript`
spawns with `env: { ...baseEnv, ...secretEnv }` — inherit, then overlay, never
an allowlist — with `baseEnv` injected from the command context rather than
read as a global.

The `.env` half becomes explicit: `--env-file <path>` / `--no-env-file` join
`--json` and `--in-process` as CLI-reserved tokens in `cli/flags.ts`, stripped
before the script's own strict `parseArgs`. Default behaviour is **unchanged**
(`--env-file-if-exists=.env`); both flags together is an error, exit `2`.

Both spawn paths are in scope — dynamic dispatch (`commands/dynamic.ts`) and
the wizard (`commands/wizard.ts`), which calls `spawnScript` directly and
bypasses `executeScript`. The in-process path (`--in-process`, ADR-0054) needs
no change: it binds a typed in-memory record with no child process and no argv.

Mechanical cost: `toEnvKey` is promoted out of
`M3LEnvironmentConfigProvider`'s module privacy into
`core/config/deriveEnvVarName.ts` so there is exactly one implementation
across both packages — one additive **Core namespace-barrel** export
(semver-minor on `m3l-common`, no new `exports` subpath), paying the standard
`docs/reference/core/config.md` + `gen:counts` + `gen:index` + provenance
re-stamp set.

Scope honesty, carried from the ADR: `/proc/<pid>/environ` is `0400`
owner-only where `cmdline` is world-readable, so this defeats a co-tenant
`ps`/`/proc` reader — **not** root, a debugger, or the same user. Secret-store
resolution (Secrets Manager / SSM) stays gated for want of a named consumer.
Unblocks V11.

### V4. `aws/bedrock-runtime` — the wrapper

**Decision:** ADR-0059. Typed Messages-API wrapper: single-shot +
streaming invocation (the library's first `AsyncIterable` contract,
scoped to this submodule), model registry with explicit fallback order,
per-invocation token capture, named `M3LError` codes with ADR-0035 origin
classification for semantic inference failures. New lazy
`AWSClientProvider` getter; SSO chain unchanged. Submodule wiring pays the
standard mechanical set; **AWS count 19 → 20 at every count site via
`pnpm gen:counts`** — never hand-edited. **Semver: additive minor.**

### V5. Tool-use loop primitives

**Decision:** ADR-0059 (same submodule). Typed tool definitions
(name/description/JSON-schema input), explicit immutable conversation
state, the invoke → tool_use → execute → tool_result loop honouring
ADR-0049 cancellation and an iteration ceiling, cumulative token/cost on
the outcome. Model output parsed under the ReDoS-conscious rules.
**Semver: additive minor** (may co-land with V4).

### V6. Agent policy layer

**Decision:** ADR-0060. Core-namespace module: declared allowlist
(scripts + operations), autonomy tiers (read-only auto; non-sensitive
mutations auto within allowlist+budget; ADR-0048-sensitive always
escalate; **ungraded targets treated as sensitive**), budgets/rate caps
(invocations, tokens, cost, iterations — exhaustion escalates loudly),
dry-run-first for first-seen mutating shapes. Policy is
config-schema-validated declared data. **Semver: additive minor.** Core
count moves via `gen:counts` when it ships (sequenced against U3's own
move — whichever lands first, counts regenerate, never hand-edit).

### V7. Agent decision log

**Decision:** ADR-0061 (+ the ADR-0035 taxonomy Update, already landed in
V1). Append-only JSONL under `data/agent-log/`; entry schema per the ADR
(identity: logical agent name required, model id, AWS principal when
resolvable; names-never-values; verdict + rule; outcome; token/cost);
**loud** write failure → escalate; size/age-segmented rotation, segments
retained. May co-land with V6 in one Core home. **Semver: additive
minor.**

### V8. `scripts/agent-operator` — scaffold + first workload

**Decision:** ADR-0058. Scaffolded via the standard pipeline (ADR-0022;
`pnpm scaffold:script`); composes V4/V5's loop, V6's policy, V7's log; its
tools drive the m3l CLI machine surface (V2 envelopes, `--json`
introspection, exit-code registry). First workload: **fleet health
checks** — `m3l doctor --json`, per-script dry-runs, anomaly summary
(read-only end to end). Hard deps: V2, V4–V7.

### V9. Workload expansion

**Decision:** ADR-0058. Preset-parameterised **ETL runs** (json-etl,
s3-objects, dynamodb-crud, athena-query — mutations under V6 policy);
**log triage & analysis** (cloudwatch-logs-insights; uncoupled from
W7/B2); **queue reconciliation** supervising `m3l flow` (**hard dep:
U10**; the other two do not wait for it). A2 hardens from soft to hard
for any ADR-0048-sensitive mutation the agent is to auto-approve — until
then those runs escalate by the ungraded/sensitive defaults.

---

## Stage 2 — the MCP surface

### V10. `packages/m3l-mcp`

**Decision:** ADR-0062. New workspace package (governance registration
mirrors m3l-cli's: root tsconfig reference, knip workspace, ESLint zones,
coverage config); `@modelcontextprotocol/sdk` as its own dependency; stdio
transport; intent-grouped tools (discovery/introspection, run — returning
V2 envelopes, flow post-U10, health), every call through V6 policy
(escalate = MCP error naming the human-approval requirement) and into
V7's log. Hard dep: V2; grouping informed by V8 experience. Publish-set
membership deferred (ADR-0057 Update at whichever of V10/U13 lands
second).

---

## Stage 3 — headless operation

### V11. Scheduled/unattended runs

**Decision:** ADR-0058. cron/EventBridge-triggered agent-operator under
policy, budget, and the decision log; unattended posture per the
secure-deployment guidance (least privilege, boundary audit). Hard deps:
V8, V6, V7. **V3's secrets decision has landed**
([ADR-0085](../adr/0085-cli-secret-delivery-via-spawn-env.md)) — a
secret-bearing script no longer blocks this row.

### V12. Remote/HTTP MCP — recorded, not built

Filed **Deferred**. Unblock condition: a dedicated future ADR settling
transport (stateless HTTP per MCP 2026-07-28), authentication, and
exposure posture. Hard dep: V10.

---

## Documentation reconciliation

Per shipped row: update the touched contract pages
(`docs/reference/aws/bedrock-runtime.md` new with V4/V5 + sidecar;
`docs/reference/core/*` for V6/V7's home; `docs/reference/cli.md` §
envelope with V2; `docs/reference/scripts/agent-operator.md` with V8),
flip the V-row, then run `/syncing-docs` — AWS 19 → 20 (V4) and any Core
move (V6/V7) regenerate via `gen:counts`, never hand-edited. No reserved
CLI command names are claimed by this programme. `docs/reference/cli.md`
is **not** edited in this docs wave — it documents shipped behaviour only.

## Definition of done

- Docs wave (V1): `pnpm verify` green; `check:tracker-status` /
  `check:tracker-coverage` / `check:hub-keys` clean; doc-count gates
  no-ops; `pnpm sync:hub` dry-run reviewed, then applied post-merge.
- Code rows: the standard battery — `typecheck`, `lint`, `test:coverage`
  thresholds, `build`, `check:zones` (no zone widened), `check:api` /
  `check:exports` unchanged, scaffold/seam/script gates for new
  submodules and the new script/package, `pnpm verify` reproducing CI;
  trackers flipped; a work log per shipped stage under `docs/logs/`.
