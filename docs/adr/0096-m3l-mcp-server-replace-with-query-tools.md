# 0096. Replace the in-repo `m3l` MCP server's tool set with read-only query tools

- **Status:** Accepted
- **Relations:** partially-supersedes: 0030 (clauses: decision item 3's tool set and the "MCP is hub-only" invariant), amends: 0030 (clauses: the 2026-07-27/2026-08-14 amendments' hub-only structural blocker, narrowed a second time)
- **Date:** 2026-09-07
- **Review by:** 2027-03-07
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + design)

## Context and problem statement

ADR-0030 item 3 shipped an in-repo `m3l` stdio MCP server
(`bin/mcp-server.mjs` + `bin/lib/mcp-tools.mjs`) exposing seven CLI-wrapper
tools: `repo_verify`, `docs_sync`, `worktree_manage`, `scaffold_script`,
`commit_lint`, `catalog_query`, `spoke_recover`. An `/auditing` pass parsing
every `tool_use` block across all 249 project session transcripts found
**zero invocations of any `mcp__m3l__*` tool** — not "rarely used," never
called once — while the two other configured MCP servers were used normally
(`mcp__github__*` 118 times, `mcp__context7__*` 10 times) and the seven
tools' own Bash equivalents ran roughly 1,425 times across the same
transcripts (`repo_verify`'s `pnpm check:*`/`pnpm verify` twin alone: 925).
The server is configured, reachable, and produces correct results when
called directly — a live protocol smoke test during the audit confirmed
`tools/list` and a `tools/call` round-trip both work. The tools are simply
never reached for.

The audit found the root cause is **discoverability, not mechanics**: no
`.claude/skills/**` file names an `m3l` tool anywhere, in contrast to the two
servers that are used, which each carry a gate-enforced stance line in skill
frontmatter (`.claude/skills/creating-prs/SKILL.md:8` "GitHub stance: gh CLI
(ADR-0030)"; `.claude/skills/reviewing-dependabot-prs/SKILL.md:9` "Docs
stance: context7 MCP (ADR-0093)"). `bin/check-integration-stance.mjs`'s
descriptor table enforces exactly two such stances and has no `m3l` entry, so
no skill is ever required to declare one — the gap is self-perpetuating. Every
skill whose procedure could use an `m3l` tool instructs the Bash equivalent
instead (`syncing-docs/SKILL.md:20`, `scaffolding-scripts/SKILL.md:57`,
`starting-work/SKILL.md:207`, `finishing-work/SKILL.md:227`). The only two
files that name an `m3l` tool at all (`.claude/rules/subagent-dispatch.md:128`,
`.claude/hooks/detect-spoke-truncation.mjs:209`) list it as a parenthetical
alternative to the CLI, addressed to _spokes_ — which is structurally
impossible: all ten `.claude/agents/*.md` grant zero `mcp__m3l__*` (only
`code-implementer` holds any MCP grant at all, and only for `context7`, per
ADR-0093's 2026-09-05 amendment), and an un-granted tool is simply absent
from a subagent's session with no prompt and no error
(`docs/research/subagent-mcp-tool-grants.md:45-47`). A prior allowlist-census
plan (`docs/plans/archive/2026-09-03-permission-allowlist-expansion.md:39`)
had already recorded "`mcp__m3l__*`, never invoked in the whole corpus" and
the allowlist was widened anyway without adding a stance or fixing the gap.

A second, independent finding: **the value model is inverted from what the
tool set assumes.** Five of the seven tools are pure passthrough — they
validate args and return the wrapped script's JSON verbatim, adding nothing a
`Bash(pnpm <script>)` call doesn't already do, and `.claude/settings.json`
already allowlists the wildcard `Bash(pnpm check:*)`, covering all 61
`check:*` gates unprompted — `repo_verify` is strictly dominated by a command
that requires no permission decision at all. `catalog_query`'s own
description claims its target files are "roughly 11k tokens combined"; they
measure ≈41–45k tokens today, and — measured directly against 249
transcripts, pre-audit-session only — **zero of them were ever fully `Read`**.
Meanwhile a demand scan of the same transcripts found large, unqueryable
artifacts agents repeatedly read in full: the ADR corpus (46 distinct
sessions), work logs (41), the command catalog (33), and the hooks reference
(22) — every one of these currently has no targeted-lookup path at all.

Finally, the audit found real correctness defects, all downstream of every
tool spawning a child process via `execFileSync` under a `cwd` fixed at
module load: `bin/lib/reference-index.mjs`'s `root` constant is derived once
from the server module's own path, and this repo's mandated workflow enters a
git worktree **mid-session, without restarting the MCP server**
(ADR-0013/0014, `EnterWorktree`). After that switch every `m3l` tool call —
including `docs_sync`, which writes files — silently operates on the
session's _starting_ checkout, not the one the agent is actually working in.
`worktree_manage`'s `setup` action is unreachable as documented for the same
reason. No cancellation, output-size cap, or SIGKILL escalation exists on any
spawn, and `spawnJson`'s generic failure branch discards the child's stderr.
None of this was caught by the 795 lines of existing tests, because both test
files mock the SDK/transport (`bin/tests/mcp-server.test.ts:29-35`) or mock
`execFileSync` (`bin/tests/mcp-tools.test.ts`) — no test has ever exercised a
real client against a real running server. No `check:*` gate validates the
server is wired at all, unlike the ~61 other gates covering agents, hooks,
skills, and doc/ADR claims.

## Decision drivers

- **Evidence over speculation** (the ADR-0023/ADR-0030 precedent, applied to
  ADR-0030's own item 3 this time): adopt exactly what logged usage justifies.
  Zero invocations across every transcript this repo has is the most direct
  evidence this precedent has ever produced against one of its own prior
  decisions.
- **Anthropic's tool-design guidance** (`docs/research/writing-custom-tools-and-mcp.md`,
  refreshed for this decision): build few, thoughtfully-scoped,
  workflow-shaped tools; "skills teach _how_, MCP provides _access_ — don't
  reach for MCP where a skill, hook, or CLI already fits"; return only
  high-signal fields; `readOnlyHint`/`title` are baseline annotations; tool
  descriptions are the highest-leverage factor in tool performance and are
  loaded into every request.
- **Match the record to a real, structural policy change** (ADR-0095's
  reversibility test): amending the hub-only invariant, replacing a tool set,
  and adding a new gate all cost real effort to reverse and touch the
  harness/agent-operating-model cluster ADR-0095 names explicitly — this
  belongs in a full ADR, not a decision note.
- **No public-API impact**: everything here is repo tooling; the `exports`
  contract is untouched.
- **Minimal, uniform toolchain** (ADR-0001): no new runtime dependency; the
  existing `@modelcontextprotocol/sdk`/`zod` devDependencies are reused, not
  added to.

## Considered options

1. **Status quo** — leave the seven tools as configured. Rejected: the
   evidence-over-speculation driver cannot tolerate a tool set with a
   measured zero-adoption rate and a documented tree-mutation defect.
2. **Fix in place** — keep the same seven tools and scope; fix only the
   `cwd`/root defect, cancellation, stderr handling, and the missing protocol
   surface (`instructions`, `outputSchema`, `title`). Rejected as
   insufficient on its own: it repairs mechanics but does nothing about the
   discoverability root cause, and leaves five passthrough tools that
   `Bash(pnpm check:*)` already dominates.
3. **Expand** — keep the seven tools, fix every defect, and add a query
   surface over the ADR/logs/command-catalog corpora on top. Rejected: this
   maximizes standing token cost (every tool's schema loads into every
   session) for the tools the evidence says are least used, and duplicates
   work the query surface alone should be doing.
4. **Retire entirely** — delete the server, drop `.mcp.json`'s `m3l` entry and
   the allowlist, invest only in the CLI/skill path. Rejected: it discards the
   one measurement this audit produced that the _category_ of tool is
   valuable — the ADR/logs/command-catalog demand data — along with the two
   tools (`commit_lint`, `catalog_query`) with genuine, if unexercised, merit.
5. **Replace** — retire the five passthrough/CLI-dominated tools
   (`repo_verify`, `docs_sync`, `worktree_manage`, `scaffold_script`,
   `spoke_recover`), keep `commit_lint` and `catalog_query`, and add a
   read-only query tool for each of the demand-ranked corpora (ADR, logs,
   commands, hooks). Fix the protocol/discoverability gaps as part of the
   same rebuild, since the new tool set needs them to have any chance of
   being used. Grant the new read-only tools to spokes, since that is where
   most of the reading this audit measured actually happens.

## Decision

We chose **option 5 — replace**, for the reasons the considered-options
comparison states. The concrete tool set, protocol fixes, gate, and skill/
agent wiring land across the PR sequence this ADR authorizes (a new ADR
first, then the server rebuild, the gate/test, and the skill/agent wiring,
each independently reviewable per ADR-0072); a work log recording the full
delivery is added once that sequence lands, per the repo's own
`writing-work-logs` convention. This ADR records the decision and its
governing constraints, not the line-level design, so the two stay in sync
without duplicating each other.

### What changes

- **Dropped:** `repo_verify`, `docs_sync`, `worktree_manage`, `scaffold_script`,
  `spoke_recover` — all either strictly dominated by an already-unprompted
  Bash path, a pure passthrough with no added logic, or (for `worktree_manage`
  and `docs_sync`) carrying the tree-mutation defect above.
- **Kept:** `commit_lint` (in-process, genuinely avoids writing a commit
  message to disk, tree-independent) and `catalog_query` (the token-savings
  premise is real even though unexercised; reshaped with `outputSchema`).
- **Added:** read-only query tools over the demand-ranked corpora — the ADR
  corpus, work logs, the command catalog, and the hooks reference — each
  reading generated/curated documentation via `readFileSync`, never spawning
  a child process. This is also what retires the `cwd`/root-pinning defect
  as a _class_: a tool that never calls `execFileSync` cannot mutate the
  wrong tree, cannot block the event loop for minutes, and needs no
  cancellation or timeout handling.
- **Protocol surface**: the server gains an `instructions` string (the
  discovery affordance ADR-0030 never used), and every tool gains `title` and
  `outputSchema`/`structuredContent`.
- **A `check:mcp` gate** (new, wired into `pnpm verify`) reconciles
  `.mcp.json`, the registered tool array, and `.claude/settings.json`'s
  allowlist, and asserts baseline annotations — the same class of protection
  `check:hooks`/`check:agents` give their artifact types, which this one
  never had.
- **A real protocol-level test** replaces the fully-mocked existing suite for
  at least a start-up + `tools/list` + one `tools/call` round-trip against a
  real stdio transport.

### Amending the "MCP is hub-only" invariant, a second time

ADR-0030's 2026-07-27/2026-08-14 amendments recorded "MCP is hub-only" as a
structural blocker and named four deliberate repo edits that would revisit
it. ADR-0093's 2026-09-05 amendment already fired revisit condition 1 once,
narrowly, for one tool grant to one spoke (`code-implementer` →
`mcp__context7__*`). This ADR fires it again, for the new **read-only**
`m3l` query tools specifically: they may be granted in `.claude/agents/*.md`
to any spoke whose brief needs the matching lookup, and
`bin/check-agents.mjs`'s `MCP_SPOKES` policy is updated to permit it. This is
where the token savings this decision is built on actually land — most of
the 1,425 Bash calls measured in the Context section came from spokes, which
is exactly the population the original hub-only invariant excluded from ever
reaching a cheaper alternative. Mutating and CLI-wrapper tools are dropped
entirely (see above), so this amendment has no bearing on any write-capable
`m3l` tool — there are none left. The headless-CI structural blocker
(`claude-pr-review.yml` has no `--mcp-config`) is untouched by this ADR.

### Relationship to ADR-0062 (runtime MCP surface)

Unaffected. `packages/m3l-mcp` remains the separate runtime-operations
surface; this ADR only touches the dev-time repo-maintenance server
ADR-0030's 2026-08-20 amendment scoped to `bin/mcp-server.mjs`.

### Relationship to the code-index deferral (ADR-0012/0023)

Unaffected in substance — `catalog_query` survives this rebuild — but its
own evidentiary premise is corrected: ADR-0030 claimed `catalog_query`
"instruments the ADR-0023 revisit trigger with real usage evidence." Zero
invocations mean it has instrumented nothing; ADR-0023's deferral has stood
on no data from this instrument since it shipped. This ADR does not reopen
ADR-0023 — the deferral's own trigger is unrelated to `m3l` usage — but
records the correction so a future reader does not inherit the false
premise.

## Consequences

- **Positive:**
  - The tool set now matches measured demand instead of an unmeasured guess;
    the highest-value corpora (ADR, logs, commands, hooks) get a query path
    for the first time.
  - Dropping every `execFileSync`-based tool eliminates the cwd/root bug,
    cancellation gap, blocking/timeout defects, and stderr-discarding as a
    class, not one fix at a time.
  - `check:mcp` and a real protocol test close the least-gated-artifact gap
    this audit found; a server that fails to start can no longer pass CI
    silently.
  - Spokes can reach the query tools directly instead of shelling out through
    a hub round-trip for the same lookup.
- **Negative / trade-offs:**
  - A new `m3l` MCP stance must be written into every skill the demand data
    says it matters for, and re-verified live rather than assumed — this ADR
    does not itself guarantee adoption; only a follow-up transcript scan
    (this `Review by:` date) will show whether it worked.
  - `worktree_manage`'s ~80 lines of argument-validation logic and
    `spoke_recover`'s recovery-recommendation logic are lost from the MCP
    surface; both remain available via their CLI scripts unchanged.
  - A `project-hub` query tool is deliberately deferred (its 40-session
    demand is close behind the corpora chosen, but `bin/lib/project-hub.mjs`/
    `hub-sync.mjs`'s actual data shape was never explored in this audit) — a
    fast-follow decision, not a gap this ADR silently drops.
- **Semver impact:** none — repo tooling and documentation only; the public
  `exports` contract is untouched.

## Links

- Related: [ADR-0030](./0030-targeted-workflow-tooling-and-mcp.md) (the
  decision this partially supersedes and amends), [ADR-0062](./0062-runtime-mcp-surface.md)
  (unaffected dev-time/runtime boundary), [ADR-0012](./0012-defer-external-code-index-mcp.md)/
  [ADR-0023](./0023-reaffirm-code-index-mcp-deferral.md) (code-index deferral,
  evidentiary premise corrected above, deferral itself unaffected),
  [ADR-0093](./0093-documentation-lookup-mcp-context7.md) (the prior, narrower
  firing of the same hub-only revisit condition), [ADR-0095](./0095-adr-worthiness-and-decision-note-tier.md)
  (why this is a full ADR, not a decision note).
- Evidence base: an `/auditing` pass over this repo's own session transcripts
  (249 transcripts, the counts cited in Context above) plus a live protocol
  smoke test, both performed 2026-09-07 and recorded in this ADR rather than
  a separate log — the delivery work log follows once the authorized PR
  sequence lands; [research snapshot](../research/writing-custom-tools-and-mcp.md)
  (official-guidance evidence base, retrieved 2026-07-16, re-confirmed for
  this decision 2026-09-07).

<!--
  Cross-ADR relations (supersedes, amends, re-affirmed-by, fires-trigger-of/
  trigger-fired-by) live in the status block's `Relations:` line above, not
  here — see ADR-0094 for the closed verb set.
-->
