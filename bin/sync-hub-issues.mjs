#!/usr/bin/env node
// One-way sync: tracker markdown (docs/ROADMAP.md, docs/plans/IMPLEMENTATION.md)
// -> GitHub Issues + Milestones (ADR-0032 visibility hub, write-back half).
//
// Maintainer-run, locally, only — never wired into CI. The Actions
// GITHUB_TOKEN cannot write GitHub Projects v2 (see the ADR-0032 update
// note), so both hub-sync write-back runners (this one and
// sync-hub-projects.mjs) stay local, invoked by a human with an
// authenticated `gh`.
//
// Dry-run by default: prints the full plan and exits 0 WITHOUT any mutating
// `gh` call. Pass --apply to execute it. All planning logic (what to
// create/update/close/reopen) lives in bin/lib/hub-sync.mjs, which is pure;
// this file supplies only I/O (`gh`, the filesystem) and dry-run printing.
//
// Usage:
//   node bin/sync-hub-issues.mjs             # dry run
//   node bin/sync-hub-issues.mjs --apply     # execute the plan
//   node bin/sync-hub-issues.mjs --json      # ADR-0030 structured report
//   node bin/sync-hub-issues.mjs --init-issue-types [--apply]
//                                            # provision the ORG's Issue Types
//                                            # (ADR-0073) — opt-in, org-wide
//                                            # blast radius, never part of --apply
//   node bin/sync-hub-issues.mjs --retype-closed [--apply]
//                                            # one-shot: backfill the Issue Type
//                                            # on closed issues, which the
//                                            # routine path never revisits
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractImplementation, extractRoadmap } from "./lib/project-hub.mjs";
import {
  actionableItems,
  countIssuesByType,
  HUB_LABEL,
  parseHubMarker,
  planBackfill,
  planClosedRetype,
  planIssueSync,
  planIssueTypes,
  planMilestones,
  planParentLinks,
} from "./lib/hub-sync.mjs";
import { ISSUE_TYPE_DEFS } from "./lib/issue-type-defs.mjs";
import { LABEL_DEFS } from "./lib/label-defs.mjs";
import { MILESTONE_DEFS } from "./lib/milestone-defs.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "monte3l/m3l-automation";
const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";
// The --limit passed to `gh issue list`. A result whose length reaches this
// window means gh silently truncated the page — reading only part of the
// tracked issues would make the planner think removed issues are gone and
// re-create them, so that case is a hard error, never a silent under-read.
const LIST_LIMIT = 500;

/**
 * The single injected `gh` execution seam: every runner call goes through
 * this function (or a test double shaped like it) so nothing else in this
 * file shells out directly. Always an argv array — never a shell string.
 *
 * @param {string[]} args
 * @returns {string} the child process's captured stdout
 */
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** Read one repo-relative file's contents as UTF-8 text. */
function readDoc(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

/** Extract the clearest available message from a failed `execFileSync` call. */
function ghErrorMessage(cause) {
  if (
    cause &&
    typeof cause === "object" &&
    "stderr" in cause &&
    typeof cause.stderr === "string" &&
    cause.stderr.trim() !== ""
  ) {
    return cause.stderr.trim();
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Parse a `gh` JSON-array response, tolerating an empty/whitespace body. */
function parseJsonArray(raw, context) {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON array from gh for ${context}, got ${typeof parsed}.`,
    );
  }
  return parsed;
}

/**
 * `gh auth status` preflight. Returns `null` on success, or a clear
 * human-readable remedy message on failure — never throws, so the caller
 * can turn a failed preflight into a reported error and a returned outcome
 * rather than an uncaught exception.
 */
function checkGhAuth(runGhFn) {
  try {
    runGhFn(["auth", "status"]);
    return null;
  } catch (cause) {
    return `gh auth status failed — run \`gh auth login\` first: ${ghErrorMessage(cause)}`;
  }
}

// Existing milestone titles for the repo, **open and closed** — the GitHub
// API's `state` query param defaults to `open`, which used to make
// planMilestones re-`POST` (and 422-fail the whole apply) any milestone a
// maintainer had since closed.
function loadExistingMilestones(runGhFn) {
  const raw = runGhFn([
    "api",
    `repos/${REPO}/milestones?state=all`,
    "--paginate",
  ]);
  // `number` is what makes an in-place rename possible at all (a PATCH is by
  // number, so every issue association survives); `description` is what
  // ADR-0073 made a managed field. The pre-ADR-0073 version returned bare
  // titles, which is why neither a rename nor a description drift was
  // expressible, and therefore why neither was ever reported.
  return parseJsonArray(raw, "milestones").map((milestone) => ({
    number: milestone.number,
    title: milestone.title,
    description: milestone.description ?? null,
    state: milestone.state,
  }));
}

// Every hub-sync-managed issue carries the hub-sync label (this runner is
// the only writer that ever applies it, on create), so filtering by label
// here is equivalent to "every marker-bearing issue" — including the ones
// close-detection needs to notice a row that was removed from the trackers.
// A markerless issue that happens to carry the label is still never touched
// (planIssueSync's own safety property: match is by marker only).
//
// Returns `null` (after reporting the error) when the response reached the
// --limit window — see the LIST_LIMIT comment.
// Shared `gh issue list` call + LIST_LIMIT safety check + shape normalization
// for both loadExistingIssues (hub-sync-labeled only) and loadAllIssues (the
// backfill collision guard's broader read). `labelArgs` is `[]` for an
// unfiltered read.
function listIssues(runGhFn, reporter, labelArgs) {
  const raw = runGhFn([
    "issue",
    "list",
    "-R",
    REPO,
    ...labelArgs,
    "--state",
    "all",
    "--json",
    "number,title,body,state,labels,issueType,parent,closedByPullRequestsReferences",
    "--limit",
    String(LIST_LIMIT),
  ]);
  const issues = parseJsonArray(raw, "issue list");
  if (issues.length >= LIST_LIMIT) {
    reporter.error(
      `gh issue list returned ${issues.length} issue(s), at or beyond the --limit ${LIST_LIMIT} window — ` +
        `the sync would under-read and could duplicate issues; raise the limit.`,
    );
    return null;
  }
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state === "CLOSED" ? "closed" : "open",
    labels: (issue.labels ?? []).map((label) => label.name),
    type: issue.issueType?.name ?? null,
    // `null` when the issue has no parent. planIssueSync's isDirty
    // deliberately ignores this — parent links are reconciled by their own
    // planner, so fixing one link must not trigger a full title/body/label
    // rewrite of the issue.
    parentNumber: issue.parent?.number ?? null,
    // PR numbers this issue's body/comments name with a closing keyword
    // (`Closes #N`) — GitHub's connection includes a PR that merely
    // references the issue this way, whether or not it has merged yet, so
    // this is only a list of *candidates*. `resolveMergedClosingPr` below
    // confirms which (if any) actually merged before the planner trusts it.
    closingPrCandidates: (issue.closedByPullRequestsReferences ?? []).map(
      (ref) => ref.number,
    ),
  }));
}

