/**
 * `agent-operator/lib/model-safety` — the outbound boundary. Every value the
 * model reads (a doctor check's detail, a script's description, a config
 * parameter's default) passes through {@link sanitizeForModel} or one of the
 * `project*` functions before it can reach a Bedrock response, because the
 * model itself is an untrusted reader: a secret, an absolute host path, or a
 * bidi/format-control character embedded in CLI output must never cross this
 * boundary unmasked.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type {
  AgentOperatorDoctorCheck,
  AgentOperatorExitCodeName,
  AgentOperatorListRow,
  AgentOperatorParamDescriptor,
  AgentOperatorReportUnavailableReason,
  AgentOperatorRunEnvelope,
  AgentOperatorRunOutcome,
} from "./cli-envelopes.js";

/** Default code-point cap applied by {@link sanitizeForModel} when the caller omits one. */
const DEFAULT_MAX_CODE_POINTS = 512;

/**
 * Private nominal-branding symbol. Its only purpose is to make a projected
 * type incompatible, at the TYPE level, with the raw shape it is projected
 * from — {@link AgentOperatorProjectedOperationDescriptor} against
 * {@link Core.M3LConfigOperationDescriptor}, and
 * {@link AgentOperatorProjectedDoctorCheck} against
 * {@link AgentOperatorDoctorCheck} — even though every other field each
 * declares is structurally identical to its raw counterpart. Without this
 * marker, a raw value is assignable into a projected slot with no cast at
 * all, silently defeating the sanitization {@link projectOperationDescriptor}
 * / {@link projectDoctorCheck} exist to guarantee. (The siblings
 * {@link AgentOperatorProjectedListRow} and
 * {@link AgentOperatorProjectedRunEnvelope} are deliberately NOT branded
 * with this marker — see their own TSDoc for why.) It is `declare const`-only
 * (ambient, never a real `Symbol()` call), so it has no runtime
 * representation whatsoever: each `project*` function "earns" the branded
 * type with an `as` assertion at the exact point every string field has just
 * been sanitized, never by actually assigning this property — it does not
 * exist as an own property on a projected value and never appears as a key
 * in `JSON.stringify(...)` of one.
 */
declare const MODEL_SAFE_BRAND: unique symbol;

/** Options accepted by {@link sanitizeForModel} and every `project*` function. */
export interface AgentOperatorProjectionOptions {
  /**
   * The absolute host workspace-root path. When supplied, every occurrence
   * is replaced with the literal `<workspace>` — verified need: `doctor`'s
   * `workspace-root` check returns the absolute host path as its `detail`,
   * and leaking it to the model discloses host filesystem layout the same
   * way an unguarded spawn error message would.
   */
  readonly workspaceRoot?: string;
  /**
   * Parameter names known to be secret-flagged (`secret: true`) for the
   * script under inspection, threaded into
   * {@link Core.redactSensitiveLogText}'s `options.secrets` as an
   * *additive* widening of its built-in heuristic (the redactor is a
   * denylist, not a parser — its own TSDoc says so). A bare AWS key pair, a
   * JWT, or a `postgres://user:pass@host` URL sitting behind a
   * heuristic-invisible key name still needs redacting when that name is
   * declared secret; names outside this list still get the built-in
   * heuristic's normal treatment. `inspect` knows which parameter names are
   * secret — `cli-surface.ts` threads them in.
   */
  readonly secrets?: readonly string[];
}

/** Code points escaped as six literal ASCII characters (`\`, `u`, four hex digits). */
const C0_MAX = 0x1f;
const DEL = 0x7f;
const C1_MIN = 0x80;
const C1_MAX = 0x9f;

const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const LEFT_TO_RIGHT_OVERRIDE = 0x202d;
const RIGHT_TO_LEFT_OVERRIDE = 0x202e;
const LEFT_TO_RIGHT_ISOLATE = 0x2066;
const RIGHT_TO_LEFT_ISOLATE = 0x2067;
const FIRST_STRONG_ISOLATE = 0x2068;
const POP_DIRECTIONAL_ISOLATE = 0x2069;

