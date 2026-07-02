#!/usr/bin/env node
/**
 * PreToolUse guard (Write|Edit): keeps implementation work off `main`.
 *
 * The hub-and-spoke pipeline is meant to run on a feature branch or an isolated
 * worktree, never directly on `main` (CLAUDE.md § Git Workflow, ADR-0013/0014).
 * Convention alone did not prevent a whole submodule from being built on `main`
 * (docs/logs/2026-07-01-core-analysis.md, divergence 7), so this guard blocks
 * source/test writes while `HEAD` is `main` — mirroring the hard `dist/`/`version`
 * protections in guard-protected-paths.mjs.
 *
 * Scope (blocked while on `main`):
 *   - packages/&#42;/src/&#42;&#42;
 *   - scripts/&#42;/src/&#42;&#42;
 *   - &#42;&#42;/tests/&#42;&#42;
 *
 * Anything else (docs, .claude/, bin/, config) is allowed on `main`. A detached
 * HEAD or a non-repo cwd is not `main`, so it never blocks.
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";

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

// Only source and test writes need branch isolation.
const isProtected =
  /(^|\/)packages\/[^/]+\/src\//.test(filePath) ||
  /(^|\/)scripts\/[^/]+\/src\//.test(filePath) ||
  /(^|\/)tests\//.test(filePath);

if (!isProtected) process.exit(0);

function currentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return ""; // not a git repo / git missing
  }
}

// A detached HEAD reports "HEAD" and an empty result means no repo — neither is
// `main`, so only the exact `main` branch is blocked.
if (currentBranch() === "main") {
  process.stderr.write(
    `Blocked: refusing to write \`${filePath}\` while HEAD is \`main\`. ` +
      `The implementation pipeline must run on an isolated branch/worktree — ` +
      `run \`pnpm worktree:new <slug>\` or \`git switch -c feat/<slug>\` first ` +
      `(CLAUDE.md § Git Workflow, ADR-0013/0014).\n`,
  );
  process.exit(2);
}

process.exit(0);
