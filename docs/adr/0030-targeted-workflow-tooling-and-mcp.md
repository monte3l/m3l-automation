# 0030. Targeted workflow tooling and MCP adoption

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Enrico Lionello

## Context and problem statement

The repo's agent workflow is entirely CLI-mediated: agents invoke `bin/*.mjs`
scripts through an allowlisted Bash surface and parse human-readable prose to
decide next steps; five skills hand-roll `gh api --paginate` + `jq`
choreography; the `/syncing-docs` pipeline is an 8-step sequence of loose
scripts with documented ordering footguns; and recovery from writer-spoke
truncation (the repo's most-recurring build divergence, 20+ logged incidents)
is a fully manual playbook.

A research pass over official Anthropic guidance
([snapshot](../research/writing-custom-tools-and-mcp.md)) and a 4-facet repo
audit converged on the question: **should this repo add custom agent tools
and/or MCP servers, and if so, which ones?** Two prior ADRs already govern part
of the answer: ADR-0012/0023 defer an external _code-index_ MCP, and two skills
carried a "GitHub MCP blocked by enterprise policy" claim that is no longer
valid.

## Decision drivers

- **Anthropic's selection framework**: custom tools for _frequent,
  high-priority agent actions_; plain Bash/CLI for _ad-hoc work_; skills teach
  _how_, MCP provides _access_; few workflow-shaped tools, never API mirrors;
  structured, high-signal, token-cheap responses.
- **Minimal, uniform toolchain** (ADR-0001): Node/pnpm/ESM only; no new
  runtime dependencies; dev-only additions acceptable when they earn their
  keep.
- **Evidence-driven adoption** (the ADR-0023 precedent): build tooling against
  observed, logged friction — not speculative scale.
- **Security**: no secrets in committed configuration; `.mcp.json` may hold a
  server inventory but never a literal key.
- **No public-API impact**: everything here is repo tooling; the `exports`
  contract is untouched.

## Considered options

1. **Status quo** — keep the pure-CLI surface; agents continue parsing prose
   output and re-implementing gh choreography per skill.
2. **MCP-first migration** — wrap every `bin/` script as an MCP tool and
   rewrite all five GitHub-facing skills onto GitHub MCP in one pass.
3. **Targeted increments** — adopt exactly the tooling that maps to logged
   friction: structured (`--json`) output on agent-invoked scripts, a
   composite doc-sync entry point, a small in-repo MCP server of
   workflow-shaped tools, GitHub MCP configuration with incremental skill
   migration, and a truncation-recovery helper.

## Decision

We chose **option 3 — targeted increments**, applying the research's design
rules to each:

1. **`--json` output mode** on the `bin/` scripts agents invoke interactively
   (shared `bin/lib/report.mjs` result shape; human output and exit codes
   unchanged). Fixes brittle prose-parsing at the lowest possible cost.
2. **Composite doc-sync** (`bin/sync-docs.mjs`, `pnpm sync:docs`) — one
   deterministic entry point for the `/syncing-docs` sequence, with the two
   logged footguns fixed by construction: provenance re-stamping is scoped to
   the affected modules by default (repo-wide only behind `--all`), and
   `gen:index` ordering relative to prettier is baked in.
3. **In-repo MCP server** (`bin/mcp-server.mjs`, stdio, checked-in secretless
   `.mcp.json`) exposing a deliberately small (≤ 7) set of workflow-shaped
   tools — `repo_verify`, `docs_sync`, `worktree_manage`, `scaffold_script`,
   `commit_lint`, `catalog_query`, optionally `spoke_recover` — never a mirror
   of the ~30 underlying scripts. Dev-only dependencies:
   `@modelcontextprotocol/sdk`, `zod`.
4. **GitHub MCP adoption** — the "blocked by enterprise policy" claim recorded
   in `triaging-ci` and `triaging-scan-alerts` is **retired**: the policy no
   longer applies. GitHub's official remote MCP server is configured at
   project scope. Skills migrate **incrementally** — when a GitHub-facing
   skill is next edited, prefer MCP tools where they simplify its gh/jq
   choreography; the gh CLI remains a supported mechanism throughout.
5. **Truncation-recovery helper** (`bin/spoke-recovery.mjs`) — automates the
   manual playbook in `docs/contributing/subagent-context-management.md`:
   journal parsing, on-disk state verification, and a structured
   resume-vs-redispatch recommendation.

### Relationship to the code-index deferral (ADR-0012/0023)

The external code-index MCP deferral **stands**. ADR-0023's revisit trigger is
a two-part AND — the W2–W4 consumer fleet has landed **and** spokes exhibit
grep/context friction the generated catalog cannot answer — and neither branch
has fired: the fleet is early, and the audit's pain-point sweep across 16+
work logs found no symbol-lookup friction.

However, the committed artifacts are now large enough that _reading_ them is
itself the cost (`symbol-map.json` ≈ 45 KB ≈ 11k tokens for a ~50-token
answer). The in-repo server therefore carries a **`catalog_query`** tool that
queries the committed, CI-gated `catalog.json`/`symbol-map.json` via
`bin/lib/reference-index.mjs` and returns only matching entries. This is the
Node-only, zero-infrastructure realization of the indexer's core value —
consistent with the deferral, not a reversal — and it **sharpens ADR-0023's
trigger**: spokes still falling back to grep sweeps _after_ a cheap typed
lookup exists is exactly the observable friction evidence the trigger waits
for.

### Secrets posture for `.mcp.json`

A committed `.mcp.json` must be secretless: server entries reference
credentials via `${VAR}` environment expansion or OAuth; real keys live in the
user's environment. Until the secretless version lands, the file is
gitignored as a stopgap (it briefly held a literal API key).

## Consequences

- **Positive:**
  - Agents get structured, machine-readable results from the scripts they run
    most, ending prose-parsing and invocation-pattern drift.
  - The doc-sync footguns (unscoped re-stamp, gen:index/prettier ordering)
    become impossible rather than documented.
  - `catalog_query` turns an ~11k-token cold-start file read into a ~50-token
    tool call and instruments the ADR-0023 revisit trigger with real usage
    evidence.
  - The GitHub-integration stance is recorded here instead of as an unsourced
    policy claim inside two skill descriptions.
- **Negative / trade-offs:**
  - Three invocation layers (CLI flag, pnpm script, MCP tool) must stay in
    sync where a script is exposed through all of them.
  - Two new dev-only dependencies (`@modelcontextprotocol/sdk`, `zod`) and one
    long-lived stdio server process per session.
  - Incremental skill migration means gh CLI and GitHub MCP coexist for a
    while; per-skill consistency is settled only when each skill is next
    touched.
- **Semver impact:** none — repo tooling and documentation only; the public
  `exports` contract is untouched.

## Amendment (2026-07-27)

An `/auditing` pass over gh CLI usage across the five GitHub-facing skills
found that decision item 4's "migrate incrementally when next edited" promise
had produced zero migrations in the 11 days since acceptance — not from
neglect, but because GitHub MCP as configured cannot cover most of what those
skills do. This amendment supersedes item 4 with the coverage evidence and a
falsifiable trigger; the rest of the ADR is unchanged.

**Correction to the Context section:** the claim that "five skills hand-roll
`gh api --paginate` + `jq` choreography" (original context, above) overstates
the jq surface. Live count: four skills use `gh api --paginate`
(`resolving-pr-comments:74`, `reviewing-dependabot-prs:79`,
`triaging-scan-alerts:55`, `creating-prs:198`); `triaging-ci` uses no `gh api`
and no jq at all. "Five" was the count of GitHub-facing skills, not of
`gh api --paginate` + jq call sites. (Corrected 2026-08-14: this errata itself
originally misstated `creating-prs:191` as using `gh api` without
`--paginate` — the live call at `creating-prs:198` does pass `--paginate`,
required for the code-scanning-alerts endpoint's pagination.)

**Coverage matrix** — why migration stalled:

| Skill                      | gh ops | MCP coverage | Blocker                                           |
| -------------------------- | ------ | ------------ | ------------------------------------------------- |
| `resolving-pr-comments`    | 4      | full         | none — migrated                                   |
| `creating-prs`             | 4      | partial      | no code-scanning tool for the CodeQL probe        |
| `reviewing-dependabot-prs` | 8      | partial      | `merge_pull_request` has no auto-merge equivalent |
| `triaging-scan-alerts`     | 6      | ~2 of 6      | no code-scanning tool in the default toolset      |
| `triaging-ci`              | 4      | none         | no Actions tools in the default toolset           |

**Toolset decision:** `.mcp.json`'s `github` entry stays on the default
toolset URL (`https://api.githubcopilot.com/mcp`). GitHub's remote server does
offer `/x/actions` and `/x/code_security` toolsets (each with a `/readonly`
variant) that would cover the two zero/near-zero rows above, but enabling them
loads roughly 20 more tool schemas against the degradation threshold recorded
in
[`docs/research/writing-custom-tools-and-mcp.md`](../research/writing-custom-tools-and-mcp.md)
(~30–50 loaded tools). `triaging-ci` and `triaging-scan-alerts` stay on the gh
CLI **by decision, not by omission**.

**Structural blockers**, previously undocumented, that cap MCP adoption
independent of toolset coverage:

- MCP is hub-only. Every agent in `.claude/agents/*.md` declares a closed
  `tools:` list with no `mcp__*` entry — no spoke can call an MCP tool at all.
  A skill whose work is delegated to a spoke cannot depend on MCP regardless of
  toolset coverage.
- MCP is unavailable in headless CI. `.github/workflows/claude-pr-review.yml`
  pins `--allowedTools Bash,Read` with no `--mcp-config` for that run. A skill
  that must execute inside that workflow must stay gh-runnable.

**Replacement for the "when next edited" trigger** — the original wording was
un-falsifiable: it named no condition under which migration was warranted or
complete, unlike the code-index deferral's sharpened two-part trigger
elsewhere in this ADR. Revisit a given skill's mechanism when **both** hold:

> (a) the default GitHub MCP toolset gains an Actions or code-scanning tool,
> **or** a logged incident in `docs/logs/` records concrete gh-CLI friction
> (auth failure, rate-limit, or a jq-parsing break); **and** (b) the affected
> skill can still run headless under `claude-pr-review.yml`'s tool allowlist.

Until a skill meets this trigger, the gh CLI is its default mechanism — a
migration requires meeting the trigger, not merely touching the file.
`resolving-pr-comments` met an equivalent bar on its own (full coverage, hub-
only invocation) and has migrated; see
[`.claude/skills/resolving-pr-comments/SKILL.md`](../../.claude/skills/resolving-pr-comments/SKILL.md).

**Evidence-driven-adoption check:** a sweep of all `docs/logs/*.md` found
zero logged gh-CLI friction (auth, rate-limit, or jq-parsing failure) in the
11 days since acceptance — this ADR's own decision driver has not yet
produced evidence that would justify migrating any of the remaining four
skills ahead of the trigger above.

**Secrets-posture correction:** `.mcp.json`'s `github` entry authenticates via
a static PAT (`Authorization: Bearer ${GITHUB_MCP_PAT}`), not the OAuth flow
recorded in the Phase 2 delivery log (see Links). Still secretless and
compliant with this ADR's posture requirement (`${VAR}` expansion, no literal
key) — but a PAT carries broader standing scope than OAuth would, and the
delivery record should be read with that correction in mind.

## Amendment (2026-08-14)

Issue #344 existed only to carry the 2026-07-27 amendment's revisit trigger
forward as a periodic re-check reminder — nothing in the repo polled it, and
its own row text admitted as much. This amendment re-evaluates the trigger
once with evidence, then retires it: the trigger's own limbs are not the kind
of thing a reminder can usefully re-check, so a re-check reminder was the
wrong instrument in the first place.

**Re-evaluation, 2026-08-14:**

| Trigger limb (2026-07-27 amendment, above)                                          | Verdict        | Evidence                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a₁) default MCP toolset gains an Actions or code-scanning tool                     | Unfired        | Live `mcp__github__*` inventory carries zero Actions tools and zero code-scanning-alerts tools. `run_secret_scanning` exists but is content secret-scanning, not the `GET /repos/{o}/{r}/code-scanning/alerts` endpoint `creating-prs`/`triaging-scan-alerts` need — a near-miss that shows limb (a₁) is not reliably checkable from memory. |
| (a₂) a logged gh-CLI friction incident in `docs/logs/`                              | Unfired        | Repo-wide grep for auth failure / rate-limit / jq-parsing break across every `docs/logs/*.md` (40+ files, 3 added since the amendment): zero hits.                                                                                                                                                                                           |
| (b) the affected skill still runs headless under `claude-pr-review.yml`'s allowlist | Still blocking | `claude-pr-review.yml` still pins `--allowedTools Bash,Read` with no `--mcp-config`.                                                                                                                                                                                                                                                         |

