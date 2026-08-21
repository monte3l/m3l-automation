/**
 * `internal/procedure/run-options` — validates and captures-by-value
 * `M3LProcedure.run()`'s options before any step executes.
 *
 * `docs/reference/core/procedure.md` § Option validation: `maxIterations`
 * must be a finite integer in `[1, Number.MAX_SAFE_INTEGER]`; `parameters`
 * and `initialValues` are each walked through the SAME bounded, validating
 * projection, exactly once, closing three related hazards at once:
 *
 * - A dangerous key (`__proto__`, `constructor`, `prototype`), a `BigInt`
 *   value, or a non-finite number anywhere in either value is rejected.
 * - A caller's object may be getter- or `Proxy`-backed and free to return a
 *   different value on every access; every property is read into a local
 *   exactly once and copied into a fresh, deeply frozen plain-data clone as
 *   it is validated, so no later consumer (`parametersDigest` included) ever
 *   reads the caller's original object a second time.
 * - The same depth bound additionally closes an unbounded recursion over a
 *   maliciously deep or self-referential caller graph — a cyclic object is
 *   naturally rejected once the walk's depth counter exceeds the ceiling via
 *   the aliasing path, with no separate cycle check needed.
 *
 * `parameters` alone also carries the top-level "did the shape declare this
 * key" check, integrated into the SAME single walk rather than a second,
 * separate read of the caller's top-level keys.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isDangerousKey } from "../../core/security/DangerousKeys.js";
import {
  isArray,
  isBigInt,
  isFunction,
  isNumber,
  isObject,
  isPlainObject,
  isString,
} from "../../core/utils/guards.js";

import { M3LProcedureInvalidOptionError } from "./errors.js";
import { captureProgressOptions, validateProgressOptions } from "./progress.js";

import {
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_ITERATIONS,
} from "../../core/procedure/types.js";

import type {
  M3LProcedureProgressOptions,
  M3LProcedureRunOptions,
  M3LProcedureTraceOptions,
} from "../../core/procedure/run-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";
import type { CapturedProgressConfig } from "./progress.js";

/** The resolved, validated, capture-by-value pieces `run()`'s options reduce to. */
export interface ValidatedRunOptions<TShape extends M3LProcedureShape> {
  readonly maxIterations: number;
  readonly parameters: Readonly<TShape["parameters"]>;
  readonly initialValues: Readonly<Partial<TShape["values"]>>;
  readonly trace: M3LProcedureTraceOptions | undefined;
  readonly progress: CapturedProgressConfig<TShape> | undefined;
}

/**
 * Validates `maxIterations`: when present, it must be a finite integer in
 * `[1, Number.MAX_SAFE_INTEGER]`. Returns the effective ceiling —
 * `maxIterations` itself, or `M3L_PROCEDURE_MAX_ITERATIONS` when absent.
 */
