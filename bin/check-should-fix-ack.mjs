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
 * Binds each review round's Should-fix findings to that round's OWN
 * commit range (`<round's reviewed sha>..<head>`), not one presence test
 * over the PR's whole `<base>..<head>` range
 * (`bin/lib/pr-review-gate.mjs`'s `collectShouldFixRounds`/
 * `planShouldFixAckRanges`/`describeShouldFixAckOutcome`). The original
 * design read only `selectShouldFixComment`'s single "loudest" comment
 * against the whole-PR range — live on PR #1190, a footer answering round
 * 1's two findings was found to silently satisfy round 2's two unrelated,
 * later findings (issue #1193): the gate reported "acknowledged" while real,
 * current findings sat unaddressed. Per-round scoping closes that: an
 * earlier round's footer can no longer satisfy a later round's findings,
 * because it necessarily predates the commit that raised them.
 *
 * A forced consequence: the round that JUST posted a finding has its own
 * reviewed commit as `head`, so its range is empty and it fails this very
 * run — no commit yet exists that could carry the footer. This is correct,
 * not a bug (an acknowledgment cannot predate the finding it acknowledges);
 * it passes once a commit carrying the footer is pushed and the gate
 * re-runs on the new head.
 *
 * PR-only — needs the PR number/repo (to fetch its posted review comments
 * via `gh api`) and the base/head commits (`base` is the fallback range's
 * floor when a round's reviewed commit can't be trusted as an ancestor of
 * `head`; mirrors `check-exports-semver.mjs`'s `--base`/`--head` shape):
 *
 *   node bin/check-should-fix-ack.mjs --repo <owner/repo> --pr <number> --base <sha> --head <sha>
 *
 * Exit codes:
 *   0  No Should-fix findings ever posted, or every round that posted one
 *      is acknowledged in its own post-review commit range.
 *   1  Some round's Should-fix findings are unacknowledged in its range —
 *      or the comment thread/commit range could not be resolved at all
 *      (fails closed, same policy as `resolveVerdict`'s "no trustworthy
 *      verdict" case: an infrastructure failure here must never read as a
 *      silent pass).
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  collectShouldFixRounds,
  describeShouldFixAckOutcome,
  hasShouldFixAcknowledgment,
  planShouldFixAckRanges,
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
 * `collectShouldFixRounds`'s round-ordinal and same-sha dedup both assume).
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
 * function does not close that gap itself — `collectShouldFixRounds`'s
 * `parseVerdict(body) !== null` filter is what excludes a non-review reply
 * downstream, the same way `countReviewComments` does. A spoofed reply that
 * happened to contain a parseable `### Verdict` block could only ever ADD a
 * spurious round (never remove or merge into a real one, since the dedup
 * key is the reviewed sha, which a spoofed reply is unlikely to share with a
 * real round), so it cannot be used to bypass this gate — only to pollute
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

/**
 * Classify a review round's reviewed commit against `head`: `"usable"` when
 * it exists in this checkout AND is an ancestor of `head` (the un-rebased
 * common case); `"missing"` when the object is absent entirely
 * (force-pushed away, or never fetched); `"unreachable"` when it exists but
 * is NOT an ancestor — the branch was rebased or amended since that review
 * (PR #1190's round-1 reviewed commit, after that PR's mid-review rebase, is
 * exactly this case: present locally, orphaned from `main`).
 *
 * Two separate git calls, not one, because the two failure modes need
 * different remediation text ({@link import("./lib/pr-review-gate.mjs").planShouldFixAckRanges}'s
 * degradation message) even though both degrade identically to the full
 * `base..head` range: `git cat-file -e` alone cannot tell "gone" from
 * "present but orphaned", and `git log <sha>..<head>` on an orphaned sha
 * does not error — it silently returns everything reachable from `head`
 * minus that sha's ancestors, which can sweep in an unrelated PR's own
 * footer and reopen the exact vacuous-pass bug this gate exists to close.
 *
 * @param {string} sha
 * @param {string} head
 * @returns {import("./lib/pr-review-gate.mjs").ReviewedShaStatus}
 */
function classifyReviewedSha(sha, head) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return "missing";
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, head], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "usable";
  } catch {
    return "unreachable";
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function readCommitLog(from, to) {
  return execFileSync("git", ["log", "--format=%B", `${from}..${to}`], {
    cwd: root,
    encoding: "utf8",
  });
}

/**
 * The gate's testable core: no `gh`/`git` calls of its own, only the
 * injected `classifySha`/`readCommitLog` seams — so the regression this
 * fixes (a footer answering one round silently satisfying another's later,
 * unrelated findings) can be pinned with fixture data and no network or real
 * git repo, per `.claude/rules/tests.md`'s no-network/no-real-fs rule for
 * unit tests. The main block below wires the real git-backed
 * implementations.
 *
 * @param {object} deps
 * @param {string[]} deps.bodies Every `claude[bot]` comment body on the PR,
 *   oldest first.
 * @param {string} deps.base
 * @param {string} deps.head
 * @param {(sha: string, head: string) => import("./lib/pr-review-gate.mjs").ReviewedShaStatus} deps.classifySha
 * @param {(from: string, to: string) => string} deps.readCommitLog
 * @returns {{ ok: boolean, messages: string[], warnings: string[], summary: string }}
 */
export function evaluateShouldFixAck({
  bodies,
  base,
  head,
  classifySha,
  readCommitLog: readLog,
}) {
  const rounds = collectShouldFixRounds(bodies);
  if (rounds.length === 0) {
    return {
      ok: true,
      messages: [],
      warnings: [],
      summary: "No Should-fix findings ever posted — nothing to acknowledge.",
    };
  }

  /** @type {Record<string, import("./lib/pr-review-gate.mjs").ReviewedShaStatus>} */
  const shaStatus = {};
  for (const round of rounds) {
    if (round.sha !== null && !(round.sha in shaStatus)) {
      shaStatus[round.sha] = classifySha(round.sha, head);
    }
  }

  const plans = planShouldFixAckRanges(rounds, { base, head, shaStatus });
  const evaluations = plans.map((plan) => ({
    ...plan,
    acknowledged: plan.empty
      ? false
      : hasShouldFixAcknowledgment(readLog(plan.from, plan.to)),
  }));

  const outcome = describeShouldFixAckOutcome(evaluations);
  const warnings = outcome.degraded.map(
    (evaluation) =>
      `${evaluation.degradeReason} — falling back to the full ` +
      `${evaluation.from}..${evaluation.to} range for round ${evaluation.round.round}. ` +
      "A footer from ANY round can now satisfy it; this is a deliberate " +
      "widening, not a guarantee the finding was handled.",
  );
  return {
    ok: outcome.ok,
    messages: outcome.messages,
    warnings,
    summary: outcome.summary,
  };
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
    const result = evaluateShouldFixAck({
      bodies,
      base,
      head,
      classifySha: classifyReviewedSha,
      readCommitLog,
    });

    for (const warning of result.warnings) reporter.warn(warning);

    if (result.ok) {
      reporter.succeed(result.summary);
      reporter.finish();
      process.exit(0);
    }

    for (const message of result.messages) reporter.error(message);
    // NOTE for a future reader confused why fixing the code alone didn't
    // clear this: a re-review's suppressed Should-fix section (REVIEW.md's
    // "Re-review convergence" rule) can never prove a fix to this gate on
    // its own, so the footer is how a fix, a deferral, or a dispute gets
    // RECORDED — the gate only checks that a decision was made and written
    // down, not which one. And it must be recorded per round: an earlier
    // round's footer no longer satisfies a later round's findings, because
    // it necessarily predates the commit that raised them (issue #1193).
    reporter.error(
      "Whatever you decide for each round above — fix it, defer it, or " +
        "dispute it as wrong — add an `Acknowledged-Should-Fix: <reason>` " +
        "footer to a commit pushed AFTER that round's reviewed commit. See " +
        "REVIEW.md's Should-fix tier.",
    );
    reporter.finish();
    process.exit(1);
  } catch (error) {
    reporter.error(error instanceof Error ? error.message : String(error));
    reporter.finish();
    process.exit(1);
  }
}
