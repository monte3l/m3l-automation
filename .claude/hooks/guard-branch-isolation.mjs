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
 *   - &#42;&#42;/tests/&#42;&#42;
 *
 * Anything else (docs, .claude/, bin/, config) is allowed on `main`.
 *
 * The branch is resolved against the git working tree that *contains the file*
 * (via `git -C <file-dir>`), not `process.cwd()`. This means:
 *   - A session on `main` writing to an absolute path inside a linked worktree on
 *     `feat/foo` is **allowed** — the worktree's branch is checked, not the session's.
 *   - A worktree accidentally checked out on `main` is **still blocked**.
 *   - A non-git directory (no repo ancestor) returns "" → never blocks.
 *
 * A **detached HEAD sitting on the `main` commit** IS treated as `main` — it's
 * the same tree state the guard protects, and a detached-on-`main` write was a
 * real bypass before this was closed.
 *
 * Blocks by exiting 2 with a message on stderr.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns a git runner that executes every command with `git -C dir`, binding
 * the branch resolution to the working tree that contains the file being written.
 *
 * @param {string} dir Absolute directory path.
 * @returns {(args: string[]) => string}
 */
export function defaultGitFor(dir) {
  return function git(args) {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  };
}

/** Default runner bound to process.cwd() — used as fallback / test default. */
const defaultGit = defaultGitFor(process.cwd());

/** True when `filePath` is a source/test path that needs branch isolation. */
export function isProtectedPath(filePath) {
  return (
    /(^|\/)packages\/[^/]+\/src\//.test(filePath) ||
    /(^|\/)tests\//.test(filePath)
  );
}

/**
 * True when the working tree is effectively on `main`: either the checked-out
 * branch is `main`, or HEAD is detached but points at the exact `main` commit.
 *
 * @param {(args: string[]) => string} [git] git runner (trimmed stdout / "")
 * @returns {boolean}
 */
export function isMainOrDetachedOnMain(git = defaultGit) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main") return true;
  if (branch === "HEAD") {
    // Detached: block only when HEAD is the same commit as `main`.
    const head = git(["rev-parse", "HEAD"]);
    const main = git(["rev-parse", "main"]);
    return head !== "" && head === main;
  }
  return false; // any other branch, or no repo ("")
}

// Only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? "";
  if (!isProtectedPath(filePath)) process.exit(0);

  // Use the file's own git working tree for the branch check. Resolving against
  // process.cwd() handles both relative and absolute file_path values, so the
  // check is correct even when file_path points into a different worktree.
  const fileDir = dirname(resolve(filePath));
  const git = defaultGitFor(fileDir);

  if (isMainOrDetachedOnMain(git)) {
    // Detect whether the file lives in a *different* worktree (native or sibling)
    // so the error message can name it explicitly.
    const worktreeRoot = git(["rev-parse", "--show-toplevel"]);
    const inDifferentTree =
      worktreeRoot !== "" && resolve(worktreeRoot) !== resolve(process.cwd());
    const location = inDifferentTree
      ? `the worktree at \`${relative(process.cwd(), worktreeRoot) || worktreeRoot}\``
      : "HEAD";

    process.stderr.write(
      `Blocked: refusing to write \`${filePath}\` while ${location} is \`main\` ` +
        `(or detached on the \`main\` commit). The implementation pipeline must ` +
        `run on an isolated branch/worktree — run \`pnpm worktree:new <slug>\` or ` +
        `\`git switch -c feat/<slug>\` first (CLAUDE.md § Git Workflow, ADR-0013/0014).\n`,
    );
    process.exit(2);
  }

  process.exit(0);
}
