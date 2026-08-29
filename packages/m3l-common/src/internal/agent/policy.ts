/**
 * `internal/agent/policy` — the one-pass declaration walk behind
 * `Core.validateAgentPolicy`: it validates a parsed policy document and
 * projects it into a fresh, deep-frozen {@link M3LAgentPolicyDeclaration} in
 * the same traversal, so nothing downstream ever re-reads the caller's
 * object.
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 * `validateAgentPolicy` (`core/agent/validate-policy.ts`) is a thin public
 * delegation that brands the result.
 */

import { M3LAgentPolicyDeclarationError } from "../../core/agent/M3LAgentPolicyDeclarationError.js";
import { M3LError } from "../../core/errors/index.js";
import type {
  M3LAgentBudgets,
  M3LAgentPolicyDeclaration,
  M3LAgentScriptGrant,
} from "../../core/agent/policy-types.js";
import {
  M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
  M3L_AGENT_MAX_SCRIPT_GRANTS,
  M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES,
} from "../../core/agent/policy-types.js";
import type { M3LSensitiveTargetSpec } from "../../core/prompt/index.js";
import { isArray, isPlainObject } from "../../core/utils/guards.js";
import {
  assertAllowedKeys,
  isNonBlankString,
  projectStringList,
} from "./validation.js";

/** The only own keys a declaration may carry (rules 11 and 12). */
const DECLARATION_KEYS: ReadonlySet<string> = new Set([
  "version",
  "scripts",
  "sensitiveTargets",
  "budgets",
  "dryRunFirst",
]);

/** The only own keys a grant may carry (rules 11 and 12). */
const GRANT_KEYS: ReadonlySet<string> = new Set([
  "script",
  "operations",
  "allOperations",
  "readOnlyOperations",
]);

/** The only own keys the grading spec may carry (rules 11 and 12). */
const GRADING_KEYS: ReadonlySet<string> = new Set([
  "profiles",
  "regions",
  "accountIds",
]);

/** The only own keys `budgets` may carry (rules 11 and 13). */
const BUDGET_KEYS: ReadonlySet<string> = new Set([
  "invocationsPerRun",
  "invocationsPerDay",
  "tokensPerRun",
  "costPerRun",
  "loopIterations",
]);

/** The grading lists, in the order they are counted against the ceiling. */
const GRADING_LISTS = ["profiles", "regions", "accountIds"] as const;

/** The budget ceilings that must be safe, positive INTEGERS (rule 14). */
const BUDGET_INTEGER_KEYS = [
  "invocationsPerRun",
  "invocationsPerDay",
  "tokensPerRun",
  "loopIterations",
] as const;

/**
 * Builds the declaration error for a named field and violation kind. The
 * `context` carries the field, the violation, and structural locators only —
 * never a value read out of the declaration.
 */
function declarationFailure(
  field: string,
  violation: string,
  detail?: Readonly<Record<string, unknown>>,
): M3LAgentPolicyDeclarationError {
  return new M3LAgentPolicyDeclarationError(
    `agent policy declaration: "${field}" is invalid (${violation})`,
    { context: { field, violation, ...detail } },
  );
}

/**
 * Rule 15: the declared cross-check on `kind`, when present. On an
 * operation-scoped grant, every entry must ALSO be in `operations` — step 2
 * would already have denied an absent operation, so an unreachable entry is
 * always a typo. `operations` is `undefined` for an `allOperations` grant,
 * where there is no list to cross-check against and only the shape rules
 * apply.
 */
function projectReadOnlyOperations(
  value: Readonly<Record<string, unknown>>,
  operations: readonly string[] | undefined,
  at: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  if (!Object.hasOwn(value, "readOnlyOperations")) {
    return undefined;
  }
  const readOnlyOperations = projectStringList(
    value["readOnlyOperations"],
    "scripts.readOnlyOperations",
    {
      allowEmpty: false,
      maxEntries: M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
      rejectDuplicates: true,
    },
    declarationFailure,
    at,
  );
  if (
    operations !== undefined &&
    readOnlyOperations.some((entry) => !operations.includes(entry))
  ) {
    throw declarationFailure(
      "scripts.readOnlyOperations",
      "unreachable-entry",
      at,
    );
  }
  return readOnlyOperations;
}

/** Rule 4: the grant's `script`, validated as non-blank and non-duplicate. */
function projectGrantScript(
  value: Readonly<Record<string, unknown>>,
  declaredScripts: Set<string>,
  at: Readonly<Record<string, unknown>>,
): string {
  const script = Object.hasOwn(value, "script") ? value["script"] : undefined;
  if (!isNonBlankString(script)) {
    throw declarationFailure("scripts.script", "blank-or-non-string", at);
  }
  if (declaredScripts.has(script)) {
    // Rule 5: no last-wins merge in an authorization declaration.
    throw declarationFailure("scripts.script", "duplicate-script", at);
  }
  declaredScripts.add(script);
  return script;
}

