#!/usr/bin/env node
/**
 * SessionStart advisory: when the session runs inside a *linked* git worktree
 * that has not been provisioned, remind the operator to run
 * `pnpm worktree:setup`.
 *
 * A fresh worktree has no `node_modules`, and — for the manual
 * `git worktree add` flow — none of the gitignored local files listed in
 * `.worktreeinclude`. Building or testing there fails confusingly.
 * `claude --worktree` copies `.worktreeinclude` natively but still does NOT run
 * `pnpm install`, so the missing-deps check covers that flow too.
 *
 * Non-blocking: always exits 0. The advisory prints to stderr so it surfaces in
 * the transcript without gating the session.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function gitOut(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Resolve the main checkout (parent of the shared `.git` common dir) and this
// worktree's root. They are equal only in the main checkout.
const commonDir = gitOut([
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);
const worktreeRoot = gitOut(["rev-parse", "--show-toplevel"]);
if (!commonDir || !worktreeRoot) process.exit(0); // not a git repo, or git missing

const mainCheckout = dirname(commonDir);
if (resolve(mainCheckout) === resolve(worktreeRoot)) process.exit(0); // main checkout

const reasons = [];
if (!existsSync(join(worktreeRoot, "node_modules"))) {
  reasons.push("`node_modules` is missing");
}

// Manual-flow check: literal `.worktreeinclude` files present in main but not here.
const includeFile = join(worktreeRoot, ".worktreeinclude");
if (existsSync(includeFile)) {
  const missing = readFileSync(includeFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("#") &&
        !l.startsWith("!") &&
        !/[*?![\]]/.test(l),
    )
    .filter(
      (rel) =>
        existsSync(join(mainCheckout, rel)) &&
        !existsSync(join(worktreeRoot, rel)),
    );
  if (missing.length > 0) {
    reasons.push(`gitignored file(s) not copied: ${missing.join(", ")}`);
  }
}

if (reasons.length > 0) {
  process.stderr.write(
    `⚡ worktree-setup reminder: this worktree looks unprovisioned ` +
      `(${reasons.join("; ")}).\n` +
      "   Run `pnpm worktree:setup` to install deps and copy gitignored local files.\n",
  );
}

process.exit(0);
