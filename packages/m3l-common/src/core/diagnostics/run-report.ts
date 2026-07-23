/**
 * `core/diagnostics/run-report` — the end-of-run report: a structured,
 * redacted summary of a script's outcome, written to a per-run timestamped
 * file under the output directory.
 *
 * @packageDocumentation
 */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { M3LError } from "../errors/index.js";
import { isSafeRelativeSegment } from "../../internal/files/guards.js";
import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";
import { redactSensitiveLogValue } from "../logging/index.js";
import { isDangerousKey } from "../security/index.js";
import { M3LPaths, M3LPathResolutionError } from "../utils/index.js";

import type { M3LBreadcrumb } from "./breadcrumbs.js";
import { collectDiagnostics } from "./collect.js";
import type { M3LDiagnosticsSnapshot, M3LPathsPort } from "./collect.js";
import { M3L_EXIT_CODES, mapErrorToExitCode } from "./exit-codes.js";
import type { M3LSerializedError } from "./format-error.js";
import { serializeErrorChain } from "./format-error.js";

/** Default report file name when {@link M3LRunReporterOptions.fileName} is omitted. */
const DEFAULT_FILE_NAME = "run-report.json";

/** Indentation width for the pretty-printed JSON report. */
const JSON_INDENT = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The terminal outcome of a script run.
 *
 * @example
 * ```ts
 * import type { M3LRunOutcome } from "@m3l-automation/m3l-common/core";
 *
 * function isTerminalFailure(outcome: M3LRunOutcome): boolean {
 *   return outcome === "failure";
 * }
 * ```
 */
export type M3LRunOutcome = "success" | "failure" | "dry-run" | "interrupted";

/**
 * The failure detail embedded in an {@link M3LRunReport}, present if and
 * only if `outcome === "failure"`.
 *
 * @example
 * ```ts
 * import type { M3LRunReportFailure } from "@m3l-automation/m3l-common/core";
 *
 * const failure: M3LRunReportFailure = { stage: "mainFn", chain: [] };
 * ```
 */
export interface M3LRunReportFailure {
  /** The named stage the failure occurred in, or `"unknown"` when unspecified. */
  readonly stage: string;
  /** The flattened, serialized error-cause chain (never an array of arrays). */
  readonly chain: readonly M3LSerializedError[];
}

/**
 * Input to {@link M3LRunReporter.build}, describing a completed (or
 * interrupted) script run.
 *
 * @example
 * ```ts
 * import type { M3LRunReportInput } from "@m3l-automation/m3l-common/core";
 *
 * const input: M3LRunReportInput = {
 *   script: { name: "import-users", version: "1.0.0" },
 *   correlationId: "run-42",
 *   startedAt: new Date(),
 *   outcome: "success",
 * };
 * ```
 */
export interface M3LRunReportInput {
  /** The identity of the script that ran. */
  readonly script: { readonly name: string; readonly version: string };
  /** The run's correlation id. */
  readonly correlationId: string;
  /** When the run started. */
  readonly startedAt: Date;
  /** When the run finished; defaults to `new Date()` when omitted. */
  readonly finishedAt?: Date;
  /** The terminal outcome. */
  readonly outcome: M3LRunOutcome;
  /** The named stage a failure occurred in; defaults to `"unknown"` when omitted. */
  readonly stage?: string;
  /** The failure, when `outcome === "failure"`. Ignored for every other outcome. */
  readonly error?: unknown;
  /** An explicit exit code, overriding the outcome-derived default. */
  readonly exitCode?: number;
  /** A diagnostics snapshot; defaults to `collectDiagnostics()` when omitted. */
  readonly environment?: M3LDiagnosticsSnapshot;
  /** A breadcrumb timeline; defaults to `[]` when omitted. */
  readonly timeline?: readonly M3LBreadcrumb[];
  /** Arbitrary archive metadata, redacted before being embedded. */
  readonly archive?: unknown;
}

/**
 * Fields shared by both `outcome` branches of {@link M3LRunReport}.
 */
