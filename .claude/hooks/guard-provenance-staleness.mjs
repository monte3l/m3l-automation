#!/usr/bin/env node
/**
 * PostToolUse advisory (Write|Edit): when a source file under
 * packages/m3l-common/src/ is edited, check whether any provenance sidecar
 * references it and warn if the source has changed since the recorded commit.
 *
 * Non-blocking (exits 2 with a reminder) — same pattern as other advisory
 * hooks. The hard gate is `pnpm check:provenance` in CI.
 */
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

// Only trigger on library source edits.
if (!/packages\/m3l-common\/src\//.test(filePath)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const abs = path.isAbsolute(filePath)
  ? filePath
  : path.resolve(projectDir, filePath);
const rel = path.relative(projectDir, abs).split(path.sep).join("/");

// Run the provenance validator scoped to this file.
const res = spawnSync(
  "node",
  [path.join(projectDir, "bin/check-doc-provenance.mjs"), "--affected", rel],
  { cwd: projectDir, encoding: "utf8" },
);

// The validator exits 0 (clean), 1 (hard errors), or 0 with warning on stderr.
// Advisory staleness warnings go to stderr; surface them here.
const hasWarning = res.stderr && /stale — re-verify/.test(res.stderr);
const hasError = res.status === 1;

if (!hasWarning && !hasError) process.exit(0);

const detail = hasError ? res.stderr || res.stdout : res.stderr;
process.stderr.write(
  `Provenance staleness detected for ${rel}:\n${detail.trim()}\n`,
);
process.exit(2);
