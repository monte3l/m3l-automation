# Work log — `core/network` submodule (2026-07-02)

This log covers the implementation of the `core/network` submodule — the 10th of
22 to ship in `@m3l-automation/m3l-common`. It ran the full hub-and-spoke TDD
pipeline (contract → RED → GREEN → five-way review → doc reconciliation) inside a
linked worktree, and records what shipped, what matched the plan, the divergences
(a stale plan premise, deep spec under-specification, an `undici`-typed mock
blocker, a concurrent-resume race, and two real review Must-fixes), and the
durable lessons.

Plan of record: [`docs/plans/network-submodule-implementation.md`](../plans/archive/network-submodule-implementation.md)

## Summary

- **Shipped:** `core/network` — an event-emitting HTTP client wrapping `undici`'s
  `fetch`. **9 public exports:** `M3LHttpClient` (GET-only), `M3LHttpClientOptions`,
  `M3LHttpClientError` (single code `ERR_HTTP_REQUEST`), `M3LHttpFailureReason`
  (`"status" | "network" | "timeout" | "abort"`), `M3LHttpAbortableRequest`, and
  the three event payloads + `M3LHttpClientEventMap` (`request` / `response` /
  `error`).
- **Runtime dependency:** `undici@8.5.0` (pinned exact) — the library's **second**
  runtime dep (after `yaml`), approved at the dependency gate.
- **Surfaced** through the `core` namespace barrel; the `exports` map stayed at
  three entries (`.`, `./core`, `./aws`) — a **minor**, not breaking, change
  (`check:api` confirms the snapshot is unchanged).
- **Tests:** 34 network tests (happy + failure + `expectTypeOf` + two Must-fix
  regression tests); **996** full-suite total. Both network source files **100%**
  coverage on all four V8 metrics (read from `coverage-final.json`).
- **Gates:** `typecheck`, `lint`, `build`, `test:coverage`, `check:api`,
  `check:scaffold`, `check:doc-exports`, `check:provenance`, `knip`,
  `check:exports` (publint + attw, `undici` ESM-safe) — all green.
- **Reviews (5 spokes):** spec-conformance **CONFORMANT** (zero code drift; all
  gaps were doc-side); security **no Must-fix** (URL-credential caveats S1/S2 →
  documented); silent-failure **PASS** (JSON-parse-on-2xx correctly surfaced,
  only a `reason` label nuance); type-design **clean under the locked contract**
  (two Should-fix exports taken); code-review **2 Must-fix** — both applied.
- **Commits (planned):** `feat(network):` (src + tests + `undici` + docs +
  provenance + status) then `docs:` (count reconciliation + provenance re-stamp).

## What went as planned

- **RED failed for the right reason** — `Cannot find module
'../src/core/network/index.js'`, not an assertion or mock bug.
- **GREEN passed the runtime suite on the first implementation attempt** — 29/29
  network tests green immediately; every follow-up was a **test-file** type/lint
  issue or a review finding, never a `src/` runtime defect.
- **The writer/reviewer separation held structurally** — the implementer never
  touched tests; test-side type defects were routed to the test-author; the five
  review spokes only read.
- **Internal helpers stayed private** — `M3LHttpClientErrorOptions` and (until the
  review-approved surface polish) the abortable/reason types were correctly
  unexported; spec-conformance confirmed no leaked exports.
- **The worktree isolation worked cleanly** — all writes landed on
  `feat/network-submodule` in the linked worktree; the guard never fired.

## What didn't go as planned, and why

### 1. The stored plan's premises were stale on two counts

The plan claimed `network` would be the **first runtime dependency** and framed the
count reconciliation as **5 → 6 of 22**. Live repo state contradicted both:
`yaml@2.9.0` had already shipped with `config`, so `undici` is the **second**
runtime dep; and nine submodules were already `✅`, so the real target is **10 of
22**. The plan also cited `implementation-status.md:41`, but the `network` row had
moved to line 42.

**Why it happened:** A stored plan is a hypothesis frozen at authoring time;
`config` (and its `yaml` dep) landed between authoring and execution.

**Fix for future:** Re-validate every count / "what exists" / dependency-count
claim against the live repo before acting, and let `/syncing-docs` own the count
target rather than the plan's hard-coded number. _(reinforces `implementing-submodules`
Step 2.)_

### 2. The spec deliberately under-specified the whole event/error/abort surface

`docs/reference/core/network.md` named `M3LHttpClient`, its five options, and
"event types" generically — but left the concrete **event names + payloads**, the
**error code(s)**, the **abort/timeout error type**, and whether `get`/`getAbortable`
take **per-call headers** entirely open. The contract spoke enumerated each as an
`INFERENCE — hub confirm`. The hub settled the lower-stakes ones by spec-aligned
default (baseUrl join via `new URL`, non-JSON 2xx → raw text, loose `context`,
`debug` → `console.debug`) and confirmed the four surface-affecting decisions with
the user in a single round: a 3-event bare-named map, one error class + one code
with the failure kind in `context.reason`, abort/timeout normalized to
`M3LHttpClientError`, and single-arg methods.

**Why it happened:** The reference page is a contract skeleton for a client whose
observable surface (events, error taxonomy) is a design space, not a fixed spec.

**Fix for future:** Front-load the contract spoke's `INFERENCE` list, batch the
**surface-affecting** decisions into one user confirmation, and settle the rest
with stated defaults — then document every locked decision in the `.md` +
provenance in the same change set (see divergence 5).

