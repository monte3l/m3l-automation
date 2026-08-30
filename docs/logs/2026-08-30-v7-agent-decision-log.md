# Work log — `core/agent` decision log, V7 (2026-08-30)

This log covers V7 of the agent-operator programme — ADR-0061's append-only
agent decision log — implemented through the hub-and-spoke TDD pipeline across
four pull requests. It records what shipped, what matched the plan, the four
divergences (one of which put a defective audit writer on `main` for about
100 minutes), and the durable lessons. The most important of those lessons is
not new: the rule that would have prevented the worst defect was already
written down, from A4, and did not fire.

## Summary

**Shipped:** `#745` (tracker drift repair, docs-only) → `#748` (entry schema,
pure projector, JSONL serializer) → `#754` (append-only segmented writer,
rotation, loud write failure, step-3b escalation) → `#756` (serialization
hardening after a security review). Closes `#544`.

- **Public surface:** `core/agent` 24 → **36 symbols**, all through the
  namespace barrel — `check:api` never moved, because it tracks `exports`-map
  subpaths only. One new error code (`ERR_AGENT_DECISION_LOG_WRITE`,
  `origin: "external"`); caller-input violations reuse the existing
  `ERR_INVALID_ARGUMENT` rather than adding a second class.
- **Policy vocabulary:** `M3LAgentPolicyRuleId` 20 → **22**
  (`decision-log-unavailable`, `decision-log-unavailable.unobservable`),
  gated on a strict-`true` `requireDecisionLog` so an existing policy reaches
  exactly the arms it reached before.
- **Tests:** agent suite 640 → **866 across nine files**; full suite 14,792
  passing, `pnpm test:coverage` exit 0 with no threshold error. The entry
  projection sits at **100% on statements, branches, lines and functions**;
  the writer at 98.21% / 93.33%, the segment layer at 94.59% / 89.66%.
- **Gates:** `typecheck`, `lint`, `build`, `format:check`, `lint:md`,
  `check:zones` (ADR-0009 — `core/` still cannot reach `aws/`), `check:api`,
  `check:provenance` (45 sidecars), `check:index` (45 modules / 781 → **801
  symbols**), `check:file-budget` (631 files), `check:control-chars`,
  `check:test-counts`, `check:tracker-status` all green.
- **Review verdicts:** round 1 — a four-spoke fan-out returned clean, then the
  PR bot found three defects of one class. Round 2 — bot **FAIL** ×2 then
  **PASS**; `security-reviewer` **FAIL** (1 must-fix, 3 should-fix);
  `silent-failure-hunter` **PASS** (0 critical/high, 3 medium).

Skills used: `writing-work-logs`.

Spoke incidents: **9+ truncations / 0 stalls / 3+ resumes** — 2 truncations and
1 `SendMessage` resume observed directly in the final session; 7+ more recorded
earlier in the task, before the context compacted.

## What went as planned

- **The three-PR split held.** The docs-only tracker repair landed first and
  cost nothing against `check:review-size`, exactly as intended. Slice 1 kept
  `core/agent`'s purity claim intact because it contained no I/O at all; only
  slice 2 needed the claim rescoped to "the **evaluator** is pure".
- **The escalation wiring needed no redesign.** Modelling it on the existing
  budgets / dry-run-first idiom — caller observes, hands the observation back
  on the ledger, evaluator stays pure and synchronous — meant the whole feature
  fit the module's existing shape. The pre-existing agent tests passed unchanged
  throughout, which is the actual proof it shipped as an additive minor.
- **`check:api` behaved as predicted.** The plan's claim that barrel-surfaced
  symbols never move the exports snapshot was re-derived from
  `bin/check-exports-snapshot.mjs` before relying on it, and held across all
  four PRs.
- **RED failed for the right reasons, every round.** Each spoke reported the
  specific observed failure per test rather than "tests fail", which is what
  made it possible to tell a real defect from a miswritten test — and in round 1
  it caught a test that passed `operation: "put-item"` while claiming to prove
  operation-less serialization.
- **The implementer refused to make coverage green the easy way.** Facing a
  38% branch score on the new projection, it reported the gap as a test gap and
  verified the uncovered paths round-trip byte-identically against `dist/`,
  instead of deleting code or adding `v8 ignore`.

## What didn't go as planned, and why

### 1. A documented lesson did not fire, and the exact defect it describes shipped

`.claude/rules/library-src.md` already says: validate and project into a fresh
structure, then derive the persisted bytes **from the projection, never from the
original** — and names "a non-enumerable own `toJSON` … applied by the
serializer" as one of the routes. It further warns that a moved or re-scoped
`try` invalidates every claim about it, citing A4, where "moving `JSON.stringify`
ahead of `canonicalJsonHash` turned a loud non-finite rejection into a silent
`null` substitution."

Both halves recurred. `renderLogLine` serialized the caller's object directly,
and the round-1 fix moved `JSON.stringify` inside the guarded `try` — after
which a `toJSON()` returning `undefined` was laundered by a template literal
into the six-character text `undefined`, appended to the audit file, with
`write()` resolving successfully. Before that move, `Buffer.byteLength` threw on
it. A loud failure became a silent corrupt write, in a file whose entire purpose
is to be trustworthy.

**Why it happened:** the rule was written for `core/checkpoint` and cites
checkpoint call sites, so it did not read as applicable while working in
`core/agent`. Nobody re-read it. The round-1 change was also framed as
"remediation", which carries an implicit assumption of moving toward safety —
so the `try` boundary move never got the fresh audit the rule demands.

**Fix for future:** before moving any call across a guard boundary, grep
`.claude/rules/` for the mechanism being moved (`stringify`, `try`, `cause`)
rather than for the module being edited. The rules are indexed by failure
mechanism, not by module, and that is exactly what makes them easy to miss.