// Only the declared keys are emitted below. An absent one is NOT
// materialised as an own `undefined`: `M3LAgentScriptGrant` is the caller's
// own preset-storable declaration type, where an optional field under
// `exactOptionalPropertyTypes` means "absent, or the type — never
// `undefined`", so an own `undefined` would need a cast that lies to every
// `"allOperations" in grant`/`"readOnlyOperations" in grant` narrowing. The
// prototype-shadowing hazard this shape carries is closed at the READ
// instead — `decide.ts` reads every one of these keys through
// `Object.hasOwn`, which is the presence rule the rest of this module
// already follows.

/** Rules 7 and 15: an operation-scoped grant (`operations` declared). */
function projectOperationScopedGrant(
  value: Readonly<Record<string, unknown>>,
  script: string,
  at: Readonly<Record<string, unknown>>,
): M3LAgentScriptGrant {
  const operations = projectStringList(
    value["operations"],
    "scripts.operations",
    {
      allowEmpty: false,
      maxEntries: M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
      rejectDuplicates: true,
    },
    declarationFailure,
    at,
  );
  const readOnlyOperations = projectReadOnlyOperations(value, operations, at);
  return Object.freeze({
    script,
    operations,
    ...(readOnlyOperations !== undefined ? { readOnlyOperations } : {}),
  });
}

/** Rules 8 and 15: a whole-script grant (`allOperations: true`). */
function projectAllOperationsGrant(
  value: Readonly<Record<string, unknown>>,
  script: string,
  at: Readonly<Record<string, unknown>>,
): M3LAgentScriptGrant {
  // Rule 8: the widening opt-in demands the boolean `true`.
  if (value["allOperations"] !== true) {
    throw declarationFailure("scripts.allOperations", "not-boolean-true", at);
  }
  const readOnlyOperations = projectReadOnlyOperations(value, undefined, at);
  return Object.freeze({
    script,
    allOperations: true,
    ...(readOnlyOperations !== undefined ? { readOnlyOperations } : {}),
  });
}

/** Rules 4 through 8 and 15 for one grant, projected into a frozen grant. */
function projectGrant(
  value: unknown,
  grantIndex: number,
  declaredScripts: Set<string>,
): M3LAgentScriptGrant {
  const at = { grantIndex };
  if (!isPlainObject(value)) {
    throw declarationFailure("scripts", "grant-not-a-plain-object", at);
  }
  assertAllowedKeys(value, GRANT_KEYS, "scripts", declarationFailure, at);
  const script = projectGrantScript(value, declaredScripts, at);

  // Rule 6: exactly one of the two. Omission never means "everything" — a
  // whole-script grant has to be written down, so a typo'd key can never
  // silently widen authority.
  const hasOperations = Object.hasOwn(value, "operations");
  const hasAllOperations = Object.hasOwn(value, "allOperations");
  if (hasOperations === hasAllOperations) {
    throw declarationFailure(
      "scripts",
      hasOperations
        ? "both-operations-and-allOperations"
        : "neither-operations-nor-allOperations",
      at,
    );
  }

  return hasOperations
    ? projectOperationScopedGrant(value, script, at)
    : projectAllOperationsGrant(value, script, at);
}

/** Rules 3 through 8 and 15: the grants list, projected into a frozen array. */
function projectGrants(
  declaration: Readonly<Record<string, unknown>>,
): readonly M3LAgentScriptGrant[] {
  if (!Object.hasOwn(declaration, "scripts")) {
    throw declarationFailure("scripts", "absent");
  }
  const scripts = declaration["scripts"];
  if (!isArray(scripts)) {
    throw declarationFailure("scripts", "not-an-array");
  }
  if (scripts.length === 0) {
    throw declarationFailure("scripts", "empty-list");
  }
  // Captured ONCE. `scripts.length` is a `Proxy` trap surface, not just a
  // plain property: a `length` getter can return a small value for this
  // check and the real (huge) one on every subsequent read, so checking the
  // bound against one read and driving the loop off per-iteration reads of
  // `scripts.length` lets a hostile proxy walk straight past
  // `M3L_AGENT_MAX_SCRIPT_GRANTS`. Both the bound check and the loop below
  // derive from this single capture.
  const scriptsLength = scripts.length;
  if (scriptsLength > M3L_AGENT_MAX_SCRIPT_GRANTS) {
    throw declarationFailure("scripts", "too-many-grants");
  }

  const declaredScripts = new Set<string>();
  const grants: M3LAgentScriptGrant[] = [];
  // Indexed, for the same reason `projectStringList` is: the ceiling was
  // checked on `scriptsLength`, so the walk must read the same captured
  // value too. An iterator-driven walk over an array with a hostile
  // `Symbol.iterator` yields an entry count the bound above never saw.
  for (let grantIndex = 0; grantIndex < scriptsLength; grantIndex++) {
    grants.push(projectGrant(scripts[grantIndex], grantIndex, declaredScripts));
  }
  return Object.freeze(grants);
}