// gh's `pr view --json state` cache, keyed by PR number — a run's
// candidate set is small (an unresolved item with a linked PR is rare) and
// overlaps across issues (e.g. one PR closing several tracker rows), so a
// cache avoids repeat `gh` calls for the same PR within one invocation.
function resolveMergedClosingPr(runGhFn, prNumbers, cache) {
  for (const number of prNumbers) {
    if (!cache.has(number)) {
      const raw = runGhFn([
        "pr",
        "view",
        String(number),
        "-R",
        REPO,
        "--json",
        "state",
      ]);
      const { state } = JSON.parse(raw);
      cache.set(number, state === "MERGED");
    }
    if (cache.get(number) === true) return number;
  }
  return null;
}

// Attach `mergedClosingPrNumber` to every issue that has at least one
// closing-keyword PR candidate — planIssueSync stays pure and never shells
// out itself, so merge-state resolution (an I/O concern) happens here, in
// the runner, before the issues are handed to the planner.
function withMergedClosingPr(runGhFn, issues) {
  const cache = new Map();
  return issues.map((issue) => {
    if (issue.closingPrCandidates.length === 0) return issue;
    return {
      ...issue,
      mergedClosingPrNumber: resolveMergedClosingPr(
        runGhFn,
        issue.closingPrCandidates,
        cache,
      ),
    };
  });
}

function loadExistingIssues(runGhFn, reporter) {
  return listIssues(runGhFn, reporter, ["--label", HUB_LABEL]);
}

// Unfiltered (no --label) read of every issue in the repo, open or closed —
// used only by the --backfill collision guard. A historically-Done/Rejected
// row never carried the hub-sync label if a maintainer filed it by hand, so
// loadExistingIssues' hub-sync-only view would miss exactly the duplicate
// planBackfill's collision guard exists to catch.
function loadAllIssues(runGhFn, reporter) {
  return listIssues(runGhFn, reporter, []);
}

// Re-parent (or un-parent) an existing issue. `gh issue edit` exposes
// --parent/--remove-parent directly, so no GraphQL node ids are needed and
// the board's read-only `Parent issue` column fills in with zero board writes.
function setIssueParent(runGhFn, number, parentNumber) {
  runGhFn([
    "issue",
    "edit",
    String(number),
    "-R",
    REPO,
    "--parent",
    String(parentNumber),
  ]);
}

function clearIssueParent(runGhFn, number) {
  runGhFn(["issue", "edit", String(number), "-R", REPO, "--remove-parent"]);
}

/** `hub-sync create --force` every fixed label; safe/idempotent to re-run. */
function bootstrapLabels(runGhFn) {
  for (const { name, color, description } of LABEL_DEFS) {
    runGhFn([
      "label",
      "create",
      name,
      "-R",
      REPO,
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
  }
}

function createMilestone(runGhFn, title, description) {
  runGhFn([
    "api",
    `repos/${REPO}/milestones`,
    "-X",
    "POST",
    "-f",
    `title=${title}`,
    "-f",
    `description=${description}`,
  ]);
}

// In-place edit by milestone number. This is the whole reason a rename is safe:
// a PATCH keeps the milestone's identity, so all of its open AND closed issue
// associations survive. Renaming by create-new-then-abandon-old would strand
// them — 28 and 31 open issues, at the time ADR-0073 renamed p1 and p2.
function patchMilestone(runGhFn, number, fields) {
  const args = ["api", `repos/${REPO}/milestones/${number}`, "-X", "PATCH"];
  for (const [name, value] of Object.entries(fields)) {
    args.push("-f", `${name}=${value}`);
  }
  runGhFn(args);
}

// Returns the created issue's number, parsed from `gh issue create`'s
// printed URL (`.../issues/<number>`) — `gh issue create` has no `--json`
// output mode, unlike list/view. The normal create path (issuePlan.create)
// doesn't need the number (the next sync run finds it via its marker) and
// discards the return value; the backfill path does, to close the issue in
// the same pass.
function createIssue(runGhFn, payload, parentNumber) {
  const args = [
    "issue",
    "create",
    "-R",
    REPO,
    "--title",
    payload.title,
    "--body",
    payload.body,
    "--type",
    payload.type,
  ];
  for (const label of payload.labels) args.push("--label", label);
  if (payload.milestoneTitle !== null) {
    args.push("--milestone", payload.milestoneTitle);
  }
  // Establishing the sub-issue link at create time means the follow-up
  // reconciliation pass has nothing to do for a freshly created child, so a
  // first-time sync converges in one run instead of two.
  if (parentNumber !== undefined) {
    args.push("--parent", String(parentNumber));
  }
  const output = runGhFn(args).trim();
  const match = /\/issues\/(\d+)\s*$/.exec(output);
  if (!match) {
    throw new Error(
      `Could not parse an issue number from \`gh issue create\`'s output: ${output}`,
    );
  }
  return parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// Org Issue Types (ADR-0073). Issue Types are an ORG-level resource, not a
// repo one, and only GraphQL exposes them — `gh issue create --type <name>`
// resolves by name against whatever the org happens to have, and 422s on a
// name that isn't there. The whole point of reading them is to turn that
// mid-batch 422 into a refusal before the first write.
// ---------------------------------------------------------------------------

const ORG = "monte3l";

// The org's node id AND its Issue Types in one query: `createIssueType` needs
// the id as `ownerId`, and every caller that wants one wants the other.
function loadOrgIssueTypes(runGhFn) {
  const raw = runGhFn([
    "api",
    "graphql",
    "-f",
    `query=query { organization(login: "${ORG}") { id issueTypes(first: 50) { nodes { id name description color isEnabled } } } }`,
  ]);
  const parsed = JSON.parse(raw);
  const organization = parsed?.data?.organization;
  if (!organization || typeof organization.id !== "string") {
    throw new Error(
      `Could not read ${ORG}'s Issue Types — the response carried no organization id. ` +
        `Issue Types are org-scoped, so this usually means the token lacks org read access: ${raw}`,
    );
  }
  return {
    ownerId: organization.id,
    types: (organization.issueTypes?.nodes ?? []).map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description ?? null,
      color: type.color ?? null,
      isEnabled: type.isEnabled === true,
    })),
  };
}

