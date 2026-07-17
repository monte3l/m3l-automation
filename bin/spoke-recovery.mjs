#!/usr/bin/env node
// Automates the FIRST step of the manual truncation-recovery playbook
// (docs/contributing/subagent-context-management.md, ADR-0030 Phase 6). An
// audit of docs/logs/*.md found subagent mid-turn truncation is this repo's
// single most-recurring build divergence — 20+ logged occurrences — and the
// hub's recovery routine (re-read the spoke's journal, verify on-disk state
// with `git status`/`git diff`, optionally re-run the targeted tests, then
// decide resume-vs-redispatch) was entirely manual. This script performs
// exactly those deterministic checks and proposes a recommendation; it is
// NOT a replacement for hub judgment — the hub still decides, this just
// removes the toil of re-deriving "what actually happened" by hand.
//
// Usage:
//   node bin/spoke-recovery.mjs --journal <path>
//   node bin/spoke-recovery.mjs --journal <path> --expected "src/a.ts,src/b/**"
//   node bin/spoke-recovery.mjs --journal <path> --test "core/retry" --json
//
// Flags:
//   --journal <path>   Path to the spoke's scratchpad journal (required). A
//                       missing/unreadable file is the playbook's "no durable
//                       trace" case — this exits 1 and still recommends
//                       redispatch-with-decomposition, never a bare failure.
//   --expected <list>  Comma-separated file globs/paths the dispatch intended
//                       to touch. Cross-referenced against `git status
//                       --porcelain` to see which were actually modified.
//   --test <pattern>   A vitest file/pattern to run (`pnpm vitest run
//                       --reporter=json <pattern>`) to verify the claimed
//                       work is actually green. Optional — omitted by default
//                       since it can take minutes; the MCP tool wrapping this
//                       script deliberately never sets it (see
//                       bin/lib/mcp-tools.mjs's spoke_recover for why).
//   --json             Machine-readable single-line JSON payload on stdout
//                       instead of the human summary block.
//
// Exit contract (mirrors bin/check-doc-provenance.mjs's "Exit contract"):
// exit 0 ONLY when recommendation.action is "none" — on-disk state is fully
// verified and there is nothing left outstanding. Exit 1 for "resume",
// "redispatch", and "unverifiable" alike: each demands the hub take an
// action (resume the spoke, redispatch fresh, or first fix whatever broke
// on-disk verification) rather than proceed unattended. A missing --journal
// flag or an unreadable journal file both short-circuit to "redispatch" and
// so also exit 1, before any git/test verification runs at all.
//
// The pure logic — parseJournalEntries, outstandingPending, recommend,
// matchesExpected, and globToRegExp — is exported so it can be unit-tested
// directly without spawning git/vitest or touching process.exit; the CLI
// body (main()) only runs when this file is executed directly (see the
// process.argv[1] guard at the bottom), mirroring bin/mcp-server.mjs /
// .claude/hooks/guard-secret-writes.mjs.
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// How many of the journal's parsed log entries to surface — enough to show
// recent progress without dumping an entire multi-hour journal into the
// recommendation payload.
const JOURNAL_TAIL_ENTRIES = 20;

// Generous — a targeted vitest run can still take a while under coverage or
// on a cold cache; this is a deliberate CLI-only affordance (never wired
// through the MCP tool, which stays read-only and fast).
const TEST_SPAWN_TIMEOUT_MS = 10 * 60 * 1000;

// Shared across every spawnSync call below (git status/diff, the optional
// vitest run) — large enough for a big monorepo diff or a verbose test
// report without truncating the captured stdout.
const SPAWN_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Parse `--flag value` out of an argv array without consuming a shared flag
 * parser dependency — mirrors the `indexOf` idiom already used by
 * bin/check-doc-provenance.mjs's `--affected`.
 *
 * @param {string[]} argv
 * @param {string} flag e.g. "--journal"
 * @returns {string | undefined}
 */
function flagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

// A negated completion claim ("not done yet", "not yet complete", "isn't
// finished") must classify as pending, not done — checked BEFORE the plain
// done-keyword match below, since "not done yet" would otherwise satisfy
// the done pattern first (it contains the word "done"). Handles both word
// orders ("not done yet" and "not yet done").
const NEGATED_DONE_PATTERN =
  /\bnot\s+(?:yet\s+)?(?:done|complete(?:d)?|verified|finished)(?:\s+yet)?\b|\bisn'?t\s+(?:yet\s+)?(?:done|complete(?:d)?|verified|finished)\b/i;
