#!/usr/bin/env node
/**
 * One-off historical measurement (ADR-0030's `--json` shape) for the
 * Should-fix acknowledgment gate (docs/adr/0097, PRs #1075/#1082/#1110).
 * Before that gate shipped, no surface in the repo read the Should-fix tier
 * at all — this script answers the question the audit that motivated the
 * gate could not answer live (GitHub access was down at the time): across
 * every merged PR, how often did a posted Should-fix finding go
 * unaccounted-for, and by which failure mode?
 *
 * Fetches every merged PR via the GitHub GraphQL API (paginated), reads each
 * PR's changed-file list and `claude[bot]` comment history, reads the local
 * squash-merge commit's message for an acknowledgment footer, and classifies
 * each PR with `bin/lib/should-fix-backfill.mjs`'s `classifyPr`. Writes a
 * dated report to `docs/logs/` (unless `--dry-run` is given) and prints a
 * summary.
 *
 * Usage:
 *   node bin/backfill-should-fix.mjs [--json] [--dry-run] [--limit N] [--page-size N] [--out <path>]
 *
 *   --json        ADR-0030 structured payload instead of human-readable
 *                 progress lines. The report file is still written (or not,
 *                 per --dry-run) regardless of this flag — it only changes
 *                 what this process prints.
 *   --dry-run     Fetch and classify, but do not write the report file.
 *   --limit N     Stop after classifying N merged PRs (oldest-first paging
 *                 order) — for a fast local smoke run, not the full backfill.
 *   --page-size N GraphQL page size (default 25). Lower it if a page's
 *                 response ever exceeds GitHub's node-cost budget.
 *   --out <path>  Report path, repo-relative (default
 *                 docs/logs/<today>-should-fix-backfill.md).
 *
 * Exit codes: 0 on a completed run (classification "uncertain" cases and
 * ambiguous categories are reported, not treated as failures — this is a
 * measurement, not a gate); 1 if `gh` auth or the GraphQL fetch itself
 * fails.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPr, summarizeResults } from "./lib/should-fix-backfill.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const REPO = "monte3l/m3l-automation";
const [OWNER, REPO_NAME] = REPO.split("/");
const DEFAULT_PAGE_SIZE = 25;
const FILES_PER_PR = 100;
const COMMENTS_PER_PR = 100;

/**
 * The single injected `gh` execution seam — mirrors `sync-hub-issues.mjs`'s
 * `runGh`, so a test double can be swapped in without touching call sites.
 *
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  return execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

/** @param {unknown} cause */
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

/** @param {(args: string[]) => string} runGhFn */
function checkGhAuth(runGhFn) {
  try {
    runGhFn(["auth", "status"]);
    return null;
  } catch (cause) {
    return `gh auth status failed — run \`gh auth login\` first: ${ghErrorMessage(cause)}`;
  }
}

const MERGED_PRS_QUERY = `
  query($owner: String!, $repo: String!, $pageSize: Int!, $cursor: String, $filesPerPr: Int!, $commentsPerPr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: MERGED, first: $pageSize, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          mergedAt
          mergedBy { login }
          autoMergeRequest { enabledAt }
          mergeCommit { oid }
          files(first: $filesPerPr) {
            nodes { path }
            pageInfo { hasNextPage }
          }
          comments(first: $commentsPerPr) {
            nodes { author { login __typename } body createdAt }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  }
`;

/**
 * Fetch every merged PR's GraphQL node, oldest first, paging until either
 * GitHub reports no further page or `limit` PRs have been collected.
 *
 * @param {(args: string[]) => string} runGhFn
 * @param {{ pageSize: number, limit: number | null, onPage?: (count: number) => void }} opts
 * @returns {object[]} raw GraphQL PR nodes
 */
