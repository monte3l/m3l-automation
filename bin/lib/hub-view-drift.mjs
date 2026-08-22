// Pure derivation for bin/check-hub-views.mjs (ADR-0073's board-surface drift
// gate). Nothing here reads a filesystem or shells out — the CLI wrapper
// collects the live board's views and fields and hands them to
// deriveViewDrift alongside the committed bin/lib/hub-views.mjs declaration,
// mirroring bin/lib/label-drift.mjs's shape so this stays exercisable in tests
// without spawning anything.
//
// What the neighbouring gates do NOT cover, and why this exists:
//
// check:hub-drift compares each ISSUE against its tracker row. check:label-drift
// compares each LABEL OBJECT against LABEL_DEFS. Neither looks at the board —
// so the board's own surface (which views exist, what columns they show, in
// what order, sorted how, and whether the Status/Priority option sets still
// match) had no gate at all. Two of those facets are UI-only: a view's sort is
// readable but not writable through any mutation, and the built-in Type field
// has no createProjectV2Field counterpart. For exactly those, prose in
// docs/contributing/filing-work.md was the only enforcement, which is how the
// live board's sort came to differ from what the runner's own MANUAL_VIEW_STEPS
// claimed it was.

/**
 * @typedef {{ field: string | null, direction: string | null }} SortPair
 * @typedef {{
 *   id: string,
 *   name: string,
 *   layout: string,
 *   filter?: string | null,
 *   sort?: SortPair[],
 *   columns?: string[],
 * }} LiveView
 * @typedef {{ name: string, dataType: string, options?: { name: string }[] }} LiveField
 */

/**
 * Why each optional column may legitimately be absent, keyed by column name.
 *
 * A predicate per column, rather than one shared condition: the exemption for
 * "Type" is specifically "the ISSUE_TYPE field is not enabled", and a future
 * optional column would silently inherit that unrelated condition if the
 * exemption were keyed on the set as a whole. An optional column with no entry
 * here is reported rather than quietly exempted — a gate must not grow silent
 * blind spots by declaration alone.
 */
const OPTIONAL_COLUMN_EXEMPTIONS = {
  // The built-in Issue Type column: no mutation can enable its field, so until
  // a human does, neither field nor column can exist.
  Type: (liveFields) =>
    !liveFields.some((field) => field.dataType === "ISSUE_TYPE"),
};

/**
 * Ordered element-wise equality. Deliberately not a joined-string compare:
 * declared column names contain spaces ("Parent issue", "Linked pull
 * requests"), so joining on " " would read ["Parent issue"] and
 * ["Parent", "issue"] as equal — and joining on a control character makes the
 * source binary to git, which is worse.
 */
