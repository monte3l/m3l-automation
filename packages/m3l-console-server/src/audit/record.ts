/**
 * `audit/record` — the human-action audit record (X7, slice 3, ADR-0070):
 * the closed shape every operator-initiated action is written to the
 * append-only trail as.
 *
 * The defining property of this module is a NEGATIVE one: no audit record
 * can carry a parameter VALUE. {@link M3LHumanActionRecord} has no field a
 * value could land in — it carries parameter NAMES and ADR-0068 references
 * only — so a leak is a compile error rather than something a redaction list
 * has to catch after the fact. {@link humanActionRecordFrom} is the single
 * seam where a caller's parameter values are ever in scope, and it keeps
 * their keys only.
 *
 * This module imports nothing from `runs/` or `sessions/`: an audit trail
 * that imported the subsystems it audits would invert the dependency it
 * exists to observe (the `audit/` eslint zone enforces this). The operator
 * profile and the target it records are therefore declared structurally.
 *
 * @packageDocumentation
 */

import type { M3LBoundedList } from "./limits.js";
import {
  booleanField,
  boundedList,
  detailScalar,
  frozen,
  isPlainRecord,
  MAX_PARAMETER_NAME_BYTES,
  MAX_PARAMETER_NAMES,
  MAX_PARAMETER_REF_BYTES,
  MAX_PARAMETER_REFS,
  memberField,
  numberField,
  refuseInlineRef,
  refuseRecord,
  stringField,
} from "./limits.js";

/** The `detail` key recording how many parameter names the count cap dropped. */
const NAMES_TRUNCATED_KEY = "parameterNamesTruncated";

/** The `detail` key recording how many parameter refs the count cap dropped. */
const REFS_TRUNCATED_KEY = "parameterRefsTruncated";

/**
 * The closed set of operator-initiated actions the console audits.
 *
 * Machine transitions (`run.started`, `run.finished`, `run.reconciled`) are
 * deliberately absent: those belong to `runs/audit.ts`'s run-lifecycle sink,
 * not to the human-action trail.
 *
 * @example
 * ```ts
 * const kind: M3LHumanActionKind = "run.launch";
 * ```
 */
export type M3LHumanActionKind =
  | "run.launch"
  | "run.cancel"
  | "session.create"
  | "session.step.add"
  | "session.decision.raise"
  | "session.decision.answer"
  | "session.binding.select"
  | "session.close"
  | "session.reopen";

/**
 * What an audited action acted upon, discriminated on `kind`.
 *
 * Every arm carries an opaque `id` and nothing else, except `script`, which
 * also carries the script's name — a launch is the one action whose target
 * an operator recognises by name rather than by id. Declared structurally
 * rather than imported from `runs/`/`sessions/` (see the module note).
 *
 * @example
 * ```ts
 * const target: M3LHumanActionTarget = { kind: "run", id: "run-1" };
 * ```
 */
export type M3LHumanActionTarget =
  | {
      readonly kind: "script";
      readonly id: string;
      readonly scriptName: string;
    }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "step"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string };

/**
 * How much human intent stood behind an action: `auto` when no gesture was
 * needed (a dry run), `confirmed` when the operator made one, `escalated`
 * when one was required and missing. See {@link humanActionPostureFor}.
 *
 * @example
 * ```ts
 * const posture: M3LHumanActionPosture = "confirmed";
 * ```
 */
export type M3LHumanActionPosture = "auto" | "confirmed" | "escalated";

/**
 * What the console did with the request.
 *
 * Exported although no `src/**` symbol names it outside this module yet: it
 * is a member of {@link M3LHumanActionRecord}'s public shape, so a consumer
 * building or narrowing a record needs to be able to name it. knip stays
 * green because its vitest plugin makes `tests/**` entry points, so a
 * test-only import IS a consumer — the same standing
 * {@link M3LHumanActionRecordInput} already has.
 *
 * @example
 * ```ts
 * const outcome: M3LHumanActionOutcome = "allowed";
 * ```
 */
export type M3LHumanActionOutcome =
  "allowed" | "denied" | "rejected" | "failed" | "served";

