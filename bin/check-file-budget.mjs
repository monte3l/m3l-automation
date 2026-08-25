#!/usr/bin/env node
/**
 * Per-file size ratchet for every package's `src` and `tests` trees
 * (ADR-0072) — the file scope matches `vitest.config.ts`'s `coverage.include`
 * exactly (each package's `.ts` sources, excluding `index.ts` barrels and
 * `.d.ts` files), since the hazard this guards against is specific to
 * `perFile: true` v8 coverage: a large implementation file binds to every
 * test file that exercises it, and after both grow past a point,
 * retrofitting a split becomes structurally impossible. `core/procedure`/B2
 * (#523) hit exactly this — an irreducible ~375,000 reviewable chars once
 * `M3LProcedure.ts` (63,988 bytes) and its two test files (137,106 bytes
 * combined) had both grown large, discovered only at merge time.
 *
 * Consumer scripts' `src` trees and `bin/` itself are deliberately out of
 * scope: neither is covered by `vitest.config.ts`'s `coverage.include`, so
 * neither carries the `perFile`-binding hazard this ratchet exists for.
 *
 * A flat ceiling is not viable on day one — twelve existing src files and
 * thirteen test files already exceed 25,000/60,000 bytes respectively — so
 * this is a **ratchet**, not a cap: a committed baseline
 * (`bin/file-budget-baseline.json`) is the sparse "debt list" of files that
 * already exceeded their ceiling when this gate landed. A baselined file may
 * shrink freely but never **grow** past its recorded size; any file not in
 * the baseline must stay under the ceiling from the start. `--update`
 * regenerates the baseline from current sizes, dropping any entry that no
 * longer exceeds its ceiling and adding any newly-over-ceiling file — the
 * same explicit, reviewed-diff social contract as
 * `bin/check-exports-snapshot.mjs`'s `--update`: a PR that baselines a new
 * oversized file is asking its reviewer to accept that debt, not silently
 * evading the gate.
 *
 * Usage:
 *   node bin/check-file-budget.mjs            # verify (fails on growth/new-over-ceiling)
 *   node bin/check-file-budget.mjs --update    # rewrite the baseline from current sizes
 *   node bin/check-file-budget.mjs --ref <ref>    # verify a committed ref instead of the working tree (no checkout/worktree required); incompatible with --update
 */
import process from "node:process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const baselineRel = "bin/file-budget-baseline.json";
const baselinePath = join(root, baselineRel);
const packagesDir = join(root, "packages");

/** Ceiling for a coverage-eligible `src` file not in the baseline. */
export const SRC_CEILING_BYTES = 25_000;
/** Ceiling for a `tests` file not in the baseline. */
export const TEST_CEILING_BYTES = 60_000;

/**
 * Recursively collect files under `dir` for which `matches(relPath)` is
 * true, pruning `dist`/`node_modules` subtrees. Missing `dir` yields no
 * files rather than throwing — a package without a `src/` or `tests/`
 * directory is not an error here.
 *
 * @param {string} dir absolute directory to walk
 * @param {(relPath: string) => boolean} matches called with the path
 *   relative to the repo root
 * @returns {string[]} repo-relative paths, sorted
 */
export function walkMatching(dir, matches) {
  const results = [];
  const skipDirs = new Set(["dist", "node_modules"]);

  function recurse(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (cause) {
      // ENOENT (the directory doesn't exist — a package legitimately
      // lacking src/ or tests/) is the only expected failure here; anything
      // else (EACCES, ELOOP, …) is a real problem and must not be silently
      // swallowed into "this subtree has zero files".
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return;
      throw cause;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        recurse(join(current, entry.name));
      } else if (entry.isFile()) {
        const rel = relative(root, join(current, entry.name));
        if (matches(rel)) results.push(rel);
      }
    }
  }

  recurse(dir);
  return results.sort();
}

/**
 * True for a `src/**\/*.ts` file that is part of `vitest.config.ts`'s
 * coverage set — a `.ts` file that is neither a declaration file nor a
 * barrel named exactly `index.ts` (coverage.exclude: `["**\/index.ts",
 * "**\/*.d.ts"]`).
 *
 * @param {string} relPath repo-relative path
 * @returns {boolean}
 */
export function isCoverageEligibleSrcFile(relPath) {
  if (!relPath.endsWith(".ts") || relPath.endsWith(".d.ts")) return false;
  return !relPath.endsWith("/index.ts") && relPath !== "index.ts";
}

/**
 * @param {string} relPath repo-relative path
 * @returns {boolean}
 */
export function isTestFile(relPath) {
  return relPath.endsWith(".test.ts");
}