export interface M3LRunReportBase {
  /** The identity of the script that ran. */
  readonly script: { readonly name: string; readonly version: string };
  /** The run's correlation id. */
  readonly correlationId: string;
  /** ISO-8601 timestamp the run started. */
  readonly startedAt: string;
  /** ISO-8601 timestamp the run finished. */
  readonly finishedAt: string;
  /** The process exit code. */
  readonly exitCode: number;
  /** The diagnostics snapshot captured for this report. */
  readonly environment: M3LDiagnosticsSnapshot;
  /** The breadcrumb timeline leading up to the outcome. */
  readonly timeline: readonly M3LBreadcrumb[];
  /** Redacted archive metadata, present only when supplied. */
  readonly archive?: unknown;
}

/**
 * The end-of-run report produced by {@link M3LRunReporter.build}. Discriminated
 * on `outcome`, mirroring `M3LDiagnosticsEnvironment`'s discriminated union in
 * this same module family: narrowing to `"failure"` narrows `failure` to
 * {@link M3LRunReportFailure}; narrowing to any other outcome narrows it to
 * `undefined`, so the two can never contradict each other.
 *
 * @example
 * ```ts
 * import type { M3LRunReport } from "@m3l-automation/m3l-common/core";
 *
 * function isFailure(report: M3LRunReport): boolean {
 *   return report.outcome === "failure";
 * }
 * ```
 */
export type M3LRunReport = M3LRunReportBase &
  (
    | {
        /** The run failed. */
        readonly outcome: "failure";
        /** The failure detail — always present when `outcome === "failure"`. */
        readonly failure: M3LRunReportFailure;
      }
    | {
        /** Every non-failure terminal outcome. */
        readonly outcome: Exclude<M3LRunOutcome, "failure">;
        /** Always `undefined` for a non-failure outcome. */
        readonly failure?: undefined;
      }
  );

/**
 * Constructor options for {@link M3LRunReporter}.
 *
 * @example
 * ```ts
 * import type { M3LRunReporterOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LRunReporterOptions = { fileName: "run-report.json" };
 * ```
 */
export interface M3LRunReporterOptions {
  /** An injected output-directory port; a real `M3LPaths` is constructed lazily without one. */
  readonly paths?: Pick<M3LPathsPort, "getOutputDir">;
  /** The report file name within its timestamped directory. Defaults to `"run-report.json"`. */
  readonly fileName?: string;
}

// ---------------------------------------------------------------------------
// build() helpers
// ---------------------------------------------------------------------------

/** Sanitizes an ISO timestamp for use as a directory name: every `:` becomes `-`. */
function sanitizeTimestamp(iso: string): string {
  return iso.replaceAll(":", "-");
}

/**
 * Throws {@link M3LPathResolutionError} when `segment` is not safe to join
 * beneath the output directory — mirrors the containment guard
 * `M3LPaths.resolveWithin` already applies to `resolveInput`/`resolveOutput`,
 * reused here rather than re-invented so both `startedAt`-derived timestamp
 * segments and a configured `fileName` are held to the same rule.
 */
function assertSafeReportSegment(segment: string, label: string): void {
  if (!isSafeRelativeSegment(segment)) {
    throw new M3LPathResolutionError(
      `M3LRunReporter: ${label} "${segment}" must be a relative path within the output directory (absolute paths and ".." segments are rejected)`,
    );
  }
}

/**
 * Throws {@link M3LPathResolutionError} when the fully-resolved `filePath`
 * escapes `outputDir` — a defense-in-depth assertion behind the per-segment
 * validation in {@link assertSafeReportSegment}, verifying the join's actual
 * result rather than only its inputs.
 *
 * This check alone is not sufficient against a symlink: `resolve()` never
 * dereferences one, so a pre-existing `<outputDir>/<timestamp>` symlink
 * pointing outside the tree still reports as contained here. See
 * {@link assertNoSymlinkEscape} for the realpath-based check layered on top.
 */
function assertContainedWithinOutputDir(
  filePath: string,
  outputDir: string,
): void {
  const resolvedOutputDir = resolve(outputDir);
  const resolvedFilePath = resolve(filePath);
  const isContained =
    resolvedFilePath === resolvedOutputDir ||
    resolvedFilePath.startsWith(resolvedOutputDir + sep);
  if (!isContained) {
    throw new M3LPathResolutionError(
      `M3LRunReporter: resolved report path "${resolvedFilePath}" escapes the output directory "${resolvedOutputDir}"`,
    );
  }
}

