#!/usr/bin/env node
/**
 * PostToolUse verify (Write|Edit): fast in-loop feedback on Markdown edits.
 *
 * `post-edit-verify.mjs` exits early on non-`.ts` files, so `.md` edits get
 * no format/lint signal until CI. This hook closes that gap by running the
 * same engines CI uses — prettier (format) and rumdl (markdown lint) — scoped
 * to the single edited file, immediately after each Write or Edit.
 *
 * Skip lists: a shared BASE_SKIP_PATTERNS covers paths excluded by both
 * engines. The only asymmetry is docs/plans/ — added only to rumdlSkipPatterns
 * so plan files are auto-formatted by prettier (preventing pre-push drift) but
 * exempt from strict markdown linting (freeform reference docs). Adding a new
 * exclusion to BASE_SKIP_PATTERNS automatically propagates to both engines.
 *
 *   BASE_SKIP_PATTERNS (prettier + rumdl):
 *       - CHANGELOG.md
 *       - .github/pull_request_template.md
 *       - docs/adr/template.md
 *       - node_modules/, dist/, .claude/
 *   rumdlSkipPatterns only: docs/plans/**
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

// Shared exclusions for both engines. Any new path added here is automatically
// skipped by both prettier and rumdl — no need to update two arrays.
const BASE_SKIP_PATTERNS = [
  /^CHANGELOG\.md$/,
  /^\.github\/pull_request_template\.md$/,
  /^docs\/adr\/template\.md$/,
  /^node_modules\//,
  /(^|\/)dist\//,
  /^\.claude\//,
  /^\.\./,
];

// docs/plans/ is auto-formatted by prettier (prevents pre-push drift) but
// skipped by rumdl (freeform reference docs, not subject to strict MD rules).
const prettierSkipPatterns = [...BASE_SKIP_PATTERNS];
const rumdlSkipPatterns = [...BASE_SKIP_PATTERNS, /^docs\/plans\//];

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

// 1. Format the edited file with prettier (skips only prettierSkipPatterns).
if (!prettierSkipPatterns.some((re) => re.test(rel))) {
  const fmt = run("pnpm", ["exec", "prettier", "--write", abs]);
  if (fmt && fmt.status !== 0) {
    failures.push(`prettier:\n${(fmt.stderr || fmt.stdout || "").trim()}`);
  }
}

// 2. Lint the edited file with rumdl (skips docs/plans/ and other exclusions).
if (!rumdlSkipPatterns.some((re) => re.test(rel))) {
  const lint = run("pnpm", ["exec", "rumdl", "check", abs]);
  if (lint && lint.status !== 0) {
    failures.push(`rumdl:\n${(lint.stdout || lint.stderr || "").trim()}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `post-edit-md-verify found issues in \`${rel}\`. Address these before ` +
      `moving on:\n\n${failures.join("\n\n")}\n`,
  );
  process.exit(2);
}

process.exit(0);
