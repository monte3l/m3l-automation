#!/usr/bin/env node
/**
 * PostToolUse verify (Write|Edit): fast in-loop feedback on Markdown edits.
 *
 * `post-edit-verify.mjs` exits early on non-`.ts` files, so `.md` edits get
 * no format/lint signal until CI. This hook closes that gap by running the
 * same engines CI uses — prettier (format) and rumdl (markdown lint) — scoped
 * to the single edited file, immediately after each Write or Edit.
 *
 * Paths skipped here match `lint:md` exclusions in package.json exactly so the
 * hook and CI are consistent:
 *   - CHANGELOG.md
 *   - .github/pull_request_template.md
 *   - docs/adr/template.md
 *   - docs/plans/** (plans are append-only reference docs)
 *   - node_modules/, dist/, .claude/
 *
 * On failure it exits 2 with a concise stderr advisory — identical contract
 * to post-edit-verify.mjs. The edit is already applied; this is a nudge, not
 * a hard gate.
 */
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const filePath = input.tool_input?.file_path;
if (typeof filePath !== "string" || filePath.length === 0) process.exit(0);

const abs = path.isAbsolute(filePath)
  ? filePath
  : path.resolve(projectDir, filePath);
const rel = path.relative(projectDir, abs).split(path.sep).join("/");

// Only Markdown files.
if (!rel.endsWith(".md")) process.exit(0);

// Skip paths excluded from lint:md in package.json.
const skipPatterns = [
  /^CHANGELOG\.md$/,
  /^\.github\/pull_request_template\.md$/,
  /^docs\/adr\/template\.md$/,
  /^docs\/plans\//,
  /^node_modules\//,
  /(^|\/)dist\//,
  /^\.claude\//,
  /^\.\./,
];
if (skipPatterns.some((re) => re.test(rel))) process.exit(0);

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: projectDir,
    encoding: "utf8",
    env: process.env,
  });
  if (res.error) return undefined;
  return res;
}

const failures = [];

// 1. Format the edited file with prettier.
const fmt = run("pnpm", ["exec", "prettier", "--write", abs]);
if (fmt && fmt.status !== 0) {
  failures.push(`prettier:\n${(fmt.stderr || fmt.stdout || "").trim()}`);
}

// 2. Lint the edited file with rumdl (single-file; matches pnpm lint:md engine).
const lint = run("pnpm", ["exec", "rumdl", "check", abs]);
if (lint && lint.status !== 0) {
  failures.push(`rumdl:\n${(lint.stdout || lint.stderr || "").trim()}`);
}

if (failures.length > 0) {
  process.stderr.write(
    `post-edit-md-verify found issues in \`${rel}\`. Address these before ` +
      `moving on:\n\n${failures.join("\n\n")}\n`,
  );
  process.exit(2);
}

process.exit(0);
