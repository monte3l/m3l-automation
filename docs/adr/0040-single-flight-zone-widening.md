# 0040. Widen the `aws/**` ESLint zone to admit `core/utils/M3LSingleFlight`

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Enrico Lionello

## Context and problem statement

The post-comparison hardening wave (§6, "wire the unwired islands") targets
`M3LSingleFlight` (`core/utils/M3LSingleFlight.ts`) — shipped in the
capability-deepening wave with zero consumers — at `aws/credentials/manager.ts`:
`M3LAWSCredentialsManager` validates profiles concurrently and runs SSO login
sequentially only **within** `ensureValidCredentialsMultiple`, so two
independent external callers (e.g. two concurrent `ensureValidCredentials()`
calls, or `ensureValidCredentials()` racing `retryWithRelogin()`) for the same
profile each spawn their own `aws sso login` child process — a real bug this
utility exists to close.

Zone A of `eslint.config.js` (`import-x/no-restricted-paths`, ADR-0009) allows
`aws/**` to import only `core/errors`, `core/prompt`, and `core/polling` (the
last widened by ADR-0026). `core/utils` is not in that list, so
`import { M3LSingleFlight } from "../../core/utils/index.js"` (or any deep
import under `core/utils/**`) fails lint. A first implementation attempt
worked around this by hand-duplicating `M3LSingleFlight`'s coalescing logic
inline in `manager.ts` — functionally correct, but it defeats the point of
wiring the shared utility (the duplicate is a second, divergence-prone
implementation of the same primitive) and leaves `M3LSingleFlight` itself
still showing zero consumers.

## Decision drivers

- The whole point of §6 is giving `M3LSingleFlight` a real consumer, not
  reimplementing its logic a second time next to it.
- Zone A exists to keep `aws/**` a shallow, acyclic island; any widening must
  be justified by a genuinely acyclic, minimal edge — not general convenience
  (the same bar ADR-0026 applied to `core/polling`).
- `core/utils` as a whole is explicitly the "mid" layer in ADR-0009's layering
  diagram (`core/utils -> analysis/config/json/exporters/network/polling/...`)
  — widening the zone to the entire `utils` subdirectory would let `aws/**`
  pull in that whole transitive graph, which is exactly what Zone A is
  designed to prevent.
- No breaking change to the `exports` map or any existing exported signature.

## Considered options

1. **Widen Zone A's `except` list to the single file
   `utils/M3LSingleFlight.ts`**, not the whole `utils` directory.
   `M3LSingleFlight.ts` has zero imports of its own (verified by reading the
   file: it is a self-contained `Map`-backed coalescer with no dependency on
   any other `core/*` module) — a strictly narrower, leafier edge than
   `core/polling` (which itself depends on `core/events` + `internal/`).
2. **Duplicate the coalescing logic inline in `manager.ts`** (the first
   implementation attempt). Rejected: two independent implementations of the
   same ~15-line primitive drift over time, and it does not satisfy the
   wave's own verification criterion that `M3LSingleFlight` gain a real
   consumer outside `core/utils/`.
3. **Widen Zone A to the whole `utils` subdirectory**, matching the
   directory-name granularity the existing `errors`/`prompt`/`polling`
   entries use. Rejected: `core/utils`'s barrel re-exports the entire mid
   layer per the ADR-0009 layering diagram — this would silently permit
   `aws/**` to import anything in that graph, not just the one acyclic leaf
   this change actually needs.
4. **Move `M3LSingleFlight` out of `core/utils` into a leaf directory already
   in Zone A's except list** (e.g. treat it as adjacent to `core/errors`).
   Rejected: it is a general-purpose async-coalescing primitive with no
   relation to the error hierarchy; relocating it to fit an unrelated
   directory would be a worse home for every other `core/**` consumer of it.

## Decision

We chose **option 1**: Zone A's exception list widens from
`except: ["errors", "prompt", "polling"]` to
`except: ["errors", "prompt", "polling", "utils/M3LSingleFlight.ts"]`
(`eslint.config.js`, the `aws/**` zone block) — a single-file exception, not a
directory-wide one. `aws/credentials/manager.ts` imports `M3LSingleFlight`
directly from that file and wraps its private `runSsoLogin` spawn call with a
per-instance `M3LSingleFlight` keyed by the resolved profile name, replacing
the inline duplicate from the first implementation attempt.

## Consequences

- **Positive:** `M3LSingleFlight` gains its first real consumer, closing the
  exact race the utility was built for, with no duplicate implementation to
  maintain. The zone widening is provably minimal — one zero-dependency file,
  not a subtree.
- **Negative / trade-offs:** `aws/**` now has a fourth named exception instead
  of three; a future contributor adding a second `core/utils` consumer to
  `aws/**` must independently justify and add that file too, one line at a
  time — this is intentional friction, not an oversight.
- **Semver impact:** none. The zone widening is dev-time lint configuration
  only. `manager.ts`'s public methods (`ensureValidCredentials`,
  `ensureValidCredentialsMultiple`, `retryWithRelogin`) keep their existing
  signatures; only the private `runSsoLogin` internals change.

## Links

- Supersedes / superseded by: none. Amends ADR-0009's Zone A enforcement
  (`eslint.config.js`), the same way ADR-0026 did for `core/polling`.
- Related: [ADR-0009 (dependency-direction guard)](./0009-dependency-direction-guard.md),
  [ADR-0026 (SQS operations wrapper — the prior Zone A widening precedent)](./0026-sqs-operations-wrapper.md),
  [ADR-0037 (deepen-first re-read — shipped `M3LSingleFlight` with no consumer)](./0037-deepen-first-re-read-against-consumer-pull.md),
  `packages/m3l-common/src/core/utils/M3LSingleFlight.ts`,
  `packages/m3l-common/src/aws/credentials/manager.ts`.
