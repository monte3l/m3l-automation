/**
 * Argument parsing for `bin/worktree-new.mjs`, split out for unit testing
 * (kept pattern-parallel with `bin/lib/worktree-prune.mjs`: pure functions,
 * no `process.exit`, no reporter, no git I/O).
 *
 * Imports `SLUG_PATTERN` from `./session-name.mjs` rather than re-declaring
 * the same kebab-case regex here — the two files sit on either side of the
 * worktree-creation / session-naming boundary but must agree on what a valid
 * slug looks like, so there is exactly one definition to drift.
 */
import { SLUG_PATTERN } from "./session-name.mjs";

/** @typedef {{ ok: true, slug: string, kind: "feat" | "fix" | null, from: string | null }} ParsedWorktreeNewArgsOk */
/** @typedef {{ ok: false, error: string }} ParsedWorktreeNewArgsErr */

/**
 * Parses `worktree:new`'s argv into a validated `{ slug, kind, from }` or an
 * error message identical to the ones `bin/worktree-new.mjs` printed inline
 * before this extraction. `kind` is `null` when `--from` is used — a detached
 * worktree has no branch, so no prefix applies.
 *
 * @param {string[]} argv already stripped of `--json` (see `report.mjs`'s
 *   `parseJsonFlag`)
 * @returns {ParsedWorktreeNewArgsOk | ParsedWorktreeNewArgsErr}
 */
export function parseWorktreeNewArgs(argv) {
  // `--from <ref>` is a value-taking flag, so it (and its value) must be
  // pulled out before the remaining args are split into flags/positionals —
  // otherwise <ref> would be mistaken for a second positional slug candidate.
  const args = [...argv];
  let from = null;
  const fromIndex = args.indexOf("--from");
  if (fromIndex !== -1) {
    const value = args[fromIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        error:
          "worktree:new: `--from` requires a ref argument.\n" +
          "   Usage: pnpm worktree:new <slug> --from <ref>",
      };
    }
    from = value;
    args.splice(fromIndex, 2);
  }

  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positionals = args.filter((a) => !a.startsWith("--"));
  const slug = positionals[0];

  if (!slug) {
    return {
      ok: false,
      error:
        "worktree:new: missing <slug>.\n" +
        "   Usage: pnpm worktree:new <slug> [--fix] [--from <ref>]",
    };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      error:
        `worktree:new: invalid slug "${slug}". Use kebab-case ` +
        "(lowercase letters, digits, single hyphens), e.g. `core-json`.",
    };
  }
  if (from !== null && flags.has("--fix")) {
    return {
      ok: false,
      error:
        "worktree:new: `--from <ref>` and `--fix` are mutually exclusive — " +
        "`--from` checks out an existing ref detached, with no new branch " +
        "to prefix.",
    };
  }

  const kind = from === null ? (flags.has("--fix") ? "fix" : "feat") : null;
  return { ok: true, slug, kind, from };
}

/**
 * The sibling worktree directory name for a slug — `worktree-new.mjs`
 * resolves it against the main checkout's parent directory.
 *
 * @param {string} slug
 * @returns {string}
 */
export function worktreeDirName(slug) {
  return `m3l-automation-${slug}`;
}
