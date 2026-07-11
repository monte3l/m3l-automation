# Work log — `aws/clients` extension (2026-07-11)

W0-L2 of the consumer-fleet program — the second unit — adding three AWS SDK
client getters to `AWSClientProvider` so the fleet scripts (`logs-insights`,
`dynamo-crud`, `data-query`) have their clients and the two orphaned polling
policies get paired. Ran through the `implementing-submodules` TDD hub-and-spoke
loop (starting-work gate → spec-first → RED → GREEN → 5-spoke review → doc
reconciliation) on branch `feat/aws-clients-logs-docdb-athena`. It records what
shipped, what matched the plan, the divergences (a shared-lifecycle design, a
spoke overstepping its scope, and a two-channel failure-test gap), and durable
lessons.

Plan of record:
[`docs/plans/2026-07-09-consumer-scripts-implementation-plan.md`](../plans/archive/2026-07-09-consumer-scripts-implementation-plan.md)
(§3, W0-L2).

## Summary

Shipped in two signed commits — `87046ff` (`feat(aws/clients)`, the provider,
tests, spec, and deps) and `f2ab8d1` (`docs`, the status, provenance, and
badges) — on `feat/aws-clients-logs-docdb-athena`, 2 ahead of `main`.

- **3 new getters on `AWSClientProvider`** (`packages/m3l-common/src/aws/clients/provider.ts`). `cloudWatchLogs` (`@aws-sdk/client-cloudwatch-logs`) and `athena` (`@aws-sdk/client-athena`) are standard config-constructed, lazily-cached getters (added to the `AWSServiceName` union + `Map` cache) exactly like the existing 14, providing the clients for the already-shipped `M3LPollingPolicies.cloudWatchLogsQuery()` / `athenaQuery()` poll flows (two previously-orphaned policies now paired). `dynamoDBDocument` (`@aws-sdk/lib-dynamodb`) wraps `this.dynamoDB` via `DynamoDBDocumentClient.from(...)` so callers use plain JS objects instead of raw `AttributeValue` shapes.
- **3 deps** added **hard + exact-pinned `3.1079.0`** (ADR-0017 AWS exception),
  user-approved at the `/starting-work` dep gate.
- **Counts:** 14 → **17** getters, 137 → **163** tests, reference index
  **unchanged at 261 symbols** (the getters are class members, not new named
  exports — the `exports` map, barrel, `check:api` snapshot, and catalog are all
  untouched). Semver: **minor**.
- **Gates:** full suite **2421 passing**; `typecheck`/`lint`/`build`/
  `check:exports`/`check:api`/`check:deps`/`check:doc-counts`/`check:doc-exports`/
  `check:impl-counts`/`check:test-counts`/`check:provenance`/`check:index`/
  `lint:md`/`format:check` all green. Both commits GPG-signed (`%G? = G`).
- **Review verdicts (5-spoke, parallel):** `code-reviewer` — PASS, 1 Should-fix
  (missing `.from()`-throwing failure test) resolved; `spec-conformance` —
  conformant; `security` — PASS via an empirical **refute pass** (no
  leak / credential-confusion / use-after-destroy); `silent-failure-hunter` —
  PASS; `type-design-analyzer` — "ship it" (singled out excluding
  `dynamoDBDocument` from the destroyable-cached `AWSServiceName` union as the
  type-honest call).

## What went as planned

- **Dep gate cleared up front.** `/starting-work` surfaced the 3-dep approval
  (all three, hard/exact) and location (shared) before any spoke ran — no
  mid-loop pause.
- **Spec-first held.** Rewriting `docs/reference/aws/clients.md` (getter table
  14 → 17, the `dynamoDBDocument` shared-lifecycle note, and the polling-policy
  pairing note) gave the writer spokes an unambiguous target; the one nuance
  (wrapper lifecycle) was resolved in the spec, not under review.
- **RED failed for the right reason** — 21 tests red with TS "property does not
  exist on `AWSClientProvider`" (getters absent), not a mock/logic defect; the
  141 existing tests stayed green.
- **GREEN was clean** — 162/162 on first pass, lint/typecheck/prettier clean; the
  `cloudWatchLogs`/`athena` getters reused `getOrConstruct` verbatim and the
  `dynamoDBDocument` special case landed as specified.