function createIssueType(runGhFn, ownerId, def) {
  runGhFn([
    "api",
    "graphql",
    "-f",
    "query=mutation($ownerId: ID!, $name: String!, $description: String, $color: IssueTypeColor) { " +
      "createIssueType(input: { ownerId: $ownerId, name: $name, description: $description, color: $color, isEnabled: true }) " +
      "{ issueType { id name } } }",
    // `-f` (string), never `-F` (typed): `-F` coerces a value that looks
    // numeric or boolean, and a type name/description is always a string.
    "-f",
    `ownerId=${ownerId}`,
    "-f",
    `name=${def.name}`,
    "-f",
    `description=${def.description}`,
    "-f",
    `color=${def.color}`,
  ]);
}

// Irreversible and org-wide: the type is gone for every repo in the org, not
// just this one. Only ever called on a `planIssueTypes.retire` entry, which is
// gated on a zero-issue census — see that planner's `blocked` output.
function deleteIssueType(runGhFn, id) {
  runGhFn([
    "api",
    "graphql",
    "-f",
    "query=mutation($issueTypeId: ID!) { deleteIssueType(input: { issueTypeId: $issueTypeId }) { clientMutationId } }",
    "-f",
    `issueTypeId=${id}`,
  ]);
}

// A priority:*/type:*/status:* label the currently-fetched issue carries but
// the desired payload does not — stale from a prior run whose item priority
// or status (Deferred/Blocked) changed, or a leftover `priority:*`/`type:*`
// name from before the ADR-0051 rename. HUB_LABEL is never stale (every
// payload always carries it), so only these three prefixed families need
// pruning.
function staleManagedLabels(currentLabels, payload) {
  return currentLabels.filter(
    (label) =>
      (label.startsWith("priority:") ||
        label.startsWith("type:") ||
        label.startsWith("status:")) &&
      !payload.labels.includes(label),
  );
}

// Sync only the managed label set (add missing / remove stale priority:*,
// type:*, status:* labels) — no --title/--body/--milestone/--type, unlike
// editIssue. Called right before closeIssue when the plan says labels are
// stale (issuePlan.close[].labelsStale), so a Done/Rejected issue's status
// label reflects the closing state instead of retaining whatever it had
// while open — gh issue close has no --add-label/--remove-label of its own
// (ADR-0052's 2026-08-20 Update: every STATUS_LABELS value is now labeled,
// including done/rejected).
function syncManagedLabels(runGhFn, number, payload, currentIssue) {
  const args = ["issue", "edit", String(number), "-R", REPO];
  for (const label of payload.labels) args.push("--add-label", label);
  for (const label of staleManagedLabels(currentIssue?.labels ?? [], payload)) {
    args.push("--remove-label", label);
  }
  runGhFn(args);
}

function editIssue(runGhFn, number, payload, currentIssue) {
  const args = [
    "issue",
    "edit",
    String(number),
    "-R",
    REPO,
    "--title",
    payload.title,
    "--body",
    payload.body,
    "--type",
    payload.type,
  ];
  for (const label of payload.labels) args.push("--add-label", label);
  for (const label of staleManagedLabels(currentIssue?.labels ?? [], payload)) {
    args.push("--remove-label", label);
  }
  if (payload.milestoneTitle !== null) {
    args.push("--milestone", payload.milestoneTitle);
  } else {
    args.push("--remove-milestone");
  }
  runGhFn(args);
}

function closeIssue(runGhFn, number, comment, reason) {
  runGhFn([
    "issue",
    "close",
    String(number),
    "-R",
    REPO,
    "--comment",
    comment,
    "--reason",
    reason,
  ]);
}

function reopenIssue(runGhFn, number) {
  runGhFn(["issue", "reopen", String(number), "-R", REPO]);
}

function printPlan(reporter, milestonePlan, issuePlan, parentPlan) {
  reporter.info(`Milestones to create (${milestonePlan.create.length}):`);
  for (const title of milestonePlan.create) reporter.info(`  + ${title}`);

  reporter.info(`Milestones to rename (${milestonePlan.rename.length}):`);
  for (const { number, from, to } of milestonePlan.rename) {
    reporter.info(`  ~ #${number} "${from}" -> "${to}"`);
  }

  reporter.info(`Milestones to describe (${milestonePlan.describe.length}):`);
  for (const { number, title } of milestonePlan.describe) {
    reporter.info(`  ~ #${number} ${title}`);
  }

  // Report-only: a milestone matching no def may still carry closed issues,
  // and deleting one strips it from every issue that ever held it. Excluded
  // from the drift verdict below for the same reason — an orphan nobody
  // intends to remove would make check:hub-drift permanently unfixable.
  reporter.info(
    `Orphaned milestones, report only (${milestonePlan.orphan.length}):`,
  );
  for (const { number, title } of milestonePlan.orphan) {
    reporter.info(
      `  ? #${number} "${title}" — matches no MILESTONE_DEFS entry`,
    );
  }

  reporter.info(`Issues to create (${issuePlan.create.length}):`);
  for (const { key, payload } of issuePlan.create) {
    reporter.info(`  + [${key}] ${payload.title}`);
  }

  reporter.info(`Issues to update (${issuePlan.update.length}):`);
  for (const { number, key, payload } of issuePlan.update) {
    reporter.info(`  ~ #${number} [${key}] ${payload.title}`);
  }

  reporter.info(`Issues to close (${issuePlan.close.length}):`);
  for (const { number, key, comment, reason } of issuePlan.close) {
    reporter.info(`  - #${number} [${key}] (${reason}: ${comment})`);
  }

  reporter.info(`Issues to reopen (${issuePlan.reopen.length}):`);
  for (const { number, key } of issuePlan.reopen) {
    reporter.info(`  ^ #${number} [${key}]`);
  }

  // Never auto-fixed by --apply — only a human editing the tracker cell can
  // resolve this, so it is reported as an error site, not a plannable action.
  reporter.info(
    `Issues with a stale tracker row (${issuePlan.staleTracker.length}):`,
  );
  for (const {
    number,
    key,
    prNumber,
    sourcePath,
    sourceAnchor,
  } of issuePlan.staleTracker) {
    reporter.info(
      `  ! #${number} [${key}] closed by merged PR #${prNumber}, but ` +
        `${sourcePath}${sourceAnchor} still lists it as unresolved — flip ` +
        `the Status cell to Done (or Rejected).`,
    );
  }

  reporter.info(`Untouched: ${issuePlan.untouched.length}`);

  reporter.info(`Sub-issue links to set (${parentPlan.set.length}):`);
  for (const { number, key, parentNumber, parentKey } of parentPlan.set) {
    reporter.info(
      `  ^ #${number} [${key}] -> parent #${parentNumber} [${parentKey}]`,
    );
  }

  reporter.info(`Sub-issue links to clear (${parentPlan.clear.length}):`);
  for (const { number, key } of parentPlan.clear) {
    reporter.info(`  x #${number} [${key}]`);
  }

  // Deferred, not drift: a pending link always coexists with a non-empty
  // create plan (the epic is being filed on this very run), so counting it in
  // the emptiness test below would double-report the same work.
  reporter.info(
    `Sub-issue links deferred until their epic is filed (${parentPlan.pending.length}):`,
  );
  for (const { key, parentKey } of parentPlan.pending) {
    reporter.info(`  … [${key}] awaits [${parentKey}]`);
  }
}