/**
 * Best-effort `realpath` of `candidatePath`, walking up to the longest
 * existing ancestor when `candidatePath` (or a component of it) does not
 * exist yet — e.g. the timestamp directory `write()` is about to create —
 * then rejoining the not-yet-existing suffix onto that ancestor's resolved
 * target. A plain `realpath()` on the not-yet-created path would fail with
 * `ENOENT` before `write()` has created anything, which is why this walks up
 * rather than resolving `candidatePath` directly; a path with no existing
 * ancestor at all (the filesystem root missing, which cannot happen in
 * practice) falls back to the plain, unresolved path rather than throwing.
 */
async function bestEffortRealpath(candidatePath: string): Promise<string> {
  const pendingSegments: string[] = [];
  let current = candidatePath;
  for (;;) {
    try {
      const resolvedAncestor = await realpath(current);
      return pendingSegments.length === 0
        ? resolvedAncestor
        : join(resolvedAncestor, ...pendingSegments.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return candidatePath;
      pendingSegments.push(current.slice(parent.length + sep.length));
      current = parent;
    }
  }
}

/**
 * Should-fix defense-in-depth against a symlink planted at any component of
 * `filePath` (most commonly a pre-existing `<outputDir>/<timestamp>`
 * symlink): re-runs {@link assertContainedWithinOutputDir}'s containment
 * comparison, but against `realpath`-resolved paths (via
 * {@link bestEffortRealpath}, so a directory `write()` has not created yet
 * is never treated as an error) rather than plain `resolve()`d ones, which
 * never dereference a symlink. Called immediately before `write()` creates
 * anything.
 *
 * @throws {@link M3LPathResolutionError} When the realpath-resolved
 *   `filePath` escapes the realpath-resolved `outputDir`.
 */
async function assertNoSymlinkEscape(
  filePath: string,
  outputDir: string,
): Promise<void> {
  const [resolvedOutputDir, resolvedFilePath] = await Promise.all([
    bestEffortRealpath(outputDir),
    bestEffortRealpath(filePath),
  ]);
  const isContained =
    resolvedFilePath === resolvedOutputDir ||
    resolvedFilePath.startsWith(resolvedOutputDir + sep);
  if (!isContained) {
    throw new M3LPathResolutionError(
      `M3LRunReporter: realpath-resolved report path "${resolvedFilePath}" escapes the realpath-resolved output directory "${resolvedOutputDir}"`,
    );
  }
}

/** `date.toISOString()`, falling back to the Unix epoch on a hostile `Date`. */
function safeToISOString(date: Date): string {
  try {
    return date.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Resolves the exit code: an explicit `input.exitCode` always wins; otherwise
 * `"failure"` maps through {@link mapErrorToExitCode}, `"interrupted"` maps to
 * {@link M3L_EXIT_CODES.INTERRUPTED}, and every other outcome defaults to `0`.
 *
 * @throws {@link M3LError} On a non-literal `outcome` that reaches the
 *   exhaustiveness `default` branch — never called directly by `build()`,
 *   which routes through {@link safeResolveExitCode} instead so its own
 *   "never throws" contract holds even for hostile input.
 */
function resolveExitCode(input: M3LRunReportInput): number {
  if (input.exitCode !== undefined) return input.exitCode;

  switch (input.outcome) {
    case "success":
    case "dry-run":
      return M3L_EXIT_CODES.SUCCESS;
    case "failure":
      return mapErrorToExitCode(input.error);
    case "interrupted":
      return M3L_EXIT_CODES.INTERRUPTED;
    default: {
      const _exhaustive: never = input.outcome;
      throw new M3LError(
        `M3LRunReporter: unhandled outcome ${String(_exhaustive)}`,
        { code: "ERR_INVALID_ARGUMENT" },
      );
    }
  }
}

/**
 * Never-throwing wrapper around {@link resolveExitCode}: a hostile,
 * non-literal `outcome` that would otherwise reach the exhaustiveness
 * `default` branch falls back to `M3L_EXIT_CODES.UNCLASSIFIED` instead of
 * propagating, so {@link M3LRunReporter.build}'s "never throws" contract
 * holds without weakening the compile-time exhaustiveness check itself.
 */
function safeResolveExitCode(input: M3LRunReportInput): number {
  try {
    return resolveExitCode(input);
  } catch {
    return M3L_EXIT_CODES.UNCLASSIFIED;
  }
}

/**
 * Builds the `failure` section for an input whose `outcome` is already known
 * to be `"failure"`. With no `error` supplied, the chain is `[]` (not a
 * synthetic single-level chain) — there is genuinely nothing to serialize.
 */
function buildFailureDetail(input: M3LRunReportInput): M3LRunReportFailure {
  const stage = input.stage ?? "unknown";
  const error = readInputError(input);
  const chain = error === undefined ? [] : serializeErrorChain(error);
  return { stage, chain };
}

/**
 * Reads `input.error`, absorbing a hostile getter that throws on access —
 * so a malicious/broken `error` accessor cannot make {@link buildFailureDetail}
 * (and transitively {@link M3LRunReporter.build}) throw, matching `build`'s
 * documented "never throws, even for … a hostile-getter `error`" contract.
 * Falls back to `undefined`, the same value `buildFailureDetail` already
 * treats as "nothing to serialize".
 */
function readInputError(input: M3LRunReportInput): unknown {
  try {
    return input.error;
  } catch {
    return undefined;
  }
}

/**
 * Placeholder substituted for a value {@link sanitizeValue} could not safely
 * redact, so a failure on any step of that pipeline degrades to a known-safe
 * string rather than ever risking unredacted data reaching the report.
 */
const UNREDACTABLE_PLACEHOLDER = "[unredactable value omitted]";

/**
 * Maximum traversal depth for {@link normalizeForRedaction}, mirroring
 * `safeJsonStringify`'s own default so a ~20k-deep acyclic value degrades to
 * `"[Max Depth]"` at the same depth instead of overflowing the stack.
 */
const MAX_NORMALIZE_DEPTH = 10;

/**
 * Narrows `value` to an object exposing a callable own or inherited `toJSON`
 * — the same method `JSON.stringify` itself would invoke, and the boundary a
 * class author uses to declare "this is my serialized (and often redacted)
 * form" (e.g. `Date`, or a credentials class that omits secret fields from
 * its `toJSON`).
 */
function hasToJSON(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

/**
 * Invokes `value.toJSON()`, guarding the call itself: a throwing `toJSON`
 * degrades to {@link UNREDACTABLE_PLACEHOLDER} for just this node rather than
 * propagating — so one hostile `toJSON` cannot blank out sibling data that
 * would otherwise redact cleanly, and never breaks {@link M3LRunReporter.build}'s
 * "never throws" contract.
 */
function invokeToJSONSafely(value: { toJSON: () => unknown }): unknown {
  try {
    return value.toJSON();
  } catch {
    return UNREDACTABLE_PLACEHOLDER;
  }
}

/**
 * Converts a `Map` into a plain, key-preserving `Record`, so key-based
 * redaction (`isSensitiveKey`, applied later by `redactSensitiveLogValue`)
 * still sees e.g. `apiKey` as an object **key** rather than as an element of
 * a `[key, value]` pair array — the shape `safeJsonStringify` produces, which
 * defeats key-based redaction entirely (a documented regression this
 * function exists to fix). A non-string key has no representable key name;
 * rather than falling back to the leaking pair-array form, such an entry is
 * dropped. A dangerous key (`__proto__`/`constructor`/`prototype`) is also
 * dropped rather than assigned — bracket-assigning `"__proto__"` onto a
 * plain object literal mutates its prototype instead of adding a data
 * property, the same hazard `redactSensitiveLogValue` guards against on its
 * own clone.
 */
function normalizeMapEntries(
  map: ReadonlyMap<unknown, unknown>,
  depth: number,
  visited: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of map.entries()) {
    if (typeof key !== "string" || isDangerousKey(key)) continue;
    result[key] = normalizeForRedaction(entryValue, depth + 1, visited);
  }
  return result;
}

/**
 * Converts a non-`toJSON`, non-`Map`/`Set` object into a plain `Record`,
 * dropping dangerous keys for the same prototype-pollution reason as
 * {@link normalizeMapEntries}.
 */
function normalizePlainObject(
  value: object,
  depth: number,
  visited: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) continue;
    result[key] = normalizeForRedaction(
      (value as Record<string, unknown>)[key],
      depth + 1,
      visited,
    );
  }
  return result;
}

/**
 * Reduces a `Set` to a non-reversible cardinality marker (`"[set: N items]"`)
 * instead of an array of its raw members. A `Set` holds values with no key
 * names attached — unlike a `Map`, whose entries at least carry a string key
 * {@link normalizeMapEntries} preserves for key-based redaction — so an array
 * of its elements is unredactable by a key-name-based redactor:
 * `isSensitiveKey`/`redactSensitiveLogValue` only ever inspects object
 * *keys*, and a bare array element has none, so a secret riding in a `Set`
 * would reach the persisted report completely unredacted. Emitting the
 * element count keeps the diagnostic signal (how many entries existed)
 * without carrying any of the — possibly sensitive — contents forward. This
 * is no worse than this module's pre-reordering baseline, under which
 * `redactSensitiveLogValue(new Set(...))` returned `{}` (dropping every
 * member outright) — and it is strictly more informative than that baseline
 * while remaining just as leak-free.
 */
function describeSetCardinality(set: ReadonlySet<unknown>): string {
  return `[set: ${set.size} item${set.size === 1 ? "" : "s"}]`;
}

/**
 * Dispatches an already cycle-checked, depth-checked object `value` to the
 * shape-specific normalizer: a `toJSON`-bearing object is replaced by its
 * (guarded) `toJSON()` result — recursed into, since that result can itself
 * contain a `Map`/`Set`/cycle — ahead of the `Array`/`Map`/`Set`/plain-object
 * checks, mirroring the precedence native `JSON.stringify` gives `toJSON`. A
 * `Set` is reduced to a cardinality marker via {@link describeSetCardinality}
 * rather than an array of its members — see that function's TSDoc for why an
 * array of key-less elements is unredactable.
 */
function normalizeObjectShape(
  value: object,
  depth: number,
  visited: WeakSet<object>,
): unknown {
  if (hasToJSON(value)) {
    return normalizeForRedaction(invokeToJSONSafely(value), depth + 1, visited);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForRedaction(item, depth + 1, visited));
  }
  if (value instanceof Map) {
    return normalizeMapEntries(value, depth, visited);
  }
  if (value instanceof Set) {
    return describeSetCardinality(value);
  }
  return normalizePlainObject(value, depth, visited);
}

