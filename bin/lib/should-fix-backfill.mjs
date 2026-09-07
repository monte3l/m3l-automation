// Pure classification logic for `bin/backfill-should-fix.mjs` — the
// historical-measurement half of the Should-fix acknowledgment gate
// (docs/adr/0097). Split out from the CLI so the classification rules (which
// GitHub/local-git facts turn into which category) are unit-testable against
// synthetic fixtures, mirroring bin/lib/pr-review-gate.mjs's own
// lib/CLI split.
//
// This module answers one question per merged PR: "was this PR's posted
// Should-fix finding — if it had one — ever accounted for?" It reuses
// bin/lib/pr-review-gate.mjs's parsers unchanged rather than re-implementing
// them, so this script can never disagree with the live gate about what
// counts as a finding.
import {
  countReviewComments,
  countShouldFixFindings,
  hasShouldFixAcknowledgment,
  parseShouldFixSection,
  selectShouldFixComment,
} from "./pr-review-gate.mjs";

/** REVIEW.md's Exclusions list (`*.md`, `docs/**`, `.github/dependabot.yml`,
 * `pnpm-lock.yaml`), mirrored here to classify a merged PR's file list
 * offline. Intentionally a small local copy rather than an import — REVIEW.md
 * is prose, not a machine-readable source, and `claude-pr-review.yml`'s own
 * reviewable-file filter (`bin/lib/pr-diff-filter.mjs`) works from a live
 * diff this script never fetches (fetching every historical PR's full patch
 * would be far more GitHub API cost than this backfill needs — the file path
 * list already answers "was this reviewed at all"). */
const REVIEW_EXCLUDED_EXACT = new Set([
  ".github/dependabot.yml",
  "pnpm-lock.yaml",
]);

/**
 * @param {string} path
 * @returns {boolean}
 */
function isReviewExcludedPath(path) {
  return (
    path.endsWith(".md") ||
    path.startsWith("docs/") ||
    REVIEW_EXCLUDED_EXACT.has(path)
  );
}

/**
 * Whether every path in a PR's changed-file list matches REVIEW.md's
 * exclusion rules — i.e. the PR's `review` job never ran, and it structurally
 * cannot have posted a Should-fix finding. `false` for an empty list: no
 * files fetched proves nothing about exclusion, and the caller separately
 * distinguishes "no comments posted" from "excluded" downstream.
 *
 * @param {string[]} paths
 * @returns {boolean}
 */
export function isReviewExcludedFileSet(paths) {
  return paths.length > 0 && paths.every(isReviewExcludedPath);
}

/** Matches the commit-subject convention `resolving-pr-comments` used before
 * ADR-0097's footer existed (`{type}: resolve claude-pr-review findings`, or
 * its must-fix-scoped variant — see SKILL.md:339 and real history, e.g.
 * `fix: resolve claude-pr-review must-fix findings`). Presence is *weak*
 * evidence only: the convention was historically scoped to Must-fix, so a
 * match here does not prove the Should-fix finding was addressed — see
 * {@link classifyPr}'s `resolve-commit-heuristic` category. */
const RESOLVE_COMMIT_RE =
  /^\w+(\([^)]*\))?:\s*resolve claude-pr-review(\s+must-fix)?\s+findings/im;

/**
 * @typedef {object} BackfillPrComment
 * @property {string} login The comment author's login. For the review bot,
 *   this is `"claude"` when sourced from the GraphQL API used by this
 *   backfill — NOT `"claude[bot]"`, the REST API's `user.login` value that
 *   `check-should-fix-ack.mjs` (a REST consumer) matches on. Verified live:
 *   `gh api repos/.../issues/<n>/comments` (REST) returns `"claude[bot]"`
 *   for the same comment GraphQL's `author.login` reports as `"claude"` —
 *   GitHub's GraphQL `Bot` type omits the bracketed suffix REST includes.
 *   See {@link isReviewBotComment}.
 * @property {boolean} isBot Whether `author.__typename` was `"Bot"` in the
 *   GraphQL response — guards against a hypothetical human account also
 *   named "claude" ever being mistaken for the review bot.
 * @property {string} body
 */

