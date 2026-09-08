# TypeScript guidance skill pair: researching-/refreshing-typescript-guidance

**Status: shipped** — PR #1129, merged 2026-09-08 (squash, merge commit `537d833a`).

## Context

The repo had a proven skill pair — `researching-anthropic-guidance` (on-demand
topic research against official Anthropic sources) and
`refreshing-anthropic-guidance` (a periodic sweep of the repo's own
Anthropic-facing assumptions against upstream, ADR-0082's cadence pattern) —
but no TypeScript-language analogue. The gap was real: the repo pinned
`typescript@6.0.3` while TypeScript 7.0 had been GA since 2026-07-08, and
`check:reference-freshness` — the closest existing mechanism — compares a
snapshot's stamp against the _local_ `package.json`, so it reads clean while
both the pin and three Context7 snapshots sit a full major behind upstream.
An `/auditing` pass of the repo's TypeScript-facing surface confirmed no
duplication risk against `typescript-configuration`/`eslint-flat-config`/
`vitest-testing` — all three answer "how is this repo's X wired," never
"does that wiring still match upstream."

## Approach / Decisions

Designed in plan mode with four non-obvious calls resolved via `AskUserQuestion`
rather than picked silently:

- **Source tiering is two-owner, not one.** TypeScript the language is
  Microsoft's; the Node↔TypeScript runtime boundary (`erasableSyntaxOnly`,
  type stripping) is Node's. T1 (owner-normative) = typescriptlang.org,
  devblogs.microsoft.com/typescript, github.com/microsoft/TypeScript, and
  nodejs.org/api/typescript.html as co-normative T1. T2 (owner-adjacent) =
  TypeScript-Website, typescript-eslint.io, attw, publint. T3/T4 (tsconfig/
  bases, DefinitelyTyped, individual authors) explicitly excluded.
- **Output location:** namespaced `docs/research/typescript/`, keeping the
  Anthropic program's existing top-level snapshots undisturbed.
- **Five fixed sweep facets** (compiler-config-flags, modules-esm-node-interop,
  packaging-declaration-emit, lint-typing-rules, language-features-deprecations)
  so sweeps stay comparable and the tracker stays diffable.
- **The skill-listing budget** — the corpus sat at 7,996/8,000 chars before
  either new description was added. Research against Anthropic's own docs
  found the 1% figure is a documented default with `skillListingBudgetFraction`
  as the sanctioned lever, and that overflow degrades gracefully rather than
  erroring — but this directly confronted **ADR-0089** (accepted five days
  earlier), which had explicitly considered and rejected raising that same
  fraction. The conflict was surfaced to the user before proceeding, not
  silently overridden; the informed decision was ADR-0098, partially
  superseding ADR-0089's specific Option-2 rejection while leaving its
  invocation-stance and skill-fired-assertion decisions in force.

Landed as eight commits in one PR:

1. `chore: raise skill-listing budget fraction from 1% to 2%` — ADR-0098,
   the `SKILL_LISTING_BUDGET_FRACTION` constant, and five updated test
   expectations (one caught by `test-author` mid-review that the hub's own
   dispatch prompt had missed).
2. `feat: add TypeScript refresh tracker and freshness gate` — a structural
   mirror of `check-harness-freshness.mjs`, seeded (not empty) with real
   findings: the 6.0.3-vs-7.0 gap, the three stale reference-freshness
   snapshots, the unverified strict-membership claim. 120-day threshold
   (not the sibling's 90) since TypeScript ships far less often than Claude
   Code.
3. `feat: add researching- and refreshing-typescript-guidance skills` —
   both skills, the shared `references/typescript-sources.md` allowlist,
   evals, decision note 0006, and catalog/routing/README wiring.
4. `docs: reconcile doc metadata` — `/syncing-docs`, re-stamped
   `docs/adr/provenance.json`.
5. `docs: fix stale skill-eval corpus count in ci-cd.md` — a `docs-consistency-reviewer`
   pre-push pass caught a "23 skills / 92 cases / 432 criteria" figure that
   predated the two new skills; corrected to 25/98/468 by direct count.
6. `docs: acknowledge outstanding claude-pr-review Should-fix finding` — the
   first `claude-pr-review` round (PASS) flagged that the budget raise is
   permissive on the same axis its own denominator is documented to
   undercount. Left unaddressed rather than fixed: it's the exact tradeoff
   ADR-0098's Consequences section already named and deliberately deferred,
   not a mechanical line fix — acknowledged via the `Acknowledged-Should-Fix:`
   commit footer `docs/adr/0097` requires.
7. `fix: resolve claude-pr-review findings` — the acknowledgment commit
   re-triggered a second review round, which found a genuine Must-fix (a
   `not.toHaveProperty` assertion violating `.claude/rules/tests.md`'s own
   prototype-chain-safety rule) plus two Should-fix. Fixing the Must-fix
   surfaced that the bot's second Should-fix — a claim that the ADR-0098
   rationale's causality read backwards — was independently, logically
   correct on inspection: an undercounted local denominator checked against
   a _larger_ ceiling is more permissive relative to the true shared budget,
   not more accurate. Rewrote the comment/ADR prose (not the raise itself)
   to remove that backwards framing rather than just silencing the finding.
8. `test: mark refreshing-typescript-guidance eval case 3 as expect_skill_fired: false` —
   the merged PR's own `Run skill evals` job (a non-blocking collapse
   detector, `docs/decision-notes/0004`) failed at 59.2% against the 60%
   floor. Investigation found most of the 40 failures were the corpus-wide,
   already-tracked `expect_skill_fired` routing-assertion weakness (issue
   #1087) unrelated to this PR, but one of this PR's own two new-case
   failures was a real authoring bug: a deliberate negative-routing test
   case missing the `expect_skill_fired: false` opt-out ADR-0089 already
   documents. Fixed; the corpus recovered to 69.4% (68/98).

**The `review` required check never converged a third time — not on a new
finding.** The eighth commit's push triggered a third automated review
round, which hit `MAX_REVIEW_ROUNDS` (3, `docs/contributing/branch-protection.md`)
before a real review could run against that one-line delta, and was
auto-replaced with FAIL per the round-bound policy. The prior round (commit 7) had already converged to a clean PASS with `should-fix-ack` passing too.
Per this repo's `bypass_actors: []` design, no one — including the
maintainer — can skip the `review` check by configuration; the documented
override procedure was followed: investigated the escalation, posted the
evidence record on the PR thread, and the maintainer merged past the FAIL
with that record in place.

## Outcome

Both skills live on `main`; `check:typescript-freshness` runs in the
pre-push cadence and CI alongside `check:harness-freshness`. Full narrative
(the ADR-0089 conflict, the four-agent research fan-out establishing the
skill-listing budget facts, the WSL eslint-OOM recurrence inside the
`pre-push` hook itself — fixed locally with a raised `NODE_OPTIONS`
`--max-old-space-size`, not `--no-verify` — and the round-limit override):
see the work log.
