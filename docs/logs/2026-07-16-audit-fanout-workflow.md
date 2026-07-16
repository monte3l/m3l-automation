# Work log — `audit-fanout` dynamic workflow, the ADR-0025 pilot (2026-07-16)

First build on the repo's new `.claude/workflows/` surface: the `auditing`
skill's Explore fan-out re-expressed as a deterministic Workflow script with
an adversarial-verification stage added, landing right after the governance
prerequisites (PR #144, `check:workflows`) opened the gate.

## Summary

- **`.claude/workflows/audit-fanout.js`** — `Find` phase: one read-only
  Explore-typed agent per facet (max 5), each writing the fixed
  EXISTING/GAP/INCONSISTENCY report to the hub-supplied run directory and
  returning a schema-forced compact digest. `Verify` phase: one refute agent
  per GAP/INCONSISTENCY finding (max 15, `sonnet`/`medium`), transplanting the
  `security-reviewer` refute-mode inversion — `confirmed` only when genuine
  refutation fails. Overflow past the verify budget returns as `unverified`
  for the hub; a dead refuter is never laundered into `confirmed`.
- **`.claude/skills/auditing/SKILL.md`** — coexist split per ADR-0025: step 2
  delegates the mechanical slice to the workflow (with a compact
  manual-dispatch fallback for Workflow-less sessions); step 3 keeps the hub's
  judgment half (verify `unverified`, spot-check `refuted`, group by theme);
  steps 1/4/5 unchanged.
- **Governance:** `// max-agents: 20` (5 finders + 15 refuters ≤ the 25
  ceiling); MODEL-MATRIX rows `audit-fanout.js` (`inherit`/`n/a`) and
  `audit-fanout.js:verify` (`sonnet`/`medium`); `pnpm check:workflows` green
  on the now non-trivial surface.
- **Tooling accommodation:** `.claude/workflows/**` added to knip's root
  `entry` and to ESLint `ignores` (see below for why the planned lint
  override was impossible).

## What went as planned

- The governance-first sequencing (PR #144 before the pilot) meant every rule
  the script had to satisfy was already machine-checked — the matrix rows,
  literal pinning, and max-agents header were written against a live gate,
  not a convention on paper.
- The coexist split fell out cleanly: the fan-out + refute slice is genuinely
  mechanical (no per-result judgment), and the hub-judgment half of the old
  step 3 survived nearly verbatim.
- **Live acceptance run** (topic: "worktree tooling docs", 2 facets): 15
  agents (2 finders + 13 refuters), 0 errors, ~868k subagent tokens, 6m12s.
  13 findings verified: **9 confirmed, 4 refuted, 0 unverified**. The
  adversarial stage caught four false positives — the exact quality upgrade
  ADR-0025 adopted the pattern for — and the 9 confirmed findings came back
  with concrete file:line evidence trails.

## What didn't go as planned, and why

### 1. ESLint cannot parse a workflow script at all — ignored, not overridden

The plan called for an ESLint override block declaring the Workflow runtime's
ambient globals. Unworkable: the runtime executes the script body inside an
async function scope, so a workflow legitimately ends with a **top-level
`return`** — unparseable in an ES module (and `export const meta` forces
module mode; espree's `globalReturn` only exists for script/commonjs mode).
`.claude/workflows/**` went into `ignores` with the rationale in a comment;
`check:workflows` is the lint for this surface.

### 2. `args` arrived as a JSON-encoded string and the run failed instantly

The first acceptance invocation died at the script's own args guard: the
Workflow tool delivered `args` as a stringified JSON blob — the exact misuse
the tool docs warn callers about. Since the caller will usually be a model
following SKILL.md, the script now parses string args before validating
instead of only rejecting. The guard produced a precise error either way,
which is what made the failure a 30-second diagnosis.

### 3. A finder returned a digest but never wrote its report file

Finder 2's digest self-reported a mixed-separator report path and the file
never landed on disk — the backslashed Windows `runDir` didn't survive the
agent's shell write (finder 1 got lucky). Verification integrity held anyway:
refuters ground verdicts in the repo, not the report. Three hardenings
followed: the script normalizes `runDir` to forward slashes before it reaches
any prompt, finders must confirm the file exists before returning, and
SKILL.md step 3 tells the hub to treat items from a missing report like
`unverified`.

### 4. Review found the check's own blind spot repeating inside the script

The PR-1 reviewer had flagged that `check:workflows` verifies literal
_presence_, not call-site _association_; the PR-2 reviewer found the mirror
image — the script trusted each digest's self-reported facet linkage. Fixed
by stamping facet/reportPath from the input array by index (`parallel()`
preserves index alignment with nulls), which is strictly more deterministic
than trusting agent echo.

## Lessons learned

1. **Run the artifact before shipping it.** All three real defects (string
   args, separator mangling, unwritten report) were invisible to every static
   gate and both review passes — only the live acceptance run surfaced them.
   For any future workflow script, an end-to-end run on a small real input is
   the acceptance test, not a nice-to-have.
2. **Validate args loudly at the top of a workflow script.** Scripts get no
   stack context worth reading when they die mid-orchestration; the explicit
   guard turned a delivery-format surprise into a one-line diagnosis.
3. **Anything a subagent self-reports about the filesystem is a claim, not a
   fact.** Stamp derivable values (paths, linkage) from inputs; instruct
   agents to verify their own writes; give the hub a recovery rule for the
   remainder.
4. **Forward slashes everywhere a path crosses an agent boundary on
   Windows.** Backslashed paths die non-deterministically depending on which
   shell the agent picks.
5. **The 15× token multiplier is real.** A deliberately small 2-facet audit
   cost ~868k subagent tokens; a full 5-facet audit would plausibly cross the
   1.5M advisory reference. The `VERIFY_MAX` clamp and the
   `budget.remaining()` short-circuit are load-bearing, not decorative.