function validateMaxIterations(maxIterations: number | undefined): number {
  if (maxIterations === undefined) return M3L_PROCEDURE_MAX_ITERATIONS;
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > Number.MAX_SAFE_INTEGER
  ) {
    throw new M3LProcedureInvalidOptionError(
      `maxIterations must be a finite integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
      { option: "maxIterations", value: maxIterations },
    );
  }
  return maxIterations;
}

/**
 * Validates `options.trace`, when present: it must be a plain object whose
 * `sink` is an object exposing a callable `record` method (the shape
 * {@link M3LProcedureTraceSink} declares), and whose optional `source` —
 * when supplied — must be a string. `undefined` passes through unchanged,
 * since tracing is opt-in.
 */
function validateTraceOption(
  trace: unknown,
): M3LProcedureTraceOptions | undefined {
  if (trace === undefined) return undefined;
  if (!isPlainObject(trace)) {
    throw new M3LProcedureInvalidOptionError(
      "trace must be a plain object when supplied",
      { option: "trace" },
    );
  }
  const sink: unknown = trace["sink"];
  if (
    !isObject(sink) ||
    !isFunction((sink as Record<string, unknown>)["record"])
  ) {
    throw new M3LProcedureInvalidOptionError(
      "trace.sink must be an object with a callable record method",
      { option: "trace" },
    );
  }
  const source: unknown = trace["source"];
  if (source !== undefined && !isString(source)) {
    throw new M3LProcedureInvalidOptionError(
      "trace.source must be a string when supplied",
      { option: "trace" },
    );
  }
  return trace as unknown as M3LProcedureTraceOptions;
}

/**
 * Validates and clones one scalar/array/nested-object value found while
 * walking a `parameters`/`initialValues` tree: rejects a `BigInt` or
 * non-finite number outright, recurses (bumping `depth`) into an array or
 * plain object, and passes every other scalar through unchanged.
 */
function projectValue(
  raw: unknown,
  optionName: string,
  depth: number,
): unknown {
  if (isBigInt(raw)) {
    throw new M3LProcedureInvalidOptionError(
      `${optionName} contains a BigInt value, which is not permitted`,
      { option: optionName },
    );
  }
  if (isNumber(raw)) {
    if (!Number.isFinite(raw)) {
      throw new M3LProcedureInvalidOptionError(
        `${optionName} contains a non-finite number, which is not permitted`,
        { option: optionName },
      );
    }
    return raw;
  }
  if (isArray(raw)) {
    if (depth + 1 > M3L_PROCEDURE_CONDITION_MAX_DEPTH) {
      throw new M3LProcedureInvalidOptionError(
        `${optionName} nests deeper than the maximum depth of ${M3L_PROCEDURE_CONDITION_MAX_DEPTH}`,
        { option: optionName },
      );
    }
    try {
      return Object.freeze(
        raw.map((element) => projectValue(element, optionName, depth + 1)),
      );
    } catch (cause) {
      // An already-typed validation error bubbling up from a nested element
      // must not be double-wrapped; only a genuinely unexpected throw (a
      // hostile getter invoked by the array's own iteration) is normalized.
      if (cause instanceof M3LProcedureInvalidOptionError) throw cause;
      throw new M3LProcedureInvalidOptionError(
        `${optionName} contains a value that could not be read`,
        { option: optionName },
        { cause },
      );
    }
  }
  if (isPlainObject(raw)) {
    return projectRecord(raw, optionName, depth + 1, undefined);
  }
  if (isObject(raw)) {
    // A `Map`/`Set`/`Date`/class instance has no own-enumerable keys a plain
    // walk would see, so silently passing it through would let
    // `canonicalJsonHash` serialize it to `"{}"` — defeating the
    // `parametersDigest`'s stated purpose of identifying a run's real inputs.
    // Reject rather than coerce or drop it.
    throw new M3LProcedureInvalidOptionError(
      `${optionName} contains an unsupported object type (Map, Set, Date, or a class instance are not permitted)`,
      { option: optionName },
    );
  }
  return raw;
}

/**
 * Validates and clones one plain-object level of a `parameters`/
 * `initialValues` tree: every own-enumerable key is read into a local exactly
 * once, checked for a dangerous name (and, when `allowedKeys` is supplied —
 * top-level `parameters` only — for shape declaration), then recursively
 * projected. Returns a fresh, frozen plain object; the caller's original is
 * never read again by anything downstream.
 */
function projectRecord(
  value: Record<string, unknown>,
  optionName: string,
  depth: number,
  allowedKeys: ReadonlySet<string> | undefined,
): Readonly<Record<string, unknown>> {
  if (depth > M3L_PROCEDURE_CONDITION_MAX_DEPTH) {
    throw new M3LProcedureInvalidOptionError(
      `${optionName} nests deeper than the maximum depth of ${M3L_PROCEDURE_CONDITION_MAX_DEPTH}`,
      { option: optionName },
    );
  }
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) {
      throw new M3LProcedureInvalidOptionError(
        `${optionName} key "${key}" is not a permitted name`,
        { option: optionName, key },
      );
    }
    if (allowedKeys !== undefined && !allowedKeys.has(key)) {
      throw new M3LProcedureInvalidOptionError(
        `parameter "${key}" was not declared by this procedure's shape`,
        { option: optionName, parameter: key },
      );
    }
    let raw: unknown;
    try {
      raw = value[key];
    } catch (cause) {
      throw new M3LProcedureInvalidOptionError(
        `${optionName} key "${key}" could not be read`,
        { option: optionName, key },
        { cause },
      );
    }
    projected[key] = projectValue(raw, optionName, depth);
  }
  return Object.freeze(projected);
}

/**
 * Rejects a top-level `parameters`/`initialValues` value that is present but
 * not a plain object — an array, a `Map`/`Set`/`Date`, or a class instance —
 * with the same `M3LProcedureInvalidOptionError` nested values are rejected
 * with, so there is exactly one rejection mechanism for "not a plain object"
 * rather than a bespoke check duplicated at each entry point. `undefined`/
 * `null` are the only values this passes through, as `undefined` — the
 * caller then defaults to `{}`.
 */
