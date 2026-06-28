#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): protects tool-owned artifacts.
 *
 *  - `dist/**` is tsc output and must never be hand-edited.
 *  - The `version` field of any `package.json` is owned by semantic-release
 *    and must never be hand-bumped.
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";

function contentToCheck(input) {
  const ti = input.tool_input ?? {};
  return [ti.content, ti.new_string, ti.old_string].filter(
    (s) => typeof s === "string",
  );
}

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

// 1. Generated build output is off-limits.
if (/(^|\/)dist\//.test(filePath)) {
  process.stderr.write(
    `Blocked: \`dist/\` is tsc-generated output and must never be ` +
      `hand-edited. Change the source under \`src/\` and rebuild.\n`,
  );
  process.exit(2);
}

// 2. The version field of a package.json is owned by semantic-release.
if (/(^|\/)package\.json$/.test(filePath)) {
  const touchesVersion = contentToCheck(input).some((s) =>
    /"version"\s*:/.test(s),
  );
  if (touchesVersion) {
    process.stderr.write(
      `Blocked: the \`version\` field in package.json is owned by ` +
        `semantic-release (Conventional Commits drive it). Never hand-bump ` +
        `it. If you must edit package.json, avoid the version line.\n`,
    );
    process.exit(2);
  }
}

process.exit(0);
