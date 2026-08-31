#!/usr/bin/env node
// CLI wrapper over bin/lib/pr-diff-filter.mjs, called from the PR-review
// workflows so the ignore set lives in exactly one place. See that module's
// header for why this exists.
//
// Deliberately writes diagnostics to stderr only: the `reviewable` mode's
// stdout is consumed by the calling shell, so a reporter banner on stdout
// would corrupt it. That is also why this script does not use
// bin/lib/report.mjs like the `check:*` scripts do — it is a filter, not a
// gate, and has no pass/fail verdict to report.
//
// Usage:
//   node bin/pr-diff-filter.mjs reviewable          # stdin -> stdout
//   node bin/pr-diff-filter.mjs patch <file>        # rewrite <file> in place
//   node bin/pr-diff-filter.mjs changed-files <file>  # rewrite <file> in place
//
// Exits 1 on any failure. Callers keep the awk's non-fatal posture by
// tolerating that exit and leaving the original file untouched.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

import { filterChangedFiles, filterPatch } from "./lib/pr-diff-filter.mjs";

/**
 * Read every byte of stdin as UTF-8.
 *
 * @returns {Promise<string>}
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Rewrite `file` through `transform`, via a temp file so a crash mid-write
 * cannot leave a truncated patch for the reviewer to read.
 *
 * @param {string} file
 * @param {(text: string) => string} transform
 */
function rewriteInPlace(file, transform) {
  const temp = `${file}.filtered`;
  try {
    writeFileSync(temp, transform(readFileSync(file, "utf8")));
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
  const [mode, file] = argv;

  if (mode === "reviewable") {
    const reviewable = filterChangedFiles(await readStdin());
    process.stdout.write(
      reviewable.length === 0 ? "" : `${reviewable.join("\n")}\n`,
    );
    return 0;
  }

  if (mode === "patch" || mode === "changed-files") {
    if (file === undefined) {
      process.stderr.write(`pr-diff-filter: ${mode} needs a file argument\n`);
      return 1;
    }
    rewriteInPlace(
      file,
      mode === "patch"
        ? filterPatch
        : (text) => {
            const reviewable = filterChangedFiles(text);
            return reviewable.length === 0 ? "" : `${reviewable.join("\n")}\n`;
          },
    );
    return 0;
  }

  process.stderr.write(
    `pr-diff-filter: unknown mode ${mode ?? "(none)"} — ` +
      `expected reviewable, patch, or changed-files\n`,
  );
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`pr-diff-filter: ${error.message}\n`);
    process.exit(1);
  },
);
