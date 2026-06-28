#!/usr/bin/env node
/**
 * PostToolUse reminder (Write|Edit): the `exports` map is the public contract.
 *
 * The three-entry `exports` map of `@m3l-automation/m3l-common` (`.`, `./core`,
 * `./aws`) IS the public API surface. Adding, removing, or retyping an entry is
 * a semver event that must ship as a `feat!:` / `BREAKING CHANGE:` commit and
 * should have been planned. This does NOT hard-block (the map legitimately
 * changes, and `guard-protected-paths.mjs` already blocks the `version` field);
 * it exits 2 with a reminder so the contract change is a conscious one.
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

// Only the published library's package.json carries the public exports map.
if (!/packages\/m3l-common\/package\.json$/.test(filePath)) process.exit(0);

// Heuristic: did this edit touch the exports map? `"exports"`, the subpath keys,
// or the `types`/`default` conditions that only appear inside that map here.
const touchesExports = contentToCheck(input).some((s) =>
  /"exports"\s*:|"\.\/(core|aws)"|"types"\s*:|"default"\s*:/.test(s),
);
if (!touchesExports) process.exit(0);

process.stderr.write(
  `Reminder: this edit touches the \`exports\` map of @m3l-automation/m3l-common, ` +
    `which is the public API contract (\`.\`, \`./core\`, \`./aws\`). ` +
    `Adding/removing/retyping an entry is a SEMVER event:\n` +
    `  - it must ship as \`feat!:\` or carry a \`BREAKING CHANGE:\` footer, and\n` +
    `  - it should have been planned (see .claude/rules/library-src.md).\n` +
    `New submodules should surface through the namespace barrel ` +
    `(src/core|aws/index.ts), NOT a new subpath entry. If this change is ` +
    `intentional and correctly committed, proceed.\n`,
);
process.exit(2);
