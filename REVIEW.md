# Review policy

Single source of truth for the severity vocabulary, finding cap, exclusions,
and verification bar every review surface in this repo shares: the mandatory
`claude-pr-review.yml` PR gate and the local review spokes dispatched by
`/creating-prs` and `/implementing-submodules`
(`code-reviewer`, `docs-consistency-reviewer`, `security-reviewer`,
`silent-failure-hunter`, `spec-conformance-reviewer`, `type-design-analyzer`
— `.claude/agents/*.md`). `pnpm check:review-policy` (`bin/check-review-policy.mjs`)
asserts the cap number below stays identical everywhere it is restated, so
this file cannot drift silently out of sync with the surfaces that enforce it.

This file is read by Anthropic's managed Code Review service convention
(`code.claude.com/docs/en/code-review`) and, in this repo, restated verbatim
at each enforcing surface below — `claude-pr-review.yml` runs via
`claude-code-action`, not the managed service, so it does not read this file
at runtime; treat this as the de-duplication source those surfaces are kept
in sync with, not something that changes their behavior on its own.

## Severity tiers

- **Must-fix** — breaks correctness, violates a stated project rule (this
  repo's `docs/contributing/style-guide.md` and `.claude/rules/*.md`), or
  introduces a security/silent-failure defect. Blocks merge.
- **Should-fix** — a real quality issue that does not block merge on its
  own: a missed edge case, a weak type, a maintainability concern.
- **Nit** — style, naming, or preference. Never blocks merge.

Reserve Must-fix for what actually blocks; route preference/stylistic items
to Nits explicitly rather than inflating Should-fix. If a change is sound,
say so plainly and leave the Must-fix list empty rather than padding it.

## Finding cap

Cap each section at its **10** most severe findings, most-severe first. If a
class of issue recurs, collapse it into one bullet listing every instance
(the exhaustive-sweep rule) rather than spilling past the cap — a capped,
scannable review also keeps later re-reviews cheap.

## Exclusions

A file matching any of these is never reviewed (and its diff is redacted to
a placeholder in `claude-pr-review.yml`'s reviewable-size measurement):

- `*.md` (any Markdown file)
- `docs/**`
- `.github/dependabot.yml`
- `pnpm-lock.yaml`

A PR touching only excluded paths skips review entirely — see
`docs/contributing/branch-protection.md` for the reviewable-patch filter this
mirrors.

## Verification bar

A behavior claim needs a `file:line` citation in the source. Never report
anything inferred from a name alone, or anything not confirmed by reading
the diff or the cited file.

## Output format

Every review surface using this cap follows the same section order and
markers, so a reviewer or a parser reading multiple surfaces' output never
has to special-case one of them:

- Headings, in order: `### Must-fix`, `### Should-fix`, `### Nits`, `### Verdict`
- An empty section reads `_None._` rather than an empty bullet list.
- Each finding is one bullet, exactly:

  ```text
  - **`path/to/file.ts:line`** — <violation> (<which rule>).
  ```

- The verdict line, exactly:

  ```text
  - PASS|FAIL — <one-line reason>
  ```

`pnpm check:review-policy` verifies each of the six literal strings above
is restated somewhere in `claude-pr-review.yml`'s prompt. `claude-pr-review.yml`
additionally requires a trailing HTML-comment marker naming the reviewed
commit SHA after the Verdict section — that is CI plumbing (it lets a later
run tell what commit a verdict reviewed), not part of this policy, and not
backtick-quoted above precisely so it stays outside what this gate compares.

## Re-review convergence

Tell the reviewer how to behave when a PR has already been reviewed, so a
one-line fix doesn't reach round seven on style alone:

- Re-check all Must-fix items from prior rounds, plus newly changed lines.
- Post Must-fix findings only. Suppress new Should-fix/Nit findings entirely
  — report them as a single count in the summary line, not as bullets.
- If all prior Must-fix items are resolved and no new Must-fix items exist,
  the verdict is PASS even if unaddressed nits remain.

## Where this is enforced

Four spokes report findings in the exact Must-fix/Should-fix/Nits per-section
shape this cap fits: the numeric cap is restated in each, and
`pnpm check:review-policy` fails if any one drifts from the number below.

| Surface                                   | What it restates                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/claude-pr-review.yml`  | Finding cap, severity tiers, output format, re-review convergence, exclusions (`bin/lib/pr-diff-filter.mjs`), verification bar |
| `.claude/agents/code-reviewer.md`         | Finding cap, severity tiers                                                                                                    |
| `.claude/agents/security-reviewer.md`     | Finding cap, severity tiers                                                                                                    |
| `.claude/agents/silent-failure-hunter.md` | Finding cap, severity tiers                                                                                                    |
| `.claude/agents/type-design-analyzer.md`  | Finding cap, severity tiers                                                                                                    |

Two spokes share the same severity philosophy but a structurally different
report shape, and are **deliberately not** numerically capped:

- **`docs-consistency-reviewer`** runs a fixed 6-check report (one PASS/
  MISMATCH/DRIFT/MISSING/ORPHANED verdict per check) — inherently bounded
  well under 10 items without a cap.
- **`spec-conformance-reviewer`** already promises never to truncate a
  Missing/Drifted/Unmet-contract finding (these block downstream work); a
  10-item cap on that list would contradict its own stronger guarantee. Its
  Extra/nit-level items are already digest-and-count-only, the same effect a
  cap gives the other four.

Changing the cap number is a single edit here, then a matching edit at each
of the five capped rows above — `pnpm check:review-policy` fails loudly if
any one of them is missed.