/**
 * One human-action audit entry: exactly eleven readonly fields, and no
 * twelfth a parameter VALUE could hide in.
 *
 * Nine of the eleven answer WHO did WHAT, WHEN and with what RESULT, and none
 * of them is wide enough to hold a parameter value: `atMs` (a number),
 * `operator` (a display name) and `operatorEmailDeclared` (a boolean) identify
 * the actor; `correlationId` ties the entry back to the request that produced
 * it; `action`, `posture` and `outcome` are members of the three closed enums
 * above; `target` is the acted-upon thing, an opaque id plus — for a script — a
 * name; and `detail` is a closed scalar map the console itself authors. That
 * they are individually small is also what the cap arithmetic in
 * `audit/limits.ts` assumes when it spends roughly half of Core's 65,536-byte
 * line ceiling on the remaining two fields.
 *
 * `parameterNames`/`parameterRefs` are the only trace a request's parameters
 * leave: their keys, and ADR-0068 references to content stored elsewhere.
 * `detail` is the same closed scalar map `M3LRunAuditRecord.detail` already
 * uses (`runs/audit.ts`), never `unknown` — the type is the primary control,
 * not a redaction list applied downstream.
 *
 * **The operator's email is not recorded.** `operator` is the profile's
 * `name`, and `operatorEmailDeclared` records only WHETHER an email was
 * declared. This is in tension with what an auditor may eventually want: an
 * email disambiguates two operators sharing a display name, and
 * `auth/identity.ts` documents the address as "Never logged", which this
 * record honours rather than reopens. The ruling is deliberately the
 * reversible one — adding the address later is an additive field change,
 * whereas removing it later is a retention problem across every segment
 * already written.
 *
 * @example
 * ```ts
 * const record: M3LHumanActionRecord = {
 *   atMs: Date.now(),
 *   operator: "ada",
 *   operatorEmailDeclared: false,
 *   correlationId: "corr-1",
 *   action: "run.launch",
 *   target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
 *   parameterNames: ["queueUrl"],
 *   parameterRefs: [],
 *   posture: "confirmed",
 *   outcome: "allowed",
 *   detail: { attempt: 1 },
 * };
 * ```
 */