/** Bidi/format-control code points escaped in addition to C0/DEL/C1 — see module TSDoc. */
const EXTRA_ESCAPE_TARGETS: ReadonlySet<number> = new Set([
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
  LEFT_TO_RIGHT_OVERRIDE,
  RIGHT_TO_LEFT_OVERRIDE,
  LEFT_TO_RIGHT_ISOLATE,
  RIGHT_TO_LEFT_ISOLATE,
  FIRST_STRONG_ISOLATE,
  POP_DIRECTIONAL_ISOLATE,
]);

/** Returns whether `codePoint` must be escaped rather than passed through as-is. */
function isEscapeTarget(codePoint: number): boolean {
  if (codePoint <= C0_MAX) return true;
  if (codePoint === DEL) return true;
  if (codePoint >= C1_MIN && codePoint <= C1_MAX) return true;
  return EXTRA_ESCAPE_TARGETS.has(codePoint);
}

/**
 * Renders `codePoint` as the literal six-character text `\uXXXX` — never the
 * raw code unit. Built with `String.raw` so this source file itself never
 * embeds a raw control byte or a real `\u` escape sequence.
 */
const HEX_RADIX = 16;
const UNICODE_ESCAPE_HEX_DIGITS = 4;

function renderCodePointEscape(codePoint: number): string {
  const hex = codePoint
    .toString(HEX_RADIX)
    .padStart(UNICODE_ESCAPE_HEX_DIGITS, "0");
  return String.raw`\u${hex}`;
}

/**
 * Replaces every C0 (`U+0000`-`U+001F`), `U+007F`, C1 (`U+0080`-`U+009F`),
 * and bidi/format-control code point (see {@link EXTRA_ESCAPE_TARGETS}) with
 * its textual `\uXXXX` escape. Iterates by code point via `for...of` so a
 * surrogate pair is never split — control/format characters are all single
 * UTF-16 code units, but the pass-through branch must still hand back
 * astral characters whole.
 */
function escapeControlCharacters(text: string): string {
  let result = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    result +=
      codePoint !== undefined && isEscapeTarget(codePoint)
        ? renderCodePointEscape(codePoint)
        : character;
  }
  return result;
}

/**
 * Truncates `text` to at most `maxCodePoints` code points, iterating with
 * `for...of` (never `.slice()`, which counts UTF-16 code units and can
 * bisect a surrogate pair, emitting a lone surrogate). Appends `"…"` only
 * when truncation actually occurred.
 */
function truncateByCodePoint(text: string, maxCodePoints: number): string {
  let result = "";
  let count = 0;
  let truncated = false;
  for (const character of text) {
    if (count >= maxCodePoints) {
      truncated = true;
      break;
    }
    result += character;
    count++;
  }
  return truncated ? `${result}…` : result;
}

/**
 * Builds the {@link Core.M3LRedactOptions} forwarded to
 * {@link Core.redactSensitiveLogText}. Returns `{}` (bare-call behavior)
 * when `secrets` is absent or empty; otherwise wraps the declared names in
 * an {@link Core.M3LSecretNamesPort} membership check.
 */
function buildRedactOptions(
  secrets: readonly string[] | undefined,
): Core.M3LRedactOptions {
  if (secrets === undefined || secrets.length === 0) return {};
  const secretNames = new Set(secrets);
  return { secrets: { isSecret: (name) => secretNames.has(name) } };
}

/** Replaces every occurrence of `workspaceRoot` in `text` with `<workspace>`. */
function scrubWorkspaceRoot(
  text: string,
  workspaceRoot: string | undefined,
): string {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) return text;
  return text.split(workspaceRoot).join("<workspace>");
}

