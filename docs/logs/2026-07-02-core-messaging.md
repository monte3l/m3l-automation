# Work log — `core/messaging` submodule (2026-07-02)

This log covers the implementation of the `core/messaging` submodule — the 8th
of 22 to ship in `@m3l-automation/m3l-common`. It ran through the full
hub-and-spoke TDD pipeline (contract → RED → GREEN → four-way review →
doc reconciliation), and records what shipped, what matched the plan, the five
divergences that came up (a stale plan, a pipeline-wide supply-chain block, six
spec-silent contract decisions, post-GREEN test-side type defects, and count
sites the plan missed), and the durable lessons.

Plan of record: [`docs/plans/messaging-submodule-implementation.md`](../plans/archive/messaging-submodule-implementation.md)

## Summary

- **Shipped:** `core/messaging` — an abstract, transport-agnostic messaging
  interface. **10 public exports:** the `M3LMessenger` facade + 9 interfaces
  (`M3LMessageWriter`, `M3LMessageReader`, `M3LOutboundMessage`,
  `M3LReceivedMessage`, `M3LMessageTarget`, `M3LMessageAuthor`,
  `M3LMessageReceipt`, `M3LInboundAttachment`, `M3LOutboundAttachment`).
  Interface-only, **zero runtime deps** (a private `internal/interpolate.ts`
  helper implements the minimal `{{ key }}` templating — no dependency on the
  not-yet-built `text` submodule).
- **Surfaced** through the `core` namespace barrel; the `exports` map stayed at
  three entries (`.`, `./core`, `./aws`) — a **minor**, not breaking, change.
- **Tests:** 36 messaging tests (happy + failure + `expectTypeOf`); **798**
  full-suite total. Messaging files **100%** coverage on all four V8 metrics.
- **Gates:** `typecheck`, `lint`, `build`, `check:api` (exports unchanged),
  `check:doc-exports`, `check:doc-counts`, `check:impl-counts`,
  `check:provenance`, `check:index`, `lint:md` — all green.
- **Reviews:** spec-conformance **CONFORMANT** (10/10 symbols, no leaked
  exports); code-review **PASS** (no must-fix; empirically probed `interpolate`
  for ReDoS and prototype-pollution — safe via `hasOwnProperty.call`);
  type-design **9/8/8/8** (no must-fix); silent-failure **PASS** (both failure
  boundaries explicit; +1 test suggested and added).
- **Commits:** `576b363` `build:` (knip exclude), `1b260a1` `feat:` (messaging),
  `3dbbb11` `docs:` (counts + provenance).

## What went as planned

- **RED failed for the right reason** — `Cannot find module
'../src/core/messaging/index.js'`, not a logic or import-path error.
- **GREEN passed the runtime suite on first pass** — all 35 (then 36) tests
  green; the only follow-ups were type-level/lint issues in the **test** file,
  never in `src/` (see divergence 4).
- **All four review spokes returned zero Must-fix items** against the
  implementation. The two Should-fix items taken (a present-but-`undefined`
  interpolation test; per-method `@example` blocks) were pure hardening.
- **The writer/reviewer separation held structurally** — the implementer never
  touched tests; test defects were routed back to the test-author; reviewers
  only read.
- **`interpolate` correctly kept private** under `internal/` and never
  re-exported — confirmed independently by spec-conformance and code-review.

## What didn't go as planned, and why

### 1. The stored plan's count-reconciliation premise was already stale

The plan's Step 3 described a three-way count drift (README "3/22", docs/README
"2/22", status "5/22") to reconcile to a target of **7/22** (5 existing + `json`

- `messaging`). Live repo state contradicted every number: all count sites
  already read **7/22** consistently, and `analysis` had landed since the plan was
  authored. The real target was therefore **8/22**, and the "reconcile the drift"
  work was already done. Caught by re-validating each plan claim against the repo
  before acting.

**Why it happened:** A stored plan is a hypothesis frozen at authoring time;
parallel work (`json`, `analysis`) landed between authoring and execution and
moved the numbers.

**Fix for future:** Re-validate every count/line/"what exists" claim in a
`docs/plans/` file against the live repo before executing, and treat count
reconciliation as a derived quantity owned by `/syncing-docs`, never a
hand-copied target baked into the plan.

### 2. A same-day Dependabot bump blocked the entire pipeline via `minimumReleaseAge`

