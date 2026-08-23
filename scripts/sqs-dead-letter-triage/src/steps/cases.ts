/**
 * `sqs-dead-letter-triage/steps/cases` — compiles a preset's authored
 * `TriageCase` rows into `M3LProcedureCase`s, plus the five codified
 * terminal cases and the mandatory `unrecognised` fallback.
 *
 * Split out of `./build-procedure.js` purely to stay under the per-file byte
 * ceiling; there is no behavioral boundary between the two files.
 */

import { Core } from "@m3l-automation/m3l-common";

import type {
  TriageArm,
  TriageCase,
  TriageConclusion,
  TriagePreset,
  TriageShape,
  TriageVerdict,
} from "./preset.js";

/** The error code a case action raises when it needs run state no step set. */
const PROCEDURE_CODE = "ERR_DLQ_TRIAGE_PROCEDURE";

/** Reserved priorities for the five codified terminal cases, highest wins first. */
const PRIORITY_NOT_RUNBOOK_MANAGED = 6;
const PRIORITY_UNPARSEABLE = 5;
const PRIORITY_UNROUTED = 4;
const PRIORITY_NO_KEY = 3;
const PRIORITY_ENTITY_NOT_FOUND = 2;

type Condition = Core.M3LProcedureCondition<TriageShape>;
type ValueKey = keyof TriageShape["values"];

/** Escapes `text` for literal, non-backtracking use inside a `RegExp` source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `compare` condition pinning `values[key]` to a literal scalar. */
function compareValue(
  key: ValueKey,
  operator: Core.M3LProcedureCompareOperator,
  literal: string | boolean,
): Condition {
  return {
    kind: "compare",
    left: { source: "value", key },
    operator,
    right: { source: "literal", literal },
  };
}

/** An `exists` condition over `values[key]`. */
function existsValue(key: ValueKey): Condition {
  return { kind: "exists", subject: { source: "value", key } };
}

/** Wraps every declared predicate in `and`, or returns the lone one unwrapped. */
function andAll(predicates: readonly [Condition, ...Condition[]]): Condition {
  return predicates.length === 1
    ? predicates[0]
    : { kind: "and", operands: predicates };
}

/**
 * Every case from every arm is declared on one procedure, but only one arm
 * is selected at run time — so every preset-row case's `when` must pin
 * `values.armLabel` to its own arm's label, alongside its declared
 * predicates, or a row from arm A could match a message routed to arm B.
 */
function armGuard(armLabel: string): Condition {
  return compareValue("armLabel", "==", armLabel);
}

/** One `matches` predicate per required progression state, pattern `,<state>,`, regex-escaped. */
function progressionConditions(states: readonly string[]): Condition[] {
  return states.map((state) => ({
    kind: "matches",
    subject: { source: "value", key: "progression" },
    pattern: `,${escapeRegExp(state.toLowerCase())},`,
  }));
}

/**
 * Builds the `and`-of-declared-predicates condition for one case row: the
 * arm guard, plus a `compare`/`matches` node for each predicate the row
 * actually declares (`fromState`, `nextState`, `eventType`, `signature`,
 * `requiredProgression`). `signature` matches against the raw message body,
 * addressed by a `step` reference to `parse-envelope`'s recorded output.
 */
function rowCondition(row: TriageCase, armLabel: string): Condition {
  const predicates: Condition[] = [armGuard(armLabel)];
  if (row.fromState !== undefined) {
    predicates.push(
      compareValue("fromState", "==", row.fromState.toLowerCase()),
    );
  }
  if (row.nextState !== undefined) {
    predicates.push(
      compareValue("nextState", "==", row.nextState.toLowerCase()),
    );
  }
  if (row.eventType !== undefined) {
    predicates.push(compareValue("eventType", "==", row.eventType));
  }
  if (row.signature !== undefined) {
    predicates.push({
      kind: "matches",
      subject: { source: "step", step: "parse-envelope" },
      pattern: row.signature,
    });
  }
  if (row.requiredProgression !== undefined) {
    predicates.push(...progressionConditions(row.requiredProgression));
  }
  return andAll(predicates as [Condition, ...Condition[]]);
}

/** A prohibition string blocking `verdict` by simple, case-insensitive containment. */
function prohibitionBlocks(
  prohibition: string,
  verdict: "remove" | "reinsert",
): boolean {
  const lower = prohibition.toLowerCase();
  return verdict === "reinsert"
    ? lower.includes("redrive") || lower.includes("reinsert")
    : lower.includes("delete") || lower.includes("remove");
}

/**
 * The row's verdict, downgraded to `"hold"` when a declared prohibition
 * blocks it. A prohibition matching neither polarity is inert — it must
 * never silently block every verdict, only the one(s) its wording names.
 */
