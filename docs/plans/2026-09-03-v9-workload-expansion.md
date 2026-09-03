# V9 — workload expansion: design plan (2026-09-03)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Tracker row:** [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §_m3l-cli
  build-out_, row **V9 — workload expansion** (line 232), hub issue
  [#546](https://github.com/monte3l/m3l-automation/issues/546).
- **Predecessor plan:**
  [`2026-08-20-agent-operator.md`](./2026-08-20-agent-operator.md) §_V9_ —
  referenced, never edited. That file is the programme-level decomposition
  (V2–V12); this one is the workload-level design for its last unstarted
  reachable row.
- **Decisions:** [ADR-0055](../adr/0055-declarative-operation-introspection.md),
  [ADR-0058](../adr/0058-agent-operator-programme.md),
  [ADR-0060](../adr/0060-agent-policy-layer.md),
  [ADR-0061](../adr/0061-agent-decision-log.md),
  [ADR-0063](../adr/0063-cli-structured-run-results.md),
  [ADR-0072](../adr/0072-reviewable-slice-discipline.md).

## Why this plan exists

V9 adds three workloads to the shipped `scripts/agent-operator`: preset ETL
runs, log triage, and queue reconciliation. The tracker row's one-line
summary encodes three caveats that have all **expired**, and the row's
implicit assumption — that the three workloads are three independent
additions — is wrong: they share a backbone that does not exist yet.

Every claim below was re-derived against the tree at
`df613cfb`, not read off the row.

## 1. Dependency state — re-derived

Every prerequisite is `Done` and its issue closed.

| Prereq | Row                                      | Evidence                             |
| ------ | ---------------------------------------- | ------------------------------------ |
| V2     | CLI machine surface (`run --json`)       | `IMPLEMENTATION.md:225`              |
| V4/V5  | `aws/bedrock-runtime` wrapper + loop     | `:227`, `:228` (#725/#728/#741/#744) |
| V6     | agent policy layer (`core/agent`)        | `:229` (#739/#742)                   |
| V7     | agent decision log                       | `:230` (#748/#754)                   |
| V8     | `agent-operator` + health checks         | `:231` (6 PRs); issue #545 closed    |
| U10    | `m3l flow` orchestration engine          | `:210` (10 PRs); issue #534 closed   |
| A2/A2b | target-graded destructive confirmation   | `:288`, `:289` (#482/#657)           |
| W7/B2  | codified log analysis / `core/procedure` | `:383`, `:297`                       |

### The row's three expired caveats — retired here

1. **"hard dep U10"** — satisfied. `m3l flow list` / `m3l flow run <name>`
   ship (`packages/m3l-cli/src/commands/flow.ts:1-8`), with a real flow
   definition at `data/config/flows/sqs-roundtrip.yaml`. Queue
   reconciliation is startable; all three workloads are.
2. **"A2 hardens to hard-prereq for auto-approving sensitive mutations"** —
   satisfied, and the row's wording is imprecise about what A2 bought.
   Target grading landed and is already wired into V6's evaluator
   (`internal/agent/decide.ts:132-206`), which has a
   `graded-mutation-auto-approved` verdict today. A _sensitive_ target is
   never auto-approved — `sensitive-target-escalated` fires first
   (`decide.ts:180-188`). What A2 makes expressible is auto-approving a
   **graded, non-sensitive** mutation. V9 must not restate the row's
   phrasing.
3. **"log triage via `cloudwatch-logs-insights` (uncoupled from W7/B2)"** —
   expired. Both shipped, and `scripts/cloudwatch-logs-analysis` exists as
   the codified-procedure consumer. The target is a live design choice,
   settled in §5 below.

## 2. The structural finding: there is no mutating run

`scripts/agent-operator`'s CLI seam is read-only end to end. The internal
discriminated union at `lib/cli-surface.ts:191-195` has exactly four
methods, and `buildArgv` (`:202-225`) emits:

| method    | argv                                   |
| --------- | -------------------------------------- |
| `list`    | `list --json`                          |
| `doctor`  | `doctor --json`                        |
| `inspect` | `inspect <scriptName> --json`          |
| `dryRun`  | `run <scriptName> --json -- --dry-run` |

So the shared backbone every V9 workload needs is a **new mutating run
operation**, and it carries the programme's real security weight. Today the
only model-supplied value reaching argv is a script _name_, kept honest by a
branded allowlist (`lib/cli-names.ts`; `assertAllowedScriptName` at `:135`
is the only minting site, and `cli-surface.ts:194-195` types the union field
with the brand so an unvalidated `string` is a _compile_ error).

This reproduces ADR-0058's own adoption order (health checks → ETL → log
triage → queue reconciliation) and argues for the backbone landing before
any workload.

### 2a. `dryRunFirst` is currently vacuous — and it blocks every mutation

The deployed policy declares `"dryRunFirst": true`
(`data/input/agent-policy.json`). V6 satisfies that clause only when the
run ledger has already recorded a **completed dry-run for the same
`shapeKey`** (`decide.ts:113-126`), and `gate-tool.ts:406` records one
only when `decision.action.dryRun` is true.

**No action in `agent-operator` sets `dryRun: true`.** `grep -rn 'dryRun:
true' scripts/agent-operator/src` returns nothing;
`build-health-tools.ts:190-199` declares `script_dry_run` as
`kind: "read-only"` and `jsonExecution` stamps `outcome.dryRun: false`
(`:173-177`), with an explicit comment that the probe is "the read-only
`dry-run` operation the fleet grants declare rather than a dry run of some
mutation this script would otherwise perform."

Two consequences the code slices must handle, or every V9 mutation will
escalate forever:

- The shape key hashes `{script, operation, kind, parameterNames}`
  (`internal/agent/shape.ts:39-48`). A `kind: "read-only"` probe therefore
  **cannot** produce the same `shapeKey` as a `kind: "mutating"` run. The
  dry-run that satisfies `dryRunFirst` for a real run must itself be
  declared `kind: "mutating"`, `dryRun: true`, with the _same_
  `parameterNames` — a genuinely new action shape, not the existing
  `script_dry_run` probe.
- `dryRunFirst` is per-run and in-memory (`run-ledger.ts:285`,
  `:449`), so the mutating operation must perform the dry-run and the
  real run in one operation, in that order. A mutating run that assumes an
  earlier session's probe will always be escalated.

**Decision:** the mutating run operation is a **two-phase gated pass** —
dry-run first (same shape, `dryRun: true`), then the real run (same shape,
`dryRun` absent) — inside one declared operation. Both phases go through
`gateToolSpec`, so both are authorized and both are recorded.

### 2b. The graded target must come from the child, not from `agent-operator`

V6 grades `action.target` (`decide.ts:139-188`), a
`{profile, region?, accountId?}` triple. `agent-operator` declares its own
`aws.profile` (`config.ts:166-171`), but a preset-parameterised run's
target is whatever the **preset or flow** declares — `sqs-roundtrip.yaml`
pins `aws.profile: m3l-acceptance` on three of its four steps, entirely
independently of the operator's own profile.

Grading the operator's own profile while the child mutates a different
account would be a vacuous cross-check that reads as a real gate.
**Decision:** the mutating run's `describeAction` derives `target.profile`
from the resolved preset/flow record, and **refuses** (throws, before
anything is authorized) when the record declares no `aws.profile` for a
script that requires one. A missing target is not "ungraded, therefore
escalate" here — it is a malformed operation.

## 3. The mutating-`run` `CliOperation` contract

### Argv shape

```text
run <scriptName> --json -- --preset=<absolutePresetPath> [--dry-run]
```

Ordering is not cosmetic. `splitAtFirstDoubleDash`
(`packages/m3l-cli/src/main.ts:99-110`) runs before `partitionJsonFlag`
(`:344`), so `--json` must precede the bare `--` to be consumed by the
CLI's own flag partitioning, and everything after `--` is forwarded to the
child verbatim. The existing `dryRun` case (`cli-surface.ts:210-215`)
already documents this constraint; the new shape inherits it unchanged.

Value tokens use the **attached** `--name=value` form, matching the CLI's
own `pushTranslatedArg` (`commands/dynamic-argv.ts:252-273`), so a value
that begins with `-` can never be re-read as a flag.

### How preset parameters reach argv

They do not, individually. The union field carries a branded preset
**name**; the operation resolves it to a path under the workspace's presets
directory and emits exactly one `--preset=<path>` token. Parameter _values_
never appear in argv and are never model-supplied.

Two facts make this the only honest option:

- `m3l run` has **no** `--preset` flag. `--preset` is a per-script
  convention: `M3LScriptOptions.preset`
  (`packages/m3l-common/src/core/script/M3LScriptOptions.ts:300-317`) takes
  a **path**, resolved by `M3LScript.buildPresetProviders`
  (`M3LScript.ts:1204-1209`) with no name→directory mapping anywhere, and
  the only script wiring it is `json-etl`
  (`scripts/json-etl/src/steps/resolve-preset.ts`). `s3-objects`,
  `dynamodb-crud`, and `athena-query` do not wire it at all.
- The comment in `data/config/presets/report.yaml` ("Run with:
  `--preset report`") is inaccurate as a literal invocation — the loader
  would try to read a file named `report`. **Fix that comment in slice 2**;
  it is exactly the kind of authored claim that rots.

**Consequence for the row's script list.** The row names four scripts;
only `json-etl` can accept a preset today. Slice 3 therefore ships preset
ETL for `json-etl` alone, and `s3-objects`/`dynamodb-crud`/`athena-query`
move to a follow-up row that first wires `resolvePresetOption` into each.
That is scope the row silently assumed; it is called out here rather than
discovered mid-slice.

### Exit-code policy and parsing

Any exit code is acceptable, as for `dryRun` (`cli-surface.ts:465`) — the
envelope carries its own `exitCode`/`outcome`. No new parser: the
`AgentOperatorRunEnvelope` (`lib/cli-envelopes.ts:137-152`) is
script-agnostic and already describes a real run (ADR-0063).

### Rejection messages

The new path reuses the three fixed, non-interpolated messages at
`cli-surface.ts:69-74` and adds **one** for a rejected preset name, in the
same style: fixed text, no echo of the value, real detail to `cause` only.

## 4. The preset-name brand

A new `lib/preset-names.ts`, mirroring `lib/cli-names.ts` exactly:

- `AgentOperatorPresetName = string & { readonly __brand: unique symbol }`,
  with a doc comment that states the brand is **compile-time only** and
  erased by `tsc` — the guarantee comes from the runtime check, nothing
  else (`cli-names.ts:20-24` is the wording to mirror).
- `AGENT_OPERATOR_PRESET_NAME_RE = /^[a-z0-9-]+$/`, copied verbatim from
  the CLI's own `PRESET_NAME_PATTERN`
  (`packages/m3l-cli/src/presets/store.ts:29`), with a drift-guard test
  that reads `store.ts` as text — the same device `cli-names.ts:39-46`
  uses for `SCRIPT_NAME_RE`, and for the same ADR-0029 reason (a
  `scripts/*` package may not import `m3l-cli`).
- A length cap checked **before** the regex, as at `cli-names.ts:103-109`.
- `assertAllowedPresetName` as the **only** minting site.
- The `CliOperation` union field typed with the brand, so an unvalidated
  `string` is a compile error.

**The brand is not the security boundary.** A name that passes the pattern
still names an arbitrary file, so the operation must additionally check
**membership** — the same "the regex is a shape check, the allowlist is the
gate" argument `cli-surface.ts:121-128` already makes for `dryRunAllowlist`.
Membership cannot come from the CLI's own `listPresetFiles`
(`packages/m3l-cli/src/presets/store.ts:84`): ADR-0029 restricts a
`scripts/*` package to `@m3l-automation/m3l-common` alone. Slice 2 therefore
adds a declared `presetAllowlist` config parameter alongside
`dryRunAllowlist` — a reviewed, versioned closed set, not a directory read
that widens itself whenever someone drops in a file.

Config-load parity: `config.ts` gains an `eachAllowedPresetName` validator
in the shape of `eachAllowedScriptName` (`config.ts:55-62`), so a malformed
name fails closed at load time too.

## 5. The log-triage target: `cloudwatch-logs-analysis`

**Decision: `scripts/cloudwatch-logs-analysis`, not
`scripts/cloudwatch-logs-insights`.** Evidence:

| Criterion              | `cloudwatch-logs-insights`            | `cloudwatch-logs-analysis`                                              |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| Declared operations    | **none** (`config.ts`, 10 parameters) | four (`analyze`/`validate`/`explain`/`convert`, `config.ts:21-50`)      |
| Model-supplied surface | a raw Insights `query` string         | an `alarm` name + `triggeredAt`, values codified in a runbook preset    |
| Verdict vocabulary     | none — raw result rows                | a closed eight-member `AnalysisVerdict` union (`steps/preset.ts:16-24`) |
| Offline rehearsal      | none                                  | `validate`/`explain` reach no AWS (ADR-0076)                            |

The decisive one is the second. Driving `cloudwatch-logs-insights` means a
model composing a **query string** — a third class of model-supplied input,
with no allowlist, no brand, and no closed vocabulary, defeating the "the
model supplies exactly one value" property `cli-surface.ts:21-22` states as
the seam's whole point. `cloudwatch-logs-analysis` reduces the model's
contribution to an alarm name, and returns a closed verdict the operator
can audit.

It is also **read-only**, so slice 4 needs no part of the mutating backbone
— it rides the existing `run <scriptName>` argv shape and the existing
`read-only-auto-approved` path.

**Naming collision to keep straight in the docs.** `cloudwatch-logs-analysis`
uses "preset" for its _runbook_ presets under `runbookDir`
(`steps/preset.ts`, `steps/load-runbook.ts`), which are a different thing
from the CLI's `data/config/presets` parameter presets that workload 1
uses. Slice 4's prose must disambiguate; the brand in §4 covers only the
latter.

## 6. Declared operations per workload (ADR-0055)

`config.ts:103-116` declares exactly two operations with an explicit note
rejecting any generic `ask`/`prompt`. Each workload adds one **declared**
operation, preserving that stance:

| Workload            | Declared operation | `requiredParameters`                   |
| ------------------- | ------------------ | -------------------------------------- |
| 1 — preset ETL      | `run-preset`       | `aws.profile`, `presetName`, `scripts` |
| 2 — log triage      | `triage-logs`      | `aws.profile`, `alarm`                 |
| 3 — queue reconcile | `reconcile-queue`  | `aws.profile`, `flowName`              |

`requiredParameters` are enforced automatically: `configValidators` already
spreads `Core.deriveOperationValidators(configParameters)`
(`config.ts:335`), which currently derives an empty array precisely because
neither existing operation declares any. Populating these is the wiring
`config.ts:302-309` says was left in place for exactly this.

`config.ts:150-159`'s "deliberately absent" block needs an update in slice
2: its claim that this workload "never calls `confirmDestructive` (it never
mutates AWS state)" stops being true. The mutating path is gated by V6, not
by `confirmDestructive` — the block should say so rather than be deleted,
so the reason `yes`/`yesSensitive` stay absent is still recorded.

## 7. Policy grants, autonomy tier, and escalation

The deployed policy's grants are **CLI-verb-shaped**, not
script-operation-shaped: every fleet entry reads
`"operations": ["inspect", "dry-run"]`
(`data/input/agent-policy.json`) — those are `agent-operator`'s own seam
verbs, not the child script's `operation` values. Two of the four
row-named ETL scripts (`json-etl`, `athena-query`) declare **no**
operations at all, so a script-operation-shaped grant could not name them.

**Decision:** keep the existing convention. The mutating run's action
declares `operation: "run"`, and each script V9 permits mutating adds
`"run"` to its grant's `operations` — and deliberately **not** to
`readOnlyOperations`, since `decideReadOnly` (`decide.ts:316-340`) uses
that list as a cross-check that would escalate a mis-declared kind.

| Workload | Action `kind`            | `operation` | Grant edit                                                                       |
| -------- | ------------------------ | ----------- | -------------------------------------------------------------------------------- |
| 1        | `mutating` (both phases) | `run`       | `json-etl`: `operations` += `run`                                                |
| 2        | `read-only`              | `run`       | `cloudwatch-logs-analysis`: `operations` += `run`, `readOnlyOperations` += `run` |
| 3        | `mutating` (both phases) | `flow-run`  | new `agent-operator` grant entry: `operations` += `flow-run`                     |

Resulting verdicts, traced through `decideAgentAction`:

- **Workload 2** — `read-only-auto-approved`, corroborated by
  `readOnlyOperations`. No new escalation path.
- **Workloads 1 and 3, dry-run phase** — reaches `decideMutation`,
  `dryRunFirst` is satisfied trivially (`record.dryRun === true`,
  `decide.ts:121`), so a graded non-sensitive target yields
  `graded-mutation-auto-approved`.
- **Workloads 1 and 3, real phase** — same path; `dryRunFirst` is now
  satisfied by the shape the dry-run phase recorded.
- **Escalates** (never auto-approved, by construction): a target matching
  `sensitiveTargets.profiles` (`prod`/`production`) →
  `sensitive-target-escalated`; a run whose dry-run phase failed, so no
  shape was recorded → `dry-run-first`; any budget ceiling →
  `budget.*`; an unwritable decision log → `decision-log-unavailable`,
  since the policy sets `requireDecisionLog: true`.
- **Autonomy tier:** unchanged from V8 — bounded autonomy with escalation
  as refusal text, never a throw (`gate-tool.ts:19-23`). V9 adds no new
  verdict and no new refusal mechanism.

## 8. Slice breakdown

`check:review-size`'s 300,000-char hard ceiling is the binding constraint —
**not** `check:file-budget`, which scopes only `packages/*/src` and
`packages/*/tests` (`bin/check-file-budget.mjs:14`, `:119-120`), so
`agent-operator`'s large files are not a gate risk. Comparable rows
overshot badly: V8 forecast fewer and shipped **6** PRs; U10 projected 2
and shipped **10** (`IMPLEMENTATION.md:210`).

| #   | Branch                            | Contents                                                                                                                                                                                                                                 | Projected reviewable |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | `docs/v9-workload-expansion-plan` | **this file**; docs only                                                                                                                                                                                                                 | ~0 (see below)       |
| 2   | `feat/v9-mutating-run-seam`       | `lib/preset-names.ts` + drift guard, the `run` `CliOperation` case, two-phase gated pass, `presetAllowlist`, grant/escalation path, decision-log wiring, the `report.yaml` and `config.ts:150-159` comment fixes. No workload operation. | 60k–90k              |
| 3   | `feat/v9-etl-presets`             | `run-preset` declared operation over the backbone, `json-etl` only                                                                                                                                                                       | 40k–70k              |
| 4   | `feat/v9-log-triage`              | `triage-logs`; read-only, no backbone dependency                                                                                                                                                                                         | 40k–70k              |
| 5   | `feat/v9-queue-reconciliation`    | `reconcile-queue`; `flow` command family + flow-name brand                                                                                                                                                                               | 60k–90k              |

Slice 1 measures ~0 because `bin/lib/pr-diff-filter.mjs:33-35` ignores both
`*.md` and `docs/**`. That is also why the `review` check auto-passes a
markdown-only PR — see §Verification.

Slices 2–5 will each likely split further once `check:review-size` is
measured, exactly as V8 and U10 did. **Open one slice at a time**: a
squash-merged parent turns a stacked child into duplicate history.

### Slice 5's second command family

`m3l flow` is a CLI **command**, not a script, so `buildArgv` needs a
second family. Three differences from the `run` family, all load-bearing:

- The argv is `flow run <flowName> --json [--dry-run]` — **no bare `--`**.
  `commands/flow.ts` parses `--json` itself and ORs it with the shared
  context flag (`:502`), so the `--json`-before-`--` constraint of §3 does
  not apply here.
- **Every extra argument is rejected, never dropped**
  (`commands/flow.ts:22-27`), so a speculative flag is a usage error, not a
  no-op.
- A flow-name brand is required and cannot reuse the script-name one:
  `AGENT_OPERATOR_SCRIPT_NAME_RE` is a kebab-case _shape_ check and cannot
  tell a script from a command or from a flow. Membership comes from
  `listFlows`'s directory (`packages/m3l-cli/src/flow/load.ts:66`,
  `data/config/flows/<name>.yaml`).

One thing slice 5 gets for free: a flow definition already carries
`parameters:` per step as operator-authored declared data
(`data/config/flows/sqs-roundtrip.yaml`), so its model-supplied surface is
a single flow name — the same property §3 engineers for presets, already
solved upstream.

## Tracker and hub hygiene

- Intermediate PRs use **`Refs #546`** only. A closing verb in a PR **body**
  fires `closingIssuesReferences` and pre-empts hub-sync silently
  (`sync:hub` still prints "in sync"), so assert
  `closingIssuesReferences` is empty before merging slices 1–4.
- #546 closes only when `IMPLEMENTATION.md:232`'s Status cell flips to
  `Done` **in the same PR** — a merged PR alone cannot close a hub-sync
  issue.
- Final slice also: flip the row, retire the three §1 caveats from the row
  text, run `/syncing-docs`, and write a work log under `docs/logs/`.
- When V9 lands, `git mv` this file into `docs/plans/archive/` and add its
  row to [`README.md`](./README.md)'s archive table, dated by the landing
  commit — not by this authoring session.

## Verification

**Slice 1 (docs-only):**

```bash
pnpm format:check && pnpm lint:md
pnpm verify
```

`check:provenance` and `check:index` are scoped to `docs/reference/` only
(`bin/check-doc-provenance.mjs:38`, `bin/gen-reference-index.mjs:24`), so a
new `docs/plans/*.md` file needs no sidecar and no index regeneration.
`docs/plans/archive/**` is excluded from `lint:md` but `docs/plans/*.md` is
not, so rumdl does lint this file — a wrapped line starting `#<number>`
trips MD018, so issue refs must not begin a line.

**The `review` check auto-passes any markdown-only diff**
(`bin/lib/pr-diff-filter.mjs:33-35`), so a green `review` on slice 1 means
nobody read it. Read the plan before merging; the green check is not a
review.

**Slices 2–5, per slice:**

```bash
pnpm check:review-size                       # BEFORE designing the slice
pnpm verify
pnpm vitest --config vitest.bin.config.ts    # NOT covered by pnpm verify
```

`pnpm verify` does not cover `bin/tests` (a separate config), so a green
`verify` can still fail the push. `pre-push` takes minutes — background it,
never `--no-verify`; a `script-aws-provisioning-failure` timeout is host
starvation from the parallel fan-out, so retry rather than raising the
timeout.

**Mutation-test the new guards.** Both brands (§4, §5) are compile-time-only
devices erased by `tsc`; only the runtime `assert*` functions guarantee
anything. For each, delete the runtime check and confirm a test fails — and
separately, delete the _membership_ check while leaving the pattern check
in place, since a shape-only guard is the failure mode §4 warns about.
