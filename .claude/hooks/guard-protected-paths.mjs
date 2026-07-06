#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): protects tool-owned artifacts.
 *
 *  - `dist/**` is tsc output and must never be hand-edited.
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";

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

// Generated build output is off-limits.
if (/(^|\/)dist\//.test(filePath)) {
  process.stderr.write(
    `Blocked: \`dist/\` is tsc-generated output and must never be ` +
      `hand-edited. Change the source under \`src/\` and rebuild.\n`,
  );
  process.exit(2);
}

process.exit(0);