/**
 * Converts a non-object scalar (or `undefined`) into its JSON-safe form.
 * Extracted purely to keep {@link normalizeForRedaction}'s own complexity
 * under the project's lint threshold; the exhaustive `typeof` switch covers
 * every non-`"object"` result so the "object" case itself is unreachable in
 * practice — {@link normalizeForRedaction} never calls this for an object.
 */
function scalarToRedactable(value: unknown): unknown {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "symbol":
      return value.description ?? "";
    case "function":
      return "";
    case "undefined":
      return null;
    case "object":
      return null;
  }
}

/**
 * Recursively converts `value` into a plain, JSON-safe, key-preserving
 * structure ahead of redaction — the cycle/depth-breaking, `Map`/`Set`
 * -normalizing, `toJSON`-respecting replacement for the
 * `JSON.parse(safeJsonStringify(value))` pre-pass this module used
 * previously. That pre-pass broke cycles and depth safely, but
 * `safeJsonStringify` flattens `Map` to `[[key, value], …]` pairs and `Set`
 * to `[value, …]` arrays — turning a sensitive `Map` key like `apiKey` into
 * an array *element*, which `isSensitiveKey` (keyed lookups only) can never
 * see, so the secret rode straight through redaction. This function performs
 * the same cycle/depth-breaking directly (its own `WeakSet`/depth counter,
 * not `safeJsonStringify`'s), while converting `Map` → `Record` (keeping
 * string keys as actual object keys) and `Set` → a non-reversible cardinality
 * marker (see {@link describeSetCardinality}) rather than an array of its
 * members — a `Set`'s elements carry no key names at all, so unlike a `Map`
 * entry there is no key-preserving form to convert them to; emitting them as
 * array elements would still defeat key-based redaction the same way the
 * `Map`-as-pairs shape does. It also invokes an object's own or inherited
 * `toJSON()` (guarded against a
 * throwing implementation) ahead of enumerating its properties — the
 * opposite of what the previous pre-pass did: `safeJsonStringify` never
 * calls `toJSON` at all, so a class using `toJSON` as its redaction boundary
 * (returning fewer fields than the instance actually has) was previously
 * *bypassed* and fully enumerated instead, exposing exactly the fields
 * `toJSON` was declared to omit.
 */