- **Security refute pass came back safe** — an adversarial attempt to construct a
  credential leak, wrong-profile confusion, or use-after-destroy all failed.

## What didn't go as planned, and why

### 1. A comment-only spoke overstepped and hand-restamped provenance

The `code-implementer` dispatched to add a **one-line field comment** also
edited `docs/reference/aws/clients.provenance.json` — hand-restamping 3 of its 6
sections to `main`'s HEAD (`2fa133c`) because a PostToolUse staleness hook fired
on the source edit. That was wrong twice over: provenance must point at the
_feature_ commit (which didn't exist yet), and it left the sidecar
half-restamped. The hub reverted it (`git checkout -- …provenance.json`) and let
`/syncing-docs` do the correct scoped restamp to the real feat commit (`87046ff`)
after the commit existed.

**Why it happened:** the spoke saw a hook complain about an adjacent file and
took initiative beyond the scope it was given; the staleness hook nudges toward
`--update`, which stamps to whatever HEAD is at that moment (here, `main`).

**Fix for future:** after any spoke, diff its actual output (`git status
--porcelain`) against the scope you handed it and revert out-of-scope edits.
Provenance restamps are a hub/`/syncing-docs` responsibility performed **after**
the feature commit exists — a spoke should never restamp, and a restamp to
`main` is always wrong on a feature branch.

### 2. The wrapper's two failure channels needed two tests

The `dynamoDBDocument` getter has two distinct failure paths: a **pass-through**
failure (`this.dynamoDB` throwing, accessed outside the `try`) and a
**local-wrap** failure (`DynamoDBDocumentClient.from()` throwing, inside the
`try`). The initial RED drove failure only via `dynamoDBCtor`/`fromIni` throwing
— which exercises the pass-through — so the getter's own `catch` (the one piece
of logic unique to it) was never executed on a failing path. `code-reviewer`
caught it; a dedicated test making `h.docFrom` throw and asserting the
`M3LAWSClientError` message mentions `dynamoDBDocument` closed the gap.

**Why it happened:** the contract described "construction failure wraps in
`M3LAWSClientError`" as one behavior, but the implementation splits it into a
pass-through and a locally-wrapped channel that look identical at the type level
(both `M3LAWSClientError`, `code: "ERR_AWS_CLIENT"`).

**Fix for future:** when a function wraps some failures locally and lets others
propagate, each channel needs its own test — and the distinguishing assertion is
the error **message / service name**, not just the class/`code` (which are shared).

## Lessons learned

- **Verify a spoke's diff against the scope you gave it.** Even a comment-only or
  one-line spoke can edit adjacent files a hook complains about. `git status
--porcelain` after every spoke and revert anything outside the task — provenance
  restamps in particular belong to the hub, after the feat commit, never to a
  writer spoke and never stamped to `main`. _(promoted → `.claude/agents/code-implementer.md`)_
- **A wrapper that shares a base client's lifecycle stays out of the destroyable
  cache.** `dynamoDBDocument` lives in a dedicated private field, not the
  `Map<AWSServiceName, DestroyableClient>`; `close()` destroys the underlying
  `dynamoDB` once and clears the wrapper field **without** destroying it (a
  double-destroy of the shared handler otherwise). Access the base **outside** the
  `try` so its own typed error propagates; wrap only the `.from()` call. Reusable
  for any SDK doc-client/wrapper over a shared base.
- **Two failure channels, two tests.** A function that wraps some failures
  locally and lets others pass through needs a test per channel; distinguish them
  by the error message / service name, since the class and `code` are shared.
- **Class members are not exports.** Adding getters/methods to an
  already-exported class changes neither the `exports` map, the barrel,
  `check:api`'s snapshot, nor the reference index (which derives from provenance
  `sources[]` mapping to the class symbol) — only the provenance **commit**
  restamp and the status-row counts need updating. Confirms the W0-L1 index
  lesson from the other angle.
- **Front-load the shared-lifecycle nuance into the contract.** Resolving the
  wrapper's `close()` semantics in the spec before RED kept the test-author,
  implementer, and reviewers aligned and avoided a rework round on the one
  non-mechanical part of an otherwise pattern-following change.

## Pre-existing / unrelated

`pnpm check:deps` prints the **non-blocking TS7 deliberate-hold notice** (from
PR #95, now on `main`) — expected; the branch inherits the hold and the gate
exits 0.
