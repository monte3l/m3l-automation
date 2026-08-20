# 0063. CLI structured run results: completing the machine surface

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

An agent driving `m3l run` today gets an exit code and inherited stdio —
nothing structured. The audit confirmed the precise state: `run` parses a
`--json` flag but never reads it (inert); dynamic dispatch hardcodes
`jsonOutput` to `false` (`packages/m3l-cli/src/main.ts:347`); the CLI never
reads `data/output/<startedAt>/run-report.json` at all (`run.ts`/`spawn.ts`
resolve only the child's exit code); and `m3l run <script> --help`
short-circuits to the generic usage block, while only the dynamic form
(`m3l <script> --help`) redirects to `inspect`.

The complication is deliberate: ADR-0035's 2026-07-23 Update classifies the
run report as a **sensitive crash-dump-class artifact**. A CLI that re-emits
report content to stdout changes that artifact's exposure surface — which
is why this is a recorded decision, not a bug-fix row.

## Decision drivers

- **The agent tool surface needs a structured result** it can branch on
  without scraping human-oriented stdio (research snapshot S1/S4:
  high-signal, token-efficient, machine-parseable results).
- **ADR-0035's classification must be honoured**, not eroded: the envelope
  derives from the report; it must never become a raw re-emission channel.
- **Symmetry**: help and JSON behaviour should not depend on which of two
  equivalent invocation forms was used.
- The envelope must serve three consumers identically: the agent-operator
  loop, the MCP run tool, and any human piping `--json`.

## Considered options

1. **Exit code + registry name only.** Rejected: too thin — an agent
   cannot distinguish partial outcomes, dry-runs, or where the full report
   lives.
2. **Re-emit `run-report.json` verbatim on stdout.** Rejected: exposes a
   sensitive-classified artifact on a new surface and couples the CLI to
   the report's full schema.
3. **An allowlisted-scalar summary envelope derived from the report, plus
   the report's path.** Chosen.

## Decision

We chose **option 3**. Implementation (V2) within these bounds:

- **`m3l run <script> --json`** (and the dynamic form) becomes operative:
  after the child exits, the CLI emits exactly one JSON envelope on stdout
  carrying **allowlisted scalars only**: script name, `startedAt`,
  duration, exit code and its ADR-0035 registry name, the report's
  `outcome` discriminant (including dry-run and partial once A3 ships),
  already-allowlisted timeline scalar counts, and the **path** to
  `run-report.json` — never error messages, parameter values, or any
  free-form string lifted from the report. The child's own stdio streams
  are unaffected (stderr passthrough; stdout inheritance suppressed only
  in favour of the envelope where interleaving would corrupt it — settled
  at implementation).
- Envelope emission is **read-tolerant**: an absent or unreadable report
  yields an envelope with the exit-code fields and a named
  `reportUnavailable` reason — never a crash, never a fabricated outcome.
- **`jsonOutput` plumbs through dynamic dispatch** (removing the
  `main.ts:347` hardcoded `false`), so `m3l <script> --json …` behaves
  identically to `m3l run <script> --json …`.
- **`m3l run <script> --help`** routes to the same per-script parameter
  table as the dynamic form (`inspect` redirect), ending the asymmetry.
- The envelope schema becomes part of `docs/reference/cli.md`'s contract
  **when it ships** (the page documents shipped behaviour only), and is
  the result shape ADR-0062's MCP run tool returns.

## Consequences

- **Positive:** agents (and shell pipelines) branch on typed results
  instead of scraping; the sensitive report stays where its classification
  puts it — referenced by path, summarized by allowlist; the two
  invocation forms stop diverging.
- **Negative / trade-offs:** the allowlist is a standing judgment call —
  every future "just add this field" request must clear the
  scalar-and-non-sensitive bar; suppressing child stdout under `--json`
  changes interactive behaviour behind an explicit flag.
- **Semver impact:** none from this ADR (docs only). V2 changes CLI
  behaviour behind flags on an unpublished package; `m3l-common` is
  untouched.

## Links

- Programme: [ADR-0058](./0058-agent-operator-programme.md). Consumers:
  [ADR-0059](./0059-bedrock-runtime-wrapper-and-loop-primitives.md)'s loop
  tools, [ADR-0062](./0062-runtime-mcp-surface.md)'s run tool.
- Constraint source: [ADR-0035](./0035-failure-reporting-and-diagnostics.md)
  (run-report sensitivity classification; exit-code registry).
- Baseline: [ADR-0042](./0042-script-cli-package-deferred.md) /
  [`docs/reference/cli.md`](../reference/cli.md) (the contract this
  extends when shipped).
