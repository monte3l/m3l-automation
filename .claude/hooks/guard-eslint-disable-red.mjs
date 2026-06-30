#!/usr/bin/env node
/**
 * PreToolUse blocking (Write|Edit): reject a test-file write/edit that
 * introduces eslint-disable directives for import-resolution or type-inference
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
 * Blocking (exits 2): the write is rejected before the file is touched,
 * preventing stale directives from landing on disk in the first place.
 *
 * Content source (detected by field presence, not tool_name — matches the
 * sibling-hook pattern so the guard stays live if tool_name is absent):
 *   tool_input.content    present → Write (full new file — complete coverage)
 *   tool_input.new_string present → Edit  (replacement text being introduced)
 *
 * Known limitation — Edit path: only the incoming `new_string` hunk is
 * scanned. A directive already present in lines that the current Edit does
 * not touch is invisible to this hook. This means a directive written before
 * this hook was installed (or from a session that pre-dates it) can survive
 * subsequent Edit operations undetected.
 *
 * This gap is bounded: the hook blocks all *new* introductions, so only
 * pre-existing directives are affected. Two mitigations exist at the lint
 * level: `reportUnusedDisableDirectives: "error"` in eslint.config.js
 * catches unused directives at any `pnpm lint` run, and step 5 of
 * post-edit-verify.mjs lints the full tests/ directory whenever a src/ file
 * is edited — surfacing stale directives once the implementation exists (GREEN).
 * Between RED and GREEN a pre-existing directive can survive Edit ops; after
 * GREEN the combination of these two mechanisms will flag it.
 */
import process from "node:process";
import path from "node:path";

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

// Detect content by field presence (Write → content, Edit → new_string),
// matching the sibling-hook pattern. This is self-healing: if tool_name is
// absent or renamed, the relevant field still identifies the intent.
const ti = input.tool_input ?? {};
let content;
if (typeof ti.content === "string" && ti.content.length > 0) {
  content = ti.content; // Write: full new file
} else if (typeof ti.new_string === "string" && ti.new_string.length > 0) {
  content = ti.new_string; // Edit: replacement text being introduced
} else {
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
[guard-eslint-disable-red] Blocked: ${rel} introduces eslint-disable
directive(s) for import-resolution / type-inference rules: ${ruleList}

If this is a RED-phase test (the module doesn't exist yet), remove the
eslint-disable. The test runner doesn't care about lint in the RED state —
the tests should fail because the module is absent, not because lint is
suppressed. These directives become stale once the implementation exists
and require a cleanup spoke after GREEN.

If this suppression is for an intentional non-Error throw/reject in an
error-channel test (only-throw-error / prefer-promise-reject-errors), it
is correct and not flagged by this hook.
`);
process.exit(2);