/** The review bot's GraphQL login — see {@link BackfillPrComment}'s `login`
 * doc comment for why this differs from `check-should-fix-ack.mjs`'s
 * `"claude[bot]"` REST-API constant despite naming the same account. */
const REVIEW_BOT_GRAPHQL_LOGIN = "claude";

/**
 * @param {BackfillPrComment} comment
 * @returns {boolean}
 */
function isReviewBotComment(comment) {
  return comment.isBot && comment.login === REVIEW_BOT_GRAPHQL_LOGIN;
}

/**
 * @typedef {object} BackfillPrInput
 * @property {number} number
 * @property {string} mergedAt ISO timestamp.
 * @property {string | null} mergedByLogin
 * @property {boolean} autoMergeUsed Whether GitHub's `autoMergeRequest` was
 *   ever set on this PR (non-null in the GraphQL response) — the actual
 *   signal for failure mode (a) from the plan, distinct from a timestamp
 *   heuristic.
 * @property {string} mergeCommitBody Concatenated `git log -1 --format=%B`
 *   of the squash-merge commit — GitHub's default squash message
 *   concatenates every original commit's own message as a `* ...` bullet
 *   (verified against #1082/#1075's own merge commits), so a footer or a
 *   resolve-commit subject on any commit in the branch is visible here even
 *   though the branch itself no longer exists post-merge.
 * @property {boolean} mergeCommitUnreachable `true` when the merge commit
 *   oid could not be read from local history at all (this repo has
 *   undergone at least one history rewrite that orphaned some early merge
 *   commits' original SHAs — see `readMergeCommitBody` in
 *   `bin/backfill-should-fix.mjs`). When true, `mergeCommitBody` is `""` by
 *   construction and a footer/resolve-commit search can only under-report,
 *   never over-report — {@link classifyPr} surfaces this via `uncertain`.
 * @property {string[]} filePaths
 * @property {boolean} filesTruncated Whether GitHub's `files` connection had
 *   more pages than were fetched — when true, exclusion cannot be trusted
 *   (see {@link classifyPr}).
 * @property {BackfillPrComment[]} comments Every issue comment on the PR
 *   (not filtered to `claude[bot]` yet — {@link classifyPr} does that,
 *   matching `check-should-fix-ack.mjs`'s own filter).
 * @property {boolean} commentsTruncated Whether the `comments` connection had
 *   more pages than were fetched.
 */

/**
 * @typedef {object} BackfillPrResult
 * @property {number} number
 * @property {"review-excluded" | "no-review-posted" | "no-should-fix" | "acknowledged-footer" | "resolve-commit-heuristic" | "multi-round-suppressed" | "merged-unresolved"} category
 * @property {number} shouldFixCount Max Should-fix finding count across all
 *   review rounds (0 for every category except the last four).
 * @property {"auto-merge" | "manual" | null} mode `null` for the first three
 *   categories, where merge mode is not the interesting axis.
 * @property {boolean} uncertain `true` when a truncated `files`/`comments`
 *   page means this classification may be wrong in either direction — flagged
 *   for manual spot-check rather than silently trusted.
 */

/**
 * Classify one merged PR's historical Should-fix disposition.
 *
 * Categories, in the order a PR falls through them:
 *
 * - `review-excluded` — every changed file matches REVIEW.md's exclusions;
 *   the `review` job never ran, so there is nothing to measure.
 * - `no-review-posted` — not excluded, but no `claude[bot]` comment parses a
 *   `### Verdict` line (pre-dates the workflow, or it failed/was skipped).
 * - `no-should-fix` — reviewed, and the max-count comment
 *   ({@link selectShouldFixComment}) carries zero Should-fix findings.
 * - `acknowledged-footer` — a Should-fix finding was posted, and the merge
 *   commit body carries an `Acknowledged-Should-Fix:` footer (ADR-0097's own
 *   mechanism — expected on essentially zero pre-ADR-0097 PRs by
 *   construction, since the convention didn't exist yet).
 * - `resolve-commit-heuristic` — no footer, but a commit in the PR matches
 *   the pre-ADR-0097 "resolve claude-pr-review findings" subject convention.
 *   Weak evidence, not proof (see {@link RESOLVE_COMMIT_RE}'s doc comment).
 * - `multi-round-suppressed` — no footer, no resolve-commit match, but more
 *   than one `claude[bot]` review-verdict comment exists. REVIEW.md's
 *   "Re-review convergence" rule suppresses fresh Should-fix bullets on every
 *   round after the first (prose count only), so this script — like the live
 *   gate — cannot tell "silently fixed" from "silently carried forward."
 *   Genuinely **indeterminate**, not resolved; see the plan's own caveat.
 * - `merged-unresolved` — no footer, no resolve-commit match, and exactly one
 *   review round ever occurred. The one category with no ambiguity: round 1
 *   posted findings, nothing after it could have addressed or suppressed
 *   them, and the PR merged anyway.
 *
 * @param {BackfillPrInput} pr
 * @returns {BackfillPrResult}
 */