Every blocker behind these limbs — the schema-budget toolset decision, MCP
being hub-only (no `.claude/agents/*.md` grants `mcp__*`), and the headless
CI allowlist — is a **repo-side decision the maintainer controls**, not a
change in GitHub's remote MCP server that a periodic re-check would ever
observe. Limb (a₁) in particular is unfalsifiable in practice: the repo pins
no baseline of the remote server's tool inventory, so "gains a tool" can only
be judged from memory at whatever moment someone happens to look.

**Retirement:** the two-part revisit trigger is retired. In its place, revisit
a given skill's `gh`-CLI mechanism only when the maintainer makes one of these
deliberate repo edits — each an action, not an observation, so re-opening no
longer depends on remembering to look:

1. `.claude/agents/*.md` gains an `mcp__*` tool grant for a spoke (MCP stops
   being hub-only);
2. `.github/workflows/claude-pr-review.yml` gains `--mcp-config` (MCP becomes
   available headless);
3. `.mcp.json`'s `github` entry opts into the `/x/actions` or
   `/x/code_security` toolset (the schema-budget decision is revisited);
4. a concrete gh-CLI failure blocks a workflow and is written up in
   `docs/logs/` — limb (a₂) above, preserved as a live re-open condition.

The coverage matrix, toolset decision, and structural-blockers text in the
2026-07-27 amendment above remain the standing record of _why_ each skill
stays gh-CLI-based; only the revisit mechanism changes. `docs/plans/IMPLEMENTATION.md`'s
gated-decisions table records this row as `Rejected`, closing issue #344.

