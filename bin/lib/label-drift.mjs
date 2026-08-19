// Pure derivation for bin/check-label-drift.mjs (ADR-0051's live-label drift
// gate). Nothing here reads a filesystem or shells out — the CLI wrapper
// collects a live `gh label list --json name,description,color` payload and
// hands it to deriveLabelDrift alongside the committed bin/lib/label-defs.mjs
// list, mirroring bin/lib/github-features.mjs's gen/check-shared-derivation
// shape so this stays exercisable in tests without spawning anything.
//
// check:hub-drift (bin/lib/hub-sync.mjs's planIssueSync/planBackfill) covers
// issue-level drift — an issue's own labels vs. what its tracker row implies.
// It does NOT cover the label *objects themselves*: nothing previously
// detected a hand-renamed or hand-deleted `priority:*`/`status:*` label on
// the repo before an issue happened to need it. This gate closes that gap.

/**
 * @typedef {{ name: string, description: string, color: string }} LiveLabel
 */

/**
 * Diff the live repository's label set against {@link LABEL_DEFS}
 * (`bin/lib/label-defs.mjs`): every managed label must exist on the remote
 * with the exact description and color `bin/sync-hub-issues.mjs` would
 * bootstrap it with. Reports missing labels and drifted description/color
 * separately, since the two failure modes call for different manual fixes
 * (`gh label create` vs. `gh label edit`). Never reports an *extra* live
 * label as drift — a maintainer-added label outside the managed set
 * (`bug`, `enhancement`, Dependabot's `dependencies`, …) is legitimately
 * outside this gate's authority, same scoping `isManagedLabel` uses in
 * `bin/lib/hub-sync.mjs`.
 *
 * @param {{ name: string, color: string, description: string }[]} labelDefs
 * @param {LiveLabel[]} liveLabels
 * @returns {string[]}
 * @example
 * ```js
 * import { deriveLabelDrift } from "@m3l-automation/workspace/bin/lib/label-drift.mjs";
 *
 * deriveLabelDrift(
 *   [{ name: "hub-sync", color: "0e8a16", description: "Managed." }],
 *   [],
 * );
 * // ['Label "hub-sync" is missing on the live repository — run `pnpm sync:hub -- --apply` to create it.']
 * ```
 */
export function deriveLabelDrift(labelDefs, liveLabels) {
  const live = new Map(liveLabels.map((label) => [label.name, label]));
  /** @type {string[]} */
  const findings = [];

  for (const def of labelDefs) {
    const actual = live.get(def.name);
    if (!actual) {
      findings.push(
        `Label "${def.name}" is missing on the live repository — run ` +
          `\`pnpm sync:hub -- --apply\` to create it.`,
      );
      continue;
    }
    if (actual.description !== def.description) {
      findings.push(
        `Label "${def.name}" description is "${actual.description}", expected ` +
          `"${def.description}" — run \`pnpm sync:hub -- --apply\` to fix it.`,
      );
    }
    if (actual.color.toLowerCase() !== def.color.toLowerCase()) {
      findings.push(
        `Label "${def.name}" color is "${actual.color}", expected "${def.color}" — ` +
          `run \`pnpm sync:hub -- --apply\` to fix it.`,
      );
    }
  }

  return findings;
}