function ensurePlainRunOption(
  value: unknown,
  optionName: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new M3LProcedureInvalidOptionError(
      `${optionName} must be a plain object when supplied (an array, Map, Set, Date, or class instance is not permitted)`,
      { option: optionName },
    );
  }
  return value;
}

/**
 * Validates and captures `options.progress` by value, mirroring
 * {@link validateTraceOption}'s shape: `undefined` passes through unchanged
 * (the no-progress guard is opt-in), otherwise `witness`/`maxStalledSteps`
 * are each read into a local exactly once
 * (`internal/procedure/progress.ts`'s `captureProgressOptions`) before being
 * validated (`validateProgressOptions`).
 */
function resolveProgressOption<TShape extends M3LProcedureShape>(
  progress: M3LProcedureProgressOptions<TShape> | undefined,
): CapturedProgressConfig<TShape> | undefined {
  const captured = captureProgressOptions<TShape>(progress);
  validateProgressOptions<TShape>(captured);
  return captured;
}

/**
 * Validates and captures `options.parameters` by value: every own key must be
 * declared by this procedure's shape (per `M3LProcedure.describe()`'s
 * `parameters` list, top-level only), must not be a dangerous name anywhere
 * in the tree, and no value may contain a non-finite number, a `BigInt`, or
 * an unsupported object type (`Map`/`Set`/`Date`/class instance), or nest
 * past `M3L_PROCEDURE_CONDITION_MAX_DEPTH`.
 *
 * `undefined`/`null` default to `{}`; any other non-plain-object value (an
 * array, a `Map`, a class instance) is rejected via
 * {@link ensurePlainRunOption} rather than silently passed through.
 */
function projectParameters<TShape extends M3LProcedureShape>(
  parameters: Readonly<TShape["parameters"]> | undefined,
  declaredParameters: readonly string[],
): Readonly<TShape["parameters"]> {
  const value = ensurePlainRunOption(parameters, "parameters");
  if (value === undefined) return {} as Readonly<TShape["parameters"]>;
  const declared = new Set(declaredParameters);
  return projectRecord(value, "parameters", 1, declared) as Readonly<
    TShape["parameters"]
  >;
}

/**
 * Validates and captures `options.initialValues` by value: the identical
 * bounded, validating projection {@link projectParameters} uses — a dangerous
 * key, a non-finite number, a `BigInt`, or an unsupported object type
 * anywhere in the tree is rejected — except there is no declared-name check
 * (`initialValues` has no analogous builder declaration).
 */
function projectInitialValues<TShape extends M3LProcedureShape>(
  initialValues: Readonly<Partial<TShape["values"]>> | undefined,
): Readonly<Partial<TShape["values"]>> {
  const value = ensurePlainRunOption(initialValues, "initialValues");
  if (value === undefined) return {} as Readonly<Partial<TShape["values"]>>;
  return projectRecord(value, "initialValues", 1, undefined) as Readonly<
    Partial<TShape["values"]>
  >;
}

/**
 * Validates the whole of `options` synchronously — before any step executes
 * — and returns the resolved iteration ceiling alongside the validated,
 * capture-by-value `parameters`/`initialValues` clones. Must be called
 * synchronously from `M3LProcedure.run()` itself (never wrapped in an `async`
 * function): a caller relying on a synchronous `try`/`catch` around the
 * `run()` call needs the throw to happen before any `await`.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @param options - The caller-supplied run options.
 * @param declaredParameters - The parameter names this procedure declared via
 *   `M3LProcedureBuilder.parameters()`.
 * @throws {@link M3LProcedureInvalidOptionError} on the first problem found.
 */
export function validateRunOptions<TShape extends M3LProcedureShape>(
  options: M3LProcedureRunOptions<TShape>,
  declaredParameters: readonly string[],
): ValidatedRunOptions<TShape> {
  const maxIterations = validateMaxIterations(options.maxIterations);
  const parameters = projectParameters<TShape>(
    options.parameters,
    declaredParameters,
  );
  const initialValues = projectInitialValues<TShape>(options.initialValues);
  const trace = validateTraceOption(options.trace);
  const progress = resolveProgressOption<TShape>(options.progress);
  return { maxIterations, parameters, initialValues, trace, progress };
}
