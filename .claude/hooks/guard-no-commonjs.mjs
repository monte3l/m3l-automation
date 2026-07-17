#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): blocks CommonJS constructs in TypeScript
 * source. This package is ESM only ("type": "module"); `require`,
 * `module.exports`, `exports.`, `__dirname`, and `__filename` are forbidden.
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";

const PATTERNS = [
  { re: /\brequire\s*\(/, label: "require(...)" },
  { re: /\bmodule\.exports\b/, label: "module.exports" },
  { re: /\bexports\.[A-Za-z_$]/, label: "exports.<name>" },
  { re: /\b__dirname\b/, label: "__dirname" },
  { re: /\b__filename\b/, label: "__filename" },
];

function contentToCheck(input) {
  const ti = input.tool_input ?? {};
  return [ti.content, ti.new_string].filter((s) => typeof s === "string");
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
// Only guard TS/JS source; skip config files, docs, and this hook dir.
// Normalize separators first: Windows paths use "\", and a literal "/"
// check silently never matches there, leaving this hook unable to exempt
// its own directory on that platform.
if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(filePath)) process.exit(0);
if (filePath.replace(/\\/g, "/").includes("/.claude/hooks/")) process.exit(0);

const source = contentToCheck(input).join("\n");
const hits = PATTERNS.filter((p) => p.re.test(source)).map((p) => p.label);
if (hits.length > 0) {
  process.stderr.write(
    `Blocked: CommonJS construct(s) found (this package is ESM only):\n` +
      hits.map((h) => `  - ${h}`).join("\n") +
      `\nUse ESM equivalents: import/export, import.meta.url, ` +
      `fileURLToPath(import.meta.url).\n`,
  );
  process.exit(2);
}

process.exit(0);