function normalizeForRedaction(
  value: unknown,
  depth: number,
  visited: WeakSet<object>,
): unknown {
  if (depth > MAX_NORMALIZE_DEPTH) return "[Max Depth]";
  if (value === null) return null;
  if (typeof value !== "object") return scalarToRedactable(value);

  // `value` is narrowed to a non-null `object` here — every other `typeof`
  // result already returned above via `scalarToRedactable`.
  if (visited.has(value)) return "[Circular]";
  visited.add(value);
  try {
    return normalizeObjectShape(value, depth, visited);
  } finally {
    visited.delete(value);
  }
}

/**
 * Redacts `value` for safe embedding into a persisted {@link M3LRunReport}.
 * Cycle/depth-breaking and `Map`/`Set`/`toJSON` normalization
 * ({@link normalizeForRedaction}) run strictly *first*, redaction runs
 * *last* — never the reverse. `redactSensitiveLogValue` has no cycle guard
 * and throws `RangeError` on a genuinely circular value (or a ~20k-deep
 * acyclic one); running it first and falling back to
 * {@link normalizeForRedaction} on that failure would mean the fallback path
 * — the one taken for exactly the hostile inputs this function exists to
 * guard against — emits **no** redaction at all. `redactSensitiveLogValue`
 * then runs on that acyclic, key-preserving result, so it always executes
 * and always has the last word. Guarded end-to-end so
 * {@link M3LRunReporter.build} still never throws: any failure at any step
 * returns {@link UNREDACTABLE_PLACEHOLDER}, never the raw value. Shared by
 * `archive`, `timeline`, and `environment` so none of the three can bypass
 * redaction on its way into the persisted report.
 */
