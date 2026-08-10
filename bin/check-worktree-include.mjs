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
import { join } from "node:path";
import { parseWorktreeInclude } from "./lib/worktree-include.mjs";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const includeFile = join(root, ".worktreeinclude");
const { json } = parseJsonFlag();
const reporter = createReporter(json);

if (!existsSync(includeFile)) {
  reporter.succeed(
    "check:worktree — no .worktreeinclude file; nothing to validate.",
  );
  reporter.finish();
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

let errorCount = 0;

for (const rel of patterns) {
  reporter.warn(
    `check:worktree — glob/negation pattern is not copied by worktree-setup.mjs ` +
      `(literal paths only): ${rel}`,
    { file: ".worktreeinclude" },
  );
}

for (const rel of literals) {
  if (!isGitIgnored(rel)) {
    reporter.error(
      `check:worktree — tracked file listed (not gitignored) — copying it is a no-op: ${rel}`,
      { file: ".worktreeinclude" },
    );
    errorCount++;
  } else if (!existsSync(join(root, rel))) {
    reporter.warn(
      `check:worktree — listed file is absent from the main checkout — nothing will be copied: ${rel}`,
      { file: ".worktreeinclude" },
    );
  }
}

if (errorCount > 0) {
  if (!json) {
    console.error(
      `\ncheck:worktree — policy violations found above.\n\nRemove tracked ` +
        `entries from .worktreeinclude (worktrees already contain tracked files).`,
    );
  }
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  `check:worktree — ${String(literals.length)} literal entr` +
    `${literals.length === 1 ? "y" : "ies"} gitignored (see any warnings above).`,
);
reporter.finish();
process.exit(0);
