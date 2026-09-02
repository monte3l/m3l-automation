// Pure decision logic for `.github/workflows/claude-pr-review.yml`'s guard,
// precompute, and Enforce steps — extracted so the gate's own control flow
// is unit tested instead of shipped on inference. Three historical fixes to
// this workflow (#503, #504, #566) shipped without a test harness; two of
// them broke production before being caught, and two PRs (#785, #806) that
// edited this very file merged with a *failing* required check because the
// gate structurally cannot review changes to itself. See
// bin/tests/pr-review-gate.test.ts and docs/research/pr-review-action-tuning.md.
//
// Also covers the loop-economics additions from PR 4 of that same effort:
// parsing the prior round's Must-fix list (`parseMustFixSection`),
// reconstructing a delta patch from GitHub's compare API
// (`buildDeltaPatch`), and counting genuine review rounds among a PR's
// claude[bot] comments (`countReviewComments`) — all feeding the
// guard/precompute steps' scoped re-review and round-bound path.
// `countReviewComments` exists as a pure function (not a bare `jq` filter
// on `.user.login == "claude[bot]"`, which was the first cut) because
// `claude-assistant.yml` responds to any `@claude` mention from any
// commenter with NO actor allowlist, posting as the same `claude[bot]`
// identity on the same PR thread — a login-only filter would let an
// unrelated reply inflate (or, if the round-bound math ever inverted, help
// evade) the round count. Filtering on "parses a `### Verdict` line" scopes
// the count to what the guard step's own PASS/FAIL logic already treats as
// a review, closing that gap without a GitHub-side actor-allowlist change.
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

/** Matches the `### Must-fix` section's body, up to the next `###` heading or
 * the trailing `claude-review-sha` HTML comment (whichever comes first) —
 * mirrors REVIEW.md's Output format section, which the workflow prompt
 * restates verbatim. */
const MUST_FIX_SECTION_RE =
  /###\s*Must-fix\s*\n+([\s\S]*?)(?=\n###\s|\n<!--|$)/i;

/** Matches the placeholder REVIEW.md's Output format section specifies for
 * an empty tier — case-insensitive, tolerant of surrounding whitespace. */
const EMPTY_SECTION_RE = /^_none\._$/i;

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
 * How many of the given `claude[bot]` comment bodies parse as an actual
 * review verdict (contain a `### Verdict` bullet) — used to bound the
 * review-round count so an unrelated `claude[bot]` comment on the same PR
 * thread (e.g. a `claude-assistant.yml` reply to an `@claude` mention from
 * any commenter, which carries no actor allowlist) can never inflate it.
 * Every body is checked independently with {@link parseVerdict}, so this is
 * equivalent to `bodies.filter((b) => parseVerdict(b) !== null).length`
 * spelled out as its own named operation for the guard step's CLI call.
 *
 * @param {string[]} bodies
 * @returns {number}
 */
export function countReviewComments(bodies) {
  return bodies.filter((body) => parseVerdict(body) !== null).length;
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
 * The raw `### Must-fix` section body from a review comment, or `null` when
 * the section is missing or reads the empty-tier placeholder (`_None._`).
 * Used to feed a delta re-review the prior round's outstanding Must-fix
 * items, so the reviewer can confirm each is resolved without re-reading the
 * whole PR — see the "Delta patch on re-review" step in
 * `claude-pr-review.yml`'s guard step.
 *
 * @param {string} body Full PR-comment body.
 * @returns {string | null}
 */
export function parseMustFixSection(body) {
  const match = MUST_FIX_SECTION_RE.exec(body);
  if (match === null) return null;
  const content = match[1].trim();
  if (content === "" || EMPTY_SECTION_RE.test(content)) return null;
  return content;
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

/**
 * @typedef {object} CompareApiFile
 * @property {string} filename
 * @property {string} [previous_filename] Present only when `status` is
 *   `"renamed"`.
 * @property {"added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"} [status]
 * @property {number} [changes] `additions + deletions`; `0` means nothing
 *   textual changed (e.g. a pure rename or a mode-only change).
 * @property {string} [patch] Unified-diff hunks for this file, absent for a
 *   binary file or one over GitHub's per-file patch size cap.
 */

/**
 * @typedef {object} CompareApiResponse
 * @property {CompareApiFile[]} [files]
 */

/** GitHub's documented cap on the compare API's `files[]` array — beyond
 * this many changed files, the response silently omits the rest with no
 * truncation flag to detect it by. A delta whose file count reaches this
 * cap can never be trusted as the complete change set. */
const COMPARE_API_FILE_CAP = 300;

/**
 * Reconstruct a synthetic unified-diff patch from a GitHub compare-API
 * response (`GET /repos/{owner}/{repo}/compare/{base}...{head}`), in the
 * same `diff --git a/x b/x` / `--- a/x` / `+++ b/x` shape
 * `bin/lib/pr-diff-filter.mjs`'s patch-splitting regex expects — so the
 * delta-review path (a scoped compare against the prior PASS's commit,
 * instead of the full PR diff) can reuse that filter and the reviewable-size
 * measurement unmodified. Added/removed files get a `/dev/null` side
 * (matching real diff output); a renamed file's header names both the old
 * and new path.
 *
 * Returns `null` — instead of a patch string — whenever the response cannot
 * be trusted to represent the complete delta:
 * - the file list hits {@link COMPARE_API_FILE_CAP}, or
 * - any file has a confirmed-or-unknown content change (`changes` is a
 *   positive number, or `changes` is missing/non-numeric) but no `patch`
 *   field — GitHub withheld real diff content (binary, or over its
 *   per-file patch size cap) that this function cannot safely paper over
 *   with a placeholder: the reviewer would never see it, and the
 *   reviewable-byte size gate would never catch it either, since the
 *   placeholder is tiny. A placeholder is only ever emitted when `changes`
 *   positively confirms nothing textual changed (`=== 0`).
 *
 * The caller (the precompute step in `claude-pr-review.yml`) falls back to
 * the full, untruncated `gh pr diff` on a `null` return — a delta review is
 * an optimization the gate can always decline, never a requirement it can
 * silently under-deliver.
 *
 * @param {CompareApiResponse} compareResponse Parsed JSON response body.
 * @returns {string | null}
 */
export function buildDeltaPatch(compareResponse) {
  const files = compareResponse.files ?? [];
  if (files.length >= COMPARE_API_FILE_CAP) return null;

  const blocks = [];
  for (const file of files) {
    const oldName =
      file.status === "renamed" && typeof file.previous_filename === "string"
        ? file.previous_filename
        : file.filename;
    const fromPath = file.status === "added" ? "/dev/null" : `a/${oldName}`;
    const toPath =
      file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
    const header = `diff --git a/${oldName} b/${file.filename}\n--- ${fromPath}\n+++ ${toPath}`;

    if (typeof file.patch === "string" && file.patch.length > 0) {
      blocks.push(`${header}\n${file.patch}`);
      continue;
    }
    if (file.changes === 0) {
      blocks.push(
        `${header}\n(diff omitted — GitHub's compare API reported no content change for this file)`,
      );
      continue;
    }
    return null;
  }
  return blocks.join("\n");
}
