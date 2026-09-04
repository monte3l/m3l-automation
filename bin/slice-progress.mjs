#!/usr/bin/env node
// Writes/clears `tmp/slice-progress.json`, the state
// `.claude/hooks/statusline-context-pressure.mjs` reads to render the
// session row's slice-progress segment (docs/adr/0072-reviewable-slice-discipline.md
// amendment). Two modes:
//
//   pnpm slice:set -- --page <docs/reference/.../*.md>   (derived)
//   pnpm slice:set -- --wave <ID> --current <N> --total <M> [--label "<text>"]  (literal)
//   pnpm slice:clear
//
// Derived mode only records a pointer to a reference page — the statusline
// itself re-parses that page's `## Landing plan` table on every render, so
// the N/M count can never drift from the committed table (CLAUDE.md's
// re-derive-authored-claims rule). Literal mode is the explicit escape hatch
// for a non-submodule multi-PR wave (V9/X8-style), which ADR-0072 does not
// give a committed record to derive from.
//
// The branch this file applies to is stamped by this script from live git
// state, never accepted as a flag — harness-artifacts.md's rule that a
// derivable value must be stamped by code, not echoed by whoever invokes the
// CLI. The statusline renders the segment only when that stamp matches the
// currently resolved branch (a stale entry from a different branch is not a
// signal, mirroring `starting-work`'s handling of a mismatched compact-handoff).
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import { LANDING_PLAN_HEADING } from "./check-scaffold-seam.mjs";
import { parseLandingPlanProgress } from "../.claude/hooks/statusline-context-pressure.mjs";

const root = repoRoot(import.meta.url);
export const SLICE_PROGRESS_REL_PATH = "tmp/slice-progress.json";

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string | undefined} the token following `flag`, or undefined
 *   when `flag` is absent or its next token looks like another flag
 *   (starts with `--`) rather than a value — this turns a missing value
 *   (`--wave --current 2 --total 4`) into a clear usage error downstream
 *   instead of silently recording the next flag's name as the value.
 */
function at(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/**
 * @param {string} cwd
 * @returns {string} current branch name, or "" if it cannot be resolved
 *   (detached HEAD, not a git repo).
 */
export function currentBranch(cwd = root) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Parses `set` subcommand args into a validated mode payload, or an error
 * message. Pure — takes the already-resolved branch and a page-reader so
 * the branching logic is unit-testable without touching disk or git.
 *
 * @param {string[]} argv args after the `set` subcommand.
 * @param {(page: string) => string | null} readPage returns page text, or
 *   null if unreadable.
 * @returns {{ ok: true, entry: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseSetArgs(argv, readPage) {
  const page = at(argv, "--page");
  const wave = at(argv, "--wave");

  if (page !== undefined && wave !== undefined) {
    return {
      ok: false,
      error:
        "Pass either --page (derived mode) or --wave (literal mode), not both.",
    };
  }

  if (page !== undefined) {
    const text = readPage(page);
    if (text === null) {
      return {
        ok: false,
        error: `--page ${page} does not exist or is unreadable.`,
      };
    }
    if (!LANDING_PLAN_HEADING.test(text)) {
      return {
        ok: false,
        error: `--page ${page} has no "## Landing plan" heading (ADR-0072) to derive slice progress from.`,
      };
    }
    if (parseLandingPlanProgress(text) === null) {
      return {
        ok: false,
        error: `--page ${page}'s "## Landing plan" section has a heading but no parseable Slice/Status table — the statusline segment would never render for it. See docs/adr/0072-reviewable-slice-discipline.md's amendment for the required "| Slice | Scope | Status |" table shape, or use --wave for a page without one.`,
      };
    }
    return { ok: true, entry: { page } };
  }

  if (wave !== undefined) {
    const currentRaw = at(argv, "--current");
    const totalRaw = at(argv, "--total");
    const label = at(argv, "--label");
    const current = Number.parseInt(currentRaw ?? "", 10);
    const total = Number.parseInt(totalRaw ?? "", 10);
    if (!Number.isInteger(current) || !Number.isInteger(total)) {
      return {
        ok: false,
        error:
          "Literal mode needs integer --current and --total (e.g. --current 2 --total 4).",
      };
    }
    if (current < 1 || total < 1 || current > total) {
      return {
        ok: false,
        error: `--current ${currentRaw} and --total ${totalRaw} must satisfy 1 <= current <= total.`,
      };
    }
    const entry = { wave, current, total };
    if (label !== undefined) entry.label = label;
    return { ok: true, entry };
  }

  return {
    ok: false,
    error:
      'Usage: slice:set -- --page <reference-page> | --wave <ID> --current <N> --total <M> [--label "<text>"]',
  };
}

/**
 * @param {string[]} argv args after the `set` subcommand.
 * @param {(page: string) => string | null} readPage
 * @param {() => string} resolveBranch
 * @returns {{ ok: true, entry: Record<string, unknown> } | { ok: false, error: string }}
 */
export function buildSliceEntry(argv, readPage, resolveBranch) {
  const parsed = parseSetArgs(argv, readPage);
  if (!parsed.ok) return parsed;
  const branch = resolveBranch();
  if (branch === "") {
    return {
      ok: false,
      error: "Could not resolve the current git branch (detached HEAD?).",
    };
  }
  return {
    ok: true,
    entry: { ...parsed.entry, branch, updatedAt: new Date().toISOString() },
  };
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const filePath = join(root, SLICE_PROGRESS_REL_PATH);

  if (subcommand === "clear") {
    if (existsSync(filePath)) {
      rmSync(filePath);
      reporter.change("removed", SLICE_PROGRESS_REL_PATH);
    }
    reporter.succeed("Slice progress cleared.");
    reporter.finish();
    process.exit(0);
  }

  if (subcommand !== "set") {
    reporter.error(
      "Usage: node bin/slice-progress.mjs <set|clear> [flags] — unknown or missing subcommand.",
    );
    reporter.finish();
    process.exit(1);
  }

  const result = buildSliceEntry(
    rest,
    (page) => {
      try {
        return readFileSync(join(root, page), "utf8");
      } catch {
        return null;
      }
    },
    () => currentBranch(root),
  );

  if (!result.ok) {
    reporter.error(result.error);
    reporter.finish();
    process.exit(1);
  }

  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(result.entry, null, 2)}\n`);
  reporter.change("created", SLICE_PROGRESS_REL_PATH);
  reporter.succeed(`Slice progress set: ${JSON.stringify(result.entry)}`);
  reporter.finish();
  process.exit(0);
}
