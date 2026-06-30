#!/usr/bin/env node
// PostToolUse advisory (Write|Edit): warns when an edit to a reference-index
// input source causes catalog.json / symbol-map.json / README.md to drift.
// Non-blocking (exit 2) — the hard gate is `pnpm check:index` in CI.
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

// Files that feed buildIndex(): provenance sidecars, barrel files,
// implementation-status table, and reference .md pages.
const TRIGGERS = [
  /^docs\/reference\/(core|aws)\/[^/]+\.provenance\.json$/,
  /^packages\/m3l-common\/src\/(core|aws)\/index\.ts$/,
  /^docs\/implementation-status\.md$/,
  /^docs\/reference\/(core|aws)\/[^/]+\.md$/,
];
if (!TRIGGERS.some((re) => re.test(rel))) process.exit(0);

const res = spawnSync(
  "node",
  [path.join(projectDir, "bin/check-reference-index.mjs")],
  { cwd: projectDir, encoding: "utf8" },
);

if (res.status === 0) process.exit(0);

const detail = (res.stderr || res.stdout || "").trim();
process.stderr.write(
  `Reference index is stale after editing ${rel}. Run:\n\n  pnpm gen:index\n\n${detail}\n`,
);
process.exit(2);
