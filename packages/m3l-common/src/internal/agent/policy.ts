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
]);

/** The only own keys a grant may carry (rules 11 and 12). */
const GRANT_KEYS: ReadonlySet<string> = new Set([
  "script",
  "operations",
  "allOperations",
]);

/** The only own keys the grading spec may carry (rules 11 and 12). */
const GRADING_KEYS: ReadonlySet<string> = new Set([
  "profiles",
  "regions",
  "accountIds",
]);

/** The grading lists, in the order they are counted against the ceiling. */
const GRADING_LISTS = ["profiles", "regions", "accountIds"] as const;

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

/** Rules 4 through 8 for one grant, projected into a frozen grant. */
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

  const script = Object.hasOwn(value, "script") ? value["script"] : undefined;
  if (!isNonBlankString(script)) {
    throw declarationFailure("scripts.script", "blank-or-non-string", at);
  }
  if (declaredScripts.has(script)) {
    // Rule 5: no last-wins merge in an authorization declaration.
    throw declarationFailure("scripts.script", "duplicate-script", at);
  }
  declaredScripts.add(script);

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

  if (hasOperations) {
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
    // Only the declared key is emitted. The absent one is NOT materialised as
    // an own `undefined`: `M3LAgentScriptGrant` is the caller's own
    // preset-storable declaration type, where `allOperations?: boolean` under
    // `exactOptionalPropertyTypes` means "absent, or a boolean — never
    // `undefined`", so an own `undefined` would need a cast that lies to
    // every `"allOperations" in grant` narrowing. The prototype-shadowing
    // hazard this shape carries is closed at the READ instead — `decide.ts`
    // reads both keys through `Object.hasOwn`, which is the presence rule the
    // rest of this module already follows.
    return Object.freeze({ script, operations });
  }

  // Rule 8: the widening opt-in demands the boolean `true`.
  if (value["allOperations"] !== true) {
    throw declarationFailure("scripts.allOperations", "not-boolean-true", at);
  }
  return Object.freeze({ script, allOperations: true });
}

/** Rules 3 through 8: the grants list, projected into a frozen array. */
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
  if (scripts.length > M3L_AGENT_MAX_SCRIPT_GRANTS) {
    throw declarationFailure("scripts", "too-many-grants");
  }

  const declaredScripts = new Set<string>();
  const grants: M3LAgentScriptGrant[] = [];
  // Indexed, for the same reason `projectStringList` is: the ceiling was
  // checked on `scripts.length`, so the walk must read `scripts.length` too.
  // An iterator-driven walk over an array with a hostile `Symbol.iterator`
  // yields an entry count the bound above never saw.
  for (let grantIndex = 0; grantIndex < scripts.length; grantIndex++) {
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
 * Validates a parsed policy document and projects it into a fresh,
 * deep-frozen declaration in the same walk.
 *
 * @param declaration - The parsed document, trusted for nothing.
 * @returns The validated, deep-frozen declaration, ready to be branded.
 * @throws M3LAgentPolicyDeclarationError On any of the twelve rule
 *   violations; its `context` names the offending field or grant index and
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

/** The twelve rules, run over a document already proven a plain object. */
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
  // The key is omitted when undeclared rather than materialised as an own
  // `undefined`, for the reason given on the grant projection above: the
  // declaration type is the caller's own preset-storable shape and an own
  // `undefined` there would need a lying cast. `decide.ts` reads this key
  // through `Object.hasOwn` for exactly that reason — with
  // `Object.prototype.sensitiveTargets = {}`, a plain dot read made the most
  // cautious deployment of all (the one that declared no grading precisely so
  // every mutation would escalate) auto-approve a prod mutation instead.
  const projected: M3LAgentPolicyDeclaration = {
    version: 1,
    scripts,
    ...(sensitiveTargets !== undefined ? { sensitiveTargets } : {}),
  };
  return Object.freeze(projected);
}