function sameOrder(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Render a sort list as "Priority ASC, Created ASC". */
function formatSort(pairs) {
  return pairs.length > 0
    ? pairs.map((pair) => `${pair.field} ${pair.direction}`).join(", ")
    : "none";
}

/**
 * Compare two option-name lists positionally. Order is load-bearing for both
 * single-selects: a board single-select sorts by DECLARED option order, and
 * the Backlog view sorts Priority ascending — so `3-gated` landing after
 * `Governance` would silently reorder the view even though the two sets are
 * equal.
 */
function optionSetFindings(fieldName, declared, live) {
  const findings = [];
  const declaredNames = declared.map((option) => option.name);
  const liveNames = live.map((option) => option.name);

  const missing = declaredNames.filter((name) => !liveNames.includes(name));
  const extra = liveNames.filter((name) => !declaredNames.includes(name));

  for (const name of missing) {
    findings.push(
      `Board field "${fieldName}" is missing the declared option "${name}" — ` +
        `run \`pnpm sync:hub-projects -- --init --apply\` to reconcile it.`,
    );
  }
  for (const name of extra) {
    findings.push(
      `Board field "${fieldName}" carries an undeclared option "${name}" — ` +
        `add it to bin/lib/hub-views.mjs if it is wanted, or run ` +
        `\`pnpm sync:hub-projects -- --init --apply\` to remove it. Note that ` +
        `updateProjectV2Field.singleSelectOptions is a full REPLACE, so ` +
        `reconciling relies on the own-name-first id lookup to preserve every ` +
        `item's current value.`,
    );
  }

  // Only worth reporting once the sets themselves agree — otherwise the
  // missing/extra findings above already describe the difference, and an
  // order complaint on top of them is noise.
  if (
    missing.length === 0 &&
    extra.length === 0 &&
    !sameOrder(declaredNames, liveNames)
  ) {
    findings.push(
      `Board field "${fieldName}" has the right options in the wrong order ` +
        `(live: ${liveNames.join(", ")}; declared: ${declaredNames.join(", ")}). ` +
        `A single-select sorts by declared option order, so this changes how ` +
        `the Backlog view orders rows — run ` +
        `\`pnpm sync:hub-projects -- --init --apply\`.`,
    );
  }

  return findings;
}

/**
 * Diff the live board's view set and field vocabulary against the
 * `bin/lib/hub-views.mjs` declaration.
 *
 * Asserts, per ADR-0073: the view set in **both** directions (a declared view
 * missing, and an undeclared view still present); each declared view's layout
 * and filter; its **ordered** visible columns; its sort against
 * `VIEW_DEFS[n].sort`; the presence of a `dataType: ISSUE_TYPE` field; and the
 * `Status`/`Priority` option sets.
 *
 * A column named in `optionalFields` is exempt **only while the ISSUE_TYPE
 * field is absent** — that is the built-in `Type` column, which no mutation can
 * enable, and the ISSUE_TYPE finding already covers that cause with the right
 * remediation (reporting both would name one cause twice). Once the field
 * exists the column is mandatory like any other, so removing it by hand is
 * reported.
 *
 * @param {{
 *   viewDefs: { name: string, layout: string, filter: string, fields: string[], sort?: SortPair[] }[],
 *   liveViews: LiveView[],
 *   liveFields: LiveField[],
 *   optionalFields?: Set<string>,
 *   desiredStatusOptions: { name: string }[],
 *   desiredPriorityOptions: { name: string }[],
 * }} input
 * @returns {string[]} one finding per drift, each carrying its own remediation
 * @example
 * ```js
 * import { deriveViewDrift } from "@m3l-automation/workspace/bin/lib/hub-view-drift.mjs";
 *
 * deriveViewDrift({
 *   viewDefs: [{ name: "Backlog", layout: "TABLE_LAYOUT", filter: "is:open", fields: [] }],
 *   liveViews: [],
 *   liveFields: [],
 *   desiredStatusOptions: [],
 *   desiredPriorityOptions: [],
 * });
 * // ['Declared view "Backlog" does not exist on the board — run `pnpm sync:hub-projects -- --init --apply` to create it.', ...]
 * ```
 */
export function deriveViewDrift({
  viewDefs,
  liveViews,
  liveFields,
  optionalFields = new Set(),
  desiredStatusOptions,
  desiredPriorityOptions,
}) {
  /** @type {string[]} */
  const findings = [];
  const liveByName = new Map(liveViews.map((view) => [view.name, view]));
  const declaredNames = new Set(viewDefs.map((def) => def.name));

  // Matched on dataType rather than name: it is the only ISSUE_TYPE-typed field
  // a board can have, and matching the name would break under localization —
  // and would let a hand-made single-select called "Type" satisfy it.
  const issueTypeFieldPresent = liveFields.some(
    (field) => field.dataType === "ISSUE_TYPE",
  );

  /**
   * Whether a declared column is currently exempt from the column assertion.
   * A mandatory column never is; an optional one is exempt only while its own
   * documented condition holds.
   */
  const isExempt = (name) => {
    if (!optionalFields.has(name)) return false;
    const condition = Object.hasOwn(OPTIONAL_COLUMN_EXEMPTIONS, name)
      ? OPTIONAL_COLUMN_EXEMPTIONS[name]
      : undefined;
    if (!condition) {
      findings.push(
        `Column "${name}" is in OPTIONAL_VIEW_FIELDS but has no entry in ` +
          `OPTIONAL_COLUMN_EXEMPTIONS, so there is no stated reason it may be ` +
          `absent. Add one in bin/lib/hub-view-drift.mjs, or drop it from the ` +
          `optional set — otherwise it is an untested blind spot.`,
      );
      return false;
    }
    return condition(liveFields);
  };

  for (const def of viewDefs) {
    const live = liveByName.get(def.name);
    if (!live) {
      findings.push(
        `Declared view "${def.name}" does not exist on the board — run ` +
          `\`pnpm sync:hub-projects -- --init --apply\` to create it.`,
      );
      continue;
    }

    if (live.layout !== def.layout) {
      findings.push(
        `View "${def.name}" has layout ${live.layout}, expected ${def.layout} — ` +
          `run \`pnpm sync:hub-projects -- --init --apply\`.`,
      );
    }

    if ((live.filter ?? "") !== def.filter) {
      findings.push(
        `View "${def.name}" filter is "${live.filter ?? ""}", expected ` +
          `"${def.filter}" — run \`pnpm sync:hub-projects -- --init --apply\`.`,
      );
    }

    // Ordered, not set-wise: visibleFieldIds IS the column order, so a
    // reordered view is real drift even when every column is present.
    //
    // An optional column is exempt only while its own documented condition
    // holds — not merely because the live view happens to lack it. Keying the
    // exemption on the live column instead (as this originally did) meant a
    // `Type` column removed by hand while the field was enabled matched neither
    // this check nor the ISSUE_TYPE one below, and the gate reported a clean
    // board: precisely the silent miss it exists to close.
    const expectedColumns = def.fields.filter((name) => !isExempt(name));
    const liveColumns = live.columns ?? [];
    if (!sameOrder(liveColumns, expectedColumns)) {
      findings.push(
        `View "${def.name}" columns are [${liveColumns.join(", ")}], expected ` +
          `[${expectedColumns.join(", ")}] — run ` +
          `\`pnpm sync:hub-projects -- --init --apply\`. The order is part of ` +
          `the assertion: configuration.visibleFieldIds is the column order, ` +
          `not a set.`,
      );
    }

    const declaredSort = def.sort ?? [];
    const liveSort = live.sort ?? [];
    if (
      declaredSort.length > 0 &&
      formatSort(liveSort) !== formatSort(declaredSort)
    ) {
      findings.push(
        `View "${def.name}" sort is ${formatSort(liveSort)}, expected ` +
          `${formatSort(declaredSort)}. Sort is readable but NOT writable ` +
          `through any mutation, so no sync can fix this: open the board, ` +
          `select the "${def.name}" view, and set the sort by hand under its ` +
          `"…" menu -> Sort.`,
      );
    }
  }

  for (const live of liveViews) {
    if (!declaredNames.has(live.name)) {
      findings.push(
        `View "${live.name}" is on the board but not declared in ` +
          `bin/lib/hub-views.mjs — either declare it, or remove it with ` +
          `\`pnpm sync:hub-projects -- --prune-views --apply\`. Deleting a ` +
          `view is irreversible through the API, which is why that is a ` +
          `separate opt-in flag.`,
      );
    }
  }

  if (!issueTypeFieldPresent) {
    findings.push(
      `The board has no ISSUE_TYPE field, so the "Type" column cannot exist. ` +
        `This one is UI-only — createProjectV2Field's dataType accepts only ` +
        `the custom types, never a built-in — so enable it by hand: board "…" ` +
        `menu -> Settings -> Fields -> Type. The next ` +
        `\`pnpm sync:hub-projects -- --init --apply\` then adds the column.`,
    );
  }

  const fieldByName = new Map(liveFields.map((field) => [field.name, field]));
  for (const [name, declared] of [
    ["Status", desiredStatusOptions],
    ["Priority", desiredPriorityOptions],
  ]) {
    const live = fieldByName.get(name);
    if (!live) {
      findings.push(
        `Board field "${name}" does not exist — run ` +
          `\`pnpm sync:hub-projects -- --init --apply\` to create it.`,
      );
      continue;
    }
    findings.push(...optionSetFindings(name, declared, live.options ?? []));
  }

  return findings;
}
