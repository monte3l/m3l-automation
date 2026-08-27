// Pure message-building for the single "main is red" tracking issue
// .github/workflows/main-health.yml maintains. Split out of
// bin/notify-main-health.mjs (the I/O wrapper) so the actual content this
// gate produces is unit-testable against synthetic occurrences, matching
// this repo's own rule for bin/ checkers — test against synthetic state,
// not just "did it run against the live repo today."
//
// One issue, exact-title-matched, updated in place (a comment per new
// failure, a closing comment + close on the first subsequent success) —
// never a fresh issue per failure, so a red main cannot become a flood of
// duplicate issues.

/**
 * The exact, stable title used both to search for an existing tracking
 * issue and to create a new one. Never changes — a rename here orphans
 * whatever issue is currently open under the old title, since the search
 * is an exact-string match, not a label or a hidden marker.
 */
export const MAIN_HEALTH_ISSUE_TITLE = "🔴 main is red";

/**
 * The exact set of workflows main-health.yml watches — must match that
 * file's own `on: workflow_run: workflows:` list. Closing the tracking
 * issue the moment ANY one watched workflow recovers would be wrong if the
 * OTHER is still red (e.g. CI failed, Pages then independently succeeds);
 * {@link otherWatchedWorkflow} and {@link decideSuccessAction} exist to
 * check the other workflow's own latest state before closing.
 */
export const WATCHED_WORKFLOWS = ["CI", "Pages"];

/**
 * The watched workflow other than `workflow` — there are exactly two, so
 * this is always well-defined for a genuine `workflow_run` payload.
 *
 * @param {string} workflow
 * @returns {string}
 */
export function otherWatchedWorkflow(workflow) {
  const others = WATCHED_WORKFLOWS.filter((name) => name !== workflow);
  if (others.length !== 1) {
    throw new Error(
      `"${workflow}" is not exactly one of the watched workflows (${WATCHED_WORKFLOWS.join(", ")}).`,
    );
  }
  return others[0];
}

/**
 * Whether the tracking issue should close now that `workflow` has passed,
 * given the OTHER watched workflow's own most recent completed conclusion
 * on `main` (`null` when it has no run history at all — e.g. a repo where
 * only one of the two has ever run — treated as "nothing else known to be
 * red", so closing is still correct).
 *
 * @param {string | null} otherConclusion
 * @returns {"close" | "stay-open"}
 */
export function decideSuccessAction(otherConclusion) {
  return otherConclusion === null || otherConclusion === "success"
    ? "close"
    : "stay-open";
}

/**
 * @typedef {Object} MainHealthOccurrence
 * @property {string} workflow - the failing/recovering workflow's display name ("CI" or "Pages")
 * @property {string} runUrl - the workflow run's html_url
 * @property {string} sha - the run's head_sha
 * @property {string} occurredAt - an ISO-8601 timestamp
 */

/**
 * The body for a brand-new tracking issue, opened on the first failure.
 *
 * @param {MainHealthOccurrence} occurrence
 * @returns {string}
 */
export function buildFailureIssueBody({ workflow, runUrl, sha, occurredAt }) {
  return [
    `**${workflow}** failed on \`main\` at commit \`${sha}\`.`,
    "",
    `Run: ${runUrl}`,
    `Occurred: ${occurredAt}`,
    "",
    "This issue is opened, updated, and closed automatically by " +
      "`.github/workflows/main-health.yml` — do not edit the title, or " +
      "the tracker loses this issue. It stays open until a subsequent " +
      "CI or Pages run on `main` succeeds.",
  ].join("\n");
}

/**
 * A comment noting a further failure while the tracking issue is already
 * open — never a second issue.
 *
 * @param {MainHealthOccurrence} occurrence
 * @returns {string}
 */
export function buildFailureComment({ workflow, runUrl, sha, occurredAt }) {
  return [
    `**${workflow}** failed again on \`main\` at commit \`${sha}\`.`,
    "",
    `Run: ${runUrl}`,
    `Occurred: ${occurredAt}`,
  ].join("\n");
}

/**
 * The comment posted immediately before closing the tracking issue, on the
 * first subsequent success.
 *
 * @param {MainHealthOccurrence} occurrence
 * @returns {string}
 */
export function buildResolutionComment({ workflow, runUrl, sha, occurredAt }) {
  return [
    `**${workflow}** passed on \`main\` at commit \`${sha}\` — closing.`,
    "",
    `Run: ${runUrl}`,
    `Occurred: ${occurredAt}`,
  ].join("\n");
}

/**
 * The comment posted when `workflow` recovers but the tracking issue
 * stays open because `other` — the other watched workflow — is still red.
 *
 * @param {MainHealthOccurrence & { other: string }} occurrence
 * @returns {string}
 */
export function buildPartialResolutionComment({
  workflow,
  other,
  runUrl,
  sha,
  occurredAt,
}) {
  return [
    `**${workflow}** passed on \`main\` at commit \`${sha}\`, but **${other}** is still red — leaving this open.`,
    "",
    `Run: ${runUrl}`,
    `Occurred: ${occurredAt}`,
  ].join("\n");
}

/**
 * Find the open tracking issue, if any, among a `gh issue list` JSON
 * response — an EXACT title match, since `gh issue list --search` performs
 * a fuzzy text search that can also return issues merely mentioning the
 * title string.
 *
 * @param {{ number: number, title: string }[]} issues
 * @returns {{ number: number, title: string } | null}
 */
export function findTrackingIssue(issues) {
  return (
    issues.find((issue) => issue.title === MAIN_HEALTH_ISSUE_TITLE) ?? null
  );
}