### 2. `#754` merged before the security round landed, putting a forging writer on `main`

The PR went green with a bot PASS and was merged at 13:45 UTC. The security
review, dispatched in parallel, returned FAIL at roughly the same time. For
about 100 minutes `main` carried a decision-log writer that would persist
`{"verdict":"auto-approved"}` for an entry whose real verdict was `escalate`,
if anything in the process had put a `toJSON` on `Object.prototype` —
`Object.freeze` on the entry is no defence, because the property is not on the
object. `#756` remediated it.

Real exposure was low: `data/agent-log/` has no consumers yet (V8 and X4 are
both still open). But the defect was in the audit trail, which is the one
property the slice exists to provide.

**Why it happened:** I pushed and opened the PR first, then dispatched the
audits in parallel to save a cycle. That is fine when audits are advisory, and
wrong when they are gating — it made "CI is green" and "the audits agree"
arrive on separate clocks, and only the first is visible on the PR.

**Fix for future:** when dispatching a security or silent-failure audit on a
diff that is already pushed, say so in the PR body and mark the PR as a draft
until the audits report. A green bot on a security-sensitive diff is a partial
result while a deeper audit is still running.

### 3. Executing against `dist/` found what four reading-based spokes missed — twice

In slice 1 a four-spoke fan-out cleared the code, and the PR bot then found
three defects across three consecutive rounds, all the same class: a
caller-supplied field read and copied without validation. In slice 2 the pattern
repeated at a higher severity — the `security-reviewer` found the `toJSON`
forgery only by writing probe scripts against the built output and observing the
bytes on disk.

**Why it happened:** reading code proves what it says; executing it proves what
it does. Prototype-chain and serializer-dispatch defects are invisible to
reading precisely because the offending property is not written anywhere in the
file under review.

**Fix for future:** for any module that persists, hashes, or signs a
caller-supplied structure, require at least one reviewer to run probes against
`dist/` and report observed bytes. This is already the `security-reviewer`'s
strength — it should be dispatched by default on that class of module, not only
when something looks suspicious.

### 4. A merge race recreated an auto-deleted remote branch

`#754` merged and GitHub auto-deleted its head branch. My next push, seconds
later, recreated it — so the repository now carries a stale
`feat/v7-agent-decision-log-writer` ref whose content is fully contained in
`main`. Harmless, but litter.

**Why it happened:** the local checkout's view of the remote was minutes stale,
and `git push` on a deleted upstream silently recreates rather than refusing.
The `* [new branch]` in the push output was the only signal, and it is easy to
read past.

**Fix for future:** `git fetch --prune` immediately before pushing to a branch
with an open PR, and treat `* [new branch]` on a push to an existing PR branch
as an error condition worth stopping on.

## Lessons learned

- **Grep the rules by mechanism, not by module.** `.claude/rules/library-src.md`
  had already recorded both halves of this PR's worst defect, written up from
  `core/checkpoint`. A rule filed under someone else's call site is invisible
  when you search for your own. Before moving a `try`, a `stringify`, or a
  `cause`, grep for that token. _(promoted → `.claude/rules/library-src.md`)_

- **`Object.freeze` does not protect serialization.** `JSON.stringify`
  dispatches to `toJSON` whether it is an own property or **inherited**, so a
  frozen, library-built record can still be persisted as something else
  entirely. Serialize a null-prototype projection you build yourself.
  _(promoted → `.claude/rules/library-src.md`)_

- **`JSON.stringify` is typed `string` and returns `undefined`.** For a plain
  object whose `toJSON()` returns `undefined`, and a template literal will
  happily launder that into the text `undefined`. Check the result is a string
  before measuring or writing it. _(promoted → `.claude/rules/library-src.md`)_

- **A remediation commit deserves more scrutiny than the code it fixes, not
  less.** The round-1 fix introduced a worse defect than three of the four it
  closed, because "we are making this safer" suppressed the instinct to re-audit
  the boundary that moved.

- **Own-key discipline is worthless if one call still walks the prototype
  chain.** This module guarded every field read with `Object.hasOwn` and then
  handed the whole object to a function that re-opened the door. Audit the
  weakest read, not the average one.

- **Parallelising an audit against a merge is a race you can lose.** Dispatching
  reviewers alongside CI saves a cycle only when nothing can merge in between.
  Draft the PR, or dispatch before pushing.

- **Coverage tables hide the file you care about.** The v8 text reporter omits a
  file once it reaches 100%, and after a full `pnpm test:coverage` the root
  `coverage/coverage-final.json` holds only the **last** lane to finish — which
  is not `bin/` any more, it is `m3l-console-web`. Read per-file numbers from a
  scoped run's JSON, and state measured figures rather than "should be covered".

- **Splitting on a real seam beats raising the ratchet.** `decision-log-writer.ts`
  crossed the 25 KB budget by 341 bytes. Extracting the segment layer as free
  functions over an explicit directory left the writer with caching, appending
  and validation only — a better file than the one that fitted.

## Follow-ups

Not filed as tracker rows, deliberately — neither is a pending library change:

- `assertAllowedKeys` in `internal/agent/validation.ts` walks `Object.keys`
  (enumerable own) while its callers read with `Object.hasOwn`, so a
  **non-enumerable** own key escapes the allowlist. Harmless today — the value
  is still type-validated — but the helper is shared with the policy
  validators, so any change reaches beyond `core/agent`. Recorded here and in
  `#756`'s body rather than fixed in a hardening PR.
- The stale `feat/v7-agent-decision-log-writer` remote ref from divergence 4 is
  fully merged and can be deleted at the maintainer's convenience.
