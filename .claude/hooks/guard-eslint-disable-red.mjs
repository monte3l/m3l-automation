#!/usr/bin/env node
/**
 * PostToolUse advisory (Write|Edit): when a test file is written, warn if it
 * contains eslint-disable directives for import-resolution or type-inference
 * rules that are RED-phase noise.
 *
 * During TDD, the implementation does not exist yet, so ESLint will produce
 * import-x/no-unresolved and @typescript-eslint/no-unsafe-* findings against
 * the non-existent module. Adding eslint-disable to suppress them makes the
 * directives stale the moment the implementation exists — removing them then
 * requires an extra cleanup spoke after GREEN.
 *
 * The correct pattern: leave those warnings in the RED state. They self-resolve
 * once the module exists. Narrow suppressions for intentional non-Error
 * throw/reject in error-channel tests (only-throw-error / prefer-promise-reject-
 * errors) are correct and are NOT flagged by this hook.
 *
 * Non-blocking (exits 2 with an advisory on stderr) — same contract as the
 * other advisory hooks.
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

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const abs = path.isAbsolute(filePath)
  ? filePath
  : path.resolve(projectDir, filePath);
const rel = path.relative(projectDir, abs).split(path.sep).join("/");

// Only trigger on test files (packages/m3l-common/tests/**).
if (!/packages\/m3l-common\/tests\//.test(rel)) process.exit(0);
if (!rel.endsWith(".test.ts") && !rel.endsWith(".test.mts")) process.exit(0);

// Read the file content to scan for RED-phase disable directives.
let content;
try {
  content = readFileSync(abs, "utf8");
} catch {
  process.exit(0);
}

// Rules that are RED-phase noise: they fire because the module doesn't exist,
// not because the test is wrong. Suppressing them creates stale directives.
const RED_PHASE_RULES = [
  "import-x/no-unresolved",
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-argument",
];

// Inline forms (eslint-disable-next-line / eslint-disable-line): capture to EOL.
const inlinePattern = /eslint-disable(?:-next-line|-line)\s+([^\n]+)/g;
// Block forms (/* eslint-disable ... */): capture all rules until */.
// (?!-) prevents matching inside eslint-disable-next-line / eslint-disable-line.
// [\s\S]*? spans multiple lines for multi-rule blocks.
const blockPattern = /\/\*\s*eslint-disable(?!-)([\s\S]*?)\*\//g;

function extractRules(ruleText) {
  return ruleText
    .split(/[,\n]/)
    .map((r) =>
      r
        .replace(/\s*\*\/$/, "") // strip trailing */ from block-comment inline form
        .replace(/\s*--.*$/, "") // strip -- reason comment
        .trim(),
    )
    .filter((r) => r.length > 0);
}

const flagged = [];

for (const m of content.matchAll(inlinePattern)) {
  const redRules = extractRules(m[1]).filter((r) =>
    RED_PHASE_RULES.includes(r),
  );
  if (redRules.length > 0) flagged.push(redRules);
}

for (const m of content.matchAll(blockPattern)) {
  const rules = extractRules(m[1]);
  // Bare /* eslint-disable */ with no rule list silences everything for the
  // rest of the file — treat it as flagging all RED_PHASE_RULES.
  const redRules =
    rules.length === 0
      ? [...RED_PHASE_RULES]
      : rules.filter((r) => RED_PHASE_RULES.includes(r));
  if (redRules.length > 0) flagged.push(redRules);
}

if (flagged.length === 0) process.exit(0);

const ruleList = [...new Set(flagged.flat())].join(", ");
process.stderr.write(`\
[guard-eslint-disable-red] Advisory: ${rel} contains eslint-disable
directive(s) for import-resolution / type-inference rules: ${ruleList}

If this is a RED-phase test (the module doesn't exist yet), remove the
eslint-disable. The test runner doesn't care about lint in the RED state —
the tests should fail because the module is absent, not because lint is
suppressed. These directives become stale once the implementation exists
and require a cleanup spoke after GREEN.

If this suppress is for an intentional non-Error throw/reject in an
error-channel test (only-throw-error / prefer-promise-reject-errors), it
is correct and not flagged by this hook.
`);
process.exit(2);
