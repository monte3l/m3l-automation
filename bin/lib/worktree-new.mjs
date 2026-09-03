/**
 * Argument parsing for `bin/worktree-new.mjs`, split out for unit testing
 * (kept pattern-parallel with `bin/lib/worktree-prune.mjs`: pure functions,
 * no `process.exit`, no reporter, no git I/O).
 *
 * Imports `SLUG_PATTERN`/`BRANCH_KINDS` from `./session-name.mjs` rather than
 * re-declaring them here — the two files sit on either side of the
 * worktree-creation / session-naming boundary but must agree on what a valid
 * slug looks like and which prefixes are mintable, so there is exactly one
 * definition of each to drift.
 */
import { BRANCH_KINDS, SLUG_PATTERN } from "./session-name.mjs";

/** @typedef {(typeof BRANCH_KINDS)[number]} BranchKind */
/** @typedef {{ ok: true, slug: string, kind: BranchKind | null, from: string | null }} ParsedWorktreeNewArgsOk */
/** @typedef {{ ok: false, error: string }} ParsedWorktreeNewArgsErr */

const USAGE =
  "   Usage: pnpm worktree:new <slug> [--kind <kind>] [--fix] [--from <ref>]";

/**
 * Parses `worktree:new`'s argv into a validated `{ slug, kind, from }` or an
 * error message. `kind` is `null` when `--from` is used — a detached
 * worktree has no branch, so no prefix applies. `--kind <kind>` selects any
 * of `BRANCH_KINDS`; `--fix` is a documented alias for `--kind fix`, kept
 * for the MCP `worktree` tool's boolean `fix` param and existing muscle
 * memory. Any other `--*` flag is rejected rather than silently ignored.
 *
 * @param {string[]} argv already stripped of `--json` (see `report.mjs`'s
 *   `parseJsonFlag`)
 * @returns {ParsedWorktreeNewArgsOk | ParsedWorktreeNewArgsErr}
 */
export function parseWorktreeNewArgs(argv) {
  // `--from <ref>` and `--kind <kind>` are value-taking flags, so each (and
  // its value) must be pulled out before the remaining args are split into
  // flags/positionals — otherwise the value would be mistaken for a second
  // positional slug candidate.
  const args = [...argv];
  let from = null;
  const fromIndex = args.indexOf("--from");
  if (fromIndex !== -1) {
    const value = args[fromIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        error: `worktree:new: \`--from\` requires a ref argument.\n${USAGE}`,
      };
    }
    from = value;
    args.splice(fromIndex, 2);
  }

  let kindValue = null;
  const kindIndex = args.indexOf("--kind");
  if (kindIndex !== -1) {
    const value = args[kindIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        error: `worktree:new: \`--kind\` requires a value.\n${USAGE}`,
      };
    }
    kindValue = value;
    args.splice(kindIndex, 2);
  }

  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positionals = args.filter((a) => !a.startsWith("--"));
  const slug = positionals[0];

  const unrecognized = [...flags].find((f) => f !== "--fix");
  if (unrecognized !== undefined) {
    return {
      ok: false,
      error: `worktree:new: unrecognized flag \`${unrecognized}\`.\n${USAGE}`,
    };
  }

  if (!slug) {
    return {
      ok: false,
      error: `worktree:new: missing <slug>.\n${USAGE}`,
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

  const hasFix = flags.has("--fix");
  if (from !== null && (kindValue !== null || hasFix)) {
    return {
      ok: false,
      error:
        "worktree:new: `--from <ref>` and `--kind`/`--fix` are mutually " +
        "exclusive — `--from` checks out an existing ref detached, with no " +
        "new branch to prefix.",
    };
  }
  if (kindValue !== null && hasFix && kindValue !== "fix") {
    return {
      ok: false,
      error:
        `worktree:new: \`--kind ${kindValue}\` conflicts with \`--fix\` ` +
        "(an alias for `--kind fix`). Pass only one.",
    };
  }
  if (kindValue !== null && !BRANCH_KINDS.includes(kindValue)) {
    return {
      ok: false,
      error:
        `worktree:new: invalid kind "${kindValue}". Use one of ` +
        `${BRANCH_KINDS.join(" | ")}.`,
    };
  }

  const kind =
    from === null
      ? /** @type {BranchKind} */ (kindValue ?? (hasFix ? "fix" : "feat"))
      : null;
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