function downgradeForProhibitions(
  preset: TriagePreset,
  verdict: TriageVerdict,
): {
  readonly verdict: TriageVerdict;
  readonly prohibited: string | undefined;
  readonly note: string | undefined;
} {
  if (verdict !== "remove" && verdict !== "reinsert") {
    return { verdict, prohibited: undefined, note: undefined };
  }
  const blocking = preset.prohibitions.find((prohibition) =>
    prohibitionBlocks(prohibition, verdict),
  );
  if (blocking === undefined) {
    return { verdict, prohibited: undefined, note: undefined };
  }
  return {
    verdict: "hold",
    prohibited: blocking,
    note: `would have concluded '${verdict}', but a prohibition blocks it: ${blocking}`,
  };
}

/** Compiles one preset case row, scoped to its declaring arm, into a procedure case. */
function presetCase(
  preset: TriagePreset,
  armLabel: string,
  row: TriageCase,
): Core.M3LProcedureCase<TriageShape, string> {
  return {
    id: row.id,
    description: row.description,
    prose: row.prose,
    priority: row.priority,
    condition: rowCondition(row, armLabel),
    action: (): TriageConclusion => {
      const resolved = downgradeForProhibitions(preset, row.verdict);
      return {
        verdict: resolved.verdict,
        caseId: row.id,
        description: row.description,
        prose: row.prose,
        ticket: row.ticket,
        resolution: row.resolution,
        escalateTo: row.escalateTo ?? preset.escalateTo,
        followUps:
          resolved.note === undefined
            ? [...row.followUps, ...preset.followUps]
            : [...row.followUps, resolved.note, ...preset.followUps],
        prohibited: resolved.prohibited,
      };
    },
  };
}

