#!/usr/bin/env node
/**
 * lefthook `pre-push` backstop: refuse to push a commit whose message still
 * carries a harness-injected `Claude-*` trailer (see FORBIDDEN_TRAILER_PATTERN,
 * bin/lib/claude-models.mjs).
 *
 * `commit-msg` (bin/strip-claude-trailers.mjs, then bin/lint-commit.mjs) is
 * the normal chokepoint, but it is bypassable with `git commit --no-verify`.
 * This is the push-time net for exactly that case — it re-scans every
 * OUTGOING commit's full body (not just the subject bin/lint-commit.mjs's
 * own range mode lints) right before the push leaves the machine.
 *
 * Shares its notion of "outgoing" with bin/verify-signed-range.mjs via
 * outgoingCommits() (bin/lib/signed-range.mjs) — both vet only what this push
 * would newly send, never already-published history, so older commits
 * predating this gate are never retroactively blocked. The pure trailer-scan
 * logic itself lives in bin/lib/commit-trailers.mjs, not here, for the same
 * reason bin/verify-signed-range.mjs delegates to bin/lib/signed-range.mjs —
 * this entry script is top-level-only wiring and is never imported by tests.
 *
 * Skipped when `CI` is set, matching bin/verify-signed-range.mjs: CI
 * checkouts don't push to `main` through this local dev backstop.
 */
import process from "node:process";
import { outgoingCommits } from "./lib/signed-range.mjs";
import { commitsWithForbiddenTrailers } from "./lib/commit-trailers.mjs";

if (process.env.CI) {
  process.exit(0);
}

const bad = commitsWithForbiddenTrailers(outgoingCommits());
if (bad.length === 0) {
  process.exit(0);
}

process.stderr.write(`\
✗  pre-push: refusing to push commit(s) with a forbidden Claude-* trailer:
${bad
  .map(
    ({ sha, lines }) =>
      `     ${sha.slice(0, 12)}\n${lines.map((l) => `       ${l.trim()}`).join("\n")}`,
  )
  .join("\n")}

Harness-injected trailers other than Co-Authored-By are not permitted
(bin/lib/claude-models.mjs) — this commit likely bypassed commit-msg with
--no-verify. Fix with an interactive rebase, rewording each flagged commit
to drop the offending line(s), then push again:
  git rebase -i origin/main
`);
process.exit(1);