// backfillPlan is `null` when --backfill wasn't passed — omit the section
// entirely rather than printing an always-zero one, so a plain run's output
// stays unchanged from before this flag existed.
function printBackfillPlan(reporter, backfillPlan) {
  if (backfillPlan === null) return;

  reporter.info(
    `Backfill issues to create+close (${backfillPlan.create.length}):`,
  );
  for (const { key, payload, reason } of backfillPlan.create) {
    reporter.info(`  + [${key}] ${payload.title} (closes: ${reason})`);
  }

  reporter.info(
    `Backfill items needing manual review (${backfillPlan.needsReview.length}):`,
  );
  for (const {
    key,
    payload,
    candidateNumber,
    candidateTitle,
    similarity,
  } of backfillPlan.needsReview) {
    reporter.info(
      `  ? [${key}] ${payload.title}\n` +
        `      possible duplicate of #${candidateNumber} "${candidateTitle}" ` +
        `(similarity ${(similarity * 100).toFixed(0)}%) — resolve by hand, not auto-created`,
    );
  }
}

/**
 * Apply-path guard: every {@link ISSUE_TYPE_DEFS} name must already exist on
 * the org. Returns `null` when it does, or the error message (naming the
 * missing types and the remedy) when it does not.
 *
 * Reads only the type census, never the issue census — a create-only question
 * needs no `loadAllIssues` page, and this runs on every `--apply`.
 */
function issueTypePreflight(runGhFn) {
  const { types } = loadOrgIssueTypes(runGhFn);
  const { create } = planIssueTypes(types, ISSUE_TYPE_DEFS, new Map());
  if (create.length === 0) return null;
  return (
    `The ${ORG} org is missing ${create.length} of the ${ISSUE_TYPE_DEFS.length} declared GitHub ` +
    `Issue Type(s): ${create.map((def) => `"${def.name}"`).join(", ")}. ` +
    `\`gh issue create --type\` would 422 partway through this batch. ` +
    `Provision them first: \`pnpm sync:hub-issues -- --init-issue-types --apply\`.`
  );
}

/**
 * Provisions the org's GitHub Issue Types against {@link ISSUE_TYPE_DEFS}:
 * creates every declared type the org lacks, and retires every undeclared one
 * no issue still carries.
 *
 * A separate opt-in entry point rather than a step inside {@link runIssueSync},
 * because the blast radius is different in kind. Issue Types are **org**-level:
 * a create is visible to every repo `monte3l` owns and a delete removes the
 * type from all of them. That does not belong on the routine
 * tracker-reconciliation path a maintainer runs whenever a Status cell changes.
 *
 * Dry-run by default, like every other runner here — `apply` executes.
 *
 * @param {{ runGh: (args: string[]) => string, reporter: ReturnType<typeof createReporter>, apply: boolean }} options
 * @returns {{ ok: boolean }}
 */