/** Every arm's case rows, flattened, each scoped to its own arm via {@link armGuard}. */
function presetCases(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string>[] {
  return preset.arms.flatMap((arm) =>
    arm.cases.map((row) => presetCase(preset, arm.label, row)),
  );
}

/** The codified case matching a queue whose `handling` is not `"runbook"`. */
function notRunbookManagedCase(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string> {
  const description = "the queue's handling mode is not 'runbook'";
  const prose = `This queue's handling is '${preset.handling}', not 'runbook' — it is not automated by this procedure.`;
  return {
    id: "not-runbook-managed",
    description,
    prose,
    priority: PRIORITY_NOT_RUNBOOK_MANAGED,
    condition: compareValue("handling", "!=", "runbook"),
    action: (): TriageConclusion => ({
      verdict: "not-runbook-managed",
      caseId: "not-runbook-managed",
      description,
      prose,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
      prohibited: undefined,
    }),
  };
}

/** The codified case matching an envelope that never resolved to a payload. */
function unparseableCase(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string> {
  const description = "the message envelope could not be resolved to a payload";
  const prose =
    "The message body could not be parsed (or its declared payload path did not resolve). Inspect the raw message by hand.";
  return {
    id: "unparseable",
    description,
    prose,
    priority: PRIORITY_UNPARSEABLE,
    condition: {
      kind: "and",
      operands: [
        { kind: "not", operand: existsValue("eventType") },
        compareValue("handling", "==", "runbook"),
      ],
    },
    action: (): TriageConclusion => ({
      verdict: "unparseable",
      caseId: "unparseable",
      description,
      prose,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
      prohibited: undefined,
    }),
  };
}

/** The codified case matching a resolved payload no arm claims. */
function unroutedCase(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string> {
  const description = "no arm matches the message's event type";
  const prose =
    "This message's event type does not match any declared arm, and the preset declares no default arm. Add an arm or a default, or escalate.";
  return {
    id: "unrouted",
    description,
    prose,
    priority: PRIORITY_UNROUTED,
    condition: { kind: "not", operand: existsValue("armLabel") },
    action: (): TriageConclusion => ({
      verdict: "unrouted",
      caseId: "unrouted",
      description,
      prose,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
      prohibited: undefined,
    }),
  };
}

/** The codified case matching a routed message with no extractable lookup key. */
function noKeyCase(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string> {
  const description = "no lookup key could be extracted from the payload";
  const prose =
    "This message routed to an arm, but no lookup key could be extracted from its payload. Inspect the arm's key rule and the message by hand.";
  return {
    id: "no-key",
    description,
    prose,
    priority: PRIORITY_NO_KEY,
    condition: { kind: "not", operand: existsValue("messageKey") },
    action: (): TriageConclusion => ({
      verdict: "no-key",
      caseId: "no-key",
      description,
      prose,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
      prohibited: undefined,
    }),
  };
}

/** The verdict `entity-not-found` concludes with, honouring the arm's `onMissing`. */
function entityNotFoundVerdict(arm: TriageArm): TriageVerdict {
  return arm.onMissing === "entity-not-found"
    ? "entity-not-found"
    : arm.onMissing;
}

/**
 * The codified case matching a routed, keyed message whose entity was never
 * found at any lookup tier. Its case id always stays `entity-not-found`; the
 * *verdict* it concludes with is substituted per the selected arm's
 * `onMissing` (`"escalate"` or `"hold"` instead of `"entity-not-found"`).
 */
function entityNotFoundCase(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string> {
  const description = "no lookup tier returned the correlated entity";
  return {
    id: "entity-not-found",
    description,
    prose:
      "No lookup tier returned a correlated entity for this message's key. Investigate the source system by hand.",
    priority: PRIORITY_ENTITY_NOT_FOUND,
    condition: {
      kind: "and",
      operands: [
        compareValue("entityFound", "==", false),
        existsValue("messageKey"),
      ],
    },
    action: (context): TriageConclusion => {
      const arm = context.deps.state.arm;
      if (arm === undefined) {
        throw new Core.M3LError(
          "sqs-dead-letter-triage: entity-not-found resolved with no arm selected",
          { code: PROCEDURE_CODE },
        );
      }
      const prose =
        arm.onMissing === "entity-not-found"
          ? "No lookup tier returned a correlated entity for this message's key. Investigate the source system by hand."
          : `No lookup tier returned a correlated entity for this message's key. Per this arm's configuration, this ${arm.onMissing === "escalate" ? "escalates" : "holds"} rather than concluding 'entity-not-found'.`;
      return {
        verdict: entityNotFoundVerdict(arm),
        caseId: "entity-not-found",
        description,
        prose,
        ticket: undefined,
        resolution: undefined,
        escalateTo: preset.escalateTo,
        followUps: [...preset.followUps],
        prohibited: undefined,
      };
    },
  };
}

/**
 * Every codified terminal case, in priority order (highest first, though the
 * engine itself sorts by priority regardless of array order).
 */
function terminalCases(
  preset: TriagePreset,
): Core.M3LProcedureCase<TriageShape, string>[] {
  return [
    notRunbookManagedCase(preset),
    unparseableCase(preset),
    unroutedCase(preset),
    noKeyCase(preset),
    entityNotFoundCase(preset),
  ];
}

/**
 * Compiles every case the procedure declares: every arm's authored rows
 * (each scoped to its own arm), plus the five codified terminal cases.
 *
 * @param preset - The validated preset the procedure is built from.
 * @returns Every `M3LProcedureCase`, ready to be `.case()`-declared in
 *   priority-independent order (the builder itself does not require sorted
 *   input).
 *
 * @example
 * ```typescript
 * import { buildTriageCases } from "./cases.js";
 * import type { TriagePreset } from "./preset.js";
 *
 * declare const preset: TriagePreset;
 * const cases = buildTriageCases(preset);
 * console.log(cases.length >= 5); // true: at least the five terminal cases
 * ```
 */
export function buildTriageCases(
  preset: TriagePreset,
): readonly Core.M3LProcedureCase<TriageShape, string>[] {
  return [...presetCases(preset), ...terminalCases(preset)];
}

/**
 * The mandatory `unrecognised` fallback: no authored row and no codified
 * terminal case matched. Priority `1` is implicitly reserved for it (it is
 * never declared as a `.case()`), the lowest of every reserved terminal
 * priority.
 *
 * @param preset - The validated preset the procedure is built from.
 * @returns The `M3LProcedureFallback` passed to `build()`.
 *
 * @example
 * ```typescript
 * import { unrecognisedFallback } from "./cases.js";
 * import type { TriagePreset } from "./preset.js";
 *
 * declare const preset: TriagePreset;
 * const fallback = unrecognisedFallback(preset);
 * console.log(fallback.description);
 * ```
 */
export function unrecognisedFallback(
  preset: TriagePreset,
): Core.M3LProcedureFallback<TriageShape> {
  return {
    description: "no known-case row or codified terminal case matched",
    prose: `This message did not match any known-case row. Escalate to ${preset.escalateTo} with the evidence below.`,
    action: (_context, investigated): TriageConclusion => ({
      verdict: "unrecognised",
      caseId: undefined,
      description: "no known-case row or codified terminal case matched",
      prose: `This message did not match any known-case row (${String(investigated.length)} known cases were checked). Escalate to ${preset.escalateTo} with the evidence below.`,
      ticket: undefined,
      resolution: undefined,
      escalateTo: preset.escalateTo,
      followUps: [...preset.followUps],
      prohibited: undefined,
    }),
  };
}
