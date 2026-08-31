# 0083. Permissions hardening and the managed-settings scope for a single-maintainer repo

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** repo maintainer

## Context and problem statement

An audit against Anthropic's AI-native SDLC playbook found `.claude/settings.json`
carried only `permissions.allow` — no `deny` tier — and three blanket `gh`
globs (`Bash(gh auth *)`, `Bash(gh api *)`, `Bash(gh repo *)`) that matched
far more than any skill actually calls: `gh auth *` reached `gh auth token`
(prints a live OAuth token into the transcript, against this repo's own
Security section), and `gh api *`/`gh repo *` matched any repository's any
endpoint, including mutating calls this repo's skills never issue (branch
protection edits, repo deletion) alongside the reads and the one legitimate
write (`reviewing-dependabot-prs` posts a HOLD/REJECT comment via
`gh api .../issues/{n}/comments --method POST`, itself gated behind that
skill's own human batch-confirmation, not auto-fired).

Separately, the playbook's managed-settings table names controls
(`sandbox.enabled`, `permissions.ask`, `allowManagedPermissionRulesOnly`,
`allowManagedHooksOnly`, `allowManagedMcpServersOnly`,
`requiredMinimumVersion`) this repo uses none of. Each is a real,
`code.claude.com`-documented lever — not adopting them should be a recorded
decision, not a silent gap an audit has to keep rediscovering.

## Decision drivers

- The narrowed permission set must not break a skill's documented, in-use
  command shape — narrowing to "read-only" where a skill's own SKILL.md
  already documents a legitimate write would just move the friction to every
  future session instead of removing risk.
- Managed-settings enforcement (`allowManaged*Only`, `sandbox.enabled`) exists
  to stop a _developer_ from widening policy against an _admin's_ intent —
  this repo has one person in both roles, so the enforcement half of that
  model has no one to enforce against.
- A conscious "not now" is worth recording once; re-litigating the same
  question on every future harness audit is the actual cost being avoided.

## Considered options

1. **Deny-list the specific leak paths, narrow the three `gh` globs to the
   literal repo + endpoint shapes actually called, leave enterprise managed
   settings unused but undocumented.** Closes the concrete leak, but repeats
   the exact "GAP with no context" pattern the audit flagged for `sandbox`/
   `permissions.ask`/`allowManaged*Only`.
2. **The same hardening, plus this ADR recording which managed-settings
   controls are deliberately out of scope and why.** Same runtime change as
   option 1; the ADR is the artifact that turns "nobody enabled sandboxing"
   into "sandboxing was considered and declined for stated reasons, revisit
   if X changes."
3. **Adopt `sandbox.enabled` and `allowManagedPermissionRulesOnly` now
   regardless of single-maintainer status**, on the theory that more
   enforcement is strictly safer. Rejected: `allowManagedPermissionRulesOnly`
   would require a `managed-settings.json` at an OS-level path
   (`/etc/claude-code/` on this Linux/WSL host) that nothing currently
   deploys or maintains — adopting the flag with no managed-settings file
   behind it either does nothing or breaks every existing `permissions.allow`
   entry, and `sandbox.enabled`'s Bash-only boundary (per
   `code.claude.com/docs/en/sandbox-environments`: file tools, MCP servers,
   and hooks all run unconstrained regardless) would not meaningfully close
   the gap this repo's actual risk surface sits in — hook-mediated writes and
   MCP tool calls — while adding real friction (WSL2 `bubblewrap`/`socat`
   dependency, `/sandbox` panel triage) to every session.

## Decision

We chose **option 2**. Implemented in `.claude/settings.json`:

- `permissions.deny` added: `Read(**/.env)`, `Read(**/.env.*)`,
  `Read(**/*.pem)`, `Read(~/.aws/**)`, `Read(~/.ssh/**)` (secret-file reads —
  `guard-secret-writes.mjs` already refuses writing a secret to disk; nothing
  previously stopped reading one already there into context), `Bash(curl)` /
  `Bash(curl *)`, `Bash(wget)` / `Bash(wget *)` (the documented gap: denying
  `WebFetch` alone does nothing while Bash can still reach any URL), and
  `Bash(gh auth token)` / `Bash(gh auth token *)`, `Bash(gh auth refresh)` /
  `Bash(gh auth refresh *)` (the credential-in-transcript leak this audit
  found).