const DONE_PATTERN = /\b(?:done|complete(?:d)?|verified|finished)\b/i;
const DONE_MARK_PATTERN = /[✓✔]/;
// "not done"/"not complete"/etc. is intentionally absent here — it's fully
// covered by NEGATED_DONE_PATTERN above, checked first.
const PENDING_PATTERN =
  /\b(?:blocked|blocker|next|todo|to-do|in[\s-]progress|started|pending|remaining)\b/i;

/**
 * Classify one journal log-line's free text into a coarse status. Journals
 * are freeform markdown bullet logs (per the writer-spoke prompts), so this
 * is deliberately forgiving rather than a strict grammar.
 *
 * @param {string} text
 * @returns {"done" | "pending" | "unknown"}
 */
function classifyStatus(text) {
  if (NEGATED_DONE_PATTERN.test(text)) return "pending";
  if (DONE_PATTERN.test(text) || DONE_MARK_PATTERN.test(text)) return "done";
  if (PENDING_PATTERN.test(text)) return "pending";
  return "unknown";
}

/**
 * Parse a journal's markdown text into an ordered list of log/checklist
 * entries. Recognizes checkbox bullets (`- [ ]`/`- [x]`), plain bullets
 * (`-`/`*`), and numbered list items — the shapes the writer-spoke prompts
 * actually produce — and is silent (skips the line) on anything else
 * (headings, prose paragraphs).
 *
 * @param {string} content
 * @returns {{ text: string, status: "done" | "pending" | "unknown", marker: "checkbox" | "bullet" }[]}
 */
export function parseJournalEntries(content) {
  /** @type {{ text: string, status: "done" | "pending" | "unknown", marker: "checkbox" | "bullet" }[]} */
  const entries = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const checkbox = /^[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (checkbox) {
      const checked = checkbox[1].toLowerCase() === "x";
      entries.push({
        text: checkbox[2].trim(),
        status: checked ? "done" : "pending",
        marker: "checkbox",
      });
      continue;
    }

    const bullet = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (bullet) {
      const text = bullet[1].trim();
      entries.push({ text, status: classifyStatus(text), marker: "bullet" });
    }
  }
  return entries;
}

/**
 * Run `git status --porcelain` in `cwd` and parse it into per-file records.
 * Handles the rename form (`R  old -> new`, reporting the new path).
 *
 * @param {string} cwd
 * @returns {{ modified: string[], error: string | null }}
 */
function gitStatusPorcelain(cwd) {
  const res = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER_BYTES,
  });
  if (res.error || res.status !== 0) {
    const message =
      res.error?.message ?? res.stderr?.trim() ?? "git status failed";
    return { modified: [], error: message };
  }
  const modified = res.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const pathPart = line.slice(3);
      const arrow = pathPart.indexOf(" -> ");
      const file = arrow === -1 ? pathPart : pathPart.slice(arrow + 4);
      return file.replace(/^"|"$/g, "");
    });
  return { modified, error: null };
}

/**
 * Run `git diff --stat` in `cwd`, returning the raw text (tail-limited).
 *
 * @param {string} cwd
 * @returns {{ raw: string, error: string | null }}
 */
function gitDiffStat(cwd) {
  const res = spawnSync("git", ["diff", "--stat"], {
    cwd,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER_BYTES,
  });
  if (res.error || res.status !== 0) {
    const message =
      res.error?.message ?? res.stderr?.trim() ?? "git diff failed";
    return { raw: "", error: message };
  }
  return { raw: res.stdout.trim(), error: null };
}

/**
 * Convert a `--expected` glob (`**`/`*` supported) into a RegExp anchored to
 * the full (forward-slash-normalized) path.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, "/");
  const DOUBLE_STAR = " DOUBLESTAR ";
  const withPlaceholder = normalized.split("**").join(DOUBLE_STAR);
  const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped.replace(/\*/g, "[^/]*");
  const restored = withStars.split(DOUBLE_STAR).join(".*");
  return new RegExp(`^${restored}$`);
}