const SRC_SUBTREE_RE = /^packages\/[^/]+\/src\//;
const TEST_SUBTREE_RE = /^packages\/[^/]+\/tests\//;

/**
 * Classify a `git ls-tree`-reported path the same way
 * {@link collectBudgetEntries}'s per-package walk classifies a filesystem
 * path — but from a bare repo-relative string, since `--ref` mode has no
 * directory to walk per package. `isCoverageEligibleSrcFile`/`isTestFile`
 * already operate on the full repo-relative path, so this only adds the
 * `packages/<pkg>/{src,tests}/` subtree gate that the filesystem walk gets
 * for free from starting inside each package's own `src`/`tests` directory.
 *
 * @param {string} relPath repo-relative path
 * @returns {"src" | "test" | null}
 */
export function classifyRefPath(relPath) {
  if (SRC_SUBTREE_RE.test(relPath) && isCoverageEligibleSrcFile(relPath))
    return "src";
  if (TEST_SUBTREE_RE.test(relPath) && isTestFile(relPath)) return "test";
  return null;
}

/**
 * @typedef {Object} BudgetEntry
 * @property {string} path repo-relative
 * @property {number} bytes current size
 * @property {"src" | "test"} category
 */

/**
 * @param {BudgetEntry} entry
 * @returns {number} the ceiling that applies when `entry.path` is not baselined
 */
function ceilingFor(entry) {
  return entry.category === "src" ? SRC_CEILING_BYTES : TEST_CEILING_BYTES;
}

/**
 * Collect every file this gate scopes, with its current byte size.
 *
 * Unlike {@link walkMatching}'s per-package `src`/`tests` scan — where a
 * missing directory is a legitimate case (a package with no `tests/`) — the
 * `packages/` root itself is never optional (`pnpm-workspace.yaml`). This
 * throws rather than swallowing a `readdirSync(packagesDir)` failure into an
 * empty package list: silently scanning zero packages would report a clean
 * ratchet ("0 files checked, none exceed their limit") for a gate that never
 * actually ran, defeating the whole point of the check.
 *
 * @returns {BudgetEntry[]}
 * @throws {Error} if `packages/` cannot be read (EACCES, a bad repo root, …)
 */