- `gh auth *` narrowed to the one subcommand actually used
  (`Bash(gh auth status)`, already present). `gh repo *` narrowed to
  `Bash(gh repo view *)` (the only subcommand any skill calls — confirmed by
  grep across `.claude/skills/*/SKILL.md` and `docs/contributing/*.md`).
  `gh api *` narrowed to this repository's specific endpoints actually
  called, each still trailing-wildcarded for the flags/query-strings a real
  invocation appends: `code-scanning/alerts*` (`creating-prs`,
  `triaging-scan-alerts`), `issues/*` (`reviewing-dependabot-prs`'s read
  _and_ its one write path — scoped by endpoint and repo, not method, since
  the write is legitimate and already human-gated by that skill),
  `commits/*` and `rulesets*`/`branches/main/protection*` (maintainer-run
  branch-protection triage commands in
  `docs/contributing/branch-protection.md`). This still closes
  the actual blast radius the audit flagged — arbitrary endpoints on
  arbitrary repositories, including this repo's own branch-protection and
  repo-settings mutations — without breaking any documented skill behavior.
- The machine-specific `claudeMdExcludes: ["/home/enri3l/CLAUDE.md"]` moved
  from the checked-in `settings.json` to the untracked `settings.local.json`
  (confirmed not tracked by git: `git ls-files` returns nothing for it),
  where a per-machine path belongs.

Left deliberately unadopted, and why:

- **`sandbox.enabled` / `sandbox.network.allowedDomains`.** Per
  `code.claude.com/docs/en/sandbox-environments`, the Bash sandbox
  constrains only Bash and its children — file tools, MCP servers, and hooks
  run unconstrained regardless, and this repo's actual write surface is
  dominated by Write/Edit (hook-guarded) and MCP tool calls, not raw shell.
  Revisit if a future session model gives Claude broader unattended
  network/Bash autonomy than the current interactive, human-present sessions
  this repo runs today.
- **`permissions.ask`.** No action in this repo's workflow needs a
  human-in-the-loop approval gate distinct from the existing allow/default
  split — the playbook's own "approval-shaped hooks belong at the deploy
  gate, not mid-build" already routes the one place that would matter
  (release/merge) through GitHub branch protection instead.
- **`allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`,
  `allowManagedMcpServersOnly`.** Each requires a `managed-settings.json`
  deployed at an OS/MDM-controlled path outside the repo, administered by
  someone other than the developer being constrained. A single maintainer
  editing their own `.claude/settings.json` has no such second party;
  enabling the flag with nothing behind it is a no-op at best. Revisit if
  this repo ever gains a second regular contributor whose local settings
  should not be able to silently widen policy.
- **`requiredMinimumVersion`.** The repo already depends on newer Claude Code
  features (`if:` hook filters, `SubagentStop`, `SessionStart` with
  `matcher: compact`) that simply no-op on an older client rather than
  erroring — an explicit floor would improve that failure mode, but with one
  maintainer on one continuously-updated client, the gap has never actually
  manifested. Revisit if a second contributor or a CI-invoked `claude`
  binary pins to an older version.

## Consequences

- **Positive:** the `gh auth token` transcript-leak path is closed; the
  blast radius of `gh api`/`gh repo` drops from "any repository, any
  endpoint" to five specific, already-in-use endpoint shapes on this
  repository; a local secret file can no longer be read into context by an
  allow-listed tool call; the managed-settings gap is now a recorded,
  revisitable decision instead of an unexplained absence the next audit
  would flag identically.
- **Negative / trade-offs:** the narrowed `gh api` rules are scoped by
  endpoint and repository, not by HTTP method — `reviewing-dependabot-prs`'s
  legitimate POST-a-comment path stays reachable inside the `issues/*` glob,
  so this is endpoint-narrowing, not a read-only guarantee. `sandbox.enabled`
  and the three `allowManaged*Only` flags remain off; if this repo's
  contributor count or session-autonomy model changes, this ADR is the
  trigger to re-open the sandboxing question rather than start from scratch.
- **Semver impact:** none — `.claude/settings.json`/`.claude/settings.local.json`
  harness configuration only, no public package export touched.

## Links

- Supersedes / superseded by: none
- Related: `docs/contributing/hooks-reference.md` (the hook-layer
  enforcement `sandbox.enabled` would not meaningfully extend), ADR-0016
  (signed-commit branch-protection layer, the actual deploy-gate approval
  mechanism `permissions.ask` was considered and rejected in favor of),
  `code.claude.com/docs/en/sandbox-environments`,
  `code.claude.com/docs/en/admin-setup`