Before any spoke could run, `pnpm install --frozen-lockfile` and every
`pnpm <script>` failed: the `minimumReleaseAge` supply-chain policy (ADR-0010)
rejected `knip@6.24.0`, pulled in by a Dependabot toolchain bump (`714dbfa`) and
published the **same day**, so it hadn't aged past the cutoff. Because pnpm
re-runs a deps-status check before every script, this blocked `test`,
`typecheck`, `lint`, `build` — and would fail CI's install too. Fixed by adding
`knip@6.24.0` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` (the
sanctioned mechanism already used for the eslint/prettier/rumdl pins), committed
separately as `build:` (`576b363`). Every spoke then had to prefix pnpm calls
with `--config.verify-deps-before-run=false` to skip the redundant pre-run
check (node_modules was already complete).

**Why it happened:** Automated dependency bumps can land a version younger than
the release-age floor; the exclude allowlist wasn't updated in the same bump.

**Fix for future:** When a fresh toolchain bump blocks install on
`minimumReleaseAge`, add the exact `name@version` to `minimumReleaseAgeExclude`
(don't disable the policy) and land it as its own `build:` commit before
starting feature work. Expect to pass `--config.verify-deps-before-run=false` to
pnpm for the rest of the session once node_modules is known-good.

### 3. The spec deliberately under-specified six contract points

`docs/reference/core/messaging.md` fixed the 10 symbols, the constructor keys,
the send-method names/order, `{{ key }}` interpolation, and target fallback —
but left six decisions open: the error channel (base `M3LError` vs a bespoke
subclass), the missing-template-key policy, the reader's shape, the constructor
options type, the writer method name, and the data-interface field sets. The
contract spoke flagged each `[inferred — spec silent]` with a recommendation;
the hub settled the three low-stakes ones by the obvious default and confirmed
the three surface-affecting ones with the user.

**Why it happened:** An abstract interface-only module intentionally leaves shape
decisions to the implementer; the doc is a contract skeleton, not a full spec.

**Fix for future:** Run the contract spoke in producer mode first and have it
enumerate `[inferred]` gaps explicitly; confirm only the decisions that change
the **public surface or user-visible behavior** with the user, and settle the
rest with stated defaults — don't over-ask.

### 4. Six test-side type/lint defects surfaced only after GREEN

The RED suite was green-for-the-right-reason and lint-acceptable while the module
didn't exist. Once GREEN provided real types, `tsc -b` and `eslint` on the test
file surfaced six defects: four redundant `as M3LFoo` casts
(`no-unnecessary-type-assertion`), a `noUncheckedIndexedAccess` error in a fake
reader's hand-written iterator, and an `expectTypeOf<M3LMessenger>().constructorParameters`
that needed `expectTypeOf<typeof M3LMessenger>()`. All were test-only; the `src/`
was correct. Routed back to the test-author, which fixed them and — while
removing a now-redundant cast — uncovered a **genuinely masked bug**: the
attachment fixtures never supplied the required `content` field, which the `as`
cast had been silently hiding.

**Why it happened:** Type assertions and type-probes written against
not-yet-existing symbols resolve loosely in RED (`error`/`any`) and only reveal
their redundancy or wrongness once the real types land at GREEN.

**Fix for future:** In RED prefer plain annotations over `as` casts, guard
indexed access in fake collaborators, and use `expectTypeOf<typeof Klass>()` for
constructor introspection; re-run `tsc -b` + `eslint` on the test file
immediately after GREEN to catch stale type-probes before the hub routes them
back. A cast removed post-GREEN can also expose a real fixture gap it was
masking — treat cast removal as a mini-audit, not a formality.

### 5. The doc-count guard surfaced two count sites the plan never listed

The plan enumerated three count sites (root README badge + prose, docs/README).
The `guard-doc-counts` hook (backed by `check:impl-counts`) rejected the edits
until **all seven** derived sites matched — including two the plan omitted: the
**npm-facing `packages/m3l-common/README.md`** badge + prose, and
**`docs/index.html`** (status span, the module-tree `class="done"`/`not-started`
node, and the "done" names list).

**Why it happened:** A hand-written edit list drifts from the authoritative set
of count-bearing sites; only the derived checker knows all of them.

**Fix for future:** Never hand-list count sites. Make the status-file edit, then
let `guard-doc-counts` / `/syncing-docs` (both backed by `check:impl-counts`)
enumerate every site that must change — the guard is the source of truth.

## Lessons learned

- **Re-validate a stored plan against the repo first.** Counts, line numbers,
  and "what exists" premises rot as parallel work lands; verify each claim before
  executing and let the derived checker own count targets. _(reinforces the
  existing `implementing-submodules` Step 2 guidance.)_
- **`minimumReleaseAge` can block the whole pipeline on a fresh bump.** A
  same-day Dependabot dependency fails install and every `pnpm <script>`; fix by
  adding `name@version` to `minimumReleaseAgeExclude` as a standalone `build:`
  commit, and pass `--config.verify-deps-before-run=false` for the session once
  node_modules is complete — don't weaken the policy.
- **Confirm only surface-affecting spec-silent decisions.** For an
  interface-only module, settle low-stakes inferred gaps with stated defaults and
  reserve user confirmation for choices that change the public API or
  user-visible behavior.
- **RED type-assertions and type-probes go stale at GREEN.** Redundant `as`
  casts, `noUncheckedIndexedAccess` in fake collaborators, and
  `expectTypeOf<Klass>()` vs `<typeof Klass>()` for `constructorParameters` only
  surface once real types resolve; prefer annotations over casts in RED and
  re-run `tsc -b` + `eslint` on the test file right after GREEN. Removing a cast
  can also unmask a real fixture gap. _(promoted → .claude/agents/test-author.md)_
- **Let the count guard enumerate count sites.** A hand-list drifts;
  `guard-doc-counts` / `check:impl-counts` / `/syncing-docs` know every
  badge/prose/HTML site (incl. the npm-facing README and `docs/index.html` module
  tree) — make the status edit and follow the guard.
- **Verify the writer spoke's state directly.** Both the GREEN implementer and a
  resumed test-author returned truncated or stale-context reports; listing files,
  grepping the barrel, and running the gates by hand (rather than trusting the
  summary) caught the real state each time. _(reinforces existing
  `implementing-submodules` Step 6 guidance.)_
