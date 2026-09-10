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
 * issue the moment ANY one watched workflow recovers would be wrong if
 * ANOTHER is still red (e.g. CI failed, Pages then independently succeeds);
 * {@link otherWatchedWorkflows} and {@link decideSuccessAction} exist to
 * check every other workflow's own latest state before closing.
 */
export const WATCHED_WORKFLOWS = ["CI", "Pages", "Skill Evals"];

/**
 * Every watched workflow other than `workflow` — one fewer than
 * {@link WATCHED_WORKFLOWS}'s full length, so this is always well-defined
 * for a genuine `workflow_run` payload naming one of the watched workflows.
 *
 * @param {string} workflow
 * @returns {string[]}
 */
export function otherWatchedWorkflows(workflow) {
  const others = WATCHED_WORKFLOWS.filter((name) => name !== workflow);
  if (others.length !== WATCHED_WORKFLOWS.length - 1) {
    throw new Error(
      `"${workflow}" is not exactly one of the watched workflows (${WATCHED_WORKFLOWS.join(", ")}).`,
    );
  }
  return others;
}

/**
 * Whether the tracking issue should close now that `workflow` has passed,
 * given every OTHER watched workflow's own most recent completed conclusion
 * on `main` (`null` for one with no run history at all — e.g. a repo where
 * it has never run — treated as "nothing else known to be red"). Closes
 * only when every other watched workflow is either unknown or green.
 *
 * @param {(string | null)[]} otherConclusions
 * @returns {"close" | "stay-open"}
 */
export function decideSuccessAction(otherConclusions) {
  return otherConclusions.every(
    (conclusion) => conclusion === null || conclusion === "success",
  )
    ? "close"
    : "stay-open";
}

/**
 * @typedef {Object} MainHealthOccurrence
 * @property {string} workflow - the failing/recovering workflow's display name (one of {@link WATCHED_WORKFLOWS})
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
      "run of every watched workflow on `main` succeeds.",
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
 * The comment posted when `workflow` recovers but the tracking issue stays
 * open because one or more OTHER watched workflows are still red.
 *
 * @param {MainHealthOccurrence & { stillRed: string[] }} occurrence
 * @returns {string}
 */
export function buildPartialResolutionComment({
  workflow,
  stillRed,
  runUrl,
  sha,
  occurredAt,
}) {
  const redList = stillRed.map((name) => `**${name}**`).join(", ");
  const verb = stillRed.length === 1 ? "is" : "are";
  return [
    `**${workflow}** passed on \`main\` at commit \`${sha}\`, but ${redList} ${verb} still red — leaving this open.`,
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
