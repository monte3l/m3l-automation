#!/usr/bin/env node
/**
 * PostToolUse advisory (Write|Edit): when a src/core/<submodule>/ or
 * src/aws/<submodule>/ file is written, check whether the corresponding
 * tests/<submodule>.test.ts still carries a RED-phase header comment that
 * claims the implementation does not exist.
 *
 * Non-blocking (exits 2 with a reminder) — same pattern as other advisory
 * hooks. The stale header is cosmetic but misleading; surfacing it at the
 * moment implementation is written ensures it gets removed immediately.
 */
import process from "node:process";
import path from "node:path";
import { readFileSync } from "node:fs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const filePath = input.tool_input?.file_path ?? "";
if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

// Only trigger on library source edits under src/core/ or src/aws/
const srcMatch = /packages\/m3l-common\/src\/(core|aws)\/([^/]+)\//.exec(
  filePath,
);
if (!srcMatch) process.exit(0);

const namespace = srcMatch[1]; // "core" or "aws"
const submodule = srcMatch[2]; // e.g. "errors"

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const testFile = path.join(
  projectDir,
  "packages/m3l-common/tests",
  `${submodule}.test.ts`,
);

let content;
try {
  content = readFileSync(testFile, "utf8");
} catch {
  process.exit(0); // no test file yet — nothing to warn about
}

// Phrases the test-author spoke inserts during RED phase
const RED_PHASE_PATTERNS = [
  /written tests-first \(RED phase\)/,
  /[Tt]he implementation does NOT exist/,
];

const found = RED_PHASE_PATTERNS.find((p) => p.test(content));
if (!found) process.exit(0);

process.stderr.write(
  `⚠ Stale RED-phase header in packages/m3l-common/tests/${submodule}.test.ts\n` +
    `  The implementation now exists under src/${namespace}/${submodule}/.\n` +
    `  Remove the opening /** … */ RED-phase comment block from the test file.\n`,
);
process.exit(2);
