#!/usr/bin/env node
// Symmetric teardown for a manual sibling-directory worktree — the partner of
// `worktree-new.mjs`. Removes the worktree, prunes stale admin entries, and
// deletes the branch if it is safely merged (`git branch -d`, i.e. merged into
// its upstream/base — not necessarily `main`). This is the immediate teardown
// `worktree-prune.mjs` does NOT do: prune only reaps worktrees whose branch is
// already merged (or that git marks prunable), so an in-progress worktree needs
// this explicit command.
//
//   node bin/worktree-remove.mjs <slug>          # remove if clean
//   node bin/worktree-remove.mjs <slug> --force  # discard uncommitted changes
import process from "node:process";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveCheckoutLocation } from "./lib/checkout-location.mjs";
import { worktreeDirName } from "./lib/worktree-new.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const slug = args.find((a) => !a.startsWith("--"));

if (!slug) {
  console.error(
    "✗  worktree:remove: missing <slug>.\n" +
      "   Usage: pnpm worktree:remove <slug> [--force]",
  );
  process.exit(1);
}

function git(argv, opts = {}) {
  // With stdio: "inherit" execFileSync returns null (output not captured), so
  // guard the .trim() — callers that inherit don't need the return value.
  const out = execFileSync("git", argv, { encoding: "utf8", ...opts });
  return typeof out === "string" ? out.trim() : "";
}

const { mainCheckout, here } = resolveCheckoutLocation({ runGit: git });
const worktreePath = resolve(mainCheckout, "..", worktreeDirName(slug));

// Refuse to remove the main checkout or the tree we are standing in — two
// distinguishable messages, since the remedy differs (the wrong command
// entirely vs. the right command from the wrong place).
if (worktreePath === resolve(mainCheckout)) {
  console.error(
    `✗  worktree:remove: "${slug}" resolves to the main checkout ` +
      `(${worktreePath}) — there is no linked worktree to remove. If you ` +
      "meant to delete a merged branch from the shared checkout, use " +
      "`pnpm branch:cleanup <branch>` instead.",
  );
  process.exit(1);
}
if (worktreePath === here) {
  console.error(
    "✗  worktree:remove: refusing to remove the worktree this session is " +
      `standing in (${worktreePath}). Leave it first — ` +
      '`ExitWorktree({action: "remove"})` if this session entered via ' +
      '`EnterWorktree`, otherwise `ExitWorktree({action: "keep"})` (or `cd` ' +
      "to the main checkout) and re-run `pnpm worktree:remove " +
      `${slug}\` from there.`,
  );
  process.exit(1);
}

// Discover the branch attached to this worktree before removing it, so we can
// offer to delete it afterwards.
let branch = null;
let current = null;
for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
  if (line.startsWith("worktree ")) {
    current = resolve(line.slice("worktree ".length));
  } else if (line.startsWith("branch ") && current === worktreePath) {
    branch = line.slice("branch ".length).replace("refs/heads/", "");
  }
}

console.log(`→  Removing worktree ${worktreePath} ...`);
try {
  const removeArgs = ["worktree", "remove", worktreePath];
  if (force) removeArgs.push("--force");
  git(removeArgs, { stdio: "pipe" });
} catch {
  console.error(
    `✗  worktree:remove: \`git worktree remove\` failed. The worktree may have ` +
      "uncommitted changes or untracked files, or the path may not exist. " +
      "Re-run with --force to discard changes, or check `git worktree list`.",
  );
  process.exit(1);
}

// Best-effort prune of stale admin entries.
try {
  git(["worktree", "prune"]);
} catch {
  console.error(
    "⚠  worktree:remove: `git worktree prune` failed; stale admin entries may " +
      "remain. Inspect `git worktree list`.",
  );
}

// Delete the branch only if it is safely merged (`git branch -d` refuses to
// delete an unmerged branch). Leave unmerged branches in place with a note.
if (branch) {
  try {
    git(["branch", "-d", branch], { stdio: "pipe" });
    console.log(`✓  Deleted merged branch ${branch}.`);
  } catch {
    console.log(
      `•  Kept branch ${branch} (not merged into its base). ` +
        `Delete manually with \`git branch -D ${branch}\` once you're sure.`,
    );
  }
}

console.log(`\n✓  Removed worktree for ${slug}.`);
