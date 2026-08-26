/**
 * `core/cli-contract/guards` — runtime type guards for the two values that
 * cross the host boundary: the descriptor a host `import()`s out of a foreign
 * `dist/command.js`, and the outcome that descriptor's `execute` resolves to.
 *
 * Both sit on a genuinely hostile boundary. A host reads properties off a
 * module it did not compile, so a `Proxy`, a throwing getter, a revoked
 * handle, or a plain `undefined` from a missing `await` are all reachable.
 * The contract is therefore absolute: **neither guard ever throws**, and each
 * reads every caller-controlled property **at most once** — so a
 * non-idempotent getter cannot answer one thing to the validation and another
 * to the code that acts on the verdict. This mirrors the fix
 * {@link mapCommandOutcomeToExitCode} already carries in `exit-codes.ts`.
 *
 * @packageDocumentation
 */

import { isArray, isFunction, isString } from "../utils/guards.js";

import type { M3LCommandModule, M3LCommandOutcome } from "./types.js";

/** The five members {@link isM3LCommandModule} reads, each read exactly once. */
interface CommandModuleSnapshot {
  readonly name: unknown;
  readonly version: unknown;
  readonly description: unknown;
  readonly configParameters: unknown;
  readonly execute: unknown;
}

/**
 * The status vocabulary {@link isM3LCommandOutcome} accepts, keyed by
 * `M3LCommandOutcome["status"]` so the **compiler** keeps it exhaustive: a
 * sixth status added to the union fails this initializer (a missing key), and
 * a key that outlives its union member fails it too (an excess key). The
 * hand-written `readonly string[]` this replaces could drift from the type in
 * either direction with nothing to catch it — the same failure mode
 * `_m3lCommandOutcomeStatusPin` in `exit-codes.ts` exists to prevent, expressed
 * here as the `Record<Union, true>` form `.claude/rules/library-src.md`
 * prescribes for tracking a string-literal union at runtime.
 */
const COMMAND_OUTCOME_STATUSES: Readonly<
  Record<M3LCommandOutcome["status"], true>
> = {
  success: true,
  "dry-run": true,
  interrupted: true,
  partial: true,
  failure: true,
};

/**
 * The same vocabulary as a membership set, **derived** from the pinned record
 * rather than re-typed — so there is exactly one place the five words live.
 */
const COMMAND_OUTCOME_STATUS_NAMES: ReadonlySet<string> = new Set(
  Object.keys(COMMAND_OUTCOME_STATUSES),
);

/**
 * Whether `value` structurally satisfies {@link M3LCommandModule}.
 *
 * The check is **structural, never nominal**, and that is the whole point: a
 * descriptor loaded from a foreign `dist/` build carries `M3LConfigParameter`
 * instances constructed by a *different copy* of this library, so an
 * `instanceof` element check would reject exactly the case the guard exists
 * for. `configParameters` is therefore checked with `Array.isArray` and its
 * elements are not inspected at all.
 *
 * `description` is optional, and its check reads the property **once** — a
 * single `get`, then `undefined ||` string — rather than asking `in` and then
 * reading. Those are two independent `Proxy` traps and a hostile handler can
 * make them disagree: a `has` returning `false` beside a `get` returning a
 * non-string would have passed the earlier two-form check while the caller
 * then acted on the non-string. The cost is that an explicit
 * `description: undefined` now passes, which `exactOptionalPropertyTypes`
 * would reject at a type level; that is the deliberate trade — the guard's job
 * is to keep a hostile descriptor out, not to re-litigate an own-property
 * distinction no consumer of the verdict can act on.
 *
 * Narrows to `M3LCommandModule<object>` rather than the bare
 * `M3LCommandModule`, which defaults `TParameters` to `Record<string, never>`
 * and cannot serve as the "any module" type (TS2375 — no index signature).
 *
 * **Never throws.** Every read happens once, inside a single `try`, before
 * any verdict is computed.
 *
 * @param value - An arbitrary value, typically a foreign module's export.
 * @returns Whether `value` may be treated as a command-module descriptor.
 *
 * @example
 * ```ts
 * import { isM3LCommandModule } from "@m3l-automation/m3l-common/core";
 *
 * const loaded: unknown = (await import(entryPath)).commandModule;
 * if (!isM3LCommandModule(loaded)) {
 *   throw new M3LError(`${entryPath} exports no command module`, {
 *     code: "ERR_INVALID_ARGUMENT",
 *   });
 * }
 * ```
 */
export function isM3LCommandModule(
  value: unknown,
): value is M3LCommandModule<object> {
  let snapshot: CommandModuleSnapshot;
  try {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    // Each property is read exactly once, here, before any check runs: a
    // validate-then-re-read implementation would let a non-idempotent getter
    // disagree with the verdict the caller then acts on.
    snapshot = {
      name: candidate["name"],
      version: candidate["version"],
      description: candidate["description"],
      configParameters: candidate["configParameters"],
      execute: candidate["execute"],
    };
  } catch {
    // A revoked Proxy, or a getter that throws. A guard that propagated would
    // cost the caller the one answer it asked for.
    return false;
  }

  return (
    isString(snapshot.name) &&
    isString(snapshot.version) &&
    (snapshot.description === undefined || isString(snapshot.description)) &&
    isArray(snapshot.configParameters) &&
    isFunction(snapshot.execute)
  );
}

/**
 * Whether `value` structurally satisfies {@link M3LCommandOutcome}.
 *
 * The guard accepts **what the type accepts**, not a stricter runtime rule the
 * type disclaims: `M3LCommandOutcome`'s own documentation notes that a
 * `partial` outcome's `recovered` admits `-3` and `1.5` as readily as `3`, so
 * `recovered` is only required to be a `number`. `NaN` and `Infinity` are
 * numbers too and are accepted for exactly the same reason: a finiteness test
 * here would be a runtime rule the type disclaims, and the exit code keys off
 * `status` alone, so such an outcome is mislabelled, never miscoded.
 *
 * On the `"failure"` arm only the *presence* of `error` is checked, never its
 * value — `error: undefined` is representable (a thrown `undefined` is a real
 * value), and reading a property the guard does not need hands a hostile
 * `Proxy` a free re-entry point. `recovered` is likewise never read on a
 * non-`"partial"` outcome.
 *
 * **Never throws**, for the same reason {@link isM3LCommandModule} does not.
 *
 * @param value - An arbitrary value, typically a foreign `execute`'s result.
 * @returns Whether `value` may be treated as a command outcome.
 *
 * @example
 * ```ts
 * import { isM3LCommandOutcome } from "@m3l-automation/m3l-common/core";
 *
 * const resolved: unknown = await commandModule.execute(parameters, context);
 * const outcome = isM3LCommandOutcome(resolved)
 *   ? resolved
 *   : { status: "failure" as const, error: resolved };
 * ```
 */
export function isM3LCommandOutcome(
  value: unknown,
): value is M3LCommandOutcome {
  try {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    const status: unknown = candidate["status"];
    if (!isString(status) || !COMMAND_OUTCOME_STATUS_NAMES.has(status)) {
      return false;
    }
    if (status === "partial") {
      const recovered: unknown = candidate["recovered"];
      return typeof recovered === "number";
    }
    // Presence, never content: `Object.hasOwn` answers the question without
    // invoking a caller-supplied getter, which is what keeps a throwing
    // `error` getter from escaping a guard that never needed the value.
    if (status === "failure") return Object.hasOwn(candidate, "error");
    return true;
  } catch {
    return false;
  }
}
