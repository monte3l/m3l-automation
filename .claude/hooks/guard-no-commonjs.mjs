#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): blocks CommonJS constructs in TypeScript
 * source. This package is ESM only ("type": "module"); `require`,
 * `module.exports`, `exports.`, `__dirname`, and `__filename` are forbidden.
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

const PATTERNS = [
  { re: /\brequire\s*\(/, label: "require(...)" },
  { re: /\bmodule\.exports\b/, label: "module.exports" },
  // A bare \b also fires inside kebab-case filenames like
  // "check-doc-exports.mjs" (hyphen -> letter is a word-boundary
  // transition). Excluding a preceding identifier char or hyphen keeps real
  // `exports.foo = ...` assignments blocked while letting mentions of any
  // "*-exports.<ext>" bin script through.
  { re: /(?<![\w-])exports\.[A-Za-z_$]/, label: "exports.<name>" },
  { re: /\b__dirname\b/, label: "__dirname" },
  { re: /\b__filename\b/, label: "__filename" },
];

const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs)$/;

/**
 * True when `filePath` is TS/JS source this guard should inspect — not a
 * config file, doc, or a file under this hook's own directory.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isGuardedFilePath(filePath) {
  if (!SOURCE_EXT_RE.test(filePath)) return false;
  // Normalize separators first: Windows paths use "\", and a literal "/"
  // check silently never matches there, leaving this hook unable to exempt
  // its own directory on that platform.
  if (filePath.replace(/\\/g, "/").includes("/.claude/hooks/")) return false;
  return true;
}

/**
 * Scan `content` for forbidden CommonJS constructs. Returns a human-readable
 * label per match (empty array when clean).
 *
 * @param {string} content
 * @returns {string[]}
 */
export function findCommonJsHits(content) {
  return PATTERNS.filter((p) => p.re.test(content)).map((p) => p.label);
}

function contentToCheck(input) {
  const ti = input.tool_input ?? {};
  return [ti.content, ti.new_string].filter((s) => typeof s === "string");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? "";
  if (!isGuardedFilePath(filePath)) process.exit(0);

  const source = contentToCheck(input).join("\n");
  const hits = findCommonJsHits(source);
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
}
