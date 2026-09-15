# Work log — lint:library heap ceiling fix (2026-09-15)

**Precursor to:** T2 of the testing-technique adoption wave
([plan](../plans/2026-09-15-testing-technique-adoption.md)), which rewrites
all four Vitest configs and re-runs `verify` repeatedly.
**Shipped:** PR #1272 (merge commit `9f91cada`).
**Prior log:** [T1, testing-technique adoption](./2026-09-15-t1-testing-technique-adoption.md)
— divergence #1 there is what this log closes out.

## Summary

`pnpm lint:library` and `lint:library:fast` gained the same
`--max-old-space-size=8192` ceiling `lint:workspace` has carried since PR #1134.
The ADR-0080 prose that had exempted `lint:library` — a correct
measurement on 2026-09-08 that expired by 2026-09-15 as `packages/m3l-common`
grew — was replaced by a blocking probe in `bin/lib/adr-claims.mjs`:
`eslint-heap-ceilings` asserts every `package.json` script invoking `eslint`
carries a raised ceiling, and reports offenders by name rather than a count so
a fifth unflagged script fails on its own without an expected-total edit.

## What went as planned

- The acceptance test held throughout: `env -u NODE_OPTIONS pnpm lint` exits 0
  with no ambient flag, on both rounds.
- ADR-0080 took the Update in the same shape ADR-0015 and ADR-0034 used in
  T1 — a dated blockquote after the status block, plus an in-place bracketed
  annotation on the superseded Decision line rather than a silent rewrite.
- Mutation-testing the probe went cleanly the first time: stripping the flag
  from either script, or from both, failed the gate naming exactly those
  scripts; replacing the word-boundary matcher with a bare `includes("eslint")`
  failed on `check:zones`, which names `bin/check-eslint-zones.mjs` without
  invoking the binary. Every mutated file restored byte-identical by
  `sha256sum`.

## What didn't go as planned

### The round-1 review found a real false negative in an already mutation-tested probe

Round 1's Should-fix: the ceiling check was a bare substring test over the
_whole_ command string, so a flag belonging to a different binary in a
chained command was credited to eslint —
`NODE_OPTIONS="--max-old-space-size=8192" node bin/x.mjs && eslint .` read as
compliant while the eslint process still ran on the default heap. That is
exactly the false negative the probe exists to prevent, and none of the three
mutation tests run beforehand exercised a chained command at all — mutating
the existing matcher can't surface a gap in what the matcher was never asked
to check.

The Nit was smaller but not cosmetic: the trailing `\s` anchor meant a
segment ending at the binary name (bare `eslint`, no arguments) was never
matched as an eslint invocation in the first place. ESLint 9+ lints the
current directory when given no patterns, so that's a real, and the most
expensive, full-workspace invocation going unchecked.

Fixed both: `splitShellSegments` divides on `&&`/`||`/`;`/`|`, and a segment
invoking eslint must itself carry the ceiling; the boundary now accepts
end-of-segment. Five new tests target exactly the two gaps (chained-command
false negative and its flagged counterpart, bare `eslint` and its flagged
form, a flag occurring outside a `NODE_OPTIONS=` assignment). Mutation-tested
three more ways — collapsing the segment split fails the chained test,
restoring the trailing-whitespace anchor fails the bare-eslint test,
reverting to a whole-segment substring check fails the outside-the-assignment
test — one distinct test per mutation, all restored byte-identical. Round 2
reviewed clean: PASS, no Must-fix, no Should-fix, no Nits.

## Insights

- **Mutation-testing a check only proves it catches the mutations you thought
  to make.** The round-1 probe was "mutation-tested both ways" per its own PR
  description and still shipped a real false negative — because every
  mutation exercised the matcher's _existing_ logic, none constructed an input
  (a chained command) the matcher had never been designed to parse. A green
  mutation suite is evidence against regression in what's already modeled,
  not evidence the model is complete; an external adversarial read (the
  review bot, here) is what found the actual gap. This is the same lesson as
  "a post-review fix is unreviewed code" from the other direction: the
  round-1 code _was_ reviewed, correctly, and still needed a second review
  round after the fix — a fixed defect earns a re-review, not a pass by
  association with the first PASS that never saw the broken version.