export function runIssueTypeInit({ runGh: runGhFn, reporter, apply }) {
  try {
    const authError = checkGhAuth(runGhFn);
    if (authError !== null) {
      reporter.error(authError);
      reporter.finish();
      return { ok: false };
    }

    const { ownerId, types } = loadOrgIssueTypes(runGhFn);

    // The retire half needs the issue census, and it needs it over BOTH
    // states: a closed issue still carrying a type is enough to make deleting
    // that type destructive, and closed issues are the majority here.
    const allIssues = loadAllIssues(runGhFn, reporter);
    if (allIssues === null) {
      reporter.finish();
      return { ok: false };
    }

    const plan = planIssueTypes(
      types,
      ISSUE_TYPE_DEFS,
      countIssuesByType(allIssues),
    );

    reporter.info(`Issue Types to create (${plan.create.length}):`);
    for (const def of plan.create) {
      reporter.info(`  + ${def.name} [${def.color}] — ${def.description}`);
    }

    reporter.info(`Issue Types to retire (${plan.retire.length}):`);
    for (const type of plan.retire) {
      reporter.info(`  - ${type.name} (no issue carries it)`);
    }

    // Report-only, and deliberately not counted as failure: this is the
    // expected mid-migration state. ADR-0073 retypes 47 open issues off
    // `Capability` on the routine --apply and 131 closed ones via
    // --retype-closed; until both have run, `Capability` is blocked here and
    // that is correct, not an error.
    if (plan.blocked.length > 0) {
      reporter.info(
        `Undeclared Issue Types still in use, NOT retired (${plan.blocked.length}):`,
      );
      for (const type of plan.blocked) {
        reporter.info(
          `  ! ${type.name} — ${type.count} issue(s) still carry it; retype them first ` +
            `(\`pnpm sync:hub-issues -- --apply\` for open, \`--retype-closed --apply\` for closed)`,
        );
      }
    }

    if (!apply) {
      reporter.succeed(
        `Dry run — pass --apply to execute. Would create ${plan.create.length} and retire ` +
          `${plan.retire.length} Issue Type(s); ${plan.blocked.length} undeclared type(s) still in use.`,
      );
      reporter.finish({
        applied: false,
        issueTypes: {
          create: plan.create.length,
          retire: plan.retire.length,
          blocked: plan.blocked.length,
        },
      });
      return { ok: true };
    }

    // Creates before retires: if a retire were to fail, the vocabulary the
    // rest of the sync depends on is already in place.
    for (const def of plan.create) {
      createIssueType(runGhFn, ownerId, def);
      reporter.change("created", `Issue Type: ${def.name}`);
    }

    for (const type of plan.retire) {
      deleteIssueType(runGhFn, type.id);
      reporter.change("removed", `Issue Type: ${type.name}`);
    }

    reporter.succeed(
      `Applied: ${plan.create.length} Issue Type(s) created, ${plan.retire.length} retired; ` +
        `${plan.blocked.length} undeclared type(s) left in place because issues still carry them.`,
    );
    reporter.finish({
      applied: true,
      issueTypes: {
        create: plan.create.length,
        retire: plan.retire.length,
        blocked: plan.blocked.length,
      },
    });
    return { ok: true };
  } catch (cause) {
    reporter.error(
      `Issue Type provisioning failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    return { ok: false };
  }
}

// Narrow, type-only edit. Deliberately NOT `editIssue`, which also rewrites
// title/body/labels/milestone: `planIssueSync` leaves a closed-and-resolved
// issue's payload completely alone by design (ADR-0032's 2026-07-28 Update),
// and rewriting 131 closed bodies to fix a type would trade one gap for a far
// larger churn — plus every one of those edits would show as activity on a
// finished issue.
function setIssueType(runGhFn, number, typeName) {
  runGhFn(["issue", "edit", String(number), "-R", REPO, "--type", typeName]);
}

/**
 * One-shot backfill: gives every closed hub-sync issue the GitHub Issue Type
 * its tracker row says it should have.
 *
 * Opt-in and separate from {@link runIssueSync} for the same reason
 * {@link planClosedRetype} is separate from `planIssueSync` — the routine path
 * must not churn closed issues. Idempotent, so re-running it is safe: the
 * planner only emits a retype where the live type actually differs.
 *
 * @param {{ runGh: (args: string[]) => string, reporter: ReturnType<typeof createReporter>, apply: boolean, readDoc: (relativePath: string) => string }} options
 * @returns {{ ok: boolean }}
 */
export function runClosedRetype({
  runGh: runGhFn,
  reporter,
  apply,
  readDoc: readDocFn,
}) {
  try {
    const authError = checkGhAuth(runGhFn);
    if (authError !== null) {
      reporter.error(authError);
      reporter.finish();
      return { ok: false };
    }

    const roadmap = extractRoadmap(readDocFn(ROADMAP_PATH));
    const implementation = extractImplementation(
      readDocFn(IMPLEMENTATION_PATH),
    );
    const extractionErrors = [...roadmap.errors, ...implementation.errors];
    if (extractionErrors.length > 0) {
      for (const message of extractionErrors) reporter.error(message);
      reporter.finish();
      return { ok: false };
    }

    const { items, warnings } = actionableItems(roadmap, implementation);
    for (const message of warnings) reporter.warn(message);

    // The UNFILTERED read: a closed issue filed before the hub-sync label
    // existed still carries its marker, and the marker is what this matches
    // on. loadExistingIssues' label filter would miss exactly those.
    const allIssues = loadAllIssues(runGhFn, reporter);
    if (allIssues === null) {
      reporter.finish();
      return { ok: false };
    }

    const plan = planClosedRetype(items, allIssues);

    reporter.info(`Closed issues to retype (${plan.set.length}):`);
    for (const { number, key, from, to } of plan.set) {
      reporter.info(`  ~ #${number} [${key}] ${from ?? "(no type)"} -> ${to}`);
    }

    // Report-only. Their tracker rows are gone, so nothing can supply a type;
    // naming them is the whole remedy, and counting them as failure would make
    // this command permanently non-clean.
    if (plan.unmatched.length > 0) {
      reporter.info(
        `Closed issues whose marker matches no tracker row, NOT retyped (${plan.unmatched.length}):`,
      );
      for (const { number, key, from } of plan.unmatched) {
        reporter.info(
          `  ! #${number} [${key}] currently ${from ?? "(no type)"} — the row was removed from the trackers`,
        );
      }
    }

    if (!apply) {
      reporter.succeed(
        `Dry run — pass --apply to execute. Would retype ${plan.set.length} closed issue(s); ` +
          `${plan.unmatched.length} unmatched (report only).`,
      );
      reporter.finish({
        applied: false,
        closedRetype: {
          set: plan.set.length,
          unmatched: plan.unmatched.length,
        },
      });
      return { ok: true };
    }

    // `gh issue edit --type` resolves by NAME against the org's Issue Types
    // and 422s on one it does not have, exactly as `gh issue create --type`
    // does — so this path needs the same preflight the sync's --apply has.
    const preflightError = issueTypePreflight(runGhFn);
    if (preflightError !== null) {
      reporter.error(preflightError);
      reporter.finish();
      return { ok: false };
    }

    for (const { number, key, from, to } of plan.set) {
      setIssueType(runGhFn, number, to);
      reporter.change(
        "updated",
        `issue #${number} [${key}] type ${from ?? "(none)"} -> ${to}`,
      );
    }

    reporter.succeed(
      `Applied: ${plan.set.length} closed issue(s) retyped; ${plan.unmatched.length} unmatched, left alone.`,
    );
    reporter.finish({
      applied: true,
      closedRetype: { set: plan.set.length, unmatched: plan.unmatched.length },
    });
    return { ok: true };
  } catch (cause) {
    reporter.error(
      `Closed-issue retype failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    return { ok: false };
  }
}

/**
 * The full read -> plan -> (print | apply) pipeline. Every I/O dependency is
 * injected so the orchestration itself stays testable; the main-guard below
 * wires the real `gh`/filesystem implementations. NEVER calls
 * `process.exit` itself — every failure path (auth preflight, extraction
 * errors, a `gh` call throwing, a truncated result window) is caught here
 * and turned into a reported error plus a returned `{ ok: false }`, so the
 * function is always safely callable (and its outcome assertable) without
 * killing the calling process. Only the main-guard below turns a `!ok`
 * outcome into `process.exit(1)`.
 *
 * `check` (mutually exclusive with `apply`) is the CI drift gate (ADR-0032's
 * 2026-08-13 Update): it runs the same dry-run plan but returns `{ ok: false }`
 * when the plan is non-empty, instead of always succeeding the way a plain
 * dry-run does for a human previewing changes. Distinct from `apply` so a
 * developer's local `pnpm sync:hub-issues` (no flags) keeps its
 * always-exits-0 preview contract unchanged.
 *
 * `backfill` is the one-time historical-record pass ({@link planBackfill}):
 * files a closed issue for every Done/Rejected tracker row that predates
 * `sync:hub` ever running (no marker). It composes with `apply`/`check` but
 * is deliberately excluded from `check`'s emptiness test — a
 * backfill-eligible historical row existing indefinitely (until someone
 * opts into `--backfill`) is not the kind of drift the CI alarm should ever
 * fire on.
 *
 * @param {{
 *   runGh: typeof runGh,
 *   reporter: ReturnType<typeof createReporter>,
 *   apply: boolean,
 *   check?: boolean,
 *   backfill?: boolean,
 *   readDoc: typeof readDoc,
 * }} deps
 * @returns {{ ok: boolean }}
 * @example
 * ```js
 * import { createReporter } from "./lib/report.mjs";
 * import { runIssueSync } from "./sync-hub-issues.mjs";
 *
 * const outcome = runIssueSync({
 *   runGh: (args) => "",
 *   reporter: createReporter(false),
 *   apply: false,
 *   readDoc: (path) => "",
 * });
 * outcome.ok; // false — an empty runGh stub fails the auth preflight
 * ```
 */
export function runIssueSync({
  runGh: runGhFn,
  reporter,
  apply,
  check = false,
  backfill = false,
  readDoc: readDocFn,
}) {
  try {
    const authError = checkGhAuth(runGhFn);
    if (authError !== null) {
      reporter.error(authError);
      reporter.finish();
      return { ok: false };
    }

    const roadmap = extractRoadmap(readDocFn(ROADMAP_PATH));
    const implementation = extractImplementation(
      readDocFn(IMPLEMENTATION_PATH),
    );
    const extractionErrors = [...roadmap.errors, ...implementation.errors];
    if (extractionErrors.length > 0) {
      for (const message of extractionErrors) reporter.error(message);
      reporter.finish();
      return { ok: false };
    }

    const { items, warnings } = actionableItems(roadmap, implementation);
    for (const message of warnings) reporter.warn(message);

    const existingMilestones = loadExistingMilestones(runGhFn);
    const existingIssuesRaw = loadExistingIssues(runGhFn, reporter);
    if (existingIssuesRaw === null) {
      reporter.finish();
      return { ok: false };
    }
    const existingIssues = withMergedClosingPr(runGhFn, existingIssuesRaw);
    const existingIssuesByNumber = new Map(
      existingIssues.map((issue) => [issue.number, issue]),
    );

    const milestonePlan = planMilestones(
      items,
      existingMilestones,
      MILESTONE_DEFS,
    );
    const issuePlan = planIssueSync(items, existingIssues);
    const parentPlan = planParentLinks(items, existingIssues);

    let backfillPlan = null;
    if (backfill) {
      const allIssues = loadAllIssues(runGhFn, reporter);
      if (allIssues === null) {
        reporter.finish();
        return { ok: false };
      }
      backfillPlan = planBackfill(items, allIssues);
    }

    printPlan(reporter, milestonePlan, issuePlan, parentPlan);
    printBackfillPlan(reporter, backfillPlan);

    if (!apply) {
      const staleTrackerIsEmpty = issuePlan.staleTracker.length === 0;
      // Kept separate from staleTrackerIsEmpty so --check can tell "GitHub
      // drifted from the trackers" (fixable by --apply) apart from "the
      // trackers drifted from GitHub" (fixable only by hand) and emit the
      // right remedy for each.
      const otherDriftIsEmpty =
        milestonePlan.create.length === 0 &&
        milestonePlan.rename.length === 0 &&
        milestonePlan.describe.length === 0 &&
        issuePlan.create.length === 0 &&
        issuePlan.update.length === 0 &&
        issuePlan.close.length === 0 &&
        issuePlan.reopen.length === 0 &&
        parentPlan.set.length === 0 &&
        parentPlan.clear.length === 0;
      const planIsEmpty = otherDriftIsEmpty && staleTrackerIsEmpty;
      const summary = {
        applied: false,
        milestones: {
          create: milestonePlan.create.length,
          rename: milestonePlan.rename.length,
          describe: milestonePlan.describe.length,
          orphan: milestonePlan.orphan.length,
        },
        issues: {
          create: issuePlan.create.length,
          update: issuePlan.update.length,
          close: issuePlan.close.length,
          reopen: issuePlan.reopen.length,
          staleTracker: issuePlan.staleTracker.length,
          untouched: issuePlan.untouched.length,
        },
        parents: {
          set: parentPlan.set.length,
          clear: parentPlan.clear.length,
          pending: parentPlan.pending.length,
        },
        ...(backfillPlan && {
          backfill: {
            create: backfillPlan.create.length,
            needsReview: backfillPlan.needsReview.length,
          },
        }),
      };

      if (check && !planIsEmpty) {
        if (!staleTrackerIsEmpty) {
          reporter.error(
            `${issuePlan.staleTracker.length} issue(s) closed by a merged PR ` +
              "still list an unresolved tracker row. This is not GitHub/tracker " +
              "drift — `--apply` cannot fix it. Edit the Status cell(s) by hand:\n" +
              issuePlan.staleTracker
                .map(
                  ({ number, key, prNumber, sourcePath, sourceAnchor }) =>
                    `  #${number} [${key}]: ${sourcePath}${sourceAnchor} (closed by PR #${prNumber})`,
                )
                .join("\n"),
          );
        }
        if (!otherDriftIsEmpty) {
          reporter.error(
            "Tracker/GitHub drift detected — the docs/ROADMAP.md and " +
              "docs/plans/IMPLEMENTATION.md trackers no longer match GitHub " +
              "Issues/Milestones. Run `pnpm sync:hub -- --apply` (maintainer-local, " +
              "needs your own `gh` auth) to reconcile.",
          );
        }
        reporter.finish(summary);
        return { ok: false };
      }

      const backfillSummary = backfillPlan
        ? ` Backfill: ${backfillPlan.create.length} to create+close, ` +
          `${backfillPlan.needsReview.length} needing manual review.`
        : "";
      reporter.succeed(
        (check
          ? "Drift check passed — GitHub Issues/Milestones already match the trackers."
          : `Dry run — pass --apply to execute. Would create ${milestonePlan.create.length}, rename ` +
            `${milestonePlan.rename.length} and describe ${milestonePlan.describe.length} milestone(s); ` +
            `${issuePlan.create.length} issue(s) to create, ${issuePlan.update.length} to update, ` +
            `${issuePlan.close.length} to close, ${issuePlan.reopen.length} to reopen, ` +
            `${issuePlan.staleTracker.length} with a stale tracker row, ` +
            `${issuePlan.untouched.length} untouched.`) + backfillSummary,
      );
      reporter.finish(summary);
      return { ok: true };
    }

    // Issue-Type preflight — apply path ONLY, and before the first mutation.
    // `gh issue create/edit --type <name>` resolves by name against the org's
    // Issue Types and 422s on an unknown one, so a vocabulary the org has not
    // been provisioned with fails partway through a ~50-issue batch, leaving
    // half of it written. Refusing up front is the difference between "nothing
    // happened" and "reconcile a half-applied run by hand".
    //
    // Not on the dry-run/`--check` path on purpose: `check:hub-drift` runs in
    // CI with the Actions GITHUB_TOKEN, which is repo-scoped and cannot read
    // an ORG-level resource — asserting there would fail the gate for a
    // permission reason with nothing to do with tracker drift.
    const preflightError = issueTypePreflight(runGhFn);
    if (preflightError !== null) {
      reporter.error(preflightError);
      reporter.finish();
      return { ok: false };
    }

    bootstrapLabels(runGhFn);

    // Milestones are applied before any issue write, and renames before
    // creates: `gh issue create/edit --milestone` resolves by TITLE, so an
    // issue edit that runs before its milestone has been renamed silently
    // fails to move. Same ordering rationale as bootstrapLabels above.
    for (const { number, from, to } of milestonePlan.rename) {
      patchMilestone(runGhFn, number, { title: to });
      reporter.change("updated", `milestone #${number}: "${from}" -> "${to}"`);
    }

    for (const { number, title, description } of milestonePlan.describe) {
      patchMilestone(runGhFn, number, { description });
      reporter.change("updated", `milestone #${number} description: ${title}`);
    }

    for (const title of milestonePlan.create) {
      const def = MILESTONE_DEFS.find((entry) => entry.title === title);
      if (def === undefined) {
        // Unreachable today: every planMilestones `create` entry originates
        // from a def's own `title`. Thrown rather than defaulted to "" because
        // the failure mode of degrading is invisible — the milestone would be
        // created description-less, then show up as describe-drift on the next
        // run, with nothing pointing back to here.
        throw new Error(
          `planMilestones planned milestone "${title}" with no matching MILESTONE_DEFS entry — ` +
            `create entries are derived from def titles, so this means the two have diverged.`,
        );
      }
      createMilestone(runGhFn, title, def.description);
      reporter.change("created", `milestone: ${title}`);
    }

    // Epics are created before their children so each child's create can
    // carry `--parent <number>`. Without this ordering the parent number does
    // not exist yet, every child falls through to the reconciliation pass
    // below, and a first-time sync needs a second `--apply` to converge.
    const numberByKey = new Map();
    for (const issue of existingIssues) {
      const marker = parseHubMarker(issue.body);
      if (marker !== null) numberByKey.set(marker, issue.number);
    }

    const [epicCreates, childCreates] = [
      issuePlan.create.filter((entry) => entry.isEpic === true),
      issuePlan.create.filter((entry) => entry.isEpic !== true),
    ];

    for (const { key, payload } of epicCreates) {
      numberByKey.set(key, createIssue(runGhFn, payload));
      reporter.change("created", `epic issue [${key}] ${payload.title}`);
    }

    for (const { key, payload, parentKey } of childCreates) {
      const parentNumber =
        parentKey === undefined ? undefined : numberByKey.get(parentKey);
      numberByKey.set(key, createIssue(runGhFn, payload, parentNumber));
      reporter.change("created", `issue [${key}] ${payload.title}`);
    }

    for (const { number, key, payload } of issuePlan.update) {
      editIssue(runGhFn, number, payload, existingIssuesByNumber.get(number));
      reporter.change("updated", `issue #${number} [${key}]`);
    }

    for (const {
      number,
      key,
      comment,
      reason,
      payload,
      labelsStale,
    } of issuePlan.close) {
      if (labelsStale) {
        syncManagedLabels(
          runGhFn,
          number,
          payload,
          existingIssuesByNumber.get(number),
        );
      }
      closeIssue(runGhFn, number, comment, reason);
      reporter.change(
        "removed",
        `issue #${number} [${key}] closed (${reason}: ${comment})`,
      );
    }

    for (const { number, key, payload } of issuePlan.reopen) {
      reopenIssue(runGhFn, number);
      editIssue(runGhFn, number, payload, existingIssuesByNumber.get(number));
      reporter.change("updated", `issue #${number} [${key}] reopened`);
    }

    // Never mutated by --apply — see the `staleTracker` doc on
    // planIssueSync. Reported as errors so the run's exit code reflects
    // that human action is still required, but every other planned mutation
    // above still applies; a stale tracker row on one item must not block
    // the rest of the sync.
    for (const {
      number,
      key,
      prNumber,
      sourcePath,
      sourceAnchor,
    } of issuePlan.staleTracker) {
      reporter.error(
        `issue #${number} [${key}] closed by merged PR #${prNumber}, but ` +
          `${sourcePath}${sourceAnchor} still lists it as unresolved — flip ` +
          `the Status cell to Done (or Rejected); --apply will not do this for you.`,
      );
    }

    // Parent links last: every issue this run creates or reopens already
    // exists by now, so `numberByKey` can resolve an epic filed moments ago
    // and the run converges without needing a second --apply.
    for (const { number, key, parentNumber, parentKey } of parentPlan.set) {
      const resolved = numberByKey.get(parentKey) ?? parentNumber;
      setIssueParent(runGhFn, number, resolved);
      reporter.change(
        "updated",
        `issue #${number} [${key}] -> sub-issue of #${resolved} [${parentKey}]`,
      );
    }

    for (const { number, key } of parentPlan.clear) {
      clearIssueParent(runGhFn, number);
      reporter.change("updated", `issue #${number} [${key}] parent cleared`);
    }

    // `pending` was computed against the PRE-apply state, so on a first-time
    // sync every existing child of a not-yet-filed epic lands here rather than
    // in `set`. Now that the epics have been created above, their numbers are
    // in `numberByKey` — so resolve and link them in this same run instead of
    // leaving the whole hierarchy for a second --apply.
    for (const { number, key, parentKey } of parentPlan.pending) {
      const parentNumber = numberByKey.get(parentKey);
      if (parentNumber === undefined) {
        reporter.warn(
          `Sub-issue link deferred: [${key}] -> [${parentKey}] — the epic has no issue ` +
            `even after this run's creates. Re-run --apply once it is filed.`,
        );
        continue;
      }
      setIssueParent(runGhFn, number, parentNumber);
      reporter.change(
        "updated",
        `issue #${number} [${key}] -> sub-issue of #${parentNumber} [${parentKey}]`,
      );
    }

    if (backfillPlan) {
      for (const { key, payload, comment, reason } of backfillPlan.create) {
        const number = createIssue(runGhFn, payload);
        closeIssue(runGhFn, number, comment, reason);
        reporter.change(
          "created",
          `issue #${number} [${key}] ${payload.title} (backfilled, closed: ${reason})`,
        );
      }
      for (const {
        key,
        payload,
        candidateNumber,
      } of backfillPlan.needsReview) {
        reporter.warn(
          `Backfill skipped [${key}] ${payload.title} — possible duplicate of ` +
            `#${candidateNumber}; resolve by hand.`,
        );
      }
    }

    const backfillAppliedSummary = backfillPlan
      ? ` Backfill: ${backfillPlan.create.length} created+closed, ` +
        `${backfillPlan.needsReview.length} skipped for manual review.`
      : "";
    const staleTrackerAppliedSummary =
      issuePlan.staleTracker.length > 0
        ? ` ${issuePlan.staleTracker.length} issue(s) need a tracker Status ` +
          `cell fixed by hand — see the errors above.`
        : "";
    reporter.succeed(
      `Applied: ${milestonePlan.create.length} milestone(s) created, ${milestonePlan.rename.length} renamed, ` +
        `${milestonePlan.describe.length} described; ${issuePlan.create.length} issue(s) created, ` +
        `${issuePlan.update.length} updated, ${issuePlan.close.length} closed, ${issuePlan.reopen.length} reopened.` +
        backfillAppliedSummary +
        staleTrackerAppliedSummary,
    );
    reporter.finish({
      applied: true,
      milestones: {
        create: milestonePlan.create.length,
        rename: milestonePlan.rename.length,
        describe: milestonePlan.describe.length,
        orphan: milestonePlan.orphan.length,
      },
      issues: {
        create: issuePlan.create.length,
        update: issuePlan.update.length,
        close: issuePlan.close.length,
        reopen: issuePlan.reopen.length,
        staleTracker: issuePlan.staleTracker.length,
        untouched: issuePlan.untouched.length,
      },
      parents: {
        set: parentPlan.set.length,
        clear: parentPlan.clear.length,
        pending: parentPlan.pending.length,
      },
      ...(backfillPlan && {
        backfill: {
          create: backfillPlan.create.length,
          needsReview: backfillPlan.needsReview.length,
        },
      }),
    });
    // Deliberately `ok: true` even with staleTracker entries present: this
    // function's return code is what bin/sync-hub.mjs's runPhases() treats
    // as fatal, stopping before the projects-board phase ever runs. A
    // staleTracker row is a "human needs to fix a tracker cell" signal, not
    // a failed sync — every planned mutation above still applied — so it
    // must not block the rest of `pnpm sync:hub --apply`'s pipeline. It is
    // still loud: each entry got its own reporter.error() above, which
    // flips the --json payload's `ok` to false and prints a ✗ line in human
    // mode. `pnpm check:hub-drift` (this file's --check path, called
    // directly, never through sync-hub.mjs/runPhases) is the actual
    // CI-facing gate for this condition and is unaffected by this choice.
    return { ok: true };
  } catch (cause) {
    reporter.error(
      `Issue sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    return { ok: false };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const apply = argv.includes("--apply");
  const check = argv.includes("--check");
  const backfill = argv.includes("--backfill");
  const initIssueTypes = argv.includes("--init-issue-types");
  const retypeClosed = argv.includes("--retype-closed");
  const reporter = createReporter(json);

  if (apply && check) {
    reporter.error("--apply and --check are mutually exclusive.");
    reporter.finish();
    process.exit(1);
  }

  // --init-issue-types is a whole different runner, not a phase of the sync:
  // it touches an ORG-level resource and reconciles nothing against the
  // trackers. Combining it with --check (a drift question about tracker rows)
  // or --backfill (a historical-issue pass) is always a mistake, so say so
  // rather than silently ignoring the other flag.
  if (initIssueTypes && (check || backfill)) {
    reporter.error(
      "--init-issue-types cannot be combined with --check or --backfill — it provisions org " +
        "Issue Types and reconciles no tracker rows. Run it on its own.",
    );
    reporter.finish();
    process.exit(1);
  }

  // Both one-shots are their own runner, so combining them with each other or
  // with a tracker-reconciliation flag is always a mistake rather than a
  // composition — say so instead of silently honouring one and dropping the
  // rest. (--backfill, by contrast, IS composable with --apply: it is a phase
  // of the same reconciliation.)
  if (retypeClosed && (check || backfill || initIssueTypes)) {
    reporter.error(
      "--retype-closed cannot be combined with --check, --backfill or --init-issue-types — it is a " +
        "one-shot pass over closed issues. Run it on its own.",
    );
    reporter.finish();
    process.exit(1);
  }

  if (initIssueTypes) {
    const outcome = runIssueTypeInit({ runGh, reporter, apply });
    if (!outcome.ok) process.exit(1);
    process.exit(0);
  }

  if (retypeClosed) {
    const outcome = runClosedRetype({ runGh, reporter, apply, readDoc });
    if (!outcome.ok) process.exit(1);
    process.exit(0);
  }

  const outcome = runIssueSync({
    runGh,
    reporter,
    apply,
    check,
    backfill,
    readDoc,
  });
  if (!outcome.ok) process.exit(1);
}
