# 0092. Documentation-lookup MCP (Context7): adoption stance and usage policy

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

`.mcp.json` has declared a third MCP server, `context7`, since before ADR-0030
existed — ADR-0030's Phase 2 only made the already-present entry secretless
after a live `ctx7sk-…` key was found untracked in the repo root, one
`git add -A` from being committed. **Context7 is never named in ADR-0030
itself**; the only text that governs it there is the generic "Secrets posture
for `.mcp.json`" section.

The server is not, however, unused. Three skill reference snapshots —
`.claude/skills/{tsconfig-strict-esm,eslint-flat-config,vitest-coverage-types-mocks}/references/*.md` —
were authored _from_ Context7 and carry a `> **Provenance**` block naming the
library id, the version pinned, and a refresh policy. All three are dated
2026-07-02, all three had drifted from the versions actually installed, and
all three instructed a refresh via `ctx7 skills generate` — a command that
never existed (the installed `ctx7` CLI's verbs are `library`/`docs`) — on a
CLI now being uninstalled. Two eval suites
(`eslint-flat-config/evals/evals.json`, `vitest-coverage-types-mocks/evals/evals.json`)
independently graded responses on routing to a `context7-mcp` plugin skill
that does not exist in this repo, encoding "Unknown skill" as an acceptable
outcome.

So real intent produced real residue — provenance blocks, eval expectations,
secret guards (`guard-secret-writes.mjs`'s `CONTEXT7_API_KEY` name and
`ctx7sk-` pattern; `.gitleaks.toml`'s `context7-api-key` rule) — with no
connective tissue: no `.claude/settings.json` allowlist entry, no decision of
record, no gate keeping the snapshots honest, and no agent-operating-model
statement of who may call it or how. This ADR supplies all four.

## Decision drivers

- **Evidence over speculation** (the ADR-0023 precedent): adopt exactly what
  logged usage justifies, not a broader integration.
- **Few, workflow-shaped tools, never an API mirror** (ADR-0030's inherited
  design rule): the server exposes exactly two tools —
  `resolve-library-id`, `query-docs` — already minimal by construction.
- **Minimal, uniform toolchain** (ADR-0001): no new runtime dependency; the
  `ctx7` CLI is being uninstalled rather than adopted as a second mechanism.
- **Least Agency**: grant the narrowest tool surface that resolves a real,
  logged need — not a blanket grant across every spoke on the theory that any
  of them might someday want documentation.
- **No public-API impact**: this is repo tooling; the `exports` contract is
  untouched.

## Considered options

1. **Retire it** — remove the `context7` entry from `.mcp.json`, drop the
   provenance blocks. Rejected: three snapshots depend on it for their
   original authoring method, and the secret-guard work (`guard-secret-writes.mjs`,
   `.gitleaks.toml`) is already paid for and would need no changes either way.
2. **Document-only** — write a stance note and leave the mechanism, gate, and
   spoke access untouched. Rejected: this is close to the state that produced
   the shelfware in the first place — a name in prose with nothing checking it.
3. **Governed, hub-plus-one-spoke adoption** — allowlist the tools, record
   this decision, add a freshness gate keeping the snapshots honest, and grant
   `code-implementer` (only) a scoped MCP tool grant for the one logged need
   that justifies it. **Chosen.**

## Decision

We chose **option 3**.

**Allowlist.** `.claude/settings.json`'s `permissions.allow` gains
`mcp__context7__resolve-library-id` and `mcp__context7__query-docs`, matching
the existing `mcp__m3l__*`/`mcp__github__*` entries.

**Mechanism: hub plus one spoke, not hub-only.** The hub retains its own
allowlisted access (for refreshing the reference snapshots, an in-process
task). In addition, `code-implementer` — and only `code-implementer` — is
granted the same two tools via a scoped `mcpServers: [context7]` +
`tools:` entry in its frontmatter. This is a deliberate departure from
ADR-0030's "MCP is hub-only" invariant, made on evidence rather than
speculation:

- **The logged need.** `implementing-submodules` Step 4 already mandates
  verifying an AWS SDK wrapper's actual resolve/throw behavior against its
  installed `dist-types` before treating a drafted contract as settled — the
  rule exists because `aws/ecs`'s first-drafted contract claimed
  `waitUntilServicesStable` "resolves on timeout" when the SDK's real waiter
  throws on any non-`SUCCESS` state (`docs/logs/2026-07-24-aws-ecs.md`).
  `dist-types` answer the _shape_; they cannot answer documented _behavioral_
  semantics (retry/backoff policy, terminal-state classification, pagination
  contracts) that only the library's own docs describe. Today, that gap is
  closed by the hub pre-resolving it and re-serializing the answer into
  `code-implementer`'s dispatch prompt — exactly the "information bottleneck"
  pattern Anthropic's multi-agent coordination guidance identifies as a cost,
  not a virtue, of over-centralizing retrieval
  (see `docs/research/subagent-mcp-tool-grants.md`).
- **Why the grant, not the relay.** Per that research snapshot: "the only
  content you pass from parent to subagent is the Agent tool's prompt
  string" — granting a subagent the tool _is_ the mechanism by which it
  self-retrieves; a tool omitted from `tools:` is silently absent from its
  session, no prompt, no error. Anthropic's own multi-agent research system
  has subagents perform their own retrieval and return a distilled summary
  rather than routing everything through the lead.
- **Why one spoke, not all ten.** "Principle of Least Agency" and the Agent
  SDK's explicit "prefer `allowedTools` over permission modes for MCP access"
  both argue for the narrowest grant that resolves the logged need. No other
  spoke has a demonstrated, logged requirement for third-party documentation
  lookup today. `test-author`'s closest candidate use (Vitest mocking-API
  questions) is already covered by the `vitest-coverage-types-mocks` reference
  snapshot; the four reviewer spokes judge code against project rules and
  `dist-types`, not upstream docs.
- **The mechanism used for the grant.** `mcpServers: [context7]` in
  `code-implementer`'s frontmatter scopes the server to that one subagent and
  keeps its tool schemas out of the hub's own context — strictly better than a
  bare `tools:` entry when only one spoke needs a server. This requires Claude
  Code v2.1.238+; `.claude-code-version` pins 2.1.251, so no version bump is
  needed.
- **Precedence, stated in the agent body.** Installed `dist-types` remain the
  pinned truth and win on any conflict; `context7` answers behavioral
  semantics a `.d.ts` cannot express. The repo pins `@aws-sdk/*` at
  `3.1123.0` while Context7 returns current upstream docs, so a disagreement
  between them is expected and is not, by itself, evidence the types are
  wrong.
- **Never a hard dependency.** `code-implementer` is dispatched in contexts
  where `context7` may be unavailable (a session with no network, a stripped
  `--mcp-config`), and headless CI has no MCP configuration at all (below).
  The lookup must be framed as an available aid, never a required step.

**Freshness.** A new `check:reference-freshness` gate (CI + `pnpm verify`,
mirroring `check:integration-stance`'s registration) parses a machine-readable
stamp on each Context7-sourced reference snapshot and compares the version it
was written against to what's actually installed, firing on the refresh
policy each snapshot already declares in prose (`major` for tsconfig/eslint,
`minor` for vitest's faster-moving mocking API). It also fails on any
reappearance of the retired `ctx7 skills generate` string.

**Stance.** `bin/lib/integration-stance.mjs` generalizes from a single
GitHub-shaped descriptor to a table of integration descriptors, adding a
docs-lookup descriptor alongside the existing GitHub one: any `SKILL.md` body
calling `mcp__context7__*` must carry an ADR-0092 reference in its
frontmatter. `docs/contributing/skills-catalog.md` gains an `## External
documentation` section (mirroring `## GitHub integration`) recording which
skills use `context7` and why.

**Not adopted.** The `ctx7` CLI (a separate, unauthenticated command-line
client — `ctx7 whoami` reports "Not logged in") is being uninstalled rather
than adopted as a parallel mechanism. Its only appearance in this repo was as
a dead refresh instruction inside the three reference snapshots, corrected in
the same change that adds this ADR's gate.

### Distinguishing this from the ADR-0012/0023 code-index deferral

ADR-0012 and ADR-0023 decline an external MCP server that would index _this
repo's own code_ — the generated `catalog.json`/`symbol-map.json` plus the
in-repo `catalog_query` tool (ADR-0030) already serve that need cheaply and
locally. `context7` answers a different question entirely: the current
documented behavior of a _third-party_ library this repo depends on, which no
local index of this repo's own source can ever answer. Adopting `context7` is
not a reversal of the code-index deferral, any more than adopting the GitHub
MCP server was — they cover disjoint problem spaces.

### The ADR-0030 re-open condition this decision fires

Granting `code-implementer` an `mcp__*` tool is ADR-0030's 2026-08-14
amendment condition #1, verbatim: "`.claude/agents/*.md` gains an `mcp__*`
tool grant for a spoke (MCP stops being hub-only)." That condition exists to
reopen whether the five GitHub-facing skills (`creating-prs`,
`resolving-pr-comments`, `reviewing-dependabot-prs`, `triaging-ci`,
`triaging-scan-alerts`) should migrate from the `gh` CLI to GitHub MCP. Firing
it does not skip that re-examination — this section performs it.

**Re-examination, 2026-09-05:** the 2026-07-27 amendment's coverage matrix
blocked four of the five skills on _toolset coverage_ (no Actions or
code-scanning tool in the default GitHub MCP toolset) and all five on
_headless CI_ (`claude-pr-review.yml` still pins a scoped `--allowedTools`
with no `--mcp-config`). Neither blocker is affected by granting
`code-implementer` — a spoke with no GitHub-facing role at all — an unrelated
server. `code-implementer` is never dispatched by any of the five
GitHub-facing skills. **Conclusion: none of the five migrate.** The coverage
matrix, toolset decision, and structural-blockers text in ADR-0030's
2026-07-27 amendment stand unchanged; only the "MCP is hub-only" half of the
structural-blockers text stops being a true blanket claim once the grant
below actually lands, and is corrected at that point.

**Sequencing.** This ADR is delivered across a small PR sequence, not one
change: an earlier PR establishes the allowlist, this decision's stance, and
the freshness gate; a later PR in the same sequence adds `code-implementer`'s
actual frontmatter grant. **"MCP is hub-only" remains true, and neither doc
below needs correction, until that later PR lands** — a decision being
accepted is not the same event as its implementation shipping. The two doc
corrections below are scoped to land in that same later PR, alongside the
frontmatter change that makes them true:

- `docs/contributing/agent-operating-model.md`'s "MCP is hub-only" bullet —
  amend to name the one exception and point here.
- `docs/contributing/skills-catalog.md`'s GitHub-integration structural-
  constraints paragraph — same correction.
- This ADR stands as the record of the exception; ADR-0030 itself is not
  rewritten, per the append-only convention for accepted decisions — its
  2026-07-27 and 2026-08-14 amendments' coverage matrix and toolset decision
  remain the standing record for the five GitHub-facing skills specifically.

The **headless-CI** half of ADR-0030's structural blockers is unchanged and
still true: `claude-pr-review.yml` pins `--allowedTools` with no
`--mcp-config`, so `code-implementer` cannot rely on `context7` being present
in that context either, and no skill may depend on it to run.

## Consequences

- **Positive:**
  - Three previously-authored reference snapshots get a governing decision,
    an enforced freshness policy, and corrected refresh instructions instead
    of a dead CLI reference.
  - `implementing-submodules` Step 4's dist-types verification gains a
    documented complement for behavioral semantics `.d.ts` files cannot
    express, resolvable by `code-implementer` itself rather than pre-resolved
    and re-serialized by the hub for every dispatch.
  - The two eval suites that graded on a nonexistent `context7-mcp` skill now
    grade on the real, working mechanism.
  - "Selective, not blanket" becomes a checked invariant
    (`bin/lib/agent-roster.mjs`'s `MCP_SPOKES`, enforced by `check-agents.mjs`)
    rather than a one-time decision nothing revisits.
- **Negative / trade-offs:**
  - ADR-0030's "MCP is hub-only" invariant is no longer universally true; two
    docs (`agent-operating-model.md`, `skills-catalog.md`) needed correction
    in the same change to avoid shipping a false claim.
  - `code-implementer` gains a dependency on external, third-party
    documentation content it did not have before — Anthropic does not
    security-audit any MCP server, and content fetched from one is data, not
    instructions, but it enters a spoke that also holds `Write`/`Edit`.
    Addressed by framing the lookup as advisory (never load-bearing for a
    passing gate) in the agent's own body.
  - A CI-facing check (`check:reference-freshness`) and a governance check
    extension (`check-integration-stance`'s new descriptor) are two more gates
    to keep in sync with `ci.yml` via `check:verify-parity`.
- **Semver impact:** none — repo tooling, harness configuration, and
  documentation only; the public `@m3l-automation/m3l-common` exports contract
  is untouched.

## Links

- Amends [ADR-0030](./0030-targeted-workflow-tooling-and-mcp.md) — fires its
  2026-08-14 amendment's re-open condition #1; re-examines and reaffirms the
  five GitHub-facing skills' gh-CLI mechanism unchanged; corrects the
  "MCP is hub-only" blanket claim to name this one exception.
- Related: [ADR-0012](./0012-defer-external-code-index-mcp.md) /
  [ADR-0023](./0023-reaffirm-code-index-mcp-deferral.md) — the code-index
  deferral this decision is distinguished from, not a reversal of.
- Evidence: [`docs/research/subagent-mcp-tool-grants.md`](../research/subagent-mcp-tool-grants.md)
  (the official-guidance research this decision's spoke-grant reasoning is
  drawn from, retrieved 2026-09-05); `docs/logs/2026-07-24-aws-ecs.md` (the
  logged incident motivating the grant); `docs/logs/2026-07-17-adr-0030-workflow-tooling-mcp.md`
  (records the untracked-key incident that made `.mcp.json` secretless).
