#!/usr/bin/env node
/**
 * PostToolUse advisory (Write|Edit): warn when a reference page is written
 * under docs/reference/ or when the root README.md is edited, but the prose
 * counts in CLAUDE.md / docs/README.md / README.md no longer match the
 * actual file count.
 *
 * Non-blocking (exits 2 with a reminder) — the same pattern as
 * guard-exports-semver.mjs. The hard gate is bin/check-doc-counts.mjs in CI.
 */
import process from "node:process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  // Normalize to absolute path — Claude Code may deliver relative or absolute paths.
  const absFilePath = resolveFilePath(filePath, projectDir);

  // Trigger on reference page writes/edits OR edits to the root README.md.
  const isReferencePage = /docs\/reference\/(core|aws)\/[^/]+\.md$/.test(
    absFilePath,
  );
  const isRootReadme = absFilePath === join(projectDir, "README.md");
  if (!isReferencePage && !isRootReadme) process.exit(0);

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
  const corePat =
    /Core namespace barrel \((\d+) submodules surfaced here\)/.exec(claudeMd);
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

  const rootReadme = readFile("README.md");
  const rootBadgePat = /modules-\d+%2F(\d+)-/.exec(rootReadme);
  if (rootBadgePat && parseInt(rootBadgePat[1], 10) !== total) {
    mismatches.push(
      `README.md badge URL says total=${rootBadgePat[1]} but derived total is ${total}`,
    );
  }
  const rootProsePat = /\d+ of (\d+) submodules are/.exec(rootReadme);
  if (rootProsePat && parseInt(rootProsePat[1], 10) !== total) {
    mismatches.push(
      `README.md prose says total=${rootProsePat[1]} but derived total is ${total}`,
    );
  }

  if (mismatches.length === 0) process.exit(0);

  const trigger = isRootReadme ? "README.md" : "docs/reference/";
  process.stderr.write(
    `Doc-count drift detected after editing ${trigger}. Update prose to match ` +
      `derived counts (Core: ${coreCount}, AWS: ${awsCount}, total: ${total}):\n` +
      mismatches.map((m) => `  - ${m}`).join("\n") +
      `\nRun \`node bin/check-doc-counts.mjs\` to verify.\n`,
  );
  process.exit(2);
}