export function classifyPr(pr) {
  const uncertain = pr.filesTruncated || pr.commentsTruncated;

  if (isReviewExcludedFileSet(pr.filePaths) && !pr.filesTruncated) {
    return {
      number: pr.number,
      category: "review-excluded",
      shouldFixCount: 0,
      mode: null,
      uncertain,
    };
  }

  const claudeBotBodies = pr.comments
    .filter((comment) => isReviewBotComment(comment))
    .map((comment) => comment.body);

  const selected = selectShouldFixComment(claudeBotBodies);
  if (selected === null) {
    return {
      number: pr.number,
      category: "no-review-posted",
      shouldFixCount: 0,
      mode: null,
      uncertain,
    };
  }

  const shouldFixCount = countShouldFixFindings(
    parseShouldFixSection(selected),
  );
  if (shouldFixCount === 0) {
    return {
      number: pr.number,
      category: "no-should-fix",
      shouldFixCount: 0,
      mode: null,
      uncertain,
    };
  }

  const mode = pr.autoMergeUsed ? "auto-merge" : "manual";
  // From here on, a footer/resolve-commit search reads mergeCommitBody — if
  // that body could never be read (see mergeCommitUnreachable's doc comment),
  // a negative result proves nothing, so every branch below is uncertain too.
  const uncertainWithMergeBody =
    uncertain || pr.mergeCommitUnreachable === true;

  if (hasShouldFixAcknowledgment(pr.mergeCommitBody)) {
    return {
      number: pr.number,
      category: "acknowledged-footer",
      shouldFixCount,
      mode,
      uncertain: uncertainWithMergeBody,
    };
  }

  if (RESOLVE_COMMIT_RE.test(pr.mergeCommitBody)) {
    return {
      number: pr.number,
      category: "resolve-commit-heuristic",
      shouldFixCount,
      mode,
      uncertain: uncertainWithMergeBody,
    };
  }

  const rounds = countReviewComments(claudeBotBodies);
  if (rounds > 1) {
    return {
      number: pr.number,
      category: "multi-round-suppressed",
      shouldFixCount,
      mode,
      uncertain: uncertainWithMergeBody,
    };
  }

  return {
    number: pr.number,
    category: "merged-unresolved",
    shouldFixCount,
    mode,
    uncertain: uncertainWithMergeBody,
  };
}

/**
 * Tally a list of {@link BackfillPrResult}s into per-category counts plus a
 * per-category, per-mode breakdown for the four Should-fix-positive
 * categories — the shape the CLI's report renders directly.
 *
 * @param {BackfillPrResult[]} results
 * @returns {{
 *   total: number,
 *   byCategory: Record<string, number>,
 *   modeByCategory: Record<string, { "auto-merge": number, manual: number }>,
 *   uncertainCount: number,
 * }}
 */
export function summarizeResults(results) {
  /** @type {Record<string, number>} */
  const byCategory = {};
  /** @type {Record<string, { "auto-merge": number, manual: number }>} */
  const modeByCategory = {};
  let uncertainCount = 0;

  for (const result of results) {
    byCategory[result.category] = (byCategory[result.category] ?? 0) + 1;
    if (result.mode !== null) {
      const bucket = (modeByCategory[result.category] ??= {
        "auto-merge": 0,
        manual: 0,
      });
      bucket[result.mode] += 1;
    }
    if (result.uncertain) uncertainCount += 1;
  }

  return { total: results.length, byCategory, modeByCategory, uncertainCount };
}