/**
 * Sanitizes free-form text before it can reach the model, in a fixed,
 * load-bearing order:
 *
 * 1. {@link Core.redactSensitiveLogText} runs FIRST, over the whole
 *    original string — so a later truncation step can never slide a secret
 *    out of the redactor's matching window by cutting the string mid-match.
 * 2. The workspace-root absolute path (when supplied) is replaced with the
 *    literal `<workspace>`.
 * 3. C0/DEL/C1 and bidi/format-control code points are escaped as textual
 *    `\uXXXX` sequences, never passed through raw.
 * 4. The result is truncated to `maxCodePoints` code points, counted by
 *    code point (never UTF-16 code unit) so a surrogate pair straddling the
 *    cap survives whole.
 *
 * @param text - The raw text to sanitize (a CLI field, never model output).
 * @param maxCodePoints - The maximum code points to retain. Defaults to `512`.
 * @param options - Optional workspace-root scrubbing and declared secret names.
 * @returns The sanitized, length-capped text.
 * @example
 * ```ts
 * import { sanitizeForModel } from "./model-safety.js";
 *
 * const safe = sanitizeForModel("token=abc123", 512);
 * // "token=[REDACTED]"
 * ```
 */
export function sanitizeForModel(
  text: string,
  maxCodePoints: number = DEFAULT_MAX_CODE_POINTS,
  options?: AgentOperatorProjectionOptions,
): string {
  const redacted = Core.redactSensitiveLogText(
    text,
    buildRedactOptions(options?.secrets),
  );
  const scrubbed = scrubWorkspaceRoot(redacted, options?.workspaceRoot);
  const escaped = escapeControlCharacters(scrubbed);
  return truncateByCodePoint(escaped, maxCodePoints);
}

/** Sanitizes `text` under the shared default cap, forwarding `opts`. */
function sanitize(text: string, opts: AgentOperatorProjectionOptions): string {
  return sanitizeForModel(text, undefined, opts);
}

/**
 * The model-safe projection of {@link AgentOperatorDoctorCheck}. A
 * dedicated, nominally-branded type (see {@link MODEL_SAFE_BRAND}) — not
 * merely a same-shaped re-declaration of the raw check — so a raw
 * `AgentOperatorDoctorCheck` cannot be assigned here without the `as` cast
 * {@link projectDoctorCheck} performs once every string has been sanitized:
 * `detail` — the one un-allowlisted string that crosses to the model,
 * carrying a raw `error.message` from the CLI in the failure case — cannot
 * silently regain an unsanitized shape because the compiler, not just the
 * runtime sanitizer, rejects the assignment. Any test double that needs a
 * projected doctor check must build it via {@link projectDoctorReport} or
 * {@link projectDoctorCheck} over a raw check shape, never as a plain object
 * literal.
 */
export interface AgentOperatorProjectedDoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
  /** Type-level-only marker — see {@link MODEL_SAFE_BRAND}. Never present at runtime. */
  readonly [MODEL_SAFE_BRAND]: true;
}

/**
 * Projects one doctor check for the model. `detail` is KEPT (sanitized) —
 * it is the diagnostic value the check exists to carry, unlike
 * {@link projectListRow}'s `loadError`, which is dropped entirely. Document
 * both sides of this asymmetry together, here and on `projectListRow`, or a
 * future pass will "fix" one side to match the other.
 *
 * @param check - The parsed doctor check.
 * @param opts - Sanitization options (workspace-root scrubbing).
 * @returns A fresh, frozen, model-safe projection.
 * @example
 * ```ts
 * import { projectDoctorCheck } from "./model-safety.js";
 *
 * const safe = projectDoctorCheck(
 *   { name: "disk-space", status: "ok", detail: "42% used" },
 *   {},
 * );
 * ```
 */
export function projectDoctorCheck(
  check: AgentOperatorDoctorCheck,
  opts: AgentOperatorProjectionOptions = {},
): AgentOperatorProjectedDoctorCheck {
  return Object.freeze({
    name: sanitize(check.name, opts),
    status: check.status,
    detail: sanitize(check.detail, opts),
  }) as AgentOperatorProjectedDoctorCheck;
}

