// Resolves this repo's directory inside Claude Code's per-project store
// (~/.claude/projects/<slug>/), which holds both the auto-memory store
// (memory/) and the session transcripts (*.jsonl). Shared by
// bin/check-retrospective.mjs and bin/session-telemetry.mjs — ADR-0084's two
// consumers — so the slug is derived in exactly one place.
//
// Pure apart from the injected git seam: nothing here reads a filesystem or
// shells out on its own, mirroring bin/lib/control-char-scan.mjs's shape so
// it stays exercisable in bin/tests/** without touching disk.
import { dirname, join } from "node:path";

/**
 * Claude Code names a project directory after the checkout's absolute path
 * with every `/` replaced by `-`.
 *
 * @param {string} checkoutRoot absolute path to the main checkout
 * @returns {string}
 */
export function projectSlug(checkoutRoot) {
  return checkoutRoot.replaceAll("/", "-");
}

/**
 * Absolute path to `~/.claude/projects/<slug>` for the repo `runGitFn` runs
 * in.
 *
 * Uses `--git-common-dir`, never `--git-dir`. Inside a linked worktree
 * (ADR-0013) the two differ, and only the common dir points back at the main
 * checkout — which is the path Claude Code slugified when it created the one
 * store every worktree shares. Resolving from `--git-dir` would invent a
 * second, always-empty directory per worktree and report a clean scan of
 * nothing.
 *
 * @param {(args: string[]) => string} runGitFn injected git seam; always an
 *   argv array, never a shell string
 * @param {string} home the user's home directory
 * @returns {string}
 */
export function resolveClaudeProjectDir(runGitFn, home) {
  const commonDir = runGitFn([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  return join(home, ".claude", "projects", projectSlug(dirname(commonDir)));
}