/**
 * Whether `modifiedPath` satisfies one `--expected` entry — either as a glob
 * match or, for a plain (wildcard-free) entry, an exact match or a directory
 * prefix match (an expected package/module directory whose files changed).
 *
 * @param {string} modifiedPath
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesExpected(modifiedPath, pattern) {
  const normalizedPath = modifiedPath.replace(/\\/g, "/");
  if (globToRegExp(pattern).test(normalizedPath)) return true;
  if (pattern.includes("*")) return false;
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/\/$/, "");
  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`)
  );
}

/**
 * Spawn a targeted `pnpm vitest run --reporter=json <pattern>` and summarize
 * pass/fail plus counts. Parse failures (e.g. no JSON on stdout, a config
 * error) still surface a usable `pass: false` result with a diagnostic tail
 * rather than throwing.
 *
 * @param {string} pattern
 * @param {string} cwd
 * @returns {{ command: string, pass: boolean, total: number | null, passed: number | null, failed: number | null, raw: string }}
 */
function runTargetedTests(pattern, cwd) {
  const command = `pnpm vitest run --reporter=json ${pattern}`;
  const res = spawnSync("pnpm", ["vitest", "run", "--reporter=json", pattern], {
    cwd,
    encoding: "utf8",
    timeout: TEST_SPAWN_TIMEOUT_MS,
    maxBuffer: SPAWN_MAX_BUFFER_BYTES,
  });
  if (res.error) {
    return {
      command,
      pass: false,
      total: null,
      passed: null,
      failed: null,
      raw: res.error.message,
    };
  }
  try {
    const data = JSON.parse(res.stdout);
    const passed =
      typeof data.numPassedTests === "number" ? data.numPassedTests : null;
    const failed =
      typeof data.numFailedTests === "number" ? data.numFailedTests : null;
    const total =
      typeof data.numTotalTests === "number" ? data.numTotalTests : null;
    return {
      command,
      pass: res.status === 0,
      total,
      passed,
      failed,
      raw: tailLines(`${res.stdout}\n${res.stderr ?? ""}`, 20),
    };
  } catch {
    return {
      command,
      pass: res.status === 0,
      total: null,
      passed: null,
      failed: null,
      raw: tailLines(`${res.stdout ?? ""}\n${res.stderr ?? ""}`, 20),
    };
  }
}

/**
 * Keep only the last `n` non-blank lines of `text`.
 *
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
function tailLines(text, n) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-n)
    .join("\n");
}

/**
 * Find entries still outstanding as of the END of the journal. A freeform
 * log is chronological, not a maintained checklist — a "Next: X" or an
 * unchecked `- [ ]` bullet logged early is routinely superseded by a later
 * "DONE"/"TASK COMPLETE" entry without the writer ever going back to edit
 * the earlier line or tick its checkbox (the common real-world shape; see
 * the sidecar-backfill.md incident this heuristic was built against). Only
 * a "pending"-classified entry that occurs AFTER the LAST "done"-classified
 * entry counts as genuinely still open; earlier pending markers are treated
 * as resolved by that later completion signal.
 *
 * CAVEAT — interleaved workstreams: this heuristic assumes one journal
 * tracks one linear workstream, which is the dispatch convention (a single
 * spoke works one scoped task per journal). If a journal instead interleaves
 * two parallel workstreams (A and B) in one log, a later "done" entry for B
 * can retroactively mask an earlier still-open "pending" entry for A — the
 * position-based cutoff has no per-workstream awareness. Don't hand one
 * spoke a journal spanning multiple independent workstreams if this
 * function's output needs to be trustworthy per-item.
 *
 * @param {ReturnType<typeof parseJournalEntries>} entries
 * @returns {ReturnType<typeof parseJournalEntries>}
 */
export function outstandingPending(entries) {
  let lastDoneIndex = -1;
  entries.forEach((entry, index) => {
    if (entry.status === "done") lastDoneIndex = index;
  });
  return entries.filter(
    (entry, index) => entry.status === "pending" && index > lastDoneIndex,
  );
}

/**
 * Encode the playbook's resume-vs-redispatch rules
 * (docs/contributing/subagent-context-management.md): a journal with
 * verified partial progress that on-disk state corroborates recommends a
 * scoped resume; an absent/empty journal, or one on-disk state contradicts,
 * recommends a fresh decomposed redispatch; on-disk verification itself
 * failing (e.g. `git status` errored) is its own "unverifiable" outcome —
 * distinct from a confirmed contradiction, since we genuinely don't know
 * what's on disk; and a journal with nothing left outstanding and disk/tests
 * both green needs no recovery at all.
 *
 * @param {{ entries: ReturnType<typeof parseJournalEntries> }} journal
 * @param {{ modified: string[], untouchedExpected: string[], expectedGiven: boolean, expectedTotal: number, verified: boolean, error: string | null }} disk
 * @param {ReturnType<typeof runTargetedTests> | null} tests
 * @returns {{ action: "resume" | "redispatch" | "none" | "unverifiable", punchList: string[], rationale: string }}
 */
