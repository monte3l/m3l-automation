#!/usr/bin/env node
/**
 * Local reproduction of `claude-pr-review.yml`'s reviewable-size measurement
 * (ADR-0072) — so an author learns before pushing what CI would say after.
 * PR #523 (`core/procedure`) was rejected by that gate three times, costing
 * ~$8.15 of gate spend before the rejection was ever seen locally; this
 * script computes the same number for `origin/main...HEAD` on demand.
 *
 * Reads `MAX_REVIEWABLE_BYTES` out of `.github/workflows/claude-pr-review.yml`
 * at runtime rather than duplicating the constant — one source of truth, in
 * the same gen/check spirit as `check:cadence` / `check:verify-parity`.
 * `SOFT_TARGET_BYTES` (75,000) is this script's own addition: an authoring
 * target, not a rejection ceiling — see ADR-0072.
 *
 * Mirrors the workflow's `is_ignored` predicate exactly (`*.md`, `docs/**`,
 * `.github/dependabot.yml`, plus the separately-excluded `pnpm-lock.yaml`)
 * and measures a **unified** diff (`git diff <base>..<head>`), never a
 * per-commit series — `gh pr diff --patch` inflated PR #523 by 39% before
 * that was fixed (PR #569, `0174a5a`).
 *
 * Usage:
 *   node bin/check-review-size.mjs                      # resolves base/head itself
 *   node bin/check-review-size.mjs --base <ref> --head <ref>
 *
 * Exit codes:
 *   0  Under the soft target, or over it but under the hard ceiling (warns).
 *   1  Over MAX_REVIEWABLE_BYTES, or the ceiling could not be resolved from
 *      the workflow file.
 *
 * A missing or unresolvable `origin/main...HEAD` range (no `origin` remote,
 * already on `main`, shallow clone) is reported and skipped — never a
 * spurious failure.
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const workflowRel = ".github/workflows/claude-pr-review.yml";

/** Authoring target (ADR-0072) — a warning line, never a failure, above this. */
export const SOFT_TARGET_BYTES = 75_000;

/** Max diff bytes the diff parser/`execFileSync` buffer will hold. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Read `MAX_REVIEWABLE_BYTES` out of the workflow file's `env:` block.
 *
 * @param {string} workflowText
 * @returns {number | null} null if the constant could not be found.
 */
export function parseMaxReviewableBytes(workflowText) {
  const match = /MAX_REVIEWABLE_BYTES:\s*(\d+)/.exec(workflowText);
  return match ? Number(match[1]) : null;
}

/**
 * True when `path` is excluded from the reviewable count — the workflow's
 * `is_ignored()` predicate (`*.md`, `docs/**`, `.github/dependabot.yml`),
 * plus the separately-excluded `pnpm-lock.yaml`. Bash `case` globbing is not
 * anchored to the basename, so `*.md` matches any path ending in `.md`
 * regardless of directory — mirrored here with `endsWith`/`startsWith`
 * rather than a basename check.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isIgnoredPath(path) {
  return (
    path.endsWith(".md") ||
    path.startsWith("docs/") ||
    path === ".github/dependabot.yml" ||
    path === "pnpm-lock.yaml"
  );
}

/**
 * @typedef {Object} DiffFileBlock
 * @property {string} path
 * @property {string} text   the block's full text (header line through the
 *   line before the next `diff --git`, or EOF), newline-terminated
 * @property {boolean} ignored
 */

/**
 * Split a unified diff into per-file blocks, keyed by the `a/<path>` side of
 * each `diff --git a/<path> b/<path>` header — mirroring the workflow's own
 * awk parser (`f = $3; sub(/^a\//, "", f)`).
 *
 * @param {string} diffText
 * @returns {DiffFileBlock[]}
 */
export function splitDiffByFile(diffText) {
  if (diffText === "") return [];
  const lines = diffText.split("\n");
  /** @type {DiffFileBlock[]} */
  const blocks = [];
  /** @type {string[] | null} */
  let current = null;
  let currentPath = "";
  for (const line of lines) {
    const header = /^diff --git a\/(\S+) b\/\S+/.exec(line);
    if (header) {
      if (current) {
        blocks.push({
          path: currentPath,
          text: current.join("\n"),
          ignored: isIgnoredPath(currentPath),
        });
      }
      current = [line];
      currentPath = header[1];
    } else if (current) {
      current.push(line);
    }
    // Lines before the first `diff --git` header (there are none in a plain
    // `git diff` unified-diff output) are dropped — nothing to attribute
    // them to.
  }
  if (current) {
    blocks.push({
      path: currentPath,
      text: current.join("\n"),
      ignored: isIgnoredPath(currentPath),
    });
  }
  return blocks;
}

/**
 * Reconstruct the filtered patch the workflow would measure: an ignored
 * file keeps only its `diff --git` header plus a short omission marker
 * (never its hunks); a reviewable file keeps its block unchanged. Returns
 * the filtered text plus each file's post-filter byte size and its
 * `ignored` flag, for the top-contributor ranking and the `--json`
 * per-file breakdown.
 *
 * @param {DiffFileBlock[]} blocks
 * @returns {{ filteredText: string, perFile: { path: string, bytes: number, ignored: boolean }[] }}
 */