/** The model-safe projection of a full `doctor --json` run. */
export interface AgentOperatorProjectedDoctorReport {
  /** `true` when any check's status is `"fail"` — derived here, never read from the CLI. */
  readonly blocking: boolean;
  readonly counts: {
    readonly ok: number;
    readonly warn: number;
    readonly fail: number;
  };
  readonly checks: readonly AgentOperatorProjectedDoctorCheck[];
}

/** Tallies each doctor status into its bucket. Unreachable statuses are simply not counted. */
function countDoctorStatuses(checks: readonly AgentOperatorDoctorCheck[]): {
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
} {
  let ok = 0;
  let warn = 0;
  let fail = 0;
  for (const check of checks) {
    switch (check.status) {
      case "ok":
        ok++;
        break;
      case "warn":
        warn++;
        break;
      case "fail":
        fail++;
        break;
      default: {
        // `check.status` is already constrained to the three literals by
        // `parseDoctorChecks`; this arm exists only so a future fourth
        // status fails to compile here, mirroring `mapCommandOutcomeToExitCode`'s
        // never-throws convention rather than throwing on a value the type
        // system already proved cannot occur.
        const _exhaustive: never = check.status;
        void _exhaustive;
      }
    }
  }
  return { ok, warn, fail };
}

/**
 * Projects a full doctor run for the model. `blocking` is derived as
 * `checks.some((c) => c.status === "fail")` — it is not a CLI field.
 *
 * @param checks - The parsed doctor checks.
 * @param opts - Sanitization options (workspace-root scrubbing).
 * @returns A fresh, frozen, model-safe report.
 * @example
 * ```ts
 * import { projectDoctorReport } from "./model-safety.js";
 *
 * const report = projectDoctorReport(
 *   [{ name: "disk-space", status: "ok", detail: "42% used" }],
 *   {},
 * );
 * // report.blocking === false
 * ```
 */
export function projectDoctorReport(
  checks: readonly AgentOperatorDoctorCheck[],
  opts: AgentOperatorProjectionOptions = {},
): AgentOperatorProjectedDoctorReport {
  return Object.freeze({
    blocking: checks.some((check) => check.status === "fail"),
    counts: countDoctorStatuses(checks),
    checks: checks.map((check) => projectDoctorCheck(check, opts)),
  });
}

/** The model-safe projection of {@link AgentOperatorListRow}. */
export interface AgentOperatorProjectedListRow {
  readonly name: string;
  readonly description: string;
  readonly parameterCount: number | null;
  readonly configLoadFailed: boolean;
}

/**
 * Projects one `list --json` row for the model. `loadError` is DROPPED
 * entirely — replaced by the boolean `configLoadFailed` — unlike
 * {@link projectDoctorCheck}'s `detail`, which is kept (sanitized). The
 * model needs the fact that a script's config failed to load, not the raw
 * error text (which can embed secrets or prompt-injection attempts drawn
 * from that script's own config source).
 *
 * @param row - The parsed list row.
 * @param opts - Sanitization options (workspace-root scrubbing).
 * @returns A fresh, frozen, model-safe projection.
 * @example
 * ```ts
 * import { projectListRow } from "./model-safety.js";
 *
 * const safe = projectListRow(
 *   { name: "json-etl", description: "Transforms JSON.", parameterCount: 3, loadError: null },
 *   {},
 * );
 * // safe.configLoadFailed === false
 * ```
 */
export function projectListRow(
  row: AgentOperatorListRow,
  opts: AgentOperatorProjectionOptions = {},
): AgentOperatorProjectedListRow {
  return Object.freeze({
    name: sanitize(row.name, opts),
    description: sanitize(row.description, opts),
    parameterCount: row.parameterCount,
    configLoadFailed: row.loadError !== null,
  });
}

/**
 * The model-safe projection of {@link Core.M3LConfigOperationDescriptor}. A
 * dedicated, nominally-branded type (see {@link MODEL_SAFE_BRAND}) — not
 * merely a same-shaped re-declaration of the raw descriptor — so a raw
 * `Core.M3LConfigOperationDescriptor` cannot be assigned here without the
 * `as` cast {@link projectOperationDescriptor} performs once every string
 * has been sanitized: `operations` cannot silently regain an unsanitized
 * shape because the compiler, not just the runtime sanitizer, rejects the
 * assignment. Every string field is sanitized, `requiredParameters` is
 * capped and sanitized per-element, and both this object and the array it
 * lives in are frozen by {@link projectParamDescriptor}.
 */