## Amendment (2026-08-20)

The agent-operator programme ([ADR-0058](./0058-agent-operator-programme.md))
introduces a **second, runtime MCP surface** —
[ADR-0062](./0062-runtime-mcp-surface.md)'s `packages/m3l-mcp`, exposing
intent-grouped fleet operations (discovery, run, flow, health) to external
MCP clients under the agent policy layer. This amendment records the
boundary so the two servers are never conflated: `bin/mcp-server.mjs`
(this ADR) remains the **dev-time repo-maintenance** surface — hub-only,
devDependency-backed, workflow tools over repo state; `packages/m3l-mcp`
is the **runtime operations** surface with its own dependency, lifecycle,
and governance registration. Nothing in this ADR's decision items is
superseded; the tool-design rules it adopted (fewer, workflow-shaped
tools) apply to the runtime surface as well.

## Amendment (2026-09-05)

[ADR-0093](./0093-documentation-lookup-mcp-context7.md) fires this ADR's
2026-08-14 amendment re-open condition #1: `code-implementer` — and only
`code-implementer` — is to be granted a scoped `mcp__context7__*` tool for
one logged need (verifying AWS SDK behavioral semantics `dist-types` cannot
express), delivered in a later PR of ADR-0093's own delivery sequence. **Once
that PR lands, "MCP is hub-only" in the 2026-07-27 amendment's structural-
blockers text stops being universally true**; read it from then on as
"hub-only, except the one scoped grant ADR-0093 records" — until it lands,
the invariant still holds exactly as stated. ADR-0093 re-examines the five
GitHub-facing skills' mechanism under this condition and reaffirms gh-CLI for
all five unchanged — the grant is to a spoke with no GitHub-facing role, so
neither the coverage matrix nor the toolset decision above is affected. The
headless-CI structural blocker is untouched: `code-implementer` still cannot
rely on any MCP server inside `claude-pr-review.yml`.

