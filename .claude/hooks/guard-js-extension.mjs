#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): blocks writing a relative import that is
 * missing the `.js` extension.
 *
 * This is the #1 documented ESM gotcha — a relative import without `.js`
 * type-checks but fails to resolve at runtime in Node. Path-scoped rules
 * inject on Read, not reliably at Write, so this runs as a hook.
 *
 * Blocks by exiting 2 with a message on stderr (Claude Code convention).
 */
import process from "node:process";

const ALLOWED = [".js", ".mjs", ".cjs", ".json", ".node"];

/** Extract the content being written from the tool input. */
function contentToCheck(input) {
  const ti = input.tool_input ?? {};
  // Write -> content; Edit -> new_string (the text being introduced).
  return [ti.content, ti.new_string].filter((s) => typeof s === "string");
}

/** Find relative import/export specifiers missing an allowed extension. */
function offendingSpecifiers(source) {
  const offenders = [];
  // Matches: from "./x", from '../y', import("./z"), require("./w")
  const re = /\b(?:from|import|require)\s*\(?\s*["'](\.\.?\/[^"']*)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    const hasAllowed = ALLOWED.some((ext) => spec.endsWith(ext));
    if (!hasAllowed) offenders.push(spec);
  }
  return offenders;
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
  process.exit(0); // Not our concern; let the call through.
}

const filePath = input.tool_input?.file_path ?? "";
if (!/\.(ts|tsx|mts|cts)$/.test(filePath)) process.exit(0);

const offenders = contentToCheck(input).flatMap(offendingSpecifiers);
if (offenders.length > 0) {
  const unique = [...new Set(offenders)];
  process.stderr.write(
    `Blocked: relative import(s) missing the required \`.js\` extension ` +
      `(ESM + NodeNext will fail to resolve at runtime):\n` +
      unique.map((s) => `  - "${s}"  ->  "${s}.js"`).join("\n") +
      `\nAdd the \`.js\` extension to every relative import.\n`,
  );
  process.exit(2);
}

process.exit(0);