export interface AgentOperatorProjectedOperationDescriptor {
  readonly name: string;
  readonly description: string;
  readonly requiredParameters: readonly string[];
  /** Type-level-only marker — see {@link MODEL_SAFE_BRAND}. Never present at runtime. */
  readonly [MODEL_SAFE_BRAND]: true;
}

/** Maximum `requiredParameters` entries retained per projected operation. */
const MAX_OPERATION_REQUIRED_PARAMETERS = 32;

/**
 * Projects one operation's `requiredParameters` into a fresh, frozen,
 * sanitized, element-capped array — the array that carried
 * `"apiKey=SUPER-SECRET"`-shaped entries unsanitized before this fix.
 */
function projectRequiredParameters(
  requiredParameters: readonly string[],
  opts: AgentOperatorProjectionOptions,
): readonly string[] {
  return Object.freeze(
    requiredParameters
      .slice(0, MAX_OPERATION_REQUIRED_PARAMETERS)
      .map((parameter) => sanitize(parameter, opts)),
  );
}

/**
 * Projects one declared operation (ADR-0055) for the model: a fresh, frozen
 * object with every string field sanitized — never a reference copy of the
 * raw {@link Core.M3LConfigOperationDescriptor}.
 */
function projectOperationDescriptor(
  operation: Core.M3LConfigOperationDescriptor,
  opts: AgentOperatorProjectionOptions,
): AgentOperatorProjectedOperationDescriptor {
  return Object.freeze({
    name: sanitize(operation.name, opts),
    description: sanitize(operation.description, opts),
    requiredParameters: projectRequiredParameters(
      operation.requiredParameters,
      opts,
    ),
  }) as AgentOperatorProjectedOperationDescriptor;
}

/**
 * Projects a param descriptor's whole `operations` array into fresh, frozen,
 * sanitized entries — the array itself is also frozen, so neither a later
 * mutation of the source array nor of the source's nested objects can reach
 * the projection.
 */
function projectOperations(
  operations: readonly Core.M3LConfigOperationDescriptor[],
  opts: AgentOperatorProjectionOptions,
): readonly AgentOperatorProjectedOperationDescriptor[] {
  return Object.freeze(
    operations.map((operation) => projectOperationDescriptor(operation, opts)),
  );
}

/** The model-safe projection of {@link AgentOperatorParamDescriptor}. */
export interface AgentOperatorProjectedParamDescriptor {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description: string;
  readonly secret: boolean;
  readonly operations: readonly AgentOperatorProjectedOperationDescriptor[];
}

/**
 * Computes the (possibly absent) `defaultValue` field of a projected param
 * descriptor. Omits the key entirely — via a conditional spread at the call
 * site, never an explicit `undefined` — when `secret === true` or no
 * default was declared, so `exactOptionalPropertyTypes` sees a genuinely
 * absent property rather than a present-but-`undefined` one.
 */
function projectDefaultValue(
  descriptor: AgentOperatorParamDescriptor,
  opts: AgentOperatorProjectionOptions,
): { readonly defaultValue?: string } {
  if (descriptor.secret) return {};
  if (descriptor.defaultValue === undefined) return {};
  return { defaultValue: sanitize(descriptor.defaultValue, opts) };
}

/**
 * Projects one `inspect --json` row for the model. `defaultValue` is
 * DROPPED when `descriptor.secret === true` and kept (sanitized) otherwise;
 * `secret` is always emitted so the model can tell the two cases apart.
 *
 * @param descriptor - The parsed param descriptor.
 * @param opts - Sanitization options (workspace-root scrubbing).
 * @returns A fresh, frozen, model-safe projection.
 * @example
 * ```ts
 * import { projectParamDescriptor } from "./model-safety.js";
 *
 * const safe = projectParamDescriptor(
 *   {
 *     name: "apiKey",
 *     aliases: [],
 *     type: "STRING",
 *     required: true,
 *     defaultValue: "shhh",
 *     description: "d",
 *     secret: true,
 *     operations: [],
 *   },
 *   {},
 * );
 * // safe.defaultValue === undefined
 * ```
 */
