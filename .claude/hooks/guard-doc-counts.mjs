#!/usr/bin/env node
/**
 * PostToolUse advisory (Write|Edit): warn when a reference page is written
 * under docs/reference/ but the prose counts in CLAUDE.md / docs/README.md
 * no longer match the actual file count.
 *
 * Non-blocking (exits 2 with a reminder) — the same pattern as
 * guard-exports-semver.mjs. The hard gate is bin/check-doc-counts.mjs in CI.
 */
import process from "node:process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

// Only trigger on reference page writes/edits.
if (!/docs\/reference\/(core|aws)\/[^/]+\.md$/.test(filePath)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function countMdFiles(dir) {
  try {
    return readdirSync(join(projectDir, dir)).filter((f) => f.endsWith(".md"))
      .length;
  } catch {
    return 0;
  }
}

const coreCount = countMdFiles("docs/reference/core");
const awsCount = countMdFiles("docs/reference/aws");
const total = coreCount + awsCount;

function readFile(rel) {
  try {
    return readFileSync(join(projectDir, rel), "utf8");
  } catch {
    return "";
  }
}

const mismatches = [];

const claudeMd = readFile("CLAUDE.md");
const corePat = /Core namespace barrel \((\d+) submodules surfaced here\)/.exec(
  claudeMd,
);
if (corePat && parseInt(corePat[1], 10) !== coreCount) {
  mismatches.push(
    `CLAUDE.md core barrel comment says ${corePat[1]} but there are ${coreCount} Core reference pages`,
  );
}
const implPat = /\d+ of (\d+) submodules are implemented/.exec(claudeMd);
if (implPat && parseInt(implPat[1], 10) !== total) {
  mismatches.push(
    `CLAUDE.md implementation state says total=${implPat[1]} but derived total is ${total}`,
  );
}

const readmeMd = readFile("docs/README.md");
const readmePat = /(\d+) submodules documented/.exec(readmeMd);
if (readmePat && parseInt(readmePat[1], 10) !== total) {
  mismatches.push(
    `docs/README.md says ${readmePat[1]} submodules but derived total is ${total}`,
  );
}

if (mismatches.length === 0) process.exit(0);

process.stderr.write(
  `Doc-count drift detected after editing docs/reference/. Update prose to match ` +
    `derived counts (Core: ${coreCount}, AWS: ${awsCount}, total: ${total}):\n` +
    mismatches.map((m) => `  - ${m}`).join("\n") +
    `\nRun \`node bin/check-doc-counts.mjs\` to verify.\n`,
);
process.exit(2);
