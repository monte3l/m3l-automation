#!/usr/bin/env node
// Provisions the development environment for a git worktree created with the
// manual `git worktree add` flow (which, unlike `claude --worktree`, does NOT
// consult `.worktreeinclude`). Run it from inside the new worktree:
//
//   git worktree add ../m3l-automation-<slug> -b feat/<slug>
//   cd ../m3l-automation-<slug>
//   pnpm worktree:setup
//
// Steps: install dependencies, then copy the gitignored local files listed in
// `.worktreeinclude` from the main checkout (a fresh worktree has none of them).
import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const worktreeRoot = process.cwd();

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: worktreeRoot });
}

function gitOut(args) {
  return execFileSync("git", args, {
    cwd: worktreeRoot,
    encoding: "utf8",
  }).trim();
}

// The main checkout is the parent of the shared `.git` common dir; that is where
// the gitignored local files (e.g. `.env`) actually live.
const gitCommonDir = gitOut([
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);
const mainCheckout = dirname(gitCommonDir);

if (resolve(mainCheckout) === resolve(worktreeRoot)) {
  console.error(
    "✗  worktree:setup must be run from inside a worktree, not the main checkout.",
  );
  process.exit(1);
}

console.log(`→  Installing dependencies in ${worktreeRoot} ...`);
run("pnpm", ["install"]);

const includeFile = join(worktreeRoot, ".worktreeinclude");
let copied = 0;
let skipped = 0;

if (existsSync(includeFile)) {
  const patterns = readFileSync(includeFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  for (const rel of patterns) {
    // Literal file paths only; glob/negation patterns are reported, not expanded.
    if (/[*?![\]]/.test(rel) || rel.startsWith("!")) {
      console.log(`•  Skipping non-literal pattern (copy manually): ${rel}`);
      skipped++;
      continue;
    }
    const from = join(mainCheckout, rel);
    const to = join(worktreeRoot, rel);
    if (!existsSync(from)) continue; // nothing to copy from main
    if (existsSync(to)) {
      skipped++;
      continue; // never clobber an existing file in the worktree
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`✓  Copied ${rel} from main checkout`);
    copied++;
  }
} else {
  console.log("•  No .worktreeinclude found; skipping file copy.");
}

console.log(
  `\n✓  Worktree ready: deps installed, ${copied} file(s) copied, ${skipped} skipped.`,
);
console.log(
  "   Next: make your changes, commit, and `git push -u origin HEAD`.",
);