export function projectParamDescriptor(
  descriptor: AgentOperatorParamDescriptor,
  opts: AgentOperatorProjectionOptions = {},
): AgentOperatorProjectedParamDescriptor {
  return Object.freeze({
    name: sanitize(descriptor.name, opts),
    aliases: descriptor.aliases.map((alias) => sanitize(alias, opts)),
    type: sanitize(descriptor.type, opts),
    required: descriptor.required,
    description: sanitize(descriptor.description, opts),
    secret: descriptor.secret,
    operations: projectOperations(descriptor.operations, opts),
    ...projectDefaultValue(descriptor, opts),
  });
}

/** The model-safe projection of {@link AgentOperatorRunEnvelope}. */
export interface AgentOperatorProjectedRunEnvelope {
  readonly script: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly exitCodeName: AgentOperatorExitCodeName | null;
  readonly outcome: AgentOperatorRunOutcome | null;
  readonly reportAvailable: boolean;
  readonly reportUnavailable: AgentOperatorReportUnavailableReason | null;
  readonly timelineCount: number | null;
  readonly timelineSourceCount: number | null;
  readonly recoveryTotal: number | null;
}

/**
 * Projects a `run --json` envelope for the model. `reportPath` is DROPPED —
 * it is an absolute host path — and replaced by the boolean
 * `reportAvailable`. `script`, `startedAt`, and `finishedAt` are free CLI
 * text — `cli-envelopes.ts` only `requireString`s them, with no ISO-8601 or
 * script-name validation — so each is sanitized through
 * {@link sanitizeForModel} like every other free-text field. Chosen
 * contract: a malformed `startedAt`/`finishedAt` is sanitized, never
 * rejected, so a bad CLI value cannot fail the whole run. The remaining
 * fields are already validated enums/counts with no free-text disclosure
 * risk, so none needs sanitizing.
 *
 * @param env - The parsed run envelope.
 * @param opts - Sanitization options (workspace-root scrubbing, declared secrets).
 * @returns A fresh, frozen, model-safe projection.
 * @example
 * ```ts
 * import { projectRunEnvelope } from "./model-safety.js";
 *
 * const safe = projectRunEnvelope(
 *   {
 *     kind: "m3l.run.result",
 *     schemaVersion: 1,
 *     script: "json-etl",
 *     startedAt: "2026-08-30T00:00:00.000Z",
 *     finishedAt: "2026-08-30T00:00:01.000Z",
 *     durationMs: 1000,
 *     exitCode: 0,
 *     exitCodeName: "SUCCESS",
 *     outcome: "dry-run",
 *     reportPath: null,
 *     reportUnavailable: null,
 *     timelineCount: null,
 *     timelineSourceCount: null,
 *     recoveryTotal: null,
 *   },
 *   {},
 * );
 * // safe.reportAvailable === false
 * ```
 */
export function projectRunEnvelope(
  env: AgentOperatorRunEnvelope,
  opts: AgentOperatorProjectionOptions = {},
): AgentOperatorProjectedRunEnvelope {
  return Object.freeze({
    script: sanitize(env.script, opts),
    startedAt: sanitize(env.startedAt, opts),
    finishedAt: sanitize(env.finishedAt, opts),
    durationMs: env.durationMs,
    exitCode: env.exitCode,
    exitCodeName: env.exitCodeName,
    outcome: env.outcome,
    reportAvailable: env.reportPath !== null,
    reportUnavailable: env.reportUnavailable,
    timelineCount: env.timelineCount,
    timelineSourceCount: env.timelineSourceCount,
    recoveryTotal: env.recoveryTotal,
  });
}
