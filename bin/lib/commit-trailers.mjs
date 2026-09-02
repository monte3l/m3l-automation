/**
 * Pure helper for bin/check-commit-trailers.mjs (the `pre-push` backstop) —
 * kept out of the entry script itself, mirroring bin/lib/signed-range.mjs's
 * split from bin/verify-signed-range.mjs: the entry script is top-level-only
 * wiring never imported by tests, so any importable logic it needs must live
 * here to stay unit-testable without triggering a live push-check.
 */
import { execFileSync } from "node:child_process";
import { FORBIDDEN_TRAILER_PATTERN } from "./claude-models.mjs";

/**
 * Default git runner; returns stdout as a string. Injectable for tests.
 *
 * @param {string[]} args
 * @returns {string}
 */
function defaultRunGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * The full message body for a commit.
 *
 * @param {string} sha
 * @param {(args: string[]) => string} runGit
 * @returns {string}
 */
function commitBody(sha, runGit) {
  return runGit(["show", "--no-patch", "--format=%B", sha]);
}

/**
 * Find every commit (from `shas`) whose message still contains a line
 * matching {@link FORBIDDEN_TRAILER_PATTERN} — the push-time backstop for a
 * `git commit --no-verify` that skipped bin/strip-claude-trailers.mjs and
 * bin/lint-commit.mjs.
 *
 * @param {string[]} shas
 * @param {(args: string[]) => string} [runGit]
 * @returns {{ sha: string, lines: string[] }[]}
 */
export function commitsWithForbiddenTrailers(shas, runGit = defaultRunGit) {
  const offenders = [];
  for (const sha of shas) {
    const lines = commitBody(sha, runGit)
      .split("\n")
      .filter((line) => FORBIDDEN_TRAILER_PATTERN.test(line));
    if (lines.length > 0) offenders.push({ sha, lines });
  }
  return offenders;
}
