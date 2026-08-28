/**
 * `store/parameters-json` — strict JSON serialization for persisted run
 * `parameters`, enforced at the `insertQueued` write boundary
 * (`store/runs-repository.ts`, PR #719 defect 1).
 *
 * `Core.safeJsonStringify` is the wrong tool for this: it is a *diagnostic*
 * serializer built to never throw (e.g. turning an arbitrary caught error's
 * `context` into loggable text), so it silently truncates depth-exceeding
 * input to the literal `"[Max Depth]"`, cycles to `"[Circular]"`, and
 * function/symbol values to `""`. Persisted state is not a diagnostic
 * string — the declared contract is "parameters must be JSON-serializable",
 * so a violating caller needs a loud, caller-facing rejection at the write
 * boundary, not a silently corrupted row that a later `get()` hands back as
 * if it were the caller's own input. `JSON.stringify` has no depth limit at
 * all (so legitimately deep, valid input round-trips byte-identically) and
 * throws a `TypeError` on a cycle or a `BigInt` — but it *silently drops*
 * function-, symbol-, and explicit-`undefined`-valued properties instead of
 * throwing, so those three are detected explicitly below via a
 * path-tracking `replacer`.
 *
 * @packageDocumentation
 */
import { M3LConsoleError } from "../errors/console-error.js";

/** The three value shapes `JSON.stringify` silently drops (from an object) or nulls out (in an array) instead of throwing on — detected explicitly by {@link createStrictReplacer}. */
type UnserializableValueKind = "function" | "symbol" | "undefined";

/**
 * Thrown internally the instant {@link createStrictReplacer} sees a
 * function, symbol, or explicit `undefined` value. Caught and re-raised by
 * {@link toParametersJson} as a caller-facing `M3LConsoleError`; never
 * escapes this module.
 */
class UnserializableParameterValue extends Error {
  readonly path: string;
  readonly kind: UnserializableValueKind;

  constructor(path: string, kind: UnserializableValueKind) {
    super(`${kind} value at ${path}`);
    this.path = path;
    this.kind = kind;
  }
}

/**
 * Computes the full dotted path for the property currently being
 * serialized. The replacer's `this` is the holder object (per the
 * `JSON.stringify` spec) and its `key` argument is only the immediate
 * property name, never the full path, so the holder's own
 * already-computed path (tracked in `pathByHolder`) is looked up and
 * extended by `key`.
 */
function computePath(
  pathByHolder: WeakMap<object, string>,
  holder: unknown,
  key: string,
): string {
  if (key === "") return "<root>";
  const holderPath =
    typeof holder === "object" && holder !== null
      ? (pathByHolder.get(holder) ?? "")
      : "";
  return holderPath === "" ? key : `${holderPath}.${key}`;
}

/** Classifies `value` as one of the three shapes `JSON.stringify` silently drops, or `undefined` for an ordinary serializable value. */
function classifyUnserializable(
  value: unknown,
): UnserializableValueKind | undefined {
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (value === undefined) return "undefined";
  return undefined;
}

/**
 * Builds the path-tracking `JSON.stringify` replacer that throws
 * {@link UnserializableParameterValue} the instant it sees a function,
 * symbol, or explicit `undefined` value. Path tracking uses a `WeakMap`
 * from a holder object to that holder's own already-computed path — see
 * {@link computePath}.
 */
function createStrictReplacer(): (
  this: unknown,
  key: string,
  value: unknown,
) => unknown {
  const pathByHolder = new WeakMap<object, string>();
  return function replacer(
    this: unknown,
    key: string,
    value: unknown,
  ): unknown {
    const path = computePath(pathByHolder, this, key);
    const kind = classifyUnserializable(value);
    if (kind !== undefined) {
      throw new UnserializableParameterValue(path, kind);
    }
    if (typeof value === "object" && value !== null) {
      // The root value's own reported `path` is `<root>` (informative only
      // when the offending value IS the root itself), but that prefix
      // carries no information for a child key — everything in `parameters`
      // lives under the root redundantly. Register the root holder with an
      // EMPTY path instead, so `computePath`'s `holderPath === "" ? key :
      // ...` arm yields a bare `key` for a top-level property rather than
      // `<root>.key`.
      pathByHolder.set(value, key === "" ? "" : path);
    }
    return value;
  };
}

/**
 * Serializes `parameters` to a JSON string for persistence, failing loudly
 * — as an {@link M3LConsoleError} coded `ERR_CONSOLE_BAD_REQUEST` — on
 * exactly the ways real JSON cannot represent a JS value: a cycle (or a
 * `BigInt`, which `JSON.stringify` also `TypeError`s on) and a function,
 * symbol, or `undefined` value, explicitly detected via
 * {@link createStrictReplacer}. Everything else — including input far
 * deeper than `Core.safeJsonStringify`'s own 10-level diagnostic ceiling —
 * round-trips byte-identically, since `JSON.stringify` itself has no depth
 * limit.
 *
 * The thrown error's message names only the offending **path** — a
 * top-level property as a bare key (e.g. `"callback"`), a nested one
 * dotted (e.g. `"outer.callback"`), and the sentinel `"<root>"` in the one
 * case a path would otherwise be empty: `parameters` itself is the
 * offending value (e.g. a bare function). Never the value found there —
 * `parameters` is caller data, and this project does not log or echo
 * caller data.
 *
 * @param parameters - The candidate value to persist.
 * @returns The JSON text to store in `parameters_json`.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"`
 *   when `parameters` is not JSON-serializable.
 *
 * @example
 * ```ts
 * import { toParametersJson } from "@m3l-automation/m3l-console-server/store/parameters-json.js";
 *
 * const json = toParametersJson({ mode: "batch", count: 3 });
 * ```
 */
export function toParametersJson(parameters: unknown): string {
  try {
    return JSON.stringify(parameters, createStrictReplacer());
  } catch (cause) {
    if (cause instanceof UnserializableParameterValue) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        `run parameters are not JSON-serializable: ${cause.kind} value at ${cause.path}`,
        { cause },
      );
    }
    // JSON.stringify itself throws a bare TypeError on a cycle or a
    // BigInt; that message names structure (a constructor, a property
    // name), never the value, so it is safe to chain as `cause` unchanged.
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "run parameters are not JSON-serializable",
      { cause },
    );
  }
}
