// Shared ADR-0087/ADR-0088 vocabulary for a Claude Code session name:
//   <kind>-<slug>, kind from a closed set, slug kebab-case, ≤40 chars.
// Consumed by bin/claude-launch.mjs so the launcher's naming logic cannot
// drift from what .claude/hooks/statusline-context-pressure.mjs validates —
// the two live on opposite sides of the hook/bin boundary and don't share a
// single file, but they must agree on the same shape.

/** @type {readonly string[]} */
export const SESSION_KINDS = Object.freeze([
  "feat",
  "fix",
  "audit",
  "research",
  "docs",
  "review",
  "ci",
  "merge",
]);

/** @type {readonly string[]} */
export const BRANCH_KINDS = Object.freeze(["feat", "fix"]);

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_SESSION_NAME_LENGTH = 40;

/**
 * Derives `{ kind, slug }` from a `feat/<slug>` or `fix/<slug>` branch name.
 * Returns `null` for any other branch shape (`main`, a detached ref, or a
 * branch prefix outside `BRANCH_KINDS`) — there is no signal to infer a
 * `main`-resident kind (`audit`, `research`, ...) from git state alone.
 *
 * @param {string} branch
 * @returns {{ kind: string, slug: string } | null}
 */
export function deriveFromBranch(branch) {
  const match = /^([a-z]+)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(branch);
  if (match === null || !BRANCH_KINDS.includes(match[1])) {
    return null;
  }
  return { kind: match[1], slug: match[2] };
}

/**
 * Validates `kind` and `slug` and composes them into a session name,
 * throwing a `TypeError` with a corrective message on any violation — a
 * malformed name must never reach `claude -n`, since the statusline would
 * then flag the very name the launcher just "applied".
 *
 * @param {string} kind
 * @param {string} slug
 * @returns {string}
 */
export function buildSessionName(kind, slug) {
  if (!SESSION_KINDS.includes(kind)) {
    throw new TypeError(
      `session name: kind "${kind}" is not one of ${SESSION_KINDS.join(" | ")}.`,
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new TypeError(
      `session name: slug "${slug}" must be kebab-case ` +
        "(lowercase letters, digits, single hyphens), e.g. `core-json`.",
    );
  }
  const name = `${kind}-${slug}`;
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    throw new TypeError(
      `session name "${name}" is ${name.length} characters, over the ` +
        `${MAX_SESSION_NAME_LENGTH}-character bound.`,
    );
  }
  return name;
}