function fetchMergedPrNodes(runGhFn, { pageSize, limit, onPage }) {
  /** @type {object[]} */
  const nodes = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage && (limit === null || nodes.length < limit)) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${MERGED_PRS_QUERY}`,
      "-f",
      `owner=${OWNER}`,
      "-f",
      `repo=${REPO_NAME}`,
      "-F",
      `pageSize=${pageSize}`,
      "-F",
      `filesPerPr=${FILES_PER_PR}`,
      "-F",
      `commentsPerPr=${COMMENTS_PER_PR}`,
    ];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);

    const raw = runGhFn(args);
    const parsed = JSON.parse(raw);
    if (parsed.errors) {
      throw new Error(
        `GraphQL error fetching merged PRs: ${JSON.stringify(parsed.errors)}`,
      );
    }
    const connection = parsed.data.repository.pullRequests;
    nodes.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
    onPage?.(nodes.length);
  }

  return limit === null ? nodes : nodes.slice(0, limit);
}

/**
 * The squash-merge commit's full message, read from local git history —
 * available for any commit reachable from `main`, no GitHub call needed.
 * GitHub's default squash message concatenates every original commit's own
 * message as a `* ...` bullet (verified against #1082's real merge commit,
 * which carries its `Acknowledged-Should-Fix`-footer-free follow-up commits
 * verbatim), so a footer landed on ANY commit in the branch is visible here.
 *
 * @param {string} oid
 * @returns {string | null} `null` if the commit is unreachable locally — this
 *   repo has undergone at least one history rewrite (see
 *   `resolving-merge-conflicts`'s "absurd ahead/behind count" step), which
 *   orphaned some early PRs' original merge-commit SHAs entirely (confirmed
 *   live: PR #1's recorded merge oid resolves to "fatal: bad object", and no
 *   commit in current history even carries its `(#1)` subject suffix — the
 *   commit is gone, not just renamed). The caller treats `null` as
 *   `mergeCommitUnreachable`, distinct from a real (if empty) body.
 */
function readMergeCommitBody(oid) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%B", oid], {
      cwd: root,
      encoding: "utf8",
      // `git log` writes "fatal: bad object <oid>" to stderr on the
      // unreachable case above; swallow it rather than let it leak past the
      // caught error below — the null fallback is already the correct
      // fail-open response, so the raw git error is noise, not a
      // diagnostic.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * @param {object} node Raw GraphQL PR node.
 * @returns {import("./lib/should-fix-backfill.mjs").BackfillPrInput}
 */
function toBackfillInput(node) {
  const mergeCommitBody =
    node.mergeCommit?.oid != null
      ? readMergeCommitBody(node.mergeCommit.oid)
      : null;
  return {
    number: node.number,
    mergedAt: node.mergedAt,
    mergedByLogin: node.mergedBy?.login ?? null,
    autoMergeUsed: node.autoMergeRequest !== null,
    mergeCommitBody: mergeCommitBody ?? "",
    mergeCommitUnreachable: mergeCommitBody === null,
    filePaths: (node.files?.nodes ?? []).map((f) => f.path),
    filesTruncated: node.files?.pageInfo?.hasNextPage === true,
    comments: (node.comments?.nodes ?? []).map((c) => ({
      login: c.author?.login ?? "",
      isBot: c.author?.__typename === "Bot",
      body: c.body ?? "",
    })),
    commentsTruncated: node.comments?.pageInfo?.hasNextPage === true,
  };
}

const CATEGORY_LABELS = {
  "review-excluded": "Review-excluded (docs/config-only, never reviewed)",
  "no-review-posted": "No claude[bot] review ever posted",
  "no-should-fix": "Reviewed, no Should-fix finding ever posted",
  "acknowledged-footer":
    "Should-fix posted, Acknowledged-Should-Fix: footer present",
  "resolve-commit-heuristic":
    "Should-fix posted, no footer — a pre-ADR-0097 'resolve claude-pr-review findings' commit exists (weak evidence, not proof)",
  "multi-round-suppressed":
    "Should-fix posted, no footer/resolve-commit — multiple review rounds occurred (indeterminate: REVIEW.md suppresses fresh bullets after round 1)",
  "merged-unresolved":
    "Should-fix posted, no footer/resolve-commit, exactly one review round — merged with no further review activity",
};

const CATEGORY_ORDER = [
  "review-excluded",
  "no-review-posted",
  "no-should-fix",
  "acknowledged-footer",
  "resolve-commit-heuristic",
  "multi-round-suppressed",
  "merged-unresolved",
];

/**
 * Render the markdown report body.
 *
 * @param {import("./lib/should-fix-backfill.mjs").BackfillPrResult[]} results
 * @param {ReturnType<typeof summarizeResults>} summary
 * @param {{ today: string, fetchedAt: string }} meta
 * @returns {string}
 */
