# Pin every subagent to an exact Claude model ID

**Status: shipped** — commit range on `chore/pin-spoke-model-ids`.

## Context

All nine spokes in `.claude/agents/*.md` pinned a bare model alias
(`sonnet`, `opus`, `haiku`). Aliases float to whatever Anthropic ships next, so
two runs of the same spoke weeks apart can execute on different models — the
MODEL-MATRIX in `docs/contributing/model-selection.md` recorded an intended
_tier_, not what actually ran. The maintainer asked for Sonnet spokes on
`claude-sonnet-5` and Opus spokes on `claude-opus-5`; the clarifying round
extended that to the two Haiku spokes rather than leave the matrix mixed.

An `/auditing` fan-out over four facets (agent definitions, the shared model
allow-list library, the tiering docs, and official Anthropic guidance) found
that **the code side was already done**:

- `isValidAgentModel` (`bin/lib/claude-models.mjs:113`) accepts full IDs via
  `MODEL_ID_PATTERN` (`:104`, `/^claude-[a-z]+-[a-z0-9-]+$/`). No validator
  change was needed.
- Anthropic documents full model IDs as a supported `model:` frontmatter value
  for subagents, alongside the aliases.

The real blocker was documentation policy. Step 4 of `model-selection.md`
argued the **opposite** rule — pin IDs for CI workflows, "not for spoke
frontmatter, where auto-upgrade is the point." The change therefore reversed a
reasoned decision, which had to be rewritten rather than silently contradicted.

## Approach / Decisions

Per the user's choices during the audit's clarifying round:

1. **Haiku spokes in scope.** Pinning only Sonnet/Opus would have left a bare
   `haiku` beside full-ID rows — legal, but a matrix that documents two
   conventions at once. All nine spokes now pin an exact ID.
2. **Invert the policy, no separate ADR.** Step 4 was rewritten so spokes pin
   full IDs for reproducibility, keeping the currency-vs-reproducibility
   tradeoff prose intact and resolved the other way. Two dependent passages
   were re-anchored in the same pass: the `availableModels` rationale (which
   leaned on step 4's aliases-everywhere framing) and the alias-float note.
3. **`audit-fanout.js:verify` included**, so no bare `sonnet` survives next to
   full-ID rows. Both the matrix row and the runtime pin at
   `.claude/workflows/audit-fanout.js:249` moved together.
4. **Regression tests added.** `isValidAgentModel` / `isValidWorkflowModel` had
   **zero** coverage — the exact branch all nine spokes now depend on. Written
   by the `test-author` spoke, since `bin/tests/**` is a guarded path.

### Decided without asking

`.claude/settings.json` keeps `availableModels: ["fable","opus","sonnet","haiku"]`
as **family wildcards**. Family wildcards already permit a pinned ID inside the
family, and Anthropic's merge rule is that an entry naming a specific model
disables that family's wildcard — so adding `claude-sonnet-5` there would have
narrowed the `sonnet` alias for every surface still resolving through it
(`inherit`, the hub's own `/model`). The ceiling bounds which _families_ may
run; version pinning belongs in frontmatter, where it is visible and gated.

### The one empirical unknown

`claude-opus-5` and `claude-sonnet-5` were already proven in-repo by
`claude-pr-review.yml` / `claude-assistant.yml`. The undated `claude-haiku-4-5`
was used nowhere, and the known-exact ID for that model is the dated
`claude-haiku-4-5-20251001`. Both match `MODEL_ID_PATTERN`, so **no gate could
distinguish them** — `check:agents` would pass either way.

Resolved by execution rather than assumption: dispatching an `Explore` spoke
after the repoint confirmed it ran and self-reported
`claude-haiku-4-5-20251001`, so the undated form resolves to the current
snapshot. A parallel `security-reviewer` dispatch confirmed `claude-opus-5`.
The fallback to dated IDs was never needed, and the resolution fact is now
recorded in `model-selection.md` so the next reader need not re-derive it.

## Outcome

Nine agent frontmatter files, ten MODEL-MATRIX rows, the `audit-fanout.js`
verify pin, three policy passages in `model-selection.md`, and the MODEL ROUTING
block in `CLAUDE.md` moved in a single commit — `check:agents` cross-checks
frontmatter against the matrix bidirectionally, so a partial change hard-fails.

`bin/tests/claude-models.test.ts` went 8 → 44 tests, including a named test for
the `opusplan` asymmetry (valid for a workflow pin, rejected in agent
frontmatter) that pins the contract distinction between the two validators.

`pnpm verify` passed all 39 steps. The full suite is 7167 + 1136 tests green.

**Side finding, not fixed here.** Re-probing `bin/tests/**` for this change
refreshed the measurement on issue #488 (F14 — that tree is type-checked by no
gate): the recorded fallout of 25 errors across 4 files is now 69 across 8. The
four originally-listed files match their recorded counts exactly, so nothing
regressed — four further files drifted in since, because no gate holds the
line. Posted as a comment on #488 rather than a duplicate issue; the newly
added tests here were confirmed type-clean under the same probe.