### 3. `undici`'s `Response` is a concrete class, which broke the mock's type — twice

Runtime tests passed on the first GREEN, but `tsc` reported 15× `TS2345`: the
test's plain `FakeResponse` object literals weren't assignable to `undici`'s
`fetch` return type, because `undici`'s `Response` is a concrete **class**, not a
structural interface. This is unfixable from `src/` (and the implementer correctly
must not edit tests), so it routed to the test-author. Its **first** fix
(`return type: Response`) silently resolved against the **global DOM `Response`**
rather than `undici`'s, surfacing a different error (`textStream` missing); the
real fix was a type-only `import { Response as UndiciResponse } from "undici"` with
an `as unknown as UndiciResponse` cast at the single `makeResponse` helper
boundary.

**Why it happened:** `vi.mocked(undiciFetch)` inherits the real `Promise<Response>`
signature; a hand-rolled fake never satisfies a concrete class, and an unqualified
`Response` annotation binds to the ambient DOM lib, not the package type.

**Fix for future:** When mocking a library `fetch`, type the fake response through
the **package's** `Response` type (aliased to dodge the DOM ambient) and cast once
at the mock-factory boundary — don't annotate with a bare `Response`.

### 4. A concurrent spoke resume produced a stale, contradictory lint report

The typecheck and `src`-lint fixes were routed to the implementer and test-author
**concurrently** (disjoint files: `src/` vs the test file). The implementer's
end-of-turn `pnpm lint` reported a `no-base-to-string` error at
`tests/network.test.ts:191` that the test-author had **already fixed** — the
implementer's whole-workspace lint had run before the test-author's save landed.
A fresh hub-run lint confirmed the tree was clean.

**Why it happened:** Two spokes editing different files in the same worktree, each
running a whole-workspace gate, can observe each other mid-write.

**Fix for future:** When resuming spokes concurrently, trust the **hub's** fresh
re-run of the gate over either spoke's summary; scope each spoke's own verification
to its files (`eslint <its path>`), and treat a cross-file gate result from a
concurrent spoke as possibly stale. _(reinforces the Step 6 "verify writer state
directly" rule.)_

### 5. Review found two real Must-fixes, and the fix expanded the public surface

The five-way review returned zero conformance/security/silent-failure Must-fixes
but **two from code-review**, both confirmed real by reading `undici@8.5.0`'s
source: (a) a `new ProxyAgent()` constructed **per request** and never closed —
an unbounded socket-pool leak; fixed by constructing it **once per client**; and
(b) the `request` event sharing the **live `headers` object** with the in-flight
`fetch`, letting a handler mutate (or strip auth from) the outgoing request; fixed
by emitting a shallow copy. Two regression tests now lock both. The user-approved
surface polish that rode along (exporting `M3LHttpAbortableRequest` +
`M3LHttpFailureReason`, deep-`readonly` event headers, the caller-asserted-`T`
caveat) grew the public API from 7 → 9 exports, which required updating
`network.md` **and** the provenance sidecar in the same change set, plus a
coordinated test update for the new `expectTypeOf` assertions.

**Why it happened:** A per-request collaborator with a connection pool leaks unless
its lifecycle is owned by the client; and an event payload built by spreading a
private object still **aliases** that object unless copied at the emit site. Both
are invisible to a passing test suite until a reviewer reads the dependency's
source and traces object identity.

**Fix for future:** For any pooled/native collaborator (`ProxyAgent`, DB handles),
default to constructing once and reusing — and read the dep's source to confirm it
holds resources. For observable payloads, emit a copy so a handler can't reach the
live request object. When review-approved polish adds public types, land the
`.md` + provenance + test-type updates as one coordinated change set.

## Lessons learned

- **Re-validate a stored plan's dependency and count premises.** The plan's "first
  runtime dep" and "5 → 6 of 22" were both stale once `config`/`yaml` had landed;
  verify against the repo and let `/syncing-docs` own the count. _(reinforces
  `implementing-submodules` Step 2.)_
- **Batch only surface-affecting spec-silent decisions to the user.** For a client
  whose events/error-taxonomy are undocumented, confirm the 4 public-surface
  choices in one round and settle the lower-stakes defaults yourself — then
  document each locked decision in the `.md` + provenance.
- **Mock a library `fetch` through the package's own `Response` type.** `undici`'s
  `Response` is a concrete class; a bare `Response` annotation binds to the DOM
  lib. Alias the package type (`import { Response as UndiciResponse }`) and cast
  once at the mock-factory boundary. _(candidate → test-author / vitest-mocks
  guidance.)_
- **A concurrent spoke's whole-workspace gate result can be stale.** When two
  spokes edit disjoint files at once, trust the hub's fresh re-run over either
  summary and scope each spoke's own lint/typecheck to its files. _(reinforces
  Step 6 "verify writer state directly".)_
- **Own pooled/native collaborators' lifecycle; copy observable payloads.** A
  per-request `ProxyAgent` leaks sockets — construct once per client; an event
  payload spread from a private object still aliases it — emit a copy. Reading the
  dependency's source is what turned both from "looks fine" into confirmed
  Must-fixes. _(candidate → code-reviewer / library-src guidance.)_
- **Getting the public surface right pre-release is cheap.** Exporting the
  already-structurally-public abortable/reason types and tightening readonly now —
  while the module is unreleased and `exports` is unchanged — avoids a future minor
  bump; the cost was a coordinated src + test + doc/provenance change set.
