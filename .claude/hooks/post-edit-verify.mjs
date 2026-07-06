#!/usr/bin/env node
/**
 * PostToolUse verify (Write|Edit): fast in-loop feedback on TypeScript edits.
 *
 * Lefthook + CI already gate at commit/push time, but that feedback arrives
 * late. After an edit to a `.ts`/`.mts`/`.cts` file under a package's `src`,
 * `tests` (or a script's `src`), this runs five checks **scoped to that
 * package** so the signal is immediate without paying the whole-monorepo cost:
 *
 *   1. prettier --write   (auto-format the edited file)
 *   2. eslint              (lint the edited file; flat config from repo root)
 *   3. <pkg> typecheck     (`tsc -p tsconfig.json` per package)
 *   4. vitest related      (only the tests that import the edited file)
 *   5. eslint tests/       (only when a src/ file is edited — catches stale
 *                           eslint-disable directives that went unused after
 *                           GREEN; skipped silently if tests/ doesn't exist)
 *
 * eslint runs in-loop (not just at the hub's `pnpm lint` gate) so eslint-only
 * failures — needless assertions, unused params, intentional non-`Error`
 * throws that trip `only-throw-error` / `prefer-promise-reject-errors` and
 * want a justified `eslint-disable` — surface here, not a round later.
 *
 * On any failure it exits 2 with a concise stderr summary, which Claude Code
 * surfaces back to the model as advisory feedback. The edit has already been
 * applied — this is a nudge, not a hard gate. A typecheck that depends on a
 * freshly built `m3l-common` `dist/` will, when the build is stale, surface
 * here as a rebuild nudge, which is intentional.
 */
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
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

// Only TypeScript sources; never generated declarations or the hooks themselves.
if (!/\.(ts|mts|cts)$/.test(rel) || /\.d\.ts$/.test(rel)) process.exit(0);
if (
  rel.startsWith("..") ||
  rel.includes("node_modules/") ||
  /(^|\/)dist\//.test(rel) ||
  rel.startsWith(".claude/")
) {
  process.exit(0);
}

// Scope: library src/tests.
const inScope = /^packages\/[^/]+\/(src|tests)\//.test(rel);
if (!inScope) process.exit(0);

// Walk up to the nearest package.json = the owning package root.
function findPackageDir(startDir) {
  let dir = startDir;
  while (dir.startsWith(projectDir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const pkgDir = findPackageDir(path.dirname(abs));
if (pkgDir === undefined) process.exit(0);

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: projectDir,
    encoding: "utf8",
    env: process.env,
  });
  // If the tool can't even be spawned (e.g. pnpm missing), skip silently
  // rather than emit a misleading failure.
  if (res.error) return undefined;
  return res;
}

const failures = [];

// 1. Format the edited file (best-effort; a parse error is itself signal).
const fmt = run("pnpm", ["exec", "prettier", "--write", abs]);
if (fmt && fmt.status !== 0) {
  failures.push(`prettier:\n${(fmt.stderr || fmt.stdout || "").trim()}`);
}

// 2. Lint the edited file (single file; flat config resolves from repo root
//    and honours its own `ignores`, so no per-package wrapper is needed).
//    Report-only (no --fix) so the root cause is addressed, not masked.
const lint = run("pnpm", ["exec", "eslint", abs]);
if (lint && lint.status !== 0) {
  failures.push(`eslint:\n${(lint.stdout || lint.stderr || "").trim()}`);
}

// 3. Type-check the owning package.
const tc = run("pnpm", ["-C", pkgDir, "typecheck"]);
if (tc && tc.status !== 0) {
  failures.push(`typecheck:\n${(tc.stdout || tc.stderr || "").trim()}`);
}

// 4. Run only the tests related to the edited file.
const vt = run("pnpm", ["exec", "vitest", "related", abs, "--run"]);
if (vt && vt.status !== 0) {
  failures.push(`vitest related:\n${(vt.stdout || vt.stderr || "").trim()}`);
}

// 5. When a src/ file is implemented/updated, also lint the package's tests/
//    directory to surface stale eslint-disable directives that became unused
//    directives once the implementation exists (RED-phase blocks going stale).
if (/^packages\/[^/]+\/src\//.test(rel)) {
  const testsDir = path.join(pkgDir, "tests");
  if (fs.existsSync(testsDir)) {
    const testLint = run("pnpm", ["exec", "eslint", testsDir]);
    if (testLint && testLint.status !== 0) {
      failures.push(
        `eslint (tests/ — scanned because a src/ file was edited; fix the file(s) listed below):\n${(testLint.stdout || testLint.stderr || "").trim()}`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `post-edit-verify found issues in \`${rel}\` (package: ` +
      `${path.relative(projectDir, pkgDir) || "."}). Address these before ` +
      `moving on:\n\n${failures.join("\n\n")}\n`,
  );
  process.exit(2);
}

process.exit(0);