export function collectBudgetEntries() {
  /** @type {BudgetEntry[]} */
  const entries = [];
  const packageNames = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const name of packageNames) {
    const srcDir = join(packagesDir, name, "src");
    for (const rel of walkMatching(srcDir, isCoverageEligibleSrcFile)) {
      entries.push({
        path: rel,
        bytes: Buffer.byteLength(readFileSync(join(root, rel)), "utf8"),
        category: "src",
      });
    }
    const testsDir = join(packagesDir, name, "tests");
    for (const rel of walkMatching(testsDir, isTestFile)) {
      entries.push({
        path: rel,
        bytes: Buffer.byteLength(readFileSync(join(root, rel)), "utf8"),
        category: "test",
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * {@link collectBudgetEntries}'s equivalent for a committed ref, read via
 * `git` plumbing instead of `node:fs` — no checkout or worktree required.
 * `git ls-tree` lists every path in `<ref>`'s `packages/` subtree in one
 * call; `git cat-file -s` reports a blob's byte size directly, so there is
 * no need to materialize file content the way the filesystem path's
 * `readFileSync` does.
 *
 * @param {string} ref a ref resolvable by `git` (branch, tag, SHA, `origin/*`)
 * @returns {BudgetEntry[]}
 * @throws {Error} if `ref` cannot be resolved, or `git` fails for any reason
 */
export function collectBudgetEntriesAtRef(ref) {
  const listing = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", ref, "--", "packages/"],
    { cwd: root, encoding: "utf8" },
  );

  /** @type {BudgetEntry[]} */
  const entries = [];
  for (const relPath of listing.split("\n")) {
    if (relPath === "") continue;
    const category = classifyRefPath(relPath);
    if (category === null) continue;
    const size = execFileSync("git", ["cat-file", "-s", `${ref}:${relPath}`], {
      cwd: root,
      encoding: "utf8",
    });
    entries.push({ path: relPath, bytes: Number(size.trim()), category });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * {@link readFileSync}/`JSON.parse` of `bin/file-budget-baseline.json`, but
 * against a committed ref instead of the working tree. Mirrors the
 * filesystem path's contract exactly: a baseline absent at `ref` yields `{}`
 * (the `existsSync` gate's ref-mode equivalent), while a present-but-invalid
 * baseline's `JSON.parse` failure propagates uncaught — the caller's job to
 * report fatally, same as the filesystem path.
 *
 * @param {string} ref a ref resolvable by `git`
 * @returns {Record<string, number>}
 */
export function readBaselineAtRef(ref) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${baselineRel}`], {
      cwd: root,
      encoding: "utf8",
    });
  } catch {
    return {};
  }
  const text = execFileSync("git", ["show", `${ref}:${baselineRel}`], {
    cwd: root,
    encoding: "utf8",
  });
  return JSON.parse(text);
}

/**
 * Read `--ref <value>` out of an argv array, mirroring
 * `check-review-size.mjs`'s `parseArgs`.
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function parseRefArg(argv) {
  const i = argv.indexOf("--ref");
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Compare current entries against the committed baseline.
 *
 * @param {BudgetEntry[]} entries
 * @param {Record<string, number>} baseline path -> recorded byte ceiling
 * @returns {{ violations: Array<{ path: string, bytes: number, limit: number, baselined: boolean }> }}
 */
export function checkBudget(entries, baseline) {
  const violations = [];
  for (const entry of entries) {
    const recorded = baseline[entry.path];
    if (recorded !== undefined) {
      if (entry.bytes > recorded) {
        violations.push({
          path: entry.path,
          bytes: entry.bytes,
          limit: recorded,
          baselined: true,
        });
      }
      continue;
    }
    const ceiling = ceilingFor(entry);
    if (entry.bytes > ceiling) {
      violations.push({
        path: entry.path,
        bytes: entry.bytes,
        limit: ceiling,
        baselined: false,
      });
    }
  }
  return { violations };
}

/**
 * Build the regenerated baseline: every entry currently over its ceiling,
 * keyed to its exact current size. Entries that no longer exceed their
 * ceiling (shrunk, or deleted) are dropped — the baseline only ever tracks
 * live debt.
 *
 * @param {BudgetEntry[]} entries
 * @returns {Record<string, number>} key-sorted
 */
export function buildBaseline(entries) {
  /** @type {Record<string, number>} */
  const next = {};
  for (const entry of entries) {
    if (entry.bytes > ceilingFor(entry)) next[entry.path] = entry.bytes;
  }
  return Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const reporter = createReporter(json);
  const ref = parseRefArg(argv);

  if (ref !== undefined && argv.includes("--update")) {
    reporter.error(
      "--update cannot be combined with --ref — there is no committed " +
        "blob to write a regenerated baseline into. Run --update on a " +
        "checked-out working tree instead.",
    );
    reporter.finish();
    process.exit(1);
  }

  let entries;
  try {
    entries = ref ? collectBudgetEntriesAtRef(ref) : collectBudgetEntries();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    reporter.error(
      ref
        ? `Could not scan packages/ at ${ref}: ${message}`
        : `Could not scan ${relative(root, packagesDir)}: ${message}`,
    );
    reporter.finish();
    process.exit(1);
  }

  if (argv.includes("--update")) {
    const next = buildBaseline(entries);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const count = Object.keys(next).length;
    reporter.change(
      "updated",
      baselineRel,
      `(${count} ${count === 1 ? "entry" : "entries"})`,
    );
    reporter.finish();
    process.exit(0);
  }

  /** @type {Record<string, number>} */
  let baseline = {};
  if (ref !== undefined) {
    try {
      baseline = readBaselineAtRef(ref);
    } catch (cause) {
      reporter.error(
        `Could not parse ${baselineRel} at ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      reporter.finish();
      process.exit(1);
    }
  } else if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch (cause) {
      reporter.error(
        `Could not parse ${baselineRel}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      reporter.finish();
      process.exit(1);
    }
  }

  const { violations } = checkBudget(entries, baseline);
  for (const v of violations) {
    if (v.baselined) {
      reporter.error(
        `${v.path}: ${v.bytes} bytes — grew past its baselined ceiling of ${v.limit} ` +
          `(bin/file-budget-baseline.json). See ADR-0072's slicing rules before adding more to this file.`,
        { file: v.path },
      );
    } else {
      reporter.error(
        `${v.path}: ${v.bytes} bytes — exceeds the ${v.limit}-byte ceiling and is not in the ` +
          `baseline. Split it (see ADR-0072) or, if the size is deliberate, run ` +
          `\`node bin/check-file-budget.mjs --update\` and explain why in the PR body.`,
        { file: v.path },
      );
    }
  }

  if (violations.length > 0) {
    if (!json)
      console.error(`\n✗  ${violations.length} file-budget violation(s).`);
    reporter.finish({ violations });
    process.exit(1);
  }

  reporter.succeed(
    `${entries.length} file(s) checked against the size ratchet — none exceed their limit.`,
  );
  reporter.finish({ violations });
}
