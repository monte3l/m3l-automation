#!/usr/bin/env node
// CLI wrapper over bin/lib/pr-review-gate.mjs, called from
// claude-pr-review.yml's guard and Enforce steps so the gate's own decision
// logic lives in exactly one, unit-tested place. See that module's header
// for why this exists.
//
// Deliberately writes diagnostics to stderr only — stdout carries exactly
// the value the calling shell captures into a variable, same convention as
// bin/pr-diff-filter.mjs.
//
// Usage:
//   node bin/pr-review-gate.mjs parse-verdict          # stdin (comment body) -> stdout: PASS|FAIL|NONE
//   node bin/pr-review-gate.mjs parse-sha              # stdin (comment body) -> stdout: <sha> or empty
//   node bin/pr-review-gate.mjs parse-must-fix          # stdin (comment body) -> stdout: raw Must-fix section, or empty
//   node bin/pr-review-gate.mjs count-review-comments   # stdin (JSON array of comment bodies) -> stdout: count
//   node bin/pr-review-gate.mjs workflow-gate-status    # stdin (newline-separated reviewable files) -> stdout: 2 lines
//   node bin/pr-review-gate.mjs build-delta-patch       # stdin (compare-API JSON) -> stdout: synthetic unified diff, exit 1 if untrustworthy
//   node bin/pr-review-gate.mjs resolve-verdict <file> <head-sha>  # -> stdout: PASS|FAIL|NONE, reason on stderr
//
// Exits 1 only on a usage error (missing argument) or an I/O failure reading
// the verdict file — never on "no verdict found", which is a normal,
// stdout-reported outcome the calling shell branches on.

import { readFileSync } from "node:fs";
import process from "node:process";

import {
  buildDeltaPatch,
  countReviewComments,
  describeWorkflowGateChange,
  parseMustFixSection,
  parseReviewedSha,
  parseVerdict,
  resolveVerdict,
} from "./lib/pr-review-gate.mjs";

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
 * @param {string[]} argv
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
  const [mode, ...rest] = argv;

  if (mode === "parse-verdict") {
    const verdict = parseVerdict(await readStdin());
    process.stdout.write(`${verdict ?? "NONE"}\n`);
    return 0;
  }

  if (mode === "parse-sha") {
    const sha = parseReviewedSha(await readStdin());
    process.stdout.write(`${sha ?? ""}\n`);
    return 0;
  }

  if (mode === "parse-must-fix") {
    const section = parseMustFixSection(await readStdin());
    process.stdout.write(section ?? "");
    return 0;
  }

  if (mode === "count-review-comments") {
    let bodies;
    try {
      bodies = JSON.parse(await readStdin());
    } catch (error) {
      process.stderr.write(
        `pr-review-gate: invalid JSON on stdin: ${String(error)}\n`,
      );
      return 1;
    }
    if (!Array.isArray(bodies)) {
      process.stderr.write(
        "pr-review-gate: count-review-comments expects a JSON array of strings on stdin\n",
      );
      return 1;
    }
    process.stdout.write(`${countReviewComments(bodies)}\n`);
    return 0;
  }

  if (mode === "build-delta-patch") {
    let parsed;
    try {
      parsed = JSON.parse(await readStdin());
    } catch (error) {
      process.stderr.write(
        `pr-review-gate: invalid JSON on stdin: ${String(error)}\n`,
      );
      return 1;
    }
    const patch = buildDeltaPatch(parsed);
    if (patch === null) {
      process.stderr.write(
        "pr-review-gate: compare-API response is not trustworthy as a complete delta " +
          "(hit the file-count cap, or a file has a real change with no patch GitHub could " +
          "explain) — caller should fall back to the full diff\n",
      );
      return 1;
    }
    process.stdout.write(patch);
    return 0;
  }

  if (mode === "workflow-gate-status") {
    const files = (await readStdin())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const status = describeWorkflowGateChange(files);
    process.stdout.write(`${status.includesWorkflowFile}\n`);
    process.stdout.write(`${status.otherReviewableFiles.join(",")}\n`);
    return 0;
  }

  if (mode === "resolve-verdict") {
    const [file, headSha] = rest;
    if (file === undefined || headSha === undefined) {
      process.stderr.write(
        "pr-review-gate: resolve-verdict needs <file> <head-sha>\n",
      );
      return 1;
    }
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT"
      ) {
        process.stderr.write(
          `pr-review-gate: failed to read ${file}: ${String(error)}\n`,
        );
        return 1;
      }
      // Missing file is a normal outcome (no verdict yet) — fall through
      // with empty content, same as a present-but-empty file.
    }
    const { verdict, reason } = resolveVerdict(content, headSha);
    process.stderr.write(`pr-review-gate: ${reason}\n`);
    process.stdout.write(`${verdict ?? "NONE"}\n`);
    return 0;
  }

  process.stderr.write(
    `pr-review-gate: unknown mode ${mode ?? "(none)"} — expected ` +
      "parse-verdict, parse-sha, parse-must-fix, count-review-comments, " +
      "workflow-gate-status, build-delta-patch, or resolve-verdict\n",
  );
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`pr-review-gate: ${error.message}\n`);
    process.exit(1);
  },
);
