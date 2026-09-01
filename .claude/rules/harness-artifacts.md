---
paths:
  - ".claude/hooks/**"
  - ".claude/workflows/**"
---

# Executable harness artifacts (hooks & workflow scripts)

> The `.claude/` files that **run**, as opposed to the ones that are read as
> prompts. A hook or workflow script has no test suite, no type checker and no
> coverage gate — `pnpm verify` never executes one. Review reads it; nothing
> runs it. That gap is what these rules cover.

- **Run a new hook or workflow script against known-good input before wiring
  it, not only against the failure cases it was built from.** A truncation
  detector built from truncated-message examples flagged a _clean_ review
  digest ending in a bullet list, because terminal punctuation is a poor proxy
  for completeness — structured output (lists, tables, code fences)
  legitimately ends without a period
  (`docs/logs/2026-07-19-subagent-stall-integration.md`). An advisory hook that
  fires on every event of a type must be proven **quiet** on that type's normal
  output; one that cries wolf trains the reader to ignore it, which is worse
  than not shipping it.

- **A live end-to-end run on a small real input is the acceptance test for a
  workflow script — static gates and review passes cannot see runtime
  behavior.** String-encoded `args`, a backslashed `runDir` that died in
  whichever shell the agent picked, and a report file that was never written
  all passed every gate and two review rounds, and all three fell out of the
  first real run (`docs/logs/2026-07-16-audit-fanout-workflow.md`).

- **Validate arguments loudly at the top of a workflow script.** A script that
  dies mid-orchestration produces no stack context worth reading; an explicit
  guard turns a delivery-format surprise into a one-line diagnosis. Parse a
  string-encoded `args` blob rather than only rejecting it — the caller is
  usually a model following a `SKILL.md`.

- **Anything a subagent self-reports about the filesystem is a claim, not a
  fact.** Stamp derivable values (paths, facet linkage) from the input array by
  index rather than trusting an agent's echo, require agents to confirm their
  own writes landed, and give the caller a recovery rule for a missing artifact.

- **Normalize paths to forward slashes before they cross an agent boundary.**
  A backslashed path survives or dies depending on which shell the agent picks,
  which makes the failure non-deterministic and very hard to attribute.