export function recommend(journal, disk, tests) {
  if (journal.entries.length === 0) {
    return {
      action: "redispatch",
      punchList: [],
      rationale:
        "Journal is readable but has no parseable progress markers (no " +
        "bullets/checkboxes) — treat as no durable trace and redispatch " +
        "fresh with a more decomposed scope.",
    };
  }

  // Checked BEFORE any decision that reads disk.modified/untouchedExpected —
  // if git itself failed, `modified` is an empty placeholder, not a genuine
  // "nothing changed" signal. Treating that as a confirmed contradiction
  // (the next branch below) would tell the hub a confident but false story.
  if (disk.verified === false) {
    return {
      action: "unverifiable",
      punchList: [],
      rationale:
        "On-disk state could not be verified — `git status --porcelain` " +
        `failed${disk.error ? ` (${disk.error})` : ""}. This is neither a ` +
        "confirmed resume nor a confirmed redispatch — fix why git failed " +
        "(e.g. run from inside a valid git worktree) and re-run " +
        "spoke-recovery before deciding.",
    };
  }

  if (disk.modified.length === 0) {
    return {
      action: "redispatch",
      punchList: [],
      rationale:
        "Journal logs progress, but `git status --porcelain` shows NO " +
        "modified files — on-disk state contradicts the journal. " +
        "Redispatch fresh rather than resuming against state that doesn't " +
        "exist.",
    };
  }

  // `disk.modified` is non-empty here (handled above), so this catches the
  // narrower contradiction: something changed, but none of it is any of the
  // paths this dispatch was scoped to touch.
  const expectedAllUntouched =
    disk.expectedGiven && disk.untouchedExpected.length === disk.expectedTotal;
  if (expectedAllUntouched) {
    return {
      action: "redispatch",
      punchList: [],
      rationale:
        "Files changed on disk, but NONE of the --expected paths show as " +
        "modified — on-disk state contradicts the journal's claimed scope. " +
        "Redispatch fresh, decomposed.",
    };
  }

  const pendingItems = outstandingPending(journal.entries);

  if (tests !== null && !tests.pass) {
    const punchList =
      pendingItems.length > 0
        ? pendingItems.map((e) => e.text)
        : [`Fix failing tests: ${tests.command}`];
    return {
      action: "resume",
      punchList,
      rationale:
        "Work exists on disk and the journal shows progress, but the " +
        "targeted test run failed — resume the SAME spoke (not a fresh " +
        "dispatch) with a punch-list scoped to what's still failing.",
    };
  }

  if (pendingItems.length > 0) {
    return {
      action: "resume",
      punchList: pendingItems.map((e) => e.text),
      rationale:
        "Journal shows verified partial progress and on-disk state " +
        "corroborates it (modified files present). Resume the SAME spoke " +
        "via SendMessage with the outstanding punch-list below — never a " +
        "fresh dispatch, which would restart the turn budget from zero.",
    };
  }

  if (disk.untouchedExpected.length > 0) {
    return {
      action: "resume",
      punchList: disk.untouchedExpected.map(
        (p) => `Not yet touched on disk: ${p}`,
      ),
      rationale:
        "Journal shows no explicit outstanding items, but some --expected " +
        "paths are still untouched on disk — resume the SAME spoke to " +
        "close that gap rather than assuming completion.",
    };
  }

  return {
    action: "none",
    punchList: [],
    rationale:
      "Journal shows no outstanding items, on-disk state corroborates it" +
      (tests !== null ? ", and the targeted test run passed" : "") +
      " — no recovery action needed.",
  };
}

