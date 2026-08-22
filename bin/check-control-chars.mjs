#!/usr/bin/env node
// Fails when any git-tracked source file carries a LITERAL control byte, which
// makes the file binary to git and therefore unreviewable while every other
// quality gate stays green. See bin/lib/control-char-scan.mjs for the full
// rationale and the incident that motivated it.
//
// Unlike the hub-sync gates, this needs no network and no `gh` auth — it reads
// only the git index and the working tree, so it runs on `pre-push` and in CI
// unconditionally, on every platform.
//
// Usage:
//   node bin/check-control-chars.mjs
//   node bin/check-control-chars.mjs --json     # ADR-0030 structured report
//   pnpm check:control-chars
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINARY_EXTENSIONS,
  scanControlChars,
} from "./lib/control-char-scan.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The single injected git execution seam, mirroring `runGh` in the hub-sync
 * gates so nothing here shells out directly in `bin/tests/**`. Always an argv
 * array — never a shell string.
 *
 * @param {string[]} args
 * @returns {string} the child process's captured stdout
 */
function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Every git-TRACKED path, NUL-delimited so a filename containing a newline
 * cannot split one entry into two. Tracked-only on purpose: an untracked
 * scratch file cannot make a commit unreviewable, and scanning the working tree
 * wholesale would read `node_modules`.
 *
 * @param {(args: string[]) => string} runGitFn
 * @returns {string[]}
 */
export function listTrackedFiles(runGitFn) {
  return runGitFn(["ls-files", "-z"]).split("\0").filter(Boolean);
}

/**
 * Read each candidate path as raw bytes. A path that cannot be read is
 * reported, never skipped silently — a gate that quietly stops covering a file
 * is the failure mode this whole change set is about.
 *
 * @param {string[]} paths
 * @param {(path: string) => Uint8Array} readFileFn
 * @returns {{ files: { path: string, bytes: Uint8Array }[], errors: string[] }}
 */
export function readCandidates(paths, readFileFn) {
  /** @type {{ path: string, bytes: Uint8Array }[]} */
  const files = [];
  /** @type {string[]} */
  const errors = [];

  for (const path of paths) {
    if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    try {
      files.push({ path, bytes: readFileFn(path) });
    } catch (cause) {
      errors.push(
        `Could not read tracked file ${path} ` +
          `(${cause instanceof Error ? cause.message : String(cause)}). ` +
          `Not skipping silently — resolve it or the file goes unscanned.`,
      );
    }
  }

  return { files, errors };
}

/**
 * Run the gate against injected seams. Returns the outcome rather than calling
 * `process.exit`, so every branch is assertable.
 *
 * @param {{
 *   runGit: typeof runGit,
 *   readFile: (path: string) => Uint8Array,
 *   reporter: ReturnType<typeof createReporter>,
 * }} deps
 * @returns {{ ok: boolean, findings: string[], scanned: number }}
 */
export function runControlCharCheck({
  runGit: runGitFn,
  readFile: readFileFn,
  reporter,
}) {
  try {
    const tracked = listTrackedFiles(runGitFn);
    if (tracked.length === 0) {
      reporter.error(
        "`git ls-files` returned no tracked files — refusing to report a " +
          "clean scan of nothing.",
      );
      reporter.finish({ findings: [], scanned: 0 });
      return { ok: false, findings: [], scanned: 0 };
    }

    const { files, errors } = readCandidates(tracked, readFileFn);
    const findings = [...errors, ...scanControlChars(files)];

    for (const message of findings) reporter.error(message);

    if (findings.length > 0) {
      reporter.finish({ findings, scanned: files.length });
      return { ok: false, findings, scanned: files.length };
    }

    reporter.succeed(
      `No literal control bytes in ${files.length} tracked text file(s) ` +
        `(${tracked.length - files.length} binary by extension).`,
    );
    reporter.finish({ findings, scanned: files.length });
    return { ok: true, findings, scanned: files.length };
  } catch (cause) {
    reporter.error(
      `Control-character scan failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish({ findings: [], scanned: 0 });
    return { ok: false, findings: [], scanned: 0 };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const outcome = runControlCharCheck({
    runGit,
    readFile: (path) => readFileSync(join(root, path)),
    reporter,
  });
  if (!outcome.ok) process.exit(1);
}
