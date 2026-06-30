#!/usr/bin/env node
/**
 * `.worktreeinclude` hygiene gate.
 *
 * The repo-root `.worktreeinclude` lists gitignored local files that
 * `pnpm worktree:setup` (and `claude --worktree` natively) copy into a fresh
 * worktree. This validator keeps that list honest so it cannot silently drift:
 *
 *   1. Every literal entry MUST be gitignored. A tracked file there is a no-op
 *      (worktrees already contain tracked files) and signals a mistake — hard
 *      failure.
 *   2. Every literal entry SHOULD exist in the main checkout. A listed-but-
 *      absent file is copied as nothing, so it is flagged as a warning.
 *   3. Glob / negation patterns are flagged. `worktree-setup.mjs` copies
 *      literal paths only, so a pattern gives a false sense of coverage.
 *
 * Exit codes:
 *   0  No violations (warnings for missing files / patterns still print).
 *   1  A literal entry is tracked (not gitignored).
 *
 * Usage:
 *   node bin/check-worktree-include.mjs
 *   pnpm check:worktree
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorktreeInclude } from "./lib/worktree-include.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const includeFile = join(root, ".worktreeinclude");

if (!existsSync(includeFile)) {
  console.log(
    "✓  check:worktree — no .worktreeinclude file; nothing to validate.",
  );
  process.exit(0);
}

const { literals, patterns } = parseWorktreeInclude(
  readFileSync(includeFile, "utf8"),
);

/**
 * @param {string} rel - Repo-root-relative path.
 * @returns {boolean} true when git considers the path gitignored.
 */
function isGitIgnored(rel) {
  try {
    // `git check-ignore -q` exits 0 when the path IS ignored, 1 when it is not.
    execFileSync("git", ["check-ignore", "-q", "--", rel], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

for (const rel of patterns) {
  warnings.push(
    `glob/negation pattern is not copied by worktree-setup.mjs ` +
      `(literal paths only): ${rel}`,
  );
}

for (const rel of literals) {
  if (!isGitIgnored(rel)) {
    errors.push(
      `tracked file listed (not gitignored) — copying it is a no-op: ${rel}`,
    );
  } else if (!existsSync(join(root, rel))) {
    warnings.push(
      `listed file is absent from the main checkout — nothing will be copied: ${rel}`,
    );
  }
}

for (const w of warnings) process.stderr.write(`⚠  check:worktree — ${w}\n`);

if (errors.length > 0) {
  process.stderr.write(
    `\ncheck:worktree — policy violations found:\n` +
      errors.map((e) => `  ✗  ${e}`).join("\n") +
      `\n\nRemove tracked entries from .worktreeinclude (worktrees already ` +
      `contain tracked files).\n`,
  );
  process.exit(1);
}

console.log(
  `✓  check:worktree — ${String(literals.length)} literal entr` +
    `${literals.length === 1 ? "y" : "ies"} gitignored (see any warnings above).`,
);
process.exit(0);