export interface M3LHumanActionRecord {
  /** Epoch-millisecond timestamp the action was recorded at. */
  readonly atMs: number;
  /** The operator's display name — never the profile, never the email. */
  readonly operator: string;
  /** Whether the operator declared an email; the address itself is not recorded. */
  readonly operatorEmailDeclared: boolean;
  /** The correlation id the request was served under. */
  readonly correlationId: string;
  /** The action the operator requested. */
  readonly action: M3LHumanActionKind;
  /** What the action acted upon. */
  readonly target: M3LHumanActionTarget;
  /** The NAMES of the parameters supplied, bounded in count and length. */
  readonly parameterNames: readonly string[];
  /**
   * ADR-0068 references POINTING AT parameter content held elsewhere, bounded
   * likewise. An `inline` envelope carries the content itself rather than
   * pointing at it, so it is not a reference and is refused outright — see
   * `isInlineArtifactRefText` in `audit/limits.ts`.
   */
  readonly parameterRefs: readonly string[];
  /** How much human intent stood behind the action. */
  readonly posture: M3LHumanActionPosture;
  /** What the console did with the request. */
  readonly outcome: M3LHumanActionOutcome;
  /**
   * Closed scalar detail; never caller-supplied parameter values (see above).
   *
   * {@link projectHumanActionRecord} adds `parameterNamesTruncated` /
   * `parameterRefsTruncated` counts here when its count caps dropped entries,
   * so the trail never under-reports what was supplied without saying so.
   * Those two keys are a RESERVED, console-authored namespace: a
   * caller-supplied one is refused rather than trusted, so the trail cannot
   * be made to lie about its own completeness.
   */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The operator identity {@link humanActionRecordFrom} reads.
 *
 * Structurally identical to `auth/identity.ts`'s `M3LOperatorProfile` and
 * satisfied by it, declared here because `audit/` may not import `auth/`.
 *
 * Exported although no `src/**` symbol names it outside this module yet: it
 * is the parameter shape {@link M3LHumanActionRecordInput} demands, so a
 * caller assembling that input needs to be able to name it — and, because
 * the structural claim above is only a claim, so a test can pin it against
 * `M3LOperatorProfile`. knip stays green because its vitest plugin makes
 * `tests/**` entry points, so a test-only import IS a consumer.
 *
 * @example
 * ```ts
 * const operator: M3LHumanActionOperator = { name: "ada", email: undefined };
 * ```
 */
export interface M3LHumanActionOperator {
  /** The operator's display name — the only part that is recorded. */
  readonly name: string;
  /** The operator's email, when declared; recorded only as a boolean. */
  readonly email: string | undefined;
}

/**
 * What {@link humanActionRecordFrom} accepts: the record's own fields, plus
 * the caller's raw `parameters` object, whose VALUES are read here and
 * nowhere else.
 *
 * @example
 * ```ts
 * const input: M3LHumanActionRecordInput = {
 *   atMs: Date.now(),
 *   operator: { name: "ada", email: undefined },
 *   correlationId: "corr-1",
 *   action: "session.create",
 *   target: { kind: "session", id: "sess-1" },
 *   posture: "auto",
 *   outcome: "allowed",
 * };
 * ```
 */
export interface M3LHumanActionRecordInput {
  /** Epoch-millisecond timestamp the action was recorded at. */
  readonly atMs: number;
  /** The operator who requested the action. */
  readonly operator: M3LHumanActionOperator;
  /** The correlation id the request was served under. */
  readonly correlationId: string;
  /** The action the operator requested. */
  readonly action: M3LHumanActionKind;
  /** What the action acted upon. */
  readonly target: M3LHumanActionTarget;
  /** The request's parameters; only their keys survive into the record. */
  readonly parameters?: Readonly<Record<string, unknown>> | undefined;
  /** ADR-0068 references POINTING AT parameter content held elsewhere; an
   * `inline` envelope carries the content itself and is refused. */
  readonly parameterRefs?: readonly string[] | undefined;
  /** How much human intent stood behind the action. */
  readonly posture: M3LHumanActionPosture;
  /** What the console did with the request. */
  readonly outcome: M3LHumanActionOutcome;
  /** Closed scalar detail; defaults to an empty map. */
  readonly detail?:
    Readonly<Record<string, string | number | boolean>> | undefined;
}

/** The closed set {@link M3LHumanActionKind} declares, as a runtime table. */
const ACTION_KINDS: ReadonlySet<M3LHumanActionKind> = new Set([
  "run.launch",
  "run.cancel",
  "session.create",
  "session.step.add",
  "session.decision.raise",
  "session.decision.answer",
  "session.binding.select",
  "session.close",
  "session.reopen",
]);

/** The closed set {@link M3LHumanActionPosture} declares, as a runtime table. */
const POSTURES: ReadonlySet<M3LHumanActionPosture> = new Set([
  "auto",
  "confirmed",
  "escalated",
]);

/** The closed set {@link M3LHumanActionOutcome} declares, as a runtime table. */
const OUTCOMES: ReadonlySet<M3LHumanActionOutcome> = new Set([
  "allowed",
  "denied",
  "rejected",
  "failed",
  "served",
]);

/** The closed set of {@link M3LHumanActionTarget} discriminants. */
const TARGET_KINDS: ReadonlySet<M3LHumanActionTarget["kind"]> = new Set([
  "script",
  "run",
  "session",
  "step",
  "artifact",
]);

/**
 * Rebuilds the closed scalar detail map onto a fresh object, adding the
 * count-cap truncation markers.
 *
 * The container is narrowed first: `Object.entries` over a string yields
 * per-CHARACTER entries, so a `detail` of `"oops"` would be indexed straight
 * into the trail rather than refused. Values are then narrowed at runtime,
 * not merely by type: `detail` is where a cast-boundary caller's nested
 * object (and the secret inside it) would otherwise land verbatim — see
 * {@link boundedList} for why this layer is the only one that can refuse it.
 *
 * The two marker keys are RESERVED. A caller-supplied one is refused, because
 * accepting it either makes the trail lie about its own completeness (a
 * marker on a record nothing was dropped from) or is silently arbitrated away
 * by the `Map` below (a marker on one that was truncated), and a caller
 * cannot tell a rejected field from an accepted one. The single exception is
 * where the key can only be this projection's OWN prior output — the list is
 * already at its count cap and nothing was dropped this pass — because
 * `stream.ts` projects a second time on the way to disk and a genuine marker
 * has to survive that. Closing the residual (a forger who also supplies a
 * saturated list) would need a twelfth record field, which this slice
 * forbids.
 *
 * A marker is written only when the cap actually dropped something, so it is
 * evidence rather than noise, and it goes in this map rather than in a twelfth
 * record field: "eleven fields and no twelfth" is the property the whole
 * module exists to hold, and a dropped COUNT is a number, not somewhere a
 * parameter value could hide. Entries are collected through a `Map` first so a
 * marker can supersede a same-named caller key — the projected properties are
 * non-configurable, so defining one twice would throw.
 *
 * Copied with `Object.defineProperty` rather than `projected[key] = value`:
 * a plain assignment to a key literally named `__proto__` runs the inherited
 * setter and changes the copy's prototype instead of adding a field, which
 * would silently drop a detail entry from the audit line. `defineProperty`
 * always creates an own, enumerable data property.
 */
function projectDetail(
  detail: unknown,
  markers: ReadonlyMap<string, M3LBoundedList>,
): Readonly<Record<string, string | number | boolean>> {
  if (!isPlainRecord(detail)) refuseRecord("detail", detail);

  const entries = new Map<string, string | number | boolean>();
  for (const [key, value] of Object.entries(detail)) {
    const marker = markers.get(key);
    if (marker !== undefined && !(marker.saturated && marker.dropped === 0)) {
      refuseRecord(
        `detail key '${key}'`,
        value,
        "which is a reserved truncation marker only the console may author",
      );
    }
    entries.set(key, detailScalar(value, key));
  }
  for (const [key, list] of markers) {
    if (list.dropped > 0) entries.set(key, list.dropped);
  }

  const projected: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(projected, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return frozen(projected);
}

/**
 * Rebuilds the target, field by field per arm, narrowing every field.
 *
 * Only `script` carries a third field, so the discriminant is read once
 * rather than switched over all five arms; the arms' shapes are pinned by
 * {@link M3LHumanActionTarget} itself, and a new arm with a field beyond
 * `id` would have to be added here to be persisted. A `script` target
 * missing its `scriptName` is refused rather than copied as an own
 * `undefined` key, which Core's projection would reject two layers later.
 */
function projectTarget(target: unknown): M3LHumanActionTarget {
  if (!isPlainRecord(target)) refuseRecord("target", target);

  const kind = memberField(target["kind"], TARGET_KINDS, "target kind");
  const id = stringField(target["id"], "target id");
  return kind === "script"
    ? frozen({
        kind,
        id,
        scriptName: stringField(target["scriptName"], "target scriptName"),
      })
    : frozen({ kind, id });
}

/**
 * Derives the three postures from the confirmation rule `runs/policy.ts`
 * already ships: a launch is allowed when `dryRun || confirmed`.
 *
 * A dry run needed no human gesture (`auto`); a confirmed real run had one
 * (`confirmed`); a real run that is neither was denied and is what an
 * auditor should escalate (`escalated`).
 *
 * @param request - The launch's `dryRun`/`confirmed` flags.
 * @returns The posture that rule implies.
 *
 * @example
 * ```ts
 * import { humanActionPostureFor } from "./audit/record.js";
 *
 * humanActionPostureFor({ dryRun: false, confirmed: true }); // "confirmed"
 * ```
 */
export function humanActionPostureFor(request: {
  readonly dryRun: boolean;
  readonly confirmed: boolean;
}): M3LHumanActionPosture {
  if (request.dryRun) return "auto";
  return request.confirmed ? "confirmed" : "escalated";
}

/**
 * Rebuilds `record` as the console's own detached copy — the only object
 * that ever reaches the audit stream.
 *
 * Three things this proves that the type alone cannot. A caller reaching the
 * port through a cast (or from plain JavaScript) can plant an own key the
 * interface forbids; the rebuild copies the eleven declared fields and
 * nothing else, so a smuggled `parameters` key never survives. Every field is
 * narrowed at RUNTIME, containers as well as contents — a non-array list, a
 * non-object `detail` or `target`, a non-string list entry, a non-scalar
 * `detail` value, an object planted in a verbatim-copied field, an `inline`
 * ADR-0068 ref carrying the parameter value, and a caller-forged truncation
 * marker are all refused, not silently dropped, because a dropped field
 * under-reports what the operator supplied and that is the one outcome an
 * audit trail may never produce. And every node it returns carries
 * an own, non-callable `toJSON`, so an inherited `toJSON` planted on
 * `Object.prototype` cannot forge the bytes the record serializes to. That
 * shadow — not a dropped prototype — is deliberately how the gadget is
 * defeated here, because the result is handed back to CONSUMERS and has to
 * stay iterable, `.slice`-able and re-projectable (see {@link frozen}). The
 * Core primitive projects again on its own side; this layer's job is to prove
 * no value field EXISTS on what it hands over, including to sinks that are
 * not Core (an HTTP body, a log line).
 *
 * @param record - The record to rebuild.
 * @returns A frozen copy whose every node shadows `toJSON`, carrying the same
 *   eleven fields as `record`. It is field-for-field EQUAL to `record` only
 *   when `record` already sits inside the caps: the count caps drop entries
 *   past their maximum (recording how many in the truncation markers), and
 *   the byte budget shortens a surviving entry to its longest whole-code-point
 *   prefix that fits. Both are larger differences than the markers, and both
 *   are why a second projection of this result is a fixed point.
 * @throws {@link "../errors/console-error.js".M3LConsoleError} with code
 *   `"ERR_CONSOLE_AUDIT_RECORD_INVALID"` when any container, field, list entry
 *   or `detail` value is not what the record declares, when a `parameterRefs`
 *   entry is an `inline` ADR-0068 envelope, or when the caller supplied a
 *   reserved truncation-marker key. The message never quotes the value.
 *
 * @example
 * ```ts
 * import { projectHumanActionRecord } from "./audit/record.js";
 *
 * const detached = projectHumanActionRecord(record);
 * ```
 */
export function projectHumanActionRecord(
  record: M3LHumanActionRecord,
): M3LHumanActionRecord {
  const parameterNames = boundedList(
    record.parameterNames,
    MAX_PARAMETER_NAMES,
    MAX_PARAMETER_NAME_BYTES,
    "parameterNames",
  );
  const parameterRefs = boundedList(
    record.parameterRefs,
    MAX_PARAMETER_REFS,
    MAX_PARAMETER_REF_BYTES,
    "parameterRefs",
    refuseInlineRef,
  );
  const markers: ReadonlyMap<string, M3LBoundedList> = new Map([
    [NAMES_TRUNCATED_KEY, parameterNames],
    [REFS_TRUNCATED_KEY, parameterRefs],
  ]);

  return frozen({
    atMs: numberField(record.atMs, "atMs"),
    operator: stringField(record.operator, "operator"),
    operatorEmailDeclared: booleanField(
      record.operatorEmailDeclared,
      "operatorEmailDeclared",
    ),
    correlationId: stringField(record.correlationId, "correlationId"),
    action: memberField(record.action, ACTION_KINDS, "action"),
    target: projectTarget(record.target),
    parameterNames: parameterNames.values,
    parameterRefs: parameterRefs.values,
    posture: memberField(record.posture, POSTURES, "posture"),
    outcome: memberField(record.outcome, OUTCOMES, "outcome"),
    detail: projectDetail(record.detail, markers),
  });
}

/**
 * The NAMES of a supplied `parameters` object; `[]` when none was supplied.
 *
 * `Object.keys(parameters ?? {})` returns `[]` for a primitive too, so a
 * plain-JavaScript caller passing `parameters: 5` would record "no parameters
 * supplied" — an audit trail asserting something false about what the
 * operator sent. Only an ABSENT object may flatten to an empty list: that is
 * the documented default, not a lost value.
 */
function parameterNamesOf(parameters: unknown): readonly string[] {
  if (parameters === undefined || parameters === null) return [];
  if (!isPlainRecord(parameters)) refuseRecord("parameters", parameters);
  return Object.keys(parameters);
}

/**
 * Builds a record from a request, keeping the parameters' NAMES and
 * discarding their values.
 *
 * This is the one place a caller's parameter values are in scope, and it
 * reads only `Object.keys` of them — a secret buried at any depth inside a
 * value is therefore unrepresentable in the result rather than redacted out
 * of it. The operator's email is read only to set
 * `operatorEmailDeclared`; a blank or whitespace-only address is not a
 * declaration.
 *
 * @param input - See {@link M3LHumanActionRecordInput}.
 * @returns A detached {@link M3LHumanActionRecord}, ready for the stream.
 * @throws {@link "../errors/console-error.js".M3LConsoleError} with code
 *   `"ERR_CONSOLE_AUDIT_RECORD_INVALID"` when the operator profile or the
 *   `parameters` object reaching this builder from outside the type system is
 *   not an object, or for anything {@link projectHumanActionRecord} refuses.
 *
 * @example
 * ```ts
 * import { humanActionRecordFrom } from "./audit/record.js";
 *
 * const record = humanActionRecordFrom({
 *   atMs: Date.now(),
 *   operator: { name: "ada", email: undefined },
 *   correlationId: "corr-1",
 *   action: "run.launch",
 *   target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
 *   parameters: { queueUrl: "https://sqs.example.invalid/q" },
 *   posture: "confirmed",
 *   outcome: "allowed",
 * });
 * // record.parameterNames -> ["queueUrl"]; the URL itself is gone.
 * ```
 */
export function humanActionRecordFrom(
  input: M3LHumanActionRecordInput,
): M3LHumanActionRecord {
  const operator: unknown = input.operator;
  if (!isPlainRecord(operator)) refuseRecord("operator profile", operator);
  const email: unknown = operator["email"];

  return projectHumanActionRecord({
    atMs: input.atMs,
    operator: stringField(operator["name"], "operator name"),
    operatorEmailDeclared: typeof email === "string" && email.trim().length > 0,
    correlationId: input.correlationId,
    action: input.action,
    target: input.target,
    parameterNames: parameterNamesOf(input.parameters),
    parameterRefs: input.parameterRefs ?? [],
    posture: input.posture,
    outcome: input.outcome,
    detail: input.detail ?? {},
  });
}