export function filterForReview(blocks) {
  const perFile = [];
  const parts = [];
  for (const block of blocks) {
    const headerLine = block.text.split("\n", 1)[0];
    const text = block.ignored
      ? `${headerLine}\n(diff omitted — not reviewable by this gate)\n`
      : `${block.text}\n`;
    parts.push(text);
    perFile.push({
      path: block.path,
      bytes: Buffer.byteLength(text, "utf8"),
      ignored: block.ignored,
    });
  }
  return { filteredText: parts.join(""), perFile };
}

/**
 * Resolve the merge-base of `origin/main` and `HEAD` — the same range
 * `pnpm verify`'s prOnly steps use. Returns null when unresolvable (no
 * `origin` remote, shallow clone with no common ancestor, already on
 * `main`).
 *
 * @returns {string | null}
 */
function resolveDefaultBase() {
  try {
    return execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read `--base`/`--head` from an argv array.
 *
 * @param {string[]} argv
 * @returns {{ base: string | undefined, head: string | undefined }}
 */
export function parseArgs(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { base: at("--base"), head: at("--head") };
}

/**
 * Suggest the ADR-0072 split axis to reach for first, from what actually
 * changed. Docs-vs-code is always the cheapest split when a diff mixes
 * both categories — a docs-only slice measures ~0 reviewable bytes.
 *
 * @param {DiffFileBlock[]} blocks
 * @returns {string}
 */
export function suggestSplitAxis(blocks) {
  const reviewable = blocks.filter((b) => !b.ignored);
  const hasIgnored = blocks.some((b) => b.ignored);
  if (hasIgnored && reviewable.length > 0) {
    return "docs vs. code — separate the docs/**, *.md, and .github/dependabot.yml changes into their own PR; they cost ~0 reviewable bytes and review instantly";
  }
  const topLevelDirs = new Set(
    reviewable.map((b) => b.path.split("/")[0] ?? b.path),
  );
  if (topLevelDirs.size > 1) {
    return `path cluster — this diff spans ${topLevelDirs.size} top-level paths (${[...topLevelDirs].sort().join(", ")}); land one per PR`;
  }
  return "commit boundary or public-surface subset — see ADR-0072";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);

  let maxReviewableBytes;
  try {
    const workflowText = readFileSync(join(root, workflowRel), "utf8");
    maxReviewableBytes = parseMaxReviewableBytes(workflowText);
  } catch (error) {
    reporter.error(
      `Could not read ${workflowRel}: ${error instanceof Error ? error.message : String(error)}`,
    );
    reporter.finish();
    process.exit(1);
  }
  if (maxReviewableBytes === null) {
    reporter.error(
      `Could not find MAX_REVIEWABLE_BYTES in ${workflowRel} — the gate's constant may have moved.`,
    );
    reporter.finish();
    process.exit(1);
  }

  const { base: argBase, head: argHead } = parseArgs(argv);
  const base = argBase ?? resolveDefaultBase();
  const head = argHead ?? "HEAD";

  if (!base) {
    reporter.info(
      "Could not resolve an origin/main...HEAD range (no origin remote, shallow clone, or already on main) — skipping.",
    );
    reporter.finish({ skipped: true });
    process.exit(0);
  }

  let diffText;
  try {
    diffText = execFileSync("git", ["diff", `${base}..${head}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    reporter.error(
      `git diff ${base}..${head} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    reporter.finish();
    process.exit(1);
  }

  const blocks = splitDiffByFile(diffText);
  const { filteredText, perFile } = filterForReview(blocks);
  const reviewableBytes = Buffer.byteLength(filteredText, "utf8");

  const sortedPerFile = [...perFile].sort((a, b) => b.bytes - a.bytes);
  const top = sortedPerFile
    .slice(0, 5)
    .map((f) => `- \`${f.path}\` — ${f.bytes} chars`)
    .join("\n");

  if (reviewableBytes > maxReviewableBytes) {
    reporter.error(
      `Reviewable diff is ${reviewableBytes} chars — over the ${maxReviewableBytes}-char ` +
        `MAX_REVIEWABLE_BYTES ceiling. CI will reject this PR outright with no review ` +
        `attempted. Split it — ${suggestSplitAxis(blocks)}.\n\nLargest contributors:\n${top}`,
    );
    reporter.finish({
      reviewableBytes,
      maxReviewableBytes,
      base,
      head,
      perFile: sortedPerFile,
    });
    process.exit(1);
  }

  if (reviewableBytes > SOFT_TARGET_BYTES) {
    reporter.warn(
      `Reviewable diff is ${reviewableBytes} chars — over the ${SOFT_TARGET_BYTES}-char ` +
        `ADR-0072 soft target (ceiling is ${maxReviewableBytes}). Split it or record why ` +
        `not in the PR body. Suggested split: ${suggestSplitAxis(blocks)}.\n\n` +
        `Largest contributors:\n${top}`,
    );
  }

  reporter.succeed(
    `Reviewable diff: ${reviewableBytes} chars (soft target ${SOFT_TARGET_BYTES}, ceiling ${maxReviewableBytes}).`,
  );
  reporter.finish({
    reviewableBytes,
    maxReviewableBytes,
    base,
    head,
    perFile: sortedPerFile,
  });
  process.exit(0);
}
