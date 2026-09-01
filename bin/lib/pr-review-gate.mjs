// Pure decision logic for `.github/workflows/claude-pr-review.yml`'s guard
// and Enforce steps — extracted so the gate's own control flow is unit
// tested instead of shipped on inference. Three historical fixes to this
// workflow (#503, #504, #566) shipped without a test harness; two of them
// broke production before being caught, and two PRs (#785, #806) that
// edited this very file merged with a *failing* required check because the
// gate structurally cannot review changes to itself. See
// bin/tests/pr-review-gate.test.ts and docs/research/pr-review-action-tuning.md.
//
// Mirrors bin/lib/pr-diff-filter.mjs's shape: a pure lib module, consumed by
// a thin CLI wrapper (bin/pr-review-gate.mjs) the workflow shells out to.

/** Matches the `### Verdict` heading's bullet line — `- PASS` or `- FAIL`,
 * immediately after the heading (only blank lines between). Anchored to the
 * bullet form deliberately: a bare word-search over the following lines
 * (the pattern this replaces) matches "PASS" inside a FAIL reason string
 * like `FAIL — this does not pass the export check`, converting a real FAIL
 * into a false PASS. */
const VERDICT_LINE_RE = /###\s*Verdict\s*\n+\s*-\s*(PASS|FAIL)\b/i;

/** Matches every `claude-review-sha` HTML-comment marker in a body, so the
 * caller can take the LAST one — the prompt requires the marker be the
 * comment's final line, so a quoted or restated SHA earlier in the body
 * (e.g. inside a code block discussing a prior round) must never win. */
const REVIEW_SHA_RE = /<!--\s*claude-review-sha:\s*([0-9a-f]+)\s*-->/gi;

/** A verdict-file line the model or a workflow step writes: `PASS`/`FAIL`,
 * optionally followed by whitespace and a commit SHA. */
const VERDICT_FILE_RE = /^(PASS|FAIL)(?:\s+([0-9a-f]{7,40}))?$/i;

/**
 * The verdict (`PASS`/`FAIL`) stated under a review comment's `### Verdict`
 * heading, or `null` if no parseable verdict line exists.
 *
 * @param {string} body Full PR-comment body.
 * @returns {"PASS" | "FAIL" | null}
 */
export function parseVerdict(body) {
  const match = VERDICT_LINE_RE.exec(body);
  return match ? /** @type {"PASS" | "FAIL"} */ (match[1].toUpperCase()) : null;
}

/**
 * The `claude-review-sha` marker's value — the LAST occurrence in `body`, or
 * `null` if none is present.
 *
 * @param {string} body Full PR-comment body.
 * @returns {string | null}
 */
export function parseReviewedSha(body) {
  const matches = [...body.matchAll(REVIEW_SHA_RE)];
  return matches.length === 0 ? null : matches[matches.length - 1][1];
}

/**
 * @typedef {object} WorkflowGateChangeStatus
 * @property {boolean} includesWorkflowFile Whether the reviewable-file list
 *   contains `.github/workflows/claude-pr-review.yml`.
 * @property {string[]} otherReviewableFiles Every other reviewable file in
 *   the list, in input order — non-empty exactly when a PR mixes a change to
 *   the gate itself with other reviewable content.
 */

/** Repo-relative path of the review-gate workflow itself. */
export const REVIEW_GATE_WORKFLOW_PATH =
  ".github/workflows/claude-pr-review.yml";

/**
 * Whether a reviewable-file list includes the review-gate workflow, and what
 * else (if anything) is in the same list. GitHub withholds the OIDC token
 * `claude-code-action` needs whenever the *running* workflow file differs
 * from `main`'s copy, so a PR touching this file can never get a live
 * review of ANY of its reviewable content, not just the workflow diff — the
 * caller uses `otherReviewableFiles` to say so explicitly on such a PR
 * rather than silently auto-passing unreviewed files.
 *
 * @param {string[]} reviewableFiles Reviewable paths (already filtered by
 *   `bin/lib/pr-diff-filter.mjs`), in input order.
 * @returns {WorkflowGateChangeStatus}
 */
export function describeWorkflowGateChange(reviewableFiles) {
  const otherReviewableFiles = reviewableFiles.filter(
    (path) => path !== REVIEW_GATE_WORKFLOW_PATH,
  );
  return {
    includesWorkflowFile:
      otherReviewableFiles.length !== reviewableFiles.length,
    otherReviewableFiles,
  };
}

/**
 * @typedef {object} ParsedVerdictFile
 * @property {"PASS" | "FAIL" | null} verdict `null` when unparseable.
 * @property {string | null} sha The commit SHA stamped alongside the
 *   verdict, or `null` when the file carries none (the reject step, the
 *   auto-pass step, and the prior-PASS carry-forward step all write a bare
 *   verdict with no per-commit SHA — see {@link resolveVerdict}).
 */

/**
 * Parse a verdict-file's raw content into its verdict and optional SHA.
 *
 * @param {string} raw Raw file content.
 * @returns {ParsedVerdictFile}
 */
export function parseVerdictFile(raw) {
  const trimmed = raw.trim();
  const match = VERDICT_FILE_RE.exec(trimmed);
  if (match === null) return { verdict: null, sha: null };
  return {
    verdict: /** @type {"PASS" | "FAIL"} */ (match[1].toUpperCase()),
    sha: match[2] ?? null,
  };
}

/**
 * @typedef {object} ResolvedVerdict
 * @property {"PASS" | "FAIL" | null} verdict `null` when no trustworthy
 *   verdict could be established — the caller must fail closed.
 * @property {string} reason Human-readable explanation, for the workflow log.
 */

/**
 * The Enforce step's primary-path decision: is `fileContent` a verdict this
 * commit may trust?
 *
 * A verdict carrying a SHA (the model's own write) must match `headSha` or
 * it is rejected outright — this is what closes the gap where a stale
 * verdict file (left over from an earlier commit, or written by a step that
 * ran under different `if:` conditions than intended) was previously
 * indistinguishable from a fresh one at enforcement time. A verdict with no
 * SHA is trusted unconditionally: it can only have been written by the
 * reject step, the auto-pass step, or the prior-PASS carry-forward step —
 * all three are workflow-authored for the commit under test, with no
 * per-commit provenance to check.
 *
 * @param {string} fileContent Raw `.claude-review-verdict` content, or the
 *   empty string when the file is missing.
 * @param {string} headSha The commit SHA under test.
 * @returns {ResolvedVerdict}
 */
export function resolveVerdict(fileContent, headSha) {
  if (fileContent.trim() === "") {
    return { verdict: null, reason: "Verdict file is missing or empty." };
  }

  const { verdict, sha } = parseVerdictFile(fileContent);
  if (verdict === null) {
    return {
      verdict: null,
      reason: `Verdict file content is unparseable: ${JSON.stringify(fileContent.trim())}`,
    };
  }

  if (sha !== null && sha !== headSha) {
    return {
      verdict: null,
      reason: `Verdict file is stamped for ${sha}, not the commit under test (${headSha}) — stale, discarding.`,
    };
  }

  return {
    verdict,
    reason:
      sha === null
        ? `${verdict} (unstamped — workflow-authored, trusted for this commit).`
        : `${verdict} (stamped for ${sha}, matches head).`,
  };
}
