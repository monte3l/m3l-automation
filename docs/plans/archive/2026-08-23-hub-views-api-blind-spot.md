# Hub board views — the GraphQL blind spot behind two false gate failures

**Status: shipped** — PR #616 (`fix(hub): read view columns from
configuration.visibleFields`) and its follow-up slice carrying ADR-0075.

## Context

`pnpm check:hub-views` reported two failures against a board that was correct
in both respects, and the maintainer said so: the live `Backlog` view did not
match what the gate claimed, "actually they're the opposite."

The first probe appeared to vindicate the gate — the API agreed with it, twice,
across a re-query and a check for a second board. What broke the deadlock was
changing the KIND of probe rather than repeating it. Schema introspection showed
`ProjectV2FieldConfiguration` is a union of exactly four members, none of them
an issue-type field, and that no `ProjectV2IssueTypeField` exists anywhere in
the schema. The board UI renders a column GraphQL cannot represent.

## Approach / Decisions

Two independent root causes, plus a third found on the way:

1. **Wrong connection.** The gate read `ProjectV2View.fields`, which returns
   visible fields in board field-DEFINITION order. The ordered truth is
   `configuration.visibleFields`. Both return the same SET, so the wrong one
   reads as correct until the orders are diffed — which is why it survived
   review and a green suite.
2. **An unsatisfiable assertion.** ADR-0073 held that the built-in `Type`
   field's absence was gateable because `ProjectV2FieldType` lists `ISSUE_TYPE`.
   The enum value exists; no field node is ever materialized under it. No board
   state and no manual step could clear the finding.
3. **A destructive remediation.** Both findings printed
   `pnpm sync:hub-projects -- --init --apply`, which would have DELETED the Type
   column: `resolveFieldIds` silently drops the unresolvable name, and
   `visibleFieldIds` is a full replace. Undetectable from inside sync — the API
   reports the same visible-field count either way.

Maintainer decisions: keep the Type column and make column reconciliation
**assert-only** (create writes columns, update never does — the asymmetry IS the
safety property); fix the live `Type`/`Status` ordering by hand, since that
facet is neither writable nor assertable.

Split into two PRs per ADR-0072: the safe read fix first, then the behavioural
reversal with its ADR.

## Outcome

`check:hub-views` passes clean against the live board. Ratified as ADR-0075,
amending ADR-0073's capability table (lines 127 and 129) and its
column-reconciliation decision.

Three guards added for failure modes the existing suite structurally could not
catch, each verified by reintroducing its bug:

- a **query-text** assertion, because the fixtures mirrored the wrong
  connection — a fixture-shape test can never detect a wrong-connection read;
- a **brace-balance** check over every emitted GraphQL document, after a
  malformed query passed the whole suite (the regex-matching test doubles accept
  anything) and surfaced only in a live dry run;
- an assertion that `updateProjectV2View` never carries `visibleFieldIds`.

The first of those three was itself shipped broken — a positional regex that
could not match either query — and was caught by `claude-pr-review` on #616.

## Lessons

**When a human's direct observation contradicts a tool, that is evidence about
the tool.** An absent field in a response has two causes — it isn't there, or
the API cannot express it — and only a different class of probe separates them.
Re-running the same read added confidence without adding information.

**Re-derive an ADR's capability claims before building a gate on them.** Both
false failures trace to one ADR-0073 table asserted as verified. The claims were
plausible, specific, and wrong.
