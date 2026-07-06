#!/usr/bin/env node
/**
 * lefthook `pre-push` backstop: refuse to push unsigned/unverified commits.
 *
 * Runs for every local push (agent or human), so it catches pushes the
 * agent-side PreToolUse hook can't see (a human typing `git push`, or a push
 * from another tool). It is bypassable with `git push --no-verify` — that is
 * intentional; the unbypassable layer is GitHub branch protection's "Require
 * signed commits" (docs/contributing/branch-protection.md).
 *
 * It vets only the OUTGOING range (`@{upstream}..HEAD`, falling back to
 * `origin/main`), never already-published history, so a repo with older unsigned
 * commits isn't retroactively blocked from pushing new signed work.
 *
 * Skipped when `CI` is set: CI checkouts don't push to `main` through this
 * local dev backstop, and CI has its own controls.
 */
import process from "node:process";
import { outgoingCommits, unsignedCommits } from "./lib/signed-range.mjs";

if (process.env.CI) {
  process.exit(0);
}

const bad = unsignedCommits(outgoingCommits());
if (bad.length === 0) {
  process.exit(0);
}

process.stderr.write(`\
✗  pre-push: refusing to push unsigned/unverified commit(s):
${bad.map(({ sha, code }) => `     ${sha.slice(0, 12)}  (%G? = ${code})`).join("\n")}

Every commit reaching the remote must be signed (CLAUDE.md § Security). Fix with:
  git config commit.gpgsign true
  git rebase --exec 'git commit --amend --no-edit -S' origin/main
then push again. (Authoritative gate: branch-protection "Require signed commits".)
`);
process.exit(1);
