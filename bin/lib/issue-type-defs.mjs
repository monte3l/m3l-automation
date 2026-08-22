// The single definition of every GitHub Issue Type the ADR-0032 visibility hub
// manages, mirroring bin/lib/label-defs.mjs' and bin/lib/milestone-defs.mjs'
// shape and role. Split out for the same reason: bin/sync-hub-issues.mjs
// provisions these and its own apply-path preflight reads them, so both must
// derive from one source rather than one re-deriving what the other last wrote.
//
// Issue Types were the ADR-0073 facet with the widest gap between declared and
// live. The vocabulary went from 4 kinds to 10, but nothing in the repo knew
// what the org actually had — `gh issue create --type <name>` simply 422s on an
// unknown name, so the first ~50-issue apply run would have failed partway
// through, with roughly half the batch already written.
import { ISSUE_TYPE_COLORS, ISSUE_TYPES, TYPE_KINDS } from "./hub-sync.mjs";

/**
 * Every hub-managed org Issue Type, keyed to an {@link ISSUE_TYPES} entry.
 *
 * Derived from {@link ISSUE_TYPES} and {@link TYPE_KINDS} rather than
 * re-listed, so a new kind cannot be added to the vocabulary and forgotten
 * here — the array simply grows with it. That is the difference from
 * `MILESTONE_DEFS`, which is hand-listed because a milestone carries
 * `legacyTitles` an Issue Type has no analogue for: GitHub identifies an Issue
 * Type by node id, and `updateIssueType` renames one in place, so a rename
 * never needs an alias to survive.
 *
 * `isEnabled` is not modelled. `CreateIssueTypeInput` requires it and every
 * declared kind is created enabled; a kind that should not be offered belongs
 * out of {@link ISSUE_TYPES}, not present-but-disabled — one source of truth
 * for "is this kind real", rather than two that can disagree.
 *
 * @type {{ key: string, name: string, description: string, color: string }[]}
 * @example
 * ```js
 * import { ISSUE_TYPE_DEFS } from "@m3l-automation/workspace/bin/lib/issue-type-defs.mjs";
 *
 * ISSUE_TYPE_DEFS.find((def) => def.key === "ui").color; // "PINK"
 * ```
 */
export const ISSUE_TYPE_DEFS = Object.entries(ISSUE_TYPES).map(
  ([key, name]) => ({
    key,
    name,
    description: TYPE_KINDS[key].description,
    color: TYPE_KINDS[key].color,
  }),
);

// Load-time integrity, mirroring label-defs.mjs' and milestone-defs.mjs'
// assertions: a bad def here becomes a mid-batch GraphQL failure with half the
// org's types provisioned, which is exactly the shape of failure a
// module-load throw exists to convert into a pre-`gh` one.
{
  const seen = new Set();
  for (const def of ISSUE_TYPE_DEFS) {
    if (seen.has(def.name)) {
      // GitHub identifies a type by name for `gh issue edit --type`, so two
      // defs sharing one name would make `planIssueTypes` create one and then
      // silently treat the other as already-live.
      throw new Error(
        `issue-type-defs.mjs: two ISSUE_TYPES kinds both resolve to the name "${def.name}" — ` +
          `an Issue Type name is the handle \`gh issue edit --type\` uses, so it must be unique.`,
      );
    }
    seen.add(def.name);

    if (!ISSUE_TYPE_COLORS.includes(def.color)) {
      throw new Error(
        `issue-type-defs.mjs: TYPE_KINDS.${def.key}.color is "${def.color}", which is not one of ` +
          `GitHub's IssueTypeColor values (${ISSUE_TYPE_COLORS.join(", ")}).`,
      );
    }

    if (def.description.length === 0) {
      throw new Error(
        `issue-type-defs.mjs: TYPE_KINDS.${def.key} has an empty description — a described ` +
          `Issue Type is the whole point of declaring one (ADR-0073).`,
      );
    }
  }
}
