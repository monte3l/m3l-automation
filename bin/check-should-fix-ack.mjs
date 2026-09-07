#!/usr/bin/env node
/**
 * Enforces that a PR whose posted `claude-pr-review.yml` review carries a
 * Should-fix finding either has it acknowledged via an
 * `Acknowledged-Should-Fix:` commit-footer trailer, or has no unresolved
 * Should-fix finding at all. REVIEW.md defines Should-fix as "a real quality
 * issue that does not block merge on its own" and, before this gate, no
 * check in the repo read that tier at all: `bin/lib/pr-review-gate.mjs` had
 * `parseMustFixSection` with no Should-fix counterpart, and
 * `check:review-policy` only asserted the `### Should-fix` heading string
 * appears in the workflow prompt (parity, not enforcement). Should-fix may
 * still merge unfixed under this gate — it just may never merge silently
 * unacknowledged.
 *
 * Picks the review comment carrying the MAX Should-fix finding count across
 * the PR's whole comment history (`selectShouldFixComment`), not just the
 * most recently posted one — REVIEW.md's "Re-review convergence" rule
 * instructs the reviewer to suppress new Should-fix bullets on any round
 * after the first, reporting only a count in the summary line. Reading only
 * the latest comment would silently stop enforcing acknowledgment the
 * moment a PR reaches a second review round; see that function's JSDoc in
 * bin/lib/pr-review-gate.mjs for the full reasoning.
 *
 * PR-only — needs the PR number/repo (to fetch its posted review comments
 * via `gh api`) and the base/head commits (to read the PR's full commit
 * range for an acknowledgment footer, mirroring `check-exports-semver.mjs`'s
 * `--base`/`--head` shape and its own `git log --format=%B base..head` read):
 *
 *   node bin/check-should-fix-ack.mjs --repo <owner/repo> --pr <number> --base <sha> --head <sha>
 *
 * Exit codes:
 *   0  No Should-fix findings ever posted, or the ones that exist are
 *      acknowledged.
 *   1  Unresolved, unacknowledged Should-fix findings — or the comment
 *      thread/commit range could not be resolved at all (fails closed, same
 *      policy as `resolveVerdict`'s "no trustworthy verdict" case: an
 *      infrastructure failure here must never read as a silent pass).
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  countShouldFixFindings,
  hasShouldFixAcknowledgment,
  parseShouldFixSection,
  selectShouldFixComment,
} from "./lib/pr-review-gate.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

/**
 * Read `--repo`/`--pr`/`--base`/`--head` from an argv array. Mirrors
 * `check-exports-semver.mjs`'s `parseArgs` shape.
 *
 * @param {string[]} argv
 * @returns {{ repo: string | undefined, pr: string | undefined, base: string | undefined, head: string | undefined }}
 */
export function parseArgs(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    repo: at("--repo"),
    pr: at("--pr"),
    base: at("--base"),
    head: at("--head"),
  };
}

/**
 * Fetch every issue-comment body on a PR authored by `claude[bot]`, in
 * posting order (oldest first — GitHub's default, and what
 * `selectShouldFixComment`'s tie-break assumes).
 *
 * `gh api ... --paginate` on an array-returning endpoint concatenates every
 * page into a single flat JSON array (verified live against a real PR) —
 * no `--slurp` needed here, unlike the workflow's own guard/Enforce steps,
 * which pipe to an external `jq add` for a different reason (combining
 * `--slurp`'s per-page arrays before a single `jq` filter, since `gh`
 * rejects `--slurp` together with its own `--jq` flag).
 *
 * The `login === "claude[bot]"` filter alone is the same ambiguous signal
 * `countReviewComments`'s own JSDoc (bin/lib/pr-review-gate.mjs) documents:
 * `claude-assistant.yml` replies to any `@claude` mention from any
 * commenter under that identical login, with no actor allowlist. This
 * function does not close that gap itself — `selectShouldFixComment`'s
 * `parseVerdict(body) !== null` filter is what excludes a non-review reply
 * downstream, the same way `countReviewComments` does. A spoofed reply that
 * happened to contain a parseable `### Verdict` block could only ever
 * inflate the selected finding count (never deflate it, since selection is
 * max-based), so it cannot be used to bypass this gate — only to pollute
 * the findings text quoted in a failure message.
 *
 * @param {string} repo `owner/repo`
 * @param {string} pr PR number, as a string
 * @returns {string[]}
 */
function fetchClaudeBotCommentBodies(repo, pr) {
  const raw = execFileSync(
    "gh",
    ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"],
    { cwd: root, encoding: "utf8" },
  );
  const comments = JSON.parse(raw);
  return comments
    .filter((comment) => comment.user?.login === "claude[bot]")
    .map((comment) => comment.body ?? "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);
  const { repo, pr, base, head } = parseArgs(argv);
  if (!repo || !pr || !base || !head) {
    reporter.error(
      "Usage: check-should-fix-ack.mjs --repo <owner/repo> --pr <number> --base <sha> --head <sha>",
    );
    reporter.finish();
    process.exit(1);
  }

  try {
    const bodies = fetchClaudeBotCommentBodies(repo, pr);
    const selected = selectShouldFixComment(bodies);
    const section =
      selected === null ? null : parseShouldFixSection(selected);
    const count = countShouldFixFindings(section);

    if (count === 0) {
      reporter.succeed(
        "No unresolved Should-fix findings — nothing to acknowledge.",
      );
      reporter.finish();
      process.exit(0);
    }

    const commitLog = execFileSync(
      "git",
      ["log", "--format=%B", `${base}..${head}`],
      { cwd: root, encoding: "utf8" },
    );

    if (hasShouldFixAcknowledgment(commitLog)) {
      reporter.succeed(
        `${count} Should-fix finding(s) present and acknowledged via an ` +
          "Acknowledged-Should-Fix: commit footer.",
      );
      reporter.finish();
      process.exit(0);
    }

    // NOTE for a future reader confused why fixing the code alone didn't
    // clear this: REVIEW.md's "Re-review convergence" rule suppresses
    // Should-fix bullets on every round after the first, reporting only a
    // free-text count in the summary line — never a parseable,
    // freshly-recomputed bullet list. selectShouldFixComment therefore
    // can't distinguish "still outstanding, just suppressed" from
    // "genuinely fixed, round 2 correctly says so" — it always keeps round
    // 1's max count. Fixing the code is still the right response when the
    // finding is real; the footer is how that response gets RECORDED, since
    // no re-review this gate can see proves the fix on its own. The footer
    // is one required record covering three different underlying
    // decisions — fixed, deliberately deferred, or disputed as wrong — the
    // gate only checks that a decision was made and written down, not which
    // one.
    reporter.error(
      `${count} Should-fix finding(s) from the review have no ` +
        `Acknowledged-Should-Fix: commit footer:\n\n${section}\n\nWhatever ` +
        "you decide — fix it, defer it, or dispute it as wrong — add an " +
        "`Acknowledged-Should-Fix: <reason>` footer to a commit in this PR " +
        "recording that decision; a re-review's suppressed Should-fix " +
        "section can't prove a fix on its own, so this gate needs the " +
        "footer either way. See REVIEW.md's Should-fix tier.",
    );
    reporter.finish();
    process.exit(1);
  } catch (error) {
    reporter.error(error instanceof Error ? error.message : String(error));
    reporter.finish();
    process.exit(1);
  }
}
