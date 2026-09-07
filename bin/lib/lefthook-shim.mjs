/**
 * Detection for a lefthook-generated `.git/hooks/<hook>` shim that fails
 * OPEN — its final unresolved-binary branch echoes "Can't find lefthook in
 * PATH" and falls through to `call_lefthook run "<hook>" "$@"` with no
 * `exit 1`, so a hook that cannot find any lefthook binary silently exits 0
 * (H14, issue #1097). `lefthook.yml`'s `assert_lefthook_installed: true`
 * fixes this at the source for every future `lefthook install`; this module
 * is the detection layer for a shim that predates that fix or was installed
 * on a machine without it.
 *
 * Pure/injectable functions only — no `process.exit`, no reporter. Shared by
 * `bin/check-lefthook-shim.mjs` (the warn-only `pnpm verify` gate) and
 * `.claude/hooks/guard-lefthook-shim.mjs` (the blocking PreToolUse guard),
 * same pattern as `bin/lib/signed-range.mjs`'s split between
 * `bin/verify-signed-range.mjs` and `guard-git-push-signed.mjs`.
 */
import { join } from "node:path";

/**
 * The directory holding the installed git hook shims, given the
 * repository's git common dir (`git rev-parse --path-format=absolute
 * --git-common-dir`). Always the common dir's `hooks/` — never
 * `<worktree>/.git/hooks`, which does not exist inside a linked worktree;
 * only the common dir's `hooks/` is shared across every worktree (H9, issue
 * #1002). Mirrors the idiom in `bin/worktree-setup.mjs` and
 * `bin/lib/checkout-location.mjs`.
 *
 * @param {string} gitCommonDir
 * @returns {string}
 */
export function shimsDir(gitCommonDir) {
  return join(gitCommonDir, "hooks");
}

/**
 * Whether `source` looks like a lefthook-generated shim, as opposed to a
 * `.sample` placeholder, a hand-written script, or another hook manager's
 * (e.g. husky) shim. Lefthook's template always ends with this exact call.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isLefthookShim(source) {
  return typeof source === "string" && source.includes('call_lefthook run "');
}

/**
 * Whether a lefthook shim's unresolved-binary branch falls through without
 * exiting non-zero. Locates the `echo "Can't find lefthook in PATH"` line
 * lefthook's template always emits in that branch, then scans forward only
 * within that branch (up to its closing `fi`) for a trimmed `exit 1` line —
 * the shape `assert_lefthook_installed: true` adds. An `exit 1` elsewhere in
 * the file (a different branch) must not count; scanning is bounded to the
 * branch, not the whole shim.
 *
 * @param {string} source
 * @returns {boolean} true when the branch has no `exit 1` (fails open)
 */
export function shimFailsOpen(source) {
  const lines = source.split("\n");
  const echoIdx = lines.findIndex(
    (line) => line.trim() === 'echo "Can\'t find lefthook in PATH"',
  );
  if (echoIdx === -1) return false; // not the recognizable else-branch shape
  for (let i = echoIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "exit 1") return false;
    if (trimmed === "fi") break; // reached the branch's own close; nothing found
  }
  return true;
}

/**
 * @typedef {object} ShimClassification
 * @property {boolean} present  false when there is no file to read at all
 * @property {boolean} isLefthook  false for a non-lefthook or absent shim
 * @property {boolean} failsOpen  only meaningful when `isLefthook` is true
 */

/**
 * Classify one hook file's content. `source` is `null` for a missing file —
 * a legitimate state (a fresh clone before `pnpm install`, or a hook this
 * repo's `lefthook.yml` doesn't configure), never a finding on its own.
 *
 * @param {string | null} source
 * @returns {ShimClassification}
 */
export function classifyShim(source) {
  if (source === null) {
    return { present: false, isLefthook: false, failsOpen: false };
  }
  const isLefthook = isLefthookShim(source);
  return {
    present: true,
    isLefthook,
    failsOpen: isLefthook ? shimFailsOpen(source) : false,
  };
}

/**
 * Classify every installed lefthook shim in `dir`. Filesystem access is
 * fully injected (no `fs` import here) — the established `bin/tests`
 * pattern (see `bin/lib/staleness-scan.mjs`, `check-logs-index.test.ts`) of
 * exercising pure logic without a temp directory.
 *
 * A missing directory, an unreadable entry, or a non-hook filename never
 * produces a result row — only files git's hook mechanism actually invokes.
 * No real git hook name contains a `.` (verified against git's own hook
 * list); this excludes both git's `.sample` placeholders AND a
 * `lefthook install` backup left from a prior regeneration (e.g.
 * `post-rewrite.old`) — a live scan of this repo's own `.git/hooks/` turned
 * up exactly such a backup, still lefthook-shaped and still fail-open, but
 * never invoked by git and so not a live finding. Non-lefthook shims (a
 * different hook manager, a hand-written script) are likewise omitted: this
 * module only has an opinion about lefthook shims.
 *
 * @param {string} dir  from {@link shimsDir}
 * @param {object} deps
 * @param {(dir: string) => string[]} deps.readdir  entry names, files and
 *   directories alike — errors (missing dir) are swallowed to `[]`
 * @param {(path: string) => string} deps.readFile  throws on any read
 *   failure (a directory, a permissions error); such entries are skipped
 * @returns {(ShimClassification & { hookName: string })[]} sorted by
 *   `hookName`, lefthook shims only
 */
export function scanShims(dir, { readdir, readFile }) {
  let names;
  try {
    names = readdir(dir);
  } catch {
    return [];
  }

  const results = [];
  for (const name of names) {
    if (name.includes(".")) continue; // not a git-invocable hook filename
    let source;
    try {
      source = readFile(join(dir, name));
    } catch {
      continue; // a directory entry, a permissions error — not a finding
    }
    const classification = classifyShim(source);
    if (!classification.isLefthook) continue;
    results.push({ hookName: name, ...classification });
  }
  return results.sort((a, b) => a.hookName.localeCompare(b.hookName));
}
