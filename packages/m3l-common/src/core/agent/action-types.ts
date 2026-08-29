/**
 * `core/agent/action-types` — the action vocabulary an agent submits for
 * judgement, plus the library's own frozen projection of it (ADR-0060).
 *
 * @packageDocumentation
 */

import type { M3LDestructiveTarget } from "../prompt/index.js";

/**
 * The caller-declared autonomy tier of an intended action.
 *
 * This is the module's one trust boundary: `kind` is **asserted** by the
 * caller, never detected by the library. Derive it from the script's own
 * contract — its `M3LCommandModule` descriptor or its ADR-0055 operation
 * declaration — and never from model output. A script that declares
 * `"read-only"` for something that mutates has defeated the tier rule, and no
 * validation here can notice.
 *
 * @example
 * ```ts
 * import type { M3LAgentActionKind } from "@m3l-automation/m3l-common/core";
 *
 * const kind: M3LAgentActionKind = "mutating";
 * ```
 */
export type M3LAgentActionKind = "read-only" | "mutating";

/**
 * The intended action a caller submits to `evaluateAgentAction`.
 *
 * @remarks
 * `script` is a plain name matched **verbatim** against a grant's `script`,
 * never an `M3LScript`: an ADR-0009 layering zone forbids any `core/**`
 * module from importing `core/script`, and `import-x/no-restricted-paths` is
 * not type-aware, so even `import type` is blocked.
 *
 * @example
 * ```ts
 * import type { M3LAgentAction } from "@m3l-automation/m3l-common/core";
 *
 * const action: M3LAgentAction = {
 *   script: "dynamodb-crud",
 *   operation: "put-item",
 *   kind: "mutating",
 *   target: { profile: "sandbox", region: "eu-central-1" },
 *   parameterNames: ["table", "item"],
 * };
 * ```
 */
export interface M3LAgentAction {
  /** The script name, matched verbatim against a grant's `script`. */
  readonly script: string;
  /**
   * A declared operation name (ADR-0055's vocabulary, carried as a string).
   * Absent when the script has no operation vocabulary.
   */
  readonly operation?: string;
  /** The caller-declared autonomy tier; see {@link M3LAgentActionKind}. */
  readonly kind: M3LAgentActionKind;
  /**
   * ADR-0048's own target descriptor, imported from `core/prompt`. This
   * module declares no target shape of its own.
   */
  readonly target?: M3LDestructiveTarget;
  /**
   * Parameter **names**, never values. Recorded but not judged in slice 1; it
   * is present from day one because ADR-0061's log entry schema requires it
   * and slice 2's dry-run-first keys on the parameter shape.
   */
  readonly parameterNames?: readonly string[];
  /**
   * A strict opt-in: when present it must be a **boolean**. `false` is
   * accepted and recorded as `false`; a non-boolean (`"yes"`, `1`, `null`) is
   * rejected rather than coerced, because present-but-valueless is malformed
   * input, not "absent". Recorded in slice 1, judged in slice 2.
   */
  readonly dryRun?: boolean;
}

/**
 * The record's copy of ADR-0048's target descriptor.
 *
 * @remarks
 * Deliberately **not** {@link M3LDestructiveTarget}. That type declares
 * `region?: string` and `accountId?: string`, which under
 * `exactOptionalPropertyTypes` means "absent, or a string — never
 * `undefined`". The projection emits both as **own keys holding
 * `undefined`**, so naming it `M3LDestructiveTarget` was a lie the compiler
 * believed: `if ("region" in target)` narrowed `target.region` to `string`,
 * compiled, and read `undefined` at runtime.
 *
 * The own-`undefined` keys are the load-bearing half and are **not** a
 * cleanup candidate: an own key cannot be shadowed by a polluted
 * `Object.prototype`, whereas an omitted one resolves up the prototype chain
 * on a plain dot read. Two fail-open defects in this module came from exactly
 * that. Never "tidy" this into a conditional spread — the type moved to match
 * the runtime, not the other way round.
 *
 * Not surfaced through the `core/agent` barrel: it is the shape of one field
 * on {@link M3LAgentActionRecord}, reachable as
 * `NonNullable<M3LAgentActionRecord["target"]>`, and slice 1's public surface
 * is fixed at twenty exports.
 */
export interface M3LAgentActionRecordTarget {
  /** The AWS CLI profile name; always a non-blank string. */
  readonly profile: string;
  /** The AWS region, or `undefined` when the action declared none. */
  readonly region: string | undefined;
  /** The AWS account ID, or `undefined` when the action declared none. */
  readonly accountId: string | undefined;
}

/**
 * The library's frozen projection of an {@link M3LAgentAction}, carried on
 * every decision.
 *
 * @remarks
 * The same information as {@link M3LAgentAction} but with **required** fields
 * holding `undefined` rather than optional keys, `parameterNames` defaulted to
 * `[]`, and `dryRun` defaulted to `false`. The stricter form follows the
 * reasoning already written for `M3LCommandContext.signal` in
 * `core/cli-contract`: this is a library-built record handed to callee code —
 * the ADR-0061 decision-log writer.
 *
 * That "required, holding `undefined`" rule reaches inside `target` too,
 * which is why it is typed {@link M3LAgentActionRecordTarget} rather than
 * `M3LDestructiveTarget` — see that type for why the two cannot be the same
 * under `exactOptionalPropertyTypes`.
 *
 * The record exists to satisfy a rule the module cannot afford to break:
 * validate once, then never let anything re-read the caller's object. The
 * projection is a **deep copy** — `parameterNames` is a frozen copy of the
 * caller's array and `target` is a fresh frozen object carrying only
 * `profile` / `region` / `accountId` — so a caller mutating their action
 * afterwards cannot make the decision log and the verdict disagree.
 *
 * @example
 * ```ts
 * import type { M3LAgentActionRecord } from "@m3l-automation/m3l-common/core";
 *
 * function describe(record: M3LAgentActionRecord): string {
 *   return `${record.script}:${record.operation ?? "-"} (${record.kind})`;
 * }
 * ```
 */
export interface M3LAgentActionRecord {
  /** The script name, copied verbatim from the validated action. */
  readonly script: string;
  /** The declared operation name, or `undefined` when the action had none. */
  readonly operation: string | undefined;
  /** The caller-declared autonomy tier. */
  readonly kind: M3LAgentActionKind;
  /**
   * A fresh frozen copy of the action's target — `region` and `accountId`
   * present as own properties holding `undefined` when absent — or
   * `undefined` when the action carried no target.
   */
  readonly target: M3LAgentActionRecordTarget | undefined;
  /** A frozen copy of the action's parameter names; `[]` when absent. */
  readonly parameterNames: readonly string[];
  /** The action's `dryRun` flag; `false` when absent. */
  readonly dryRun: boolean;
}

/**
 * The ceiling on {@link M3LAgentAction.parameterNames}.
 *
 * A **reject-above** bound: `length > 256` throws
 * `M3LAgentActionValidationError`, `length === 256` is accepted. The list is
 * never truncated — silently dropping names would silently change the
 * parameter shape slice 2 keys its dry-run discipline on.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_MAX_PARAMETER_NAMES } from "@m3l-automation/m3l-common/core";
 *
 * const withinBound = (names: readonly string[]): boolean =>
 *   names.length <= M3L_AGENT_MAX_PARAMETER_NAMES;
 * ```
 */
export const M3L_AGENT_MAX_PARAMETER_NAMES = 256;
