// The single definition of every GitHub label the ADR-0032 visibility hub
// manages, shared by two runners: bin/sync-hub-issues.mjs (bootstraps them
// on --apply) and bin/check-label-drift.mjs (ADR-0051's live-label drift
// gate — compares the remote's actual labels against this list). Splitting
// this out of sync-hub-issues.mjs keeps both runners deriving from exactly
// one source of truth instead of the drift check re-deriving what --apply
// last created and silently going stale.
import {
  HUB_LABEL,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from "./hub-sync.mjs";

/**
 * The hub-sync label, the three priority labels, the governance type label,
 * and the two status labels, plus the `triage` label
 * `.github/ISSUE_TEMPLATE/failure_report.yml` declares but which GitHub never
 * creates on its own — bootstrapped (create or `--force` update) by
 * `bin/sync-hub-issues.mjs` on every --apply run before any issue/milestone
 * action. `triage` is a literal, not a `bin/lib/hub-sync.mjs` constant: it is
 * never derived from a tracker row (nothing in ROADMAP.md/IMPLEMENTATION.md
 * maps to it), it exists purely so a template-filed failure report doesn't
 * silently drop a declared label. Names and descriptions carry the ADR-0051
 * semantic vocabulary (priority:0-now/1-next/2-later, type:governance),
 * replacing the original priority:p0/p1/p2/governance names.
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
    name: PRIORITY_LABELS.p2,
    color: "fbca04",
    description: "Later — gated or deferred backlog; not yet scheduled.",
  },
  {
    name: TYPE_LABELS.governance,
    color: "5319e7",
    description:
      "Governance follow-up (ADR/process work); outside the priority tiers.",
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