function renderReport(results, summary, meta) {
  const candidateTotal =
    summary.total -
    (summary.byCategory["review-excluded"] ?? 0) -
    (summary.byCategory["no-review-posted"] ?? 0);

  const lines = [];
  lines.push(`# Work log — should-fix-backfill (${meta.today})`);
  lines.push("");
  lines.push(
    "This log is the output of `bin/backfill-should-fix.mjs` (PR 4 of the Should-fix " +
      "acknowledgment gate sequence, [`docs/adr/0097`](../adr/0097-should-fix-acknowledgment-gate.md)) " +
      "— the historical measurement the audit that produced ADR-0097 could not run live " +
      "(GitHub access was unavailable at the time). It classifies every merged pull request's " +
      "Should-fix disposition retroactively, before the gate existed to enforce anything.",
  );
  lines.push("");
  lines.push(
    `Fetched: ${meta.fetchedAt}. Total merged PRs examined: **${summary.total}**.`,
  );
  lines.push("");

  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "For each merged PR: fetch its changed-file list and full comment history via the GitHub " +
      "GraphQL API, filter comments to the review bot (GraphQL reports its login as `claude` " +
      'with `author.__typename == "Bot"` — NOT `claude[bot]`, the REST API\'s `user.login` ' +
      "value `check-should-fix-ack.mjs` matches on instead), and reuse the SAME parsers the " +
      "live gate uses (`bin/lib/pr-review-gate.mjs`'s `selectShouldFixComment`/`parseShouldFixSection`/" +
      "`countShouldFixFindings`) so this measurement can never disagree with the gate about what " +
      "counts as a finding. Acknowledgment/resolution evidence is read from the squash-merge " +
      "commit's message via local `git log`, which concatenates every original commit's own " +
      "message as a `* ...` bullet — so an `Acknowledged-Should-Fix:` footer or a pre-ADR-0097 " +
      "resolve-commit on any commit in the branch is visible there even though the branch itself " +
      "no longer exists post-merge. Classification logic: `bin/lib/should-fix-backfill.mjs`'s " +
      "`classifyPr`.",
  );
  lines.push("");
  lines.push(
    "**Two caveats stated explicitly, not papered over (per the plan of record):**",
  );
  lines.push("");
  lines.push(
    '- REVIEW.md\'s "Re-review convergence" rule suppresses fresh Should-fix bullets to a ' +
      "count-only summary on every review round after the first. This script — like the live " +
      "gate — cannot distinguish a Should-fix finding that was silently fixed from one that was " +
      "silently carried forward once a PR reaches a second review round. Those cases are tagged " +
      "`multi-round-suppressed`: **indeterminate, not resolved.**",
  );
  lines.push(
    "- This measurement reads only `claude[bot]`'s posted PR review comments (the CI gate) — " +
      "never local spoke review output (`code-reviewer`, `security-reviewer`, etc.) that work " +
      'logs sometimes narrate as "review verdicts." Those are a different population and are ' +
      "not merged with this one.",
  );
  lines.push("");

  lines.push("## Results by category");
  lines.push("");
  lines.push("| Category | Count | % of total | Auto-merge | Manual |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const category of CATEGORY_ORDER) {
    const count = summary.byCategory[category] ?? 0;
    const pct =
      summary.total > 0 ? ((count / summary.total) * 100).toFixed(1) : "0.0";
    const modeBucket = summary.modeByCategory[category];
    const autoMerge = modeBucket ? String(modeBucket["auto-merge"]) : "—";
    const manual = modeBucket ? String(modeBucket.manual) : "—";
    lines.push(
      `| ${CATEGORY_LABELS[category]} | ${count} | ${pct}% | ${autoMerge} | ${manual} |`,
    );
  }
  lines.push("");
  lines.push(
    `Of ${summary.total} merged PRs, **${candidateTotal}** were candidates (not review-excluded, ` +
      `had a posted review). ${summary.uncertainCount} PR(s) had a truncated files/comments page ` +
      "(GitHub's GraphQL connections were fetched at their maximum page size, 100 — a PR with " +
      "more files or comments than that is marked † below) and their classification may be " +
      "wrong in either direction; spot-check those before trusting them.",
  );
  lines.push("");

  const acknowledgedNumbers = results
    .filter((r) => r.category === "acknowledged-footer")
    .map((r) => `#${r.number}${r.uncertain ? "†" : ""}`);
  lines.push(
    `**${CATEGORY_LABELS["acknowledged-footer"]}** (${acknowledgedNumbers.length}):`,
  );
  lines.push("");
  // Fenced, not a bare paragraph: a PR-number list is data, and a bare line
  // starting with "#NNN" is misread by the markdown linter as an ATX heading
  // with no space after the `#` (MD018) — the same trap ADR-0097's own draft
  // hit with a mid-sentence "#723" (docs/adr/0097's own history).
  lines.push("```text");
  lines.push(
    acknowledgedNumbers.length > 0 ? acknowledgedNumbers.join(", ") : "None.",
  );
  lines.push("```");
  lines.push("");

  const unresolvedCategories = [
    "resolve-commit-heuristic",
    "multi-round-suppressed",
    "merged-unresolved",
  ];
  lines.push("## PRs needing acknowledgment that never got one");
  lines.push("");
  lines.push(
    "Every PR in `resolve-commit-heuristic`, `multi-round-suppressed`, or `merged-unresolved` " +
      "— i.e. every PR that posted a Should-fix finding and carries no `Acknowledged-Should-Fix:` " +
      "footer. Grouped by category; PR numbers only (see the raw JSON for full detail, produced " +
      "via `--json`).",
  );
  lines.push("");
  for (const category of unresolvedCategories) {
    const numbers = results
      .filter((r) => r.category === category)
      .map((r) => `#${r.number}${r.uncertain ? "†" : ""}`);
    lines.push(`**${CATEGORY_LABELS[category]}** (${numbers.length}):`);
    lines.push("");
    lines.push("```text");
    lines.push(numbers.length > 0 ? numbers.join(", ") : "None.");
    lines.push("```");
    lines.push("");
  }
  lines.push(
    "† truncated files/comments page — spot-check before trusting this classification.",
  );
  lines.push("");

  lines.push("## Lessons");
  lines.push("");
  lines.push(
    "- The dominant historical failure mode was never auto-merge or a manual override of a " +
      "known-pending finding — it was structural silence: nothing read the Should-fix tier at " +
      "all before ADR-0097, so a posted finding left no local trace regardless of how the PR " +
      "merged. This measurement's own `mode` column corroborates the audit's live-code finding " +
      "(`creating-prs` SKILL.md defaults to plain `gh pr merge --squash`, never `--auto`): the " +
      "vast majority of PRs in every category merged `manual`, not `auto-merge`.",
  );
  lines.push(
    "- `multi-round-suppressed` cannot be resolved into `resolved`/`unresolved` after the fact — " +
      "REVIEW.md's convergence rule destroys that information at review time, not just at " +
      "measurement time. Any future gate change wanting real historical resolution data would " +
      "need REVIEW.md itself to restate current Should-fix status on every round, not a smarter " +
      "parser here.",
  );
  lines.push("");

  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  const dryRun = argv.includes("--dry-run");
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : null;
  const pageSizeIndex = argv.indexOf("--page-size");
  const pageSize =
    pageSizeIndex >= 0 ? Number(argv[pageSizeIndex + 1]) : DEFAULT_PAGE_SIZE;
  const outIndex = argv.indexOf("--out");
  const today = new Date().toISOString().slice(0, 10);
  const outPath =
    outIndex >= 0
      ? argv[outIndex + 1]
      : `docs/logs/${today}-should-fix-backfill.md`;

  const authError = checkGhAuth(runGh);
  if (authError !== null) {
    reporter.error(authError);
    reporter.finish();
    process.exit(1);
  }

  try {
    reporter.info(`Fetching merged PRs for ${REPO}...`);
    const nodes = fetchMergedPrNodes(runGh, {
      pageSize,
      limit,
      onPage: (count) => reporter.info(`  ...${count} PRs fetched so far`),
    });

    reporter.info(`Classifying ${nodes.length} merged PRs...`);
    const results = nodes.map((node) => classifyPr(toBackfillInput(node)));
    const summary = summarizeResults(results);

    if (!dryRun) {
      const report = renderReport(results, summary, {
        today,
        fetchedAt: new Date().toISOString(),
      });
      writeFileSync(
        join(root, outPath),
        `${report}\n`.replace(/\n\n\n+/g, "\n\n"),
      );
      reporter.change("created", outPath);
    }

    reporter.succeed(
      `Classified ${summary.total} merged PRs: ` +
        CATEGORY_ORDER.map((c) => `${c}=${summary.byCategory[c] ?? 0}`).join(
          ", ",
        ),
    );
    reporter.finish({ prs: results, stats: summary });
    process.exit(0);
  } catch (error) {
    reporter.error(error instanceof Error ? error.message : String(error));
    reporter.finish();
    process.exit(1);
  }
}

export {
  fetchMergedPrNodes,
  readMergeCommitBody,
  renderReport,
  toBackfillInput,
};
