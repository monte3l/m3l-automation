// The single definition of every GitHub label the ADR-0032 visibility hub
// manages, shared by two runners: bin/sync-hub-issues.mjs (bootstraps them
// on --apply) and bin/check-label-drift.mjs (ADR-0051's live-label drift
// gate — compares the remote's actual labels against this list). Splitting
// this out of sync-hub-issues.mjs keeps both runners deriving from exactly
// one source of truth instead of the drift check re-deriving what --apply
// last created and silently going stale.
import {
  HUB_LABEL,
  ISSUE_TYPES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from "./hub-sync.mjs";

/**
 * The hub-sync label, the three priority labels, one `type:*` label per
 * {@link ISSUE_TYPES} value, one `status:*` label per {@link Item} status
 * (ADR-0052's 2026-08-20 Update widened both label families to full
 * coverage — originally `type:governance` and `status:deferred`/`blocked`
 * only), plus the `triage` label `.github/ISSUE_TEMPLATE/failure_report.yml`
 * declares but which GitHub never creates on its own — bootstrapped (create
 * or `--force` update) by `bin/sync-hub-issues.mjs` on every --apply run
 * before any issue/milestone action. `triage` is a literal, not a
 * `bin/lib/hub-sync.mjs` constant: it is never derived from a tracker row
 * (nothing in ROADMAP.md/IMPLEMENTATION.md maps to it), it exists purely so
 * a template-filed failure report doesn't silently drop a declared label.
 * Names and descriptions carry the ADR-0051 semantic vocabulary
 * (priority:0-now/1-next/2-later), replacing the original
 * priority:p0/p1/p2/governance names.
 *
 * @type {{ name: string, color: string, description: string }[]}
 * @example
 * ```js
 * import { LABEL_DEFS } from "@m3l-automation/workspace/bin/lib/label-defs.mjs";
 *
 * LABEL_DEFS.find((def) => def.name === "priority:0-now").color; // "b60205"
 * ```
 */
export const LABEL_DEFS = [
  {
    name: HUB_LABEL,
    color: "0e8a16",
    description:
      "Managed by the ADR-0032 visibility hub sync — do not edit manually.",
  },
  {
    name: PRIORITY_LABELS.p0,
    color: "b60205",
    description: "Now — unblock-first work; do before more consumer scripts.",
  },
  {
    name: PRIORITY_LABELS.p1,
    color: "d93f0b",
    description: "Next — the near-term consumer-fleet wave.",
  },
  {
    // Description narrows to "real work, not yet scheduled" in the same change
    // that renames this tier's milestone (ADR-0073) — the two must move
    // together, and the rename needs the in-place PATCH path first.
    name: PRIORITY_LABELS.p2,
    color: "fbca04",
    description: "Later — gated or deferred backlog; not yet scheduled.",
  },
  {
    name: PRIORITY_LABELS.p3,
    color: "fef2c0",
    description:
      "Gated — cannot start until an external gate or future ADR opens.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.libraryCapability],
    color: "0052cc",
    description: "Library capability — packages/m3l-common (core/, aws/).",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.cliCapability],
    color: "1d76db",
    description: "CLI capability — packages/m3l-cli.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.packageCapability],
    color: "0e8a16",
    description:
      "Package capability — creating or building out another workspace package.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.ui],
    color: "f9d0c4",
    description: "UI — a browser-facing surface.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.infrastructure],
    color: "6f42c1",
    description:
      "Infrastructure — deployment, packaging, or runtime substrate.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.fleetRetrofit],
    color: "bfd4f2",
    description:
      "Fleet retrofit — changes to existing consumers under scripts/*.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.toolingGates],
    color: "006b75",
    description: "Tooling & gates — bin/, .github/, .claude/.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.consumerScript],
    color: "c2e0c6",
    description: "A new consumer script under scripts/*.",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.friction],
    color: "e99695",
    description: "Library friction / defect report (F-series).",
  },
  {
    name: TYPE_LABELS[ISSUE_TYPES.governance],
    color: "5319e7",
    description:
      "Governance follow-up (ADR/process work); outside the priority tiers.",
  },
  {
    name: STATUS_LABELS.todo,
    color: "c5def5",
    description: "To Do — not yet started.",
  },
  {
    name: STATUS_LABELS["in-progress"],
    color: "1d76db",
    description: "In Progress — actively being worked.",
  },
  {
    name: STATUS_LABELS.deferred,
    color: "8250df",
    description: "Deferred — unscheduled until its gate opens.",
  },
  {
    name: STATUS_LABELS.blocked,
    color: "cf222e",
    description: "Blocked — cannot proceed until an external condition clears.",
  },
  {
    name: STATUS_LABELS.done,
    color: "2ea44f",
    description: "Done — completed.",
  },
  {
    name: STATUS_LABELS.rejected,
    color: "6a737d",
    description: "Rejected — explicitly decided against, not merely deferred.",
  },
  {
    name: "triage",
    color: "d4c5f9",
    description:
      "Needs a fault-origin decision. Applied by .github/ISSUE_TEMPLATE/failure_report.yml.",
  },
];

// GitHub's `gh label create --description` hard cap. Asserted at module load
// (not just documented) after a live `gh api` 422 during testing — the
// original `status:blocked` description was 101 characters, one over the
// limit, and `bootstrapLabels` iterates LABEL_DEFS in order, so the failure
// surfaced only after `status:deferred` (86 chars, under the cap) had
// already been created on the real repo. Fail fast, before any `gh` call,
// rather than mutating GitHub partway through a label batch again.
export const LABEL_DESCRIPTION_MAX_LENGTH = 100;
for (const { name, description } of LABEL_DEFS) {
  if (description.length > LABEL_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `LABEL_DEFS["${name}"].description is ${description.length} chars, over GitHub's ` +
        `${LABEL_DESCRIPTION_MAX_LENGTH}-char label-description limit.`,
    );
  }
}

// `gh issue edit --add-label <name>` fails if the label doesn't already
// exist on the repo — a PRIORITY_LABELS/TYPE_LABELS/STATUS_LABELS entry with
// no matching LABEL_DEFS row would pass every local check silently and then
// hard-fail the very first live --apply that needs it (bootstrapLabels only
// ever creates what's listed here). Asserted at module load, the same
// fail-fast-before-any-gh-call guarantee as the description-length check
// above, rather than discovered as a `gh` 404 mid-apply. HUB_LABEL and
// `triage` are exempt: HUB_LABEL is already required above by construction
// (every LABEL_DEFS entry literal starting point), and `triage` is a
// legitimate LABEL_DEFS-only extra with no hub-sync.mjs constant behind it.
const managedLabelValues = [
  ...Object.values(PRIORITY_LABELS),
  ...Object.values(TYPE_LABELS),
  ...Object.values(STATUS_LABELS),
];
const definedLabelNames = new Set(LABEL_DEFS.map((def) => def.name));
for (const label of managedLabelValues) {
  if (!definedLabelNames.has(label)) {
    throw new Error(
      `"${label}" is referenced by PRIORITY_LABELS/TYPE_LABELS/STATUS_LABELS but has no ` +
        `LABEL_DEFS entry — bootstrapLabels would never create it, so the first --apply ` +
        `needing it would fail with a "label not found" gh error. Add it to LABEL_DEFS.`,
    );
  }
}
