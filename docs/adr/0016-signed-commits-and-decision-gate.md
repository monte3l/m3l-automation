# 0016. Signed-commit enforcement and the pre-work decision gate

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Enrico Lionello

## Context and problem statement

A governance audit of the worktree/commit/push workflow surfaced two gaps:

- **No commit-signing enforcement anywhere.** `lefthook` `pre-push` ran quality
  gates only; CI never verified signatures; and `docs/contributing/branch-protection.md`
  omitted GitHub's "Require signed commits" toggle. A signing key existed in local
  config but nothing required or verified signed commits reaching the remote — the
  commit side of the supply chain was unattested even though npm publish already
  emits provenance (ADR-0011).
- **Isolation was enforced only reactively, and the "where do I work?" decision
  was scattered.** `guard-branch-isolation.mjs` blocked `src/`/`tests/` writes on
  `main`, but only at write time, only for the literal branch `main` (a detached
  HEAD on the `main` commit slipped through), and nothing decided branch / PR /
  push _before_ work began. The logic was re-derived in four places
  (`guard-branch-isolation`, `implement-submodule` Step 0, `audit`, `create-pr`).

## Decision drivers

- Forbid unsigned/unverified commits from reaching the remote, with the block at
  the point that actually holds.
- Prefer in-repo, deterministic enforcement (hooks) consistent with the existing
  `.claude/settings.json` hook architecture and `check:agents`-style validators.
- Don't wedge legitimate flows: the maintainer pushes tooling changes directly
  (branch-protection bypass), and release automation creates its own commits.
- Single source of truth for the isolation decision; make it up front, not
  reactive.

## Decision

**Signed commits — three layers, branch protection authoritative:**

1. `guard-git-push-signed.mjs` — the repo's first `Bash`-matcher PreToolUse hook.
   Parses a `git push` command and blocks (exit 2) when any outgoing commit's
   `%G?` is not `G`/`U`. Agent-side early catch; fail-open on anything it can't
   classify.
2. `bin/verify-signed-range.mjs` on `lefthook` `pre-push` — covers every local
   push (agent or human). Vets only the outgoing range (`@{upstream}..HEAD`,
   falling back to `origin/main`), so old unsigned history isn't retroactively
   blocked. Skipped when `CI` is set so release automation isn't wedged;
   bypassable with `--no-verify` — deliberately, because layer 3 is the hard gate.
3. GitHub branch protection **"Require signed commits"** — authoritative and
   unbypassable, catches every path. Documented in `branch-protection.md` with the
   release-automation caveat (the release commit must be signed). Resolved by
   running semantic-release under a **Monte3L Release Bot** GitHub App token and
   using `@semantic-release-extras/verified-git-commit` — which creates the
   changelog commit over the GitHub API, so GitHub auto-signs it (Verified) and
   the App, being in the `main` push-restrictions allowlist, is authorized to
   push it. See `release.yml` and `.releaserc.json`.

The shared verification logic lives in `bin/lib/signed-range.mjs` (unit-tested),
so the hook and the pre-push script agree on what "signed" means — mirroring how
`bin/lib/worktree-include.mjs` is shared.

**Decision gate:**

- `inject-decision-gate.mjs` — the repo's first `UserPromptSubmit` hook and the
  first to _inject_ context (`additionalContext`) rather than only stderr. On a
  change-intent prompt it surfaces the four decisions (location / branch / PR /
  push). Advisory; never blocks.
- The `/start-work` skill formalizes those four decisions and is now the Step 0
  that `implement-submodule`, `new-submodule`, `new-script`, and `audit` defer to.
- `guard-branch-isolation.mjs` hardened to also block a **detached HEAD on the
  `main` commit**, and refactored to export unit-tested predicates.

**Validator:** `check:hooks` (`bin/check-hooks.mjs`, wired into CI) — the hook-side
analogue of `check:agents`: every `settings.json` hook command resolves to a real
`.claude/hooks/*.mjs`, and unwired hook files are flagged.

We deliberately did **not** add a hard "refuse direct push to `main`" pre-push
block: the maintainer legitimately pushes tooling changes directly, and branch
protection already enforces the PR path for non-bypassers. The PR-for-`src/`
policy stays as guidance (CLAUDE.md, the decision gate).

## Consequences

- **Positive:** unsigned commits are caught at three escalating layers; the
  isolation decision is made once, up front; the detached-HEAD bypass is closed;
  new hooks have a CI safety net.
- **Negative / trade-offs:** enabling branch-protection "Require signed commits"
  requires the release bot to sign its commits first (caveat documented); the
  agent-side and pre-push layers are bypassable by design; one more `check:*`
  script and two new hooks to maintain.
- **Semver impact:** none — repo tooling, hooks, and docs only; no change to
  `packages/m3l-common/src/**` or the `exports` map. Lands as `chore:` (not
  `feat:`) so it does not trigger a library release.

## Links

- Extends ADR-0011 (release & publishing — provenance) on the commit side, and
  ADR-0013/0014 (worktrees) by centralizing the isolation decision.
- Related: `.claude/hooks/guard-git-push-signed.mjs`,
  `.claude/hooks/inject-decision-gate.mjs`, `.claude/hooks/guard-branch-isolation.mjs`,
  `bin/lib/signed-range.mjs`, `bin/verify-signed-range.mjs`, `bin/check-hooks.mjs`,
  `.claude/skills/start-work/SKILL.md`, `docs/contributing/branch-protection.md`.
