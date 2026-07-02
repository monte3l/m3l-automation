#!/usr/bin/env node
/**
 * PostToolUse advisory (Write|Edit): after a reference page under
 * docs/reference/ is written or the root README.md is edited, warn when any doc
 * count has drifted from the filesystem-derived truth.
 *
 * Non-blocking (exits 2 with a reminder) — same pattern as
 * guard-provenance-staleness.mjs / guard-index-staleness.mjs. Rather than
 * re-implement the count regexes (which let the nudge drift from CI), this hook
 * spawns the authoritative CI engines and surfaces their diagnostics:
 *   - bin/check-doc-counts.mjs  → denominator (total documented submodules)
 *   - bin/check-impl-counts.mjs → numerator ("N of 22 implemented")
 * The hard gates are `pnpm check:doc-counts` / `pnpm check:impl-counts` in CI;
 * this is only the in-editor early signal, guaranteed consistent with them.
 */
import process from "node:process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve a file path that may be absolute or relative to an absolute path.
 * Claude Code may deliver either form in tool_input.file_path; normalising to
 * absolute before matching prevents path-normalization misses (#21 bug).
 *
 * @param {string} filePath
 * @param {string} projectDir
 * @returns {string}
 */
export function resolveFilePath(filePath, projectDir) {
  return isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? "";

  // Normalize to absolute path — Claude Code may deliver relative or absolute.
  const absFilePath = resolveFilePath(filePath, projectDir);

  // Trigger on reference page writes/edits OR edits to the root README.md.
  const isReferencePage = /docs\/reference\/(core|aws)\/[^/]+\.md$/.test(
    absFilePath,
  );
  const isRootReadme = absFilePath === join(projectDir, "README.md");
  if (!isReferencePage && !isRootReadme) process.exit(0);

  // Run the authoritative CI engines; each exits 1 with diagnostics on drift.
  const engines = [
    ["bin/check-doc-counts.mjs", "denominator (documented total)"],
    ["bin/check-impl-counts.mjs", "numerator (implemented count)"],
  ];

  const failures = [];
  for (const [script, label] of engines) {
    const res = spawnSync("node", [join(projectDir, script)], {
      cwd: projectDir,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || "").trim();
      failures.push(`${label} — \`${script}\`:\n${detail}`);
    }
  }

  if (failures.length === 0) process.exit(0);

  const trigger = isRootReadme ? "README.md" : "docs/reference/";
  process.stderr.write(
    `Doc-count drift detected after editing ${trigger}. ` +
      `Update the prose to match the derived counts:\n\n` +
      failures.join("\n\n") +
      `\n`,
  );
  process.exit(2);
}