/** Rules 9 through 12 for the grading spec, projected into a frozen spec. */
function projectGradingSpec(
  declaration: Readonly<Record<string, unknown>>,
): M3LSensitiveTargetSpec | undefined {
  // Absence of the spec is legal — its presence is the grading opt-in.
  if (!Object.hasOwn(declaration, "sensitiveTargets")) {
    return undefined;
  }
  const spec = declaration["sensitiveTargets"];
  if (!isPlainObject(spec)) {
    throw declarationFailure("sensitiveTargets", "not-a-plain-object");
  }
  assertAllowedKeys(spec, GRADING_KEYS, "sensitiveTargets", declarationFailure);

  const projected: {
    profiles?: readonly string[];
    regions?: readonly string[];
    accountIds?: readonly string[];
  } = {};
  let declaredEntries = 0;
  for (const key of GRADING_LISTS) {
    if (!Object.hasOwn(spec, key)) {
      continue;
    }
    const list = projectStringList(
      spec[key],
      `sensitiveTargets.${key}`,
      {
        allowEmpty: false,
        maxEntries: M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES,
        rejectDuplicates: true,
      },
      declarationFailure,
    );
    declaredEntries += list.length;
    // Rule 10: the ceiling is a total across the three lists, not a per-list
    // bound — the cost it exists to bound is the whole spec's size.
    if (declaredEntries > M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES) {
      throw declarationFailure("sensitiveTargets", "too-many-entries");
    }
    projected[key] = list;
  }

  // Rule 9, the validator's most important rule: every declared list is
  // non-empty, so a zero total means all three were omitted.
  // `sensitiveTargets({})` builds a predicate that matches nothing, which
  // would silently grade every target as non-sensitive and auto-approve every
  // mutation.
  if (declaredEntries === 0) {
    throw declarationFailure("sensitiveTargets", "no-graded-list");
  }
  return Object.freeze(projected);
}

/**
 * Rules 13 and 14 for `budgets`, when present, projected into a frozen
 * budgets object. An empty `budgets` (all five ceilings omitted) is rejected
 * rather than treated as absent — it would read as "this deployment governs
 * spend" in a diff while enforcing nothing at all.
 */
/**
 * Rule 14: one of the four integer ceilings — a positive, finite, safe
 * integer. A ceiling of `0` is rejected along with negatives, fractions, and
 * non-finite values: it would be exhausted before the run begins, which is a
 * way of spelling "deny this script" that the `scripts` allowlist already
 * spells properly.
 */
function readPositiveSafeIntegerCeiling(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const ceiling = value[key];
  if (!(
    typeof ceiling === "number" &&
    Number.isSafeInteger(ceiling) &&
    ceiling > 0
  )) {
    throw declarationFailure("budgets", "invalid-ceiling", { key });
  }
  return ceiling;
}

/** Rule 14: `costPerRun` — positive and finite, but MAY be fractional. */
function readPositiveFiniteCeiling(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const ceiling = value[key];
  if (!(
    typeof ceiling === "number" &&
    Number.isFinite(ceiling) &&
    ceiling > 0
  )) {
    throw declarationFailure("budgets", "invalid-ceiling", { key });
  }
  return ceiling;
}

function projectBudgets(
  declaration: Readonly<Record<string, unknown>>,
): M3LAgentBudgets | undefined {
  if (!Object.hasOwn(declaration, "budgets")) {
    return undefined;
  }
  const value = declaration["budgets"];
  if (!isPlainObject(value)) {
    throw declarationFailure("budgets", "not-a-plain-object");
  }
  assertAllowedKeys(value, BUDGET_KEYS, "budgets", declarationFailure);

  const projected: Record<string, number> = {};
  for (const key of BUDGET_INTEGER_KEYS) {
    if (Object.hasOwn(value, key)) {
      projected[key] = readPositiveSafeIntegerCeiling(value, key);
    }
  }
  if (Object.hasOwn(value, "costPerRun")) {
    projected["costPerRun"] = readPositiveFiniteCeiling(value, "costPerRun");
  }

  // Rule 13: an empty `budgets` (all five ceilings omitted) reads as "this
  // deployment governs spend" in a diff while enforcing nothing at all.
  if (Object.keys(projected).length === 0) {
    throw declarationFailure("budgets", "no-declared-ceiling");
  }
  return Object.freeze(projected);
}