async function main() {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  const journalPath = flagValue(argv, "--journal");
  const expectedRaw = flagValue(argv, "--expected");
  const testPattern = flagValue(argv, "--test");
  const expected =
    expectedRaw !== undefined
      ? expectedRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  if (journalPath === undefined) {
    reporter.error(
      "--journal <path> is required — pass the spoke's scratchpad journal " +
        "path. With none available, treat this as the playbook's 'no " +
        "durable trace' case.",
    );
    const payload = reporter.finish({
      journal: { path: null, entries: [], lastEntry: null },
      disk: null,
      tests: null,
      recommendation: {
        action: "redispatch",
        punchList: [],
        rationale:
          "No journal path was provided — there is no durable trace of the " +
          "spoke's prior work to resume from. Redispatch fresh with a more " +
          "decomposed scope (per the playbook's 'Prevent: decompose before " +
          "you dispatch' section).",
      },
    });
    reporter.info(
      `\nRecommendation: REDISPATCH — ${payload.recommendation.rationale}`,
    );
    process.exit(1);
  }

  let content;
  try {
    content = readFileSync(journalPath, "utf8");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    reporter.error(
      `Journal "${journalPath}" is missing or unreadable (${message}) — no ` +
        "durable trace of the spoke's prior work exists.",
    );
    const payload = reporter.finish({
      journal: { path: journalPath, entries: [], lastEntry: null },
      disk: null,
      tests: null,
      recommendation: {
        action: "redispatch",
        punchList: [],
        rationale:
          "The journal file could not be read — treat this as the " +
          "playbook's 'no durable trace' case. Redispatch fresh with a " +
          "more decomposed scope rather than guessing at prior progress.",
      },
    });
    reporter.info(
      `\nRecommendation: REDISPATCH — ${payload.recommendation.rationale}`,
    );
    process.exit(1);
  }

  const entries = parseJournalEntries(content);
  const tailEntries = entries.slice(-JOURNAL_TAIL_ENTRIES);
  const lastEntry = entries.at(-1) ?? null;

  const { modified, error: statusError } = gitStatusPorcelain(root);
  if (statusError !== null) {
    reporter.warn(`git status --porcelain failed: ${statusError}`);
  }
  const { raw: diffStat, error: diffError } = gitDiffStat(root);
  if (diffError !== null) {
    reporter.warn(`git diff --stat failed: ${diffError}`);
  }

  const untouchedExpected = expected.filter(
    (pattern) => !modified.some((m) => matchesExpected(m, pattern)),
  );

  let tests = null;
  if (testPattern !== undefined) {
    reporter.info(`Running targeted tests: pnpm vitest run ${testPattern} ...`);
    tests = runTargetedTests(testPattern, root);
  }

  const recommendation = recommend(
    { entries },
    {
      modified,
      untouchedExpected,
      expectedGiven: expected.length > 0,
      expectedTotal: expected.length,
      verified: statusError === null,
      error: statusError,
    },
    tests,
  );

  reporter.info(`Journal: ${journalPath} (${entries.length} entries parsed)`);
  for (const entry of tailEntries) {
    reporter.info(`  [${entry.status}] ${entry.text}`);
  }
  reporter.info("");
  reporter.info(`Modified files (${modified.length}):`);
  for (const file of modified) reporter.info(`  ${file}`);
  if (expected.length > 0) {
    reporter.info(
      `Untouched --expected paths (${untouchedExpected.length}/${expected.length}):`,
    );
    for (const path of untouchedExpected) reporter.info(`  ${path}`);
  }
  if (tests !== null) {
    reporter.info(
      `Tests: ${tests.command} -> ${tests.pass ? "PASS" : "FAIL"}` +
        (tests.total !== null
          ? ` (${String(tests.passed)}/${String(tests.total)} passed)`
          : ""),
    );
  }
  reporter.info("");
  reporter.succeed(
    `Recommendation: ${recommendation.action.toUpperCase()} — ${recommendation.rationale}`,
  );
  if (recommendation.punchList.length > 0) {
    reporter.info("Punch list:");
    for (const item of recommendation.punchList) reporter.info(`  - ${item}`);
  }

  reporter.finish({
    journal: { path: journalPath, entries: tailEntries, lastEntry },
    disk: {
      modified,
      untouchedExpected,
      diffStat,
      verified: statusError === null,
      error: statusError,
    },
    tests,
    recommendation,
  });
  // Exit contract (see header): 0 only for "none" — everything else demands
  // hub action, so a caller scripting around this CLI can branch on the
  // exit code alone without parsing the JSON payload.
  process.exit(recommendation.action === "none" ? 0 : 1);
}

// Guard the entry point so importing this module (e.g. from a unit test that
// exercises parseJournalEntries/outstandingPending/recommend directly) never
// spawns git/vitest or calls process.exit — only running it directly as
// `node bin/spoke-recovery.mjs` does. Mirrors the same guard in
// bin/mcp-server.mjs / .claude/hooks/guard-secret-writes.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error("bin/spoke-recovery.mjs failed:", cause);
    process.exit(1);
  });
}