## Links

- Supersedes / superseded by: the 2026-07-27 amendment supersedes decision
  item 4's original migration trigger; the 2026-08-14 amendment above
  supersedes the 2026-07-27 amendment's _revisit trigger_ specifically (its
  coverage matrix, toolset decision, and structural blockers stand
  unchanged, except as corrected by the 2026-09-05 amendment). Nothing
  supersedes this ADR as a whole. Retires the "GitHub MCP blocked by
  enterprise policy" claim formerly stated in
  `.claude/skills/triaging-ci/SKILL.md` and
  `.claude/skills/triaging-scan-alerts/SKILL.md`.
- Amended by [ADR-0093](./0093-documentation-lookup-mcp-context7.md) — the
  hub-only invariant's one scoped exception.
- Delivery record:
  [`docs/logs/2026-07-17-adr-0030-workflow-tooling-mcp.md`](../logs/2026-07-17-adr-0030-workflow-tooling-mcp.md)
  (Phase 2 row records GitHub MCP auth as OAuth; corrected above — the shipped
  config uses a static PAT).
- Related: [ADR-0001](./0001-toolchain-choices.md) (toolchain ethos),
  [ADR-0012](./0012-defer-external-code-index-mcp.md) /
  [ADR-0023](./0023-reaffirm-code-index-mcp-deferral.md) (code-index deferral,
  unchanged by this ADR),
  [research snapshot](../research/writing-custom-tools-and-mcp.md) (the
  official-guidance evidence base, retrieved 2026-07-16).
