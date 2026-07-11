# Plan: Implement the `messaging` submodule + reconcile status counts

## Context

An audit of submodule implementation status (5 parallel Explore agents) confirmed
the published library `@m3l-automation/m3l-common` has **5 of 22** documented
submodules implemented (`errors`, `events`, `security`, `environment`, `utils`).
The goal of this work is to ship the **6th... 7th** — `messaging` — a **Core**
submodule that is already fully specified at `docs/reference/core/messaging.md`
(10 symbols: the `M3LMessenger` facade + abstract writer/reader interfaces +
message/attachment types), depends on nothing, and ships _abstract interfaces
plus a facade only_ (no concrete transport).

The audit also surfaced a real, currently-unguarded inconsistency: the
**implemented-count prose has drifted three ways** —
`README.md` says "3/22" (+ badge `modules-3%2F22`), `docs/README.md` says "2/22",
while `docs/implementation-status.md` correctly says "5/22". `check:doc-counts`
only validates the _total_ (22), not the implemented count, so nothing caught it.

**Decisions taken** (from clarifying questions): reconcile the count drift as part
of this work, and — because a `json` submodule is being implemented on a parallel
branch — set the target implemented count to **7/22** (5 existing + `json` +
`messaging`). **No** automated guard will be added; the numbers are fixed by hand.

Because the spec page already exists, the correct entry point is the
**`implement-submodule`** skill (NOT `new-subpath`).

## 1 — Implement `core/messaging` via the `implement-submodule` pipeline

Run the established hub-and-spoke TDD loop (hub dispatches; never writes src/tests itself).
Target: `packages/m3l-common/src/core/messaging/`.

- **Contract** (`spec-conformance-reviewer`): enumerate the exact 10 exports and
  their behavioral contracts from `docs/reference/core/messaging.md`:
  - Facade `M3LMessenger` constructed with `{ writer (required), reader?, defaultTarget? }`.
  - `sendMessage(text, target?)`, `sendReport(template, data, attachments?, target?)`,
    `sendError(errorMessage, error?, target?)`.
  - `sendReport` interpolates `{{ key }}` placeholders from `data` into `template`.
  - Omitting `target` on any send falls back to `defaultTarget`.
  - Interfaces `M3LMessageWriter` / `M3LMessageReader`; types `M3LOutboundMessage`,
    `M3LReceivedMessage`, `M3LMessageTarget`, `M3LMessageAuthor`, `M3LMessageReceipt`,
    `M3LInboundAttachment`, `M3LOutboundAttachment`.
- **RED** (`test-author`): write failing happy-path + failure-path + `expectTypeOf`
  tests in `packages/m3l-common/tests/messaging.test.ts`. Tests supply a fake
  in-test `M3LMessageWriter`/`M3LMessageReader` (the spec ships no concrete transport).
  Cover: target fallback to `defaultTarget`, `{{ key }}` interpolation, send-only
  messenger (no reader), and `sendError` carrying the underlying `error` via `cause`.
- **GREEN** (`submodule-implementer`): minimal `src/core/messaging/index.ts`
  (+ private helpers as needed). The only real logic is the facade: target
  resolution, the minimal `{{ key }}` template interpolation (the `text` submodule
  is not yet implemented, so messaging implements its own minimal interpolation —
  no new dependency), and error wrapping through the `M3LError` hierarchy.
- **Surface the barrel**: add `export * from "./messaging/index.js";` to
  `packages/m3l-common/src/core/index.ts`. Do **not** touch the `package.json`
  `exports` map (stays `.`, `./core`, `./aws`). `messaging` is already present in
  that barrel's aspirational JSDoc list, so only the `export *` line is new.
- **Review**: `code-reviewer`, `spec-conformance-reviewer`, `type-design-analyzer`,
  and `silent-failure-hunter` (the facade has error/async paths). Iterate to clean.

## 2 — Update durable status + provenance

- Flip the `messaging` row in `docs/implementation-status.md` (line 37) from
  `❌ ❌ ❌` to implemented/reviewed, and update the "5 of 22" headline (line 5).
- Create `docs/reference/core/messaging.provenance.json` mirroring the 5 existing
  sidecars, then stamp it: `node bin/check-doc-provenance.mjs --update`, and verify
  with `pnpm check:provenance`.

## 3 — Reconcile the implemented-count prose to 7/22

Account for `json` landing in parallel (5 existing + `json` + `messaging` = 7).
Fix in a dedicated `docs:` commit, separate from the `feat:` messaging commit:

- `README.md` line 16 — badge `modules-3%2F22` → `modules-7%2F22` (and `alt` text).
- `README.md` line 20 — "3 of 22 submodules are" → "7 of 22".
- `docs/README.md` line 5 — "`errors` + `events` implemented (2 of 22)" → list the
  7 implemented and "(7 of 22)".

> **Coordination caveat:** the parallel `json` branch may also bump these numbers.
> Whichever lands second must rebase and confirm the final figure is 7/22 (not 6 or 8).
> The _total_ (22) is unchanged, so `check:doc-counts` stays green either way.

## 4 — Out of scope (recorded, not done)

- No automated guard for the implemented count (decided: by-hand reconciliation).
- No concrete transports (SNS/SQS/email/Slack) — the spec is interface-only;
  concrete senders would be a future, separately-scoped AWS submodule.
- Doc-style nits (barrel JSDoc lists 19 aspirationally; title separator `/` vs `:`
  between `errors.md` and `messaging.md`) — cosmetic, not addressed here.

## Verification

- `pnpm test` (and `pnpm vitest run packages/m3l-common/tests/messaging.test.ts`) — green.
- `pnpm typecheck` — no `any`, no missing `.js` extensions.
- `pnpm lint` and `pnpm format:check` — clean.
- `pnpm build` — `tsc` emits `dist/` ESM + `.d.ts` for messaging.
- `pnpm check:scaffold` — barrel ⇄ filesystem parity (new `messaging` dir is re-exported).
- `pnpm check:api` — `exports` map unchanged (no semver event).
- `pnpm check:provenance` — messaging sidecar validates against source symbols.
- `pnpm check:doc-counts` — total stays 22; manually confirm the 7/22 prose.
- `pnpm test:coverage` — meets the 80% gate.
- Conventional Commits: `feat: implement core/messaging submodule` (minor) +
  a separate `docs:` commit for the count reconciliation.
- Write a work log via `/write-work-log` → `docs/logs/2026-06-30-core-messaging.md`.