/**
 * Rule 16: `dryRunFirst`, when present, is a boolean. Unlike `allOperations`
 * — where only `true` is accepted, because the key exists solely to widen —
 * `false` is accepted here and means the same as absent, so a deployment can
 * write the default down.
 */
function projectDryRunFirst(
  declaration: Readonly<Record<string, unknown>>,
): boolean | undefined {
  if (!Object.hasOwn(declaration, "dryRunFirst")) {
    return undefined;
  }
  const value = declaration["dryRunFirst"];
  if (typeof value !== "boolean") {
    throw declarationFailure("dryRunFirst", "not-a-boolean");
  }
  return value;
}

/**
 * Validates a parsed policy document and projects it into a fresh,
 * deep-frozen declaration in the same walk.
 *
 * @param declaration - The parsed document, trusted for nothing.
 * @returns The validated, deep-frozen declaration, ready to be branded.
 * @throws M3LAgentPolicyDeclarationError On any of the sixteen rule
 *   violations; its `context` names the offending grant index or key and
 *   the violation kind, never a value.
 */
export function validateAgentPolicyDeclaration(
  declaration: unknown,
): M3LAgentPolicyDeclaration {
  try {
    // The plain-object check is INSIDE the guarded region, not ahead of it:
    // `isPlainObject` calls `Object.getPrototypeOf`, which is itself a
    // trappable operation. A `Proxy` whose `getPrototypeOf` trap throws used
    // to escape as a raw `RangeError` from a guard that reads as total, while
    // the sibling `ownKeys` trap — reached one frame deeper, inside the
    // walk — surfaced correctly as `traversal-threw`.
    if (!isPlainObject(declaration)) {
      throw declarationFailure("declaration", "not-a-plain-object");
    }
    return walkDeclaration(declaration);
  } catch (cause) {
    // Already typed — re-throw unchanged rather than double-wrapping. This is
    // also what keeps the `not-a-plain-object` throw above intact.
    if (cause instanceof M3LError) {
      throw cause;
    }
    // Same exposure as step 0's action traversal: a throwing accessor
    // (`get version() { throw }`) or a Proxy trap raises a raw error from
    // inside a walk that reads as total, breaking the `instanceof M3LError`
    // triage this module's error classes promise in their own `@example`.
    //
    // `cause` IS chained. `M3LCheckpointError`'s no-chaining precedent turned
    // on a cause's message reaching a serialised record; since #734,
    // `M3LError.toJSON()` allowlists its cause projection and a foreign
    // (non-`M3LError`) cause collapses to `{ name }` only — no message, no
    // stack, no own fields. The live `.cause` stays available for hand
    // debugging, which is the whole diagnostic value here.
    throw new M3LAgentPolicyDeclarationError(
      `agent policy declaration: "declaration" is invalid (traversal-threw)`,
      {
        context: { field: "declaration", violation: "traversal-threw" },
        cause,
      },
    );
  }
}

/** The sixteen rules, run over a document already proven a plain object. */
function walkDeclaration(
  declaration: Readonly<Record<string, unknown>>,
): M3LAgentPolicyDeclaration {
  assertAllowedKeys(
    declaration,
    DECLARATION_KEYS,
    "declaration",
    declarationFailure,
  );

  // Rule 2: an unknown version is never "best effort".
  if (!Object.hasOwn(declaration, "version") || declaration["version"] !== 1) {
    throw declarationFailure("version", "unsupported-version");
  }

  const scripts = projectGrants(declaration);
  const sensitiveTargets = projectGradingSpec(declaration);
  const budgets = projectBudgets(declaration);
  const dryRunFirst = projectDryRunFirst(declaration);
  // Keys are omitted when undeclared rather than materialised as an own
  // `undefined`, for the reason given on the grant projection above: the
  // declaration type is the caller's own preset-storable shape and an own
  // `undefined` there would need a lying cast. `decide.ts` reads each of
  // these keys through `Object.hasOwn` for exactly that reason — with
  // `Object.prototype.sensitiveTargets = {}`, a plain dot read made the most
  // cautious deployment of all (the one that declared no grading precisely so
  // every mutation would escalate) auto-approve a prod mutation instead. Note
  // `dryRunFirst` IS materialised when its value is the boolean `false` —
  // `false` is not `undefined`, and the spread guard below only omits truly
  // undeclared keys, so a declaration that wrote the default down keeps it.
  const projected: M3LAgentPolicyDeclaration = {
    version: 1,
    scripts,
    ...(sensitiveTargets !== undefined ? { sensitiveTargets } : {}),
    ...(budgets !== undefined ? { budgets } : {}),
    ...(dryRunFirst !== undefined ? { dryRunFirst } : {}),
  };
  return Object.freeze(projected);
}