function sanitizeValue(value: unknown): unknown {
  try {
    const acyclic = normalizeForRedaction(value, 0, new WeakSet<object>());
    return redactSensitiveLogValue(acyclic);
  } catch {
    return UNREDACTABLE_PLACEHOLDER;
  }
}

/** Builds the `{ archive }` entry, or `{}` when `input.archive` is `undefined`. */
function buildArchiveEntry(
  archive: unknown,
): { archive: unknown } | Record<string, never> {
  if (archive === undefined) return {};
  return { archive: sanitizeValue(archive) };
}

/**
 * The shape {@link logBestEffortDiagnostic} accepts, describing a
 * `persist()` failure.
 */
interface PersistFailureDiagnostic {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
}

/**
 * Builds the diagnostic {@link M3LRunReporter.persist} logs on failure,
 * forwarding `name` and `stack` (not just `message`) when `cause` is an
 * `Error` — so an `EACCES` no longer reads identically to a circular-`archive`
 * `TypeError` in the best-effort stderr line.
 */
function buildPersistFailureDiagnostic(
  cause: unknown,
): PersistFailureDiagnostic {
  if (!(cause instanceof Error)) {
    return { message: String(cause) };
  }
  return {
    message: cause.message,
    name: cause.name,
    ...(cause.stack !== undefined ? { stack: cause.stack } : {}),
  };
}

// ---------------------------------------------------------------------------
// M3LRunReporter
// ---------------------------------------------------------------------------

/**
 * Builds, writes, and best-effort persists {@link M3LRunReport}s.
 *
 * @example
 * ```ts
 * import { M3LRunReporter } from "@m3l-automation/m3l-common/core";
 *
 * const reporter = new M3LRunReporter();
 * const writtenPath = await reporter.persist({
 *   script: { name: "import-users", version: "1.0.0" },
 *   correlationId: "run-42",
 *   startedAt: new Date(),
 *   outcome: "success",
 * });
 * console.log(writtenPath);
 * ```
 */
export class M3LRunReporter {
  readonly #paths: Pick<M3LPathsPort, "getOutputDir"> | undefined;
  readonly #fileName: string;

  /**
   * Creates a new `M3LRunReporter`.
   *
   * @param options - Optional injected `paths` port and `fileName` override.
   */
  constructor(options: M3LRunReporterOptions = {}) {
    this.#paths = options.paths;
    this.#fileName = options.fileName ?? DEFAULT_FILE_NAME;
  }

