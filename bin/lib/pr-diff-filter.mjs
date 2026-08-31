// Single source of truth for what the automated PR reviewers are allowed to
// see. Until this module existed the same ignore set was written out three
// times inside .github/workflows/claude-pr-review.yml — a shell `is_ignored()`
// in the guard step (which decides *whether* to review), an awk `ignored()` in
// the pre-compute step (which decides *what patch content* is handed over),
// and a second shell `is_ignored()` filtering the changed-file list. The file
// itself warned they "MUST stay in lockstep"; they had already drifted, with
// the changed-file filter alone omitting `pnpm-lock.yaml`, so the reviewer was
// handed a file list naming the one file the patch had just suppressed.
//
// Consumed by bin/pr-diff-filter.mjs (the CLI the workflows call). Keeping the
// rules here rather than in the workflow YAML is what makes them testable —
// see bin/tests/pr-diff-filter.test.ts.

/**
 * Why a path is withheld from the reviewer. The distinction is not cosmetic:
 * each reason carries its own omission marker (see {@link OMISSION_MARKERS}),
 * because "this gate does not review docs" and "this file is machine-generated"
 * are different claims and the reviewer acts on them differently.
 */
export const IGNORE_REASONS = Object.freeze({
  /** Outside this gate's remit: prose and dependency-bot config. */
  GATE: "gate",
  /** Mechanically regenerated and validated by other CI jobs. */
  LOCKFILE: "lockfile",
});

/**
 * The ignore set, in evaluation order. Ordering matters only in that the
 * lockfile rule must be distinguishable from the gate rules; no path matches
 * more than one entry today.
 */
const IGNORE_RULES = Object.freeze([
  { matches: (path) => path.endsWith(".md"), reason: IGNORE_REASONS.GATE },
  { matches: (path) => path.startsWith("docs/"), reason: IGNORE_REASONS.GATE },
  {
    matches: (path) => path === ".github/dependabot.yml",
    reason: IGNORE_REASONS.GATE,
  },
  {
    matches: (path) => path === "pnpm-lock.yaml",
    reason: IGNORE_REASONS.LOCKFILE,
  },
]);

/**
 * The exact text substituted for an omitted file's diff body. Each file keeps
 * its `diff --git` header plus one of these markers, so the reviewer can still
 * see that the file changed and never mistakes an omission for an unchanged
 * file. Reproduced verbatim from the awk filter this module replaced — the
 * review prompt was tuned against this wording.
 */
export const OMISSION_MARKERS = Object.freeze({
  [IGNORE_REASONS.GATE]: Object.freeze([
    "(diff omitted — not reviewable by this gate: *.md,",
    " docs/**, .github/dependabot.yml. Listed so you know",
    " the file changed; do not review or Read it.)",
  ]),
  [IGNORE_REASONS.LOCKFILE]: Object.freeze([
    "(diff omitted — pnpm-lock.yaml is mechanically generated;",
    " validated by `pnpm install --frozen-lockfile` in CI and",
    " dependency-review.yml, not by this reviewer)",
  ]),
});

/**
 * Why `path` is withheld from the reviewer, or `null` when it is reviewable.
 *
 * @param {string} path Repo-relative path, as `gh pr diff --name-only` emits it.
 * @returns {string | null} An {@link IGNORE_REASONS} value, or `null`.
 */
export function ignoreReason(path) {
  const rule = IGNORE_RULES.find((candidate) => candidate.matches(path));
  return rule ? rule.reason : null;
}

/**
 * Is `path` withheld from the reviewer for any reason?
 *
 * @param {string} path Repo-relative path.
 * @returns {boolean}
 */
export function isIgnored(path) {
  return ignoreReason(path) !== null;
}

/**
 * The reviewable subset of a newline-separated changed-file list. Blank lines
 * are dropped, matching the `[ -z "$f" ] && continue` guard in the shell loops
 * this replaces.
 *
 * @param {string} text Raw `gh pr diff --name-only` output.
 * @returns {string[]} Reviewable paths, in input order.
 */
export function filterChangedFiles(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !isIgnored(line));
}

/**
 * The path a `diff --git` header refers to, or `null` if the line is not one.
 *
 * Deliberately mirrors the awk this replaces (`path = $3; sub(/^a\//, "", path)`):
 * whitespace-split, take the third field, strip a leading `a/`. That means a
 * path containing a space is mis-parsed — true of the awk too, and left
 * unchanged here so the extraction stays behavior-preserving. No such path
 * exists in this repo; fixing it is a separate, deliberate change.
 *
 * @param {string} line A single patch line.
 * @returns {string | null}
 */
function diffHeaderPath(line) {
  if (!line.startsWith("diff --git ")) return null;
  const field = line.trim().split(/\s+/)[2];
  if (field === undefined) return null;
  return field.startsWith("a/") ? field.slice(2) : field;
}

/**
 * A unified diff with every ignored file's body replaced by its omission
 * marker. Headers are always kept, so the reviewer sees that the file changed.
 *
 * @param {string} patch Raw unified diff (`gh pr diff`, no `--patch`).
 * @returns {string} The filtered patch, newline-terminated when non-empty.
 */
export function filterPatch(patch) {
  const out = [];
  let skipping = false;

  for (const line of patch.split("\n")) {
    const path = diffHeaderPath(line);
    if (path !== null) {
      const reason = ignoreReason(path);
      skipping = reason !== null;
      out.push(line);
      if (reason !== null) out.push(...OMISSION_MARKERS[reason]);
      continue;
    }
    if (skipping) continue;
    out.push(line);
  }

  // Drop the empty element a trailing newline leaves behind, then re-add one,
  // so a newline-terminated patch stays newline-terminated and an empty patch
  // stays empty.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
