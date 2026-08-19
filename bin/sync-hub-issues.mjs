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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractImplementation, extractRoadmap } from "./lib/project-hub.mjs";
import {
  actionableItems,
  HUB_LABEL,
  planBackfill,
  planIssueSync,
  planMilestones,
} from "./lib/hub-sync.mjs";
import { LABEL_DEFS } from "./lib/label-defs.mjs";
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
function loadExistingMilestoneTitles(runGhFn) {
  const raw = runGhFn([
    "api",
    `repos/${REPO}/milestones?state=all`,
    "--paginate",
  ]);
  return parseJsonArray(raw, "milestones").map((milestone) => milestone.title);
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
    "number,title,body,state,labels",
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
  }));
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

function createMilestone(runGhFn, title) {
  runGhFn([
    "api",
    `repos/${REPO}/milestones`,
    "-X",
    "POST",
    "-f",
    `title=${title}`,
  ]);
}

// Returns the created issue's number, parsed from `gh issue create`'s
// printed URL (`.../issues/<number>`) — `gh issue create` has no `--json`
// output mode, unlike list/view. The normal create path (issuePlan.create)
// doesn't need the number (the next sync run finds it via its marker) and
// discards the return value; the backfill path does, to close the issue in
// the same pass.
function createIssue(runGhFn, payload) {
  const args = [
    "issue",
    "create",
    "-R",
    REPO,
    "--title",
    payload.title,
    "--body",
    payload.body,
  ];
  for (const label of payload.labels) args.push("--label", label);
  if (payload.milestoneTitle !== null) {
    args.push("--milestone", payload.milestoneTitle);
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

function printPlan(reporter, milestonePlan, issuePlan) {
  reporter.info(`Milestones to create (${milestonePlan.create.length}):`);
  for (const title of milestonePlan.create) reporter.info(`  + ${title}`);

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

  reporter.info(`Untouched: ${issuePlan.untouched.length}`);
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

    const existingMilestoneTitles = loadExistingMilestoneTitles(runGhFn);
    const existingIssues = loadExistingIssues(runGhFn, reporter);
    if (existingIssues === null) {
      reporter.finish();
      return { ok: false };
    }
    const existingIssuesByNumber = new Map(
      existingIssues.map((issue) => [issue.number, issue]),
    );

    const milestonePlan = planMilestones(items, existingMilestoneTitles);
    const issuePlan = planIssueSync(items, existingIssues);

    let backfillPlan = null;
    if (backfill) {
      const allIssues = loadAllIssues(runGhFn, reporter);
      if (allIssues === null) {
        reporter.finish();
        return { ok: false };
      }
      backfillPlan = planBackfill(items, allIssues);
    }

    printPlan(reporter, milestonePlan, issuePlan);
    printBackfillPlan(reporter, backfillPlan);

    if (!apply) {
      const planIsEmpty =
        milestonePlan.create.length === 0 &&
        issuePlan.create.length === 0 &&
        issuePlan.update.length === 0 &&
        issuePlan.close.length === 0 &&
        issuePlan.reopen.length === 0;
      const summary = {
        applied: false,
        milestones: { create: milestonePlan.create.length },
        issues: {
          create: issuePlan.create.length,
          update: issuePlan.update.length,
          close: issuePlan.close.length,
          reopen: issuePlan.reopen.length,
          untouched: issuePlan.untouched.length,
        },
        ...(backfillPlan && {
          backfill: {
            create: backfillPlan.create.length,
            needsReview: backfillPlan.needsReview.length,
          },
        }),
      };

      if (check && !planIsEmpty) {
        reporter.error(
          "Tracker/GitHub drift detected — the docs/ROADMAP.md and " +
            "docs/plans/IMPLEMENTATION.md trackers no longer match GitHub " +
            "Issues/Milestones. Run `pnpm sync:hub -- --apply` (maintainer-local, " +
            "needs your own `gh` auth) to reconcile.",
        );
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
          : `Dry run — pass --apply to execute. Would create ${milestonePlan.create.length} milestone(s); ` +
            `${issuePlan.create.length} issue(s) to create, ${issuePlan.update.length} to update, ` +
            `${issuePlan.close.length} to close, ${issuePlan.reopen.length} to reopen, ` +
            `${issuePlan.untouched.length} untouched.`) + backfillSummary,
      );
      reporter.finish(summary);
      return { ok: true };
    }

    bootstrapLabels(runGhFn);

    for (const title of milestonePlan.create) {
      createMilestone(runGhFn, title);
      reporter.change("created", `milestone: ${title}`);
    }

    for (const { key, payload } of issuePlan.create) {
      createIssue(runGhFn, payload);
      reporter.change("created", `issue [${key}] ${payload.title}`);
    }

    for (const { number, key, payload } of issuePlan.update) {
      editIssue(runGhFn, number, payload, existingIssuesByNumber.get(number));
      reporter.change("updated", `issue #${number} [${key}]`);
    }

    for (const { number, key, comment, reason } of issuePlan.close) {
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
    reporter.succeed(
      `Applied: ${milestonePlan.create.length} milestone(s) created; ${issuePlan.create.length} issue(s) created, ` +
        `${issuePlan.update.length} updated, ${issuePlan.close.length} closed, ${issuePlan.reopen.length} reopened.` +
        backfillAppliedSummary,
    );
    reporter.finish({
      applied: true,
      milestones: { create: milestonePlan.create.length },
      issues: {
        create: issuePlan.create.length,
        update: issuePlan.update.length,
        close: issuePlan.close.length,
        reopen: issuePlan.reopen.length,
        untouched: issuePlan.untouched.length,
      },
      ...(backfillPlan && {
        backfill: {
          create: backfillPlan.create.length,
          needsReview: backfillPlan.needsReview.length,
        },
      }),
    });
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
  const reporter = createReporter(json);

  if (apply && check) {
    reporter.error("--apply and --check are mutually exclusive.");
    reporter.finish();
    process.exit(1);
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