  /**
   * Resolves the output directory from the injected `paths` port, or a
   * lazily-constructed `M3LPaths` when none was injected — never at
   * construction time, mirroring `M3LFileCopier`'s equivalent lazy resolution.
   */
  #resolveOutputDir(): string {
    return (this.#paths ?? new M3LPaths()).getOutputDir();
  }

  /**
   * Computes the report's destination path for a run started at `startedAtIso`.
   *
   * Validates both the sanitized timestamp segment and the configured
   * `fileName` against {@link isSafeRelativeSegment} (the same guard
   * `M3LPaths.resolveWithin` applies to `resolveInput`/`resolveOutput`), then
   * asserts the fully-resolved path still lands inside the resolved output
   * directory — a caller-supplied `startedAt` (surfaced as a plain, unvalidated
   * `string` on {@link M3LRunReport.startedAt}) must never be able to escape
   * the managed output tree.
   *
   * @throws {@link M3LPathResolutionError} When either segment is unsafe, or
   *   the resolved path escapes the output directory.
   */
  #buildReportPath(startedAtIso: string): string {
    return this.#buildReportPathWithOutputDir(startedAtIso).filePath;
  }

  /**
   * Same computation as {@link M3LRunReporter.#buildReportPath}, additionally
   * returning the resolved `outputDir` it was computed against — so
   * {@link M3LRunReporter.write} can run its realpath-based
   * {@link assertNoSymlinkEscape} check against the exact same `outputDir`
   * without re-resolving it (and, when no `paths` port was injected,
   * without constructing a second `M3LPaths` instance).
   */
  #buildReportPathWithOutputDir(startedAtIso: string): {
    readonly filePath: string;
    readonly outputDir: string;
  } {
    const timestampSegment = sanitizeTimestamp(startedAtIso);
    assertSafeReportSegment(timestampSegment, "startedAt-derived segment");
    assertSafeReportSegment(this.#fileName, "fileName");

    const outputDir = this.#resolveOutputDir();
    const filePath = join(outputDir, timestampSegment, this.#fileName);
    assertContainedWithinOutputDir(filePath, outputDir);
    return { filePath, outputDir };
  }

  /**
   * Resolves the path {@link M3LRunReporter.write} would use for a run
   * started at `startedAt`, without performing any I/O.
   *
   * The directory is named by `startedAt` (not `finishedAt`) so it is
   * stable for the whole run and survives a hang or a kill.
   *
   * @param startedAt - The run's start time.
   * @returns The absolute path the report would be written to.
   *
   * @example
   * ```ts
   * import { M3LRunReporter } from "@m3l-automation/m3l-common/core";
   *
   * const reporter = new M3LRunReporter();
   * console.log(reporter.resolveReportPath(new Date()));
   * ```
   */
  resolveReportPath(startedAt: Date): string {
    return this.#buildReportPath(safeToISOString(startedAt));
  }

  /**
   * Builds an {@link M3LRunReport} from `input`. Pure — performs no I/O and
   * never throws, even for hostile input (`error: null`, a circular
   * `archive`, or a hostile-getter `error`).
   *
   * @param input - The run's outcome and metadata.
   * @returns The assembled report.
   *
   * @example
   * ```ts
   * import { M3LRunReporter } from "@m3l-automation/m3l-common/core";
   *
   * const reporter = new M3LRunReporter();
   * const report = reporter.build({
   *   script: { name: "import-users", version: "1.0.0" },
   *   correlationId: "run-42",
   *   startedAt: new Date(),
   *   outcome: "success",
   * });
   * ```
   */
  build(input: M3LRunReportInput): M3LRunReport {
    const startedAt = safeToISOString(input.startedAt);
    const finishedAt = safeToISOString(input.finishedAt ?? new Date());
    const exitCode = safeResolveExitCode(input);
    const environment = sanitizeValue(
      input.environment ?? collectDiagnostics(),
    ) as M3LDiagnosticsSnapshot;
    const timeline = sanitizeValue(
      input.timeline ?? [],
    ) as readonly M3LBreadcrumb[];

    const base = {
      script: input.script,
      correlationId: input.correlationId,
      startedAt,
      finishedAt,
      exitCode,
      environment,
      timeline,
      ...buildArchiveEntry(input.archive),
    };

    if (input.outcome === "failure") {
      return {
        ...base,
        outcome: "failure",
        failure: buildFailureDetail(input),
      };
    }
    return { ...base, outcome: input.outcome };
  }

  /**
   * Writes `report` as pretty-printed (2-space indent), newline-terminated
   * JSON under a directory named by `report.startedAt`, creating that
   * directory recursively.
   *
   * @param report - A previously built report.
   * @returns The absolute path the report was written to.
   * @throws When the directory cannot be created or the file cannot be
   *   written (e.g. a non-serializable value survived into the report, or a
   *   filesystem failure), when a pre-existing symlink at any *ancestor*
   *   component of the destination path would redirect the write outside the
   *   output directory (see {@link assertNoSymlinkEscape}), or when the leaf
   *   destination itself already exists — including as a dangling symlink,
   *   which `realpath` cannot distinguish from "not yet created" and which
   *   {@link assertNoSymlinkEscape} alone therefore cannot catch; the
   *   exclusive-create `"wx"` flag below refuses to follow any pre-existing
   *   directory entry at the leaf, closing that gap directly. Use
   *   {@link M3LRunReporter.persist} for a never-rejecting variant.
   *
   * @example
   * ```ts
   * import { M3LRunReporter } from "@m3l-automation/m3l-common/core";
   *
   * const reporter = new M3LRunReporter();
   * const report = reporter.build({
   *   script: { name: "import-users", version: "1.0.0" },
   *   correlationId: "run-42",
   *   startedAt: new Date(),
   *   outcome: "success",
   * });
   * const writtenPath = await reporter.write(report);
   * ```
   */
  async write(report: M3LRunReport): Promise<string> {
    const { filePath, outputDir } = this.#buildReportPathWithOutputDir(
      report.startedAt,
    );
    await assertNoSymlinkEscape(filePath, outputDir);
    await mkdir(dirname(filePath), { recursive: true });
    // Exclusive create ("wx" == O_CREAT | O_EXCL): fails outright if a
    // directory entry already exists at `filePath` — including a *dangling*
    // symlink, which `open()` refuses even though its target doesn't exist
    // (POSIX open(2) treats O_EXCL + a symlink name as "exists" regardless
    // of what it resolves to). This is what actually closes the leaf-symlink
    // gap `assertNoSymlinkEscape` cannot: that check's `realpath` walk-up
    // treats a dangling symlink as "not yet created" and reports it as
    // contained, but `"wx"` never gets far enough to follow it.
    await writeFile(
      filePath,
      `${JSON.stringify(report, null, JSON_INDENT)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    return filePath;
  }

  /**
   * Builds and writes a report for `input`, never rejecting and never
   * throwing synchronously.
   *
   * This is the whole point of the failure path: even when the run itself
   * failed, `persist` still attempts to write the report describing that
   * failure. On any failure to build or write, a best-effort, redacted
   * diagnostic is written to `stderr` (itself swallowed if it too fails),
   * and `undefined` is returned rather than the written path. The original
   * `input.error` is never re-thrown, wrapped, or mutated.
   *
   * @param input - The run's outcome and metadata.
   * @returns The absolute path the report was written to, or `undefined` if
   *   persistence failed for any reason.
   *
   * @example
   * ```ts
   * import { M3LRunReporter } from "@m3l-automation/m3l-common/core";
   *
   * const reporter = new M3LRunReporter();
   * const writtenPath = await reporter.persist({
   *   script: { name: "import-users", version: "1.0.0" },
   *   correlationId: "run-42",
   *   startedAt: new Date(),
   *   outcome: "failure",
   *   stage: "mainFn",
   *   error: new Error("boom"),
   * });
   * if (writtenPath === undefined) {
   *   // best-effort stderr diagnostic already emitted; nothing more to do
   * }
   * ```
   */
  async persist(input: M3LRunReportInput): Promise<string | undefined> {
    try {
      const report = this.build(input);
      return await this.write(report);
    } catch (cause) {
      logBestEffortDiagnostic(
        "run-report-persist-failed",
        buildPersistFailureDiagnostic(cause),
      );
      return undefined;
    }
  }
}
