/**
 * `sqs-dead-letter-triage/steps/steps-graph` — the nine codified step
 * factories (ADR-0076/ADR-0077-style codified spine) that make up
 * `sqs-dead-letter-triage`'s procedure. Nothing else lives here: case
 * compilation is `./cases.js`, assembly is `./build-procedure.js` — split
 * three ways purely to stay under the per-file byte ceiling
 * (`pnpm check:file-budget`).
 *
 * Declaration order below is exactly the procedure's step order. The
 * `widen-lookup` / `lookup-entity` / `check-entity-present` trio is the one
 * load-bearing ordering choice: `widen-lookup` selects the tier and carries
 * NO loop, `lookup-entity` gathers at that tier, and `check-entity-present`
 * — the CHECK step — owns the back edge to `widen-lookup`. Putting the loop
 * on the check step (not the widen step) means a found entity's `"continue"`
 * falls straight through to `derive-state` instead of re-widening, and the
 * back edge originates from the one step declaring `loop`, which is exactly
 * what keeps it out of build-time cycle detection.
 */

import { Core } from "@m3l-automation/m3l-common";

import { normaliseProgression, readPath, SAFE_KEY_VALUE } from "./preset.js";
import type {
  TriageArm,
  TriageKeyRule,
  TriagePreset,
  TriageShape,
} from "./preset.js";

/** The error code a step raises when it needs run state no earlier step set. */
const PROCEDURE_CODE = "ERR_DLQ_TRIAGE_PROCEDURE";

/**
 * The fixed, non-empty sentinel `route-event` records as `values.eventType`
 * when the payload's discriminator is absent or not a string. Never a real
 * event-type value a preset author could plausibly declare. On
 * `route-event`'s **stop** path (no matched arm and no default arm) it can
 * never satisfy a preset row's `eventType` predicate: `armLabel` is never
 * set there, and every such row also carries the `armLabel` guard. That
 * does **not** extend to the continue path — when the discriminator is
 * absent but a default arm exists, the run continues with the sentinel AND
 * `armLabel` both set, so a row scoped to that arm could in principle match
 * it (see the routing step's own note on this).
 */
const EVENT_TYPE_UNROUTABLE = "(unroutable)";

type Step<
  TId extends TriageShape["stepId"],
  TJump extends TriageShape["stepId"] = never,
> = Core.M3LProcedureStep<TriageShape, TId, TJump>;

type Result<TJump extends TriageShape["stepId"] = never> =
  Core.M3LProcedureStepResult<TriageShape, TJump>;

/**
 * Reads the arm `route-event` selected, throwing rather than letting a step
 * that depends on it (`extract-key` onward) fall into an untyped `TypeError`
 * on `undefined.key`. Unreachable in normal operation: every step that calls
 * this only ever runs after a `"continue"` from `route-event`, which is the
 * one place an arm is selected — but the step graph cannot see the engine's
 * own flow-control proof of that, so the invariant is asserted here instead.
 */
function requireArm(context: Core.M3LProcedureContext<TriageShape>): TriageArm {
  const arm = context.deps.state.arm;
  if (arm === undefined) {
    throw new Core.M3LError(
      "sqs-dead-letter-triage: step requires an arm, but route-event never selected one",
      { code: PROCEDURE_CODE },
    );
  }
  return arm;
}

/**
 * `resolve-mode` — the procedure's entry gate. Every handling mode other than
 * `"runbook"` stops immediately; the codified `not-runbook-managed` case
 * resolves it.
 */
export function resolveModeStep(preset: TriagePreset): Step<"resolve-mode"> {
  return {
    id: "resolve-mode",
    label: "Resolve the queue's handling mode",
    kind: "control",
    execute: (): Result => {
      if (preset.handling === "runbook") {
        return { flow: "continue", values: { handling: preset.handling } };
      }
      return {
        flow: "stop",
        values: { handling: preset.handling },
        note: `stopped: queue handling is '${preset.handling}'`,
      };
    },
  };
}

/**
 * `parse-envelope` — parses the message body (when the preset declares it
 * JSON) and resolves the payload the rest of the run reads. The raw body is
 * recorded as this step's `output` — never in a note — solely so a case
 * row's `signature` predicate can `matches` against it via a `step`
 * reference; a DLQ body is caller data and must never appear in prose.
 */
export function parseEnvelopeStep(
  preset: TriagePreset,
): Step<"parse-envelope"> {
  return {
    id: "parse-envelope",
    label: "Parse the message envelope",
    kind: "transform",
    execute: (context): Result => {
      const body = context.deps.message.body;
      let parsed: unknown = body;
      if (preset.envelope.bodyIsJson) {
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          // Never chain the raw SyntaxError: Node embeds a content snippet
          // of the malformed body in its message.
          return {
            flow: "stop",
            output: body,
            note: "stopped: message body is not valid JSON",
          };
        }
      }
      const payloadPath = preset.envelope.payloadPath;
      if (payloadPath === undefined) {
        context.deps.state.setPayload(parsed);
        return { flow: "continue", output: body };
      }
      const payload = readPath(parsed, payloadPath);
      if (payload === undefined) {
        return {
          flow: "stop",
          output: body,
          note: `stopped: no payload at '${payloadPath}'`,
        };
      }
      context.deps.state.setPayload(payload);
      return { flow: "continue", output: body };
    },
  };
}

/**
 * `route-event` — selects the arm whose `match` equals the discriminator at
 * `preset.routeOn`, falling back to the default arm (an arm with no
 * `match`). A non-string or absent discriminator can still be caught by a
 * default arm; only when neither a value match nor a default arm exists does
 * the run stop.
 */
export function routeEventStep(preset: TriagePreset): Step<"route-event"> {
  return {
    id: "route-event",
    label: "Route the message to its event-type arm",
    kind: "decide",
    execute: (context): Result => {
      const discriminatorValue = readPath(
        context.deps.state.payload,
        preset.routeOn,
      );
      const discriminator =
        typeof discriminatorValue === "string" ? discriminatorValue : undefined;
      // Always set `values.eventType` before returning, on both the
      // success and the stop path: its presence is what the `unparseable`
      // terminal case gates on to mean "the envelope resolved and routing
      // was attempted", distinct from `unrouted`'s gate on `armLabel`. A
      // non-string/absent discriminator gets the fixed, non-empty
      // `EVENT_TYPE_UNROUTABLE` sentinel rather than `""` — `exists("")` is
      // `true` (only an absent/`undefined` value is "not present"), so an
      // empty string would already have worked, but the sentinel also makes
      // the "routing was attempted" intent explicit in a run report. On the
      // STOP path below (no matched arm and no default arm), the sentinel
      // can never satisfy a preset row's `eventType` predicate, because
      // `armLabel` is never set there and every such row also carries the
      // `armLabel` guard. That guarantee does NOT extend to the continue
      // path a few lines down: when the discriminator is absent but a
      // default arm exists, the run continues with BOTH the sentinel
      // `eventType` and `armLabel` set to the default arm's label.
      const eventType = discriminator ?? EVENT_TYPE_UNROUTABLE;
      const matchedArm =
        discriminator === undefined
          ? undefined
          : preset.arms.find((candidate) => candidate.match === discriminator);
      const arm =
        matchedArm ??
        preset.arms.find((candidate) => candidate.match === undefined);
      if (arm === undefined) {
        return {
          flow: "stop",
          values: { eventType },
          note:
            discriminator === undefined
              ? `stopped: no string discriminator at '${preset.routeOn}'`
              : // Never echo `discriminator` itself: it is read straight out
                // of the DLQ body, and a step note can end up persisted by
                // the reporting slice. Name the path instead, as the arm two
                // lines up already does.
                `stopped: no arm matches the event type at '${preset.routeOn}'`,
        };
      }
      context.deps.state.selectArm(arm);
      return {
        flow: "continue",
        values: { eventType, armLabel: arm.label },
      };
    },
  };
}

/**
 * The outcome of applying an arm's key rule's `capture` regex: either the
 * (possibly captured) key, or a stop note naming why extraction failed. No
 * `capture` rule at all is the trivial success case.
 */
type CaptureOutcome =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly note: string };

/**
 * Applies an arm's key rule's `capture` regex to `key`, bounding the subject
 * length before `exec` — defence in depth, matching how the engine itself
 * bounds a `matches` subject. The pattern was already proven safe against
 * the engine's own check at load time (`requireSafeCapturePattern`), but
 * bounding the subject too means a pathological key can never reach `exec`
 * regardless.
 */
function applyCapture(rule: TriageKeyRule, key: string): CaptureOutcome {
  if (rule.capture === undefined) return { ok: true, key };
  if (key.length > Core.M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH) {
    return {
      ok: false,
      note: `stopped: key exceeds the ${String(Core.M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH)}-character match-input limit`,
    };
  }
  const captured = new RegExp(rule.capture, "u").exec(key)?.[1];
  if (captured === undefined || captured.length === 0) {
    return { ok: false, note: `stopped: no key at '${rule.path}'` };
  }
  return { ok: true, key: captured };
}

/**
 * `extract-key` — derives the entity-lookup key from the payload: read the
 * declared path, optionally strip a prefix, optionally capture via a
 * single-group regex, optionally append a suffix, then allow-list the
 * result. The rejected key itself is never echoed in a note.
 */
export function extractKeyStep(): Step<"extract-key"> {
  return {
    id: "extract-key",
    label: "Extract the entity lookup key",
    kind: "transform",
    execute: (context): Result => {
      const arm = requireArm(context);
      const rule = arm.key;
      const rawValue = readPath(context.deps.state.payload, rule.path);
      if (typeof rawValue !== "string") {
        return { flow: "stop", note: `stopped: no key at '${rule.path}'` };
      }
      let key = rawValue;
      if (rule.stripPrefix !== undefined && key.startsWith(rule.stripPrefix)) {
        key = key.slice(rule.stripPrefix.length);
      }
      const captured = applyCapture(rule, key);
      if (!captured.ok) {
        return { flow: "stop", note: captured.note };
      }
      key = captured.key;
      if (rule.addSuffix !== undefined) {
        key = `${key}${rule.addSuffix}`;
      }
      if (!SAFE_KEY_VALUE.test(key)) {
        return {
          flow: "stop",
          note: "stopped: extracted key is not a safe lookup key",
        };
      }
      return { flow: "continue", values: { messageKey: key } };
    },
  };
}

/**
 * `widen-lookup` — selects the tier index the next `lookup-entity` gather
 * runs at. Carries NO loop: the back edge that revisits this step lives on
 * `check-entity-present` instead (see the module doc).
 */
export function widenLookupStep(): Step<"widen-lookup"> {
  return {
    id: "widen-lookup",
    label: "Select the next lookup tier",
    kind: "control",
    execute: (context): Result => {
      const arm = requireArm(context);
      const tier = context.results["widen-lookup"]?.attempt ?? 0;
      return {
        flow: "continue",
        output: tier,
        values: { lookupTier: tier },
        note: `lookup tier ${arm.lookup[tier]?.label ?? "(exhausted)"}`,
      };
    },
  };
}

/**
 * `lookup-entity` — queries the tier `widen-lookup` selected through the
 * injected `deps.lookup` seam. A tier index past the end of the arm's
 * lookup chain resolves to `undefined` rather than throwing; exhaustion is
 * `check-entity-present`'s call.
 */
export function lookupEntityStep(): Step<"lookup-entity"> {
  return {
    id: "lookup-entity",
    label: "Look up the correlated entity",
    kind: "gather",
    execute: async (context): Promise<Result> => {
      const arm = requireArm(context);
      const tierIndex = context.values.lookupTier ?? 0;
      const tier = arm.lookup[tierIndex];
      const entity =
        tier === undefined
          ? undefined
          : await context.deps.lookup.get(
              tier,
              context.values.messageKey ?? "",
              context.signal,
            );
      context.deps.state.setEntity(entity);
      return {
        flow: "continue",
        output: entity === undefined ? 0 : 1,
        values: { entityFound: entity !== undefined },
      };
    },
  };
}

/** `maxRevisits` must cover every arm's lookup chain, not just the one selected at run time. */
function maxLookupRevisits(preset: TriagePreset): number {
  const longest = Math.max(1, ...preset.arms.map((arm) => arm.lookup.length));
  return Math.max(1, longest - 1);
}

/**
 * `check-entity-present` — the loop head that owns the back edge to
 * `widen-lookup` (see the module doc for why the loop lives here and not on
 * `widen-lookup` itself). Found entity continues straight through; a
 * remaining tier revisits `widen-lookup`; exhaustion stops for the codified
 * `entity-not-found` case (or whichever verdict the arm's `onMissing`
 * substitutes).
 */
export function checkEntityPresentStep(
  preset: TriagePreset,
): Step<"check-entity-present", "widen-lookup"> {
  return {
    id: "check-entity-present",
    label: "Check whether the correlated entity was found",
    kind: "check",
    jumpsTo: ["widen-lookup"],
    loop: {
      reason: "fall back to the next lookup tier",
      maxRevisits: maxLookupRevisits(preset),
    },
    execute: (context): Result<"widen-lookup"> => {
      const arm = requireArm(context);
      if (context.values.entityFound === true) return { flow: "continue" };
      const tier = context.values.lookupTier ?? 0;
      if (tier < arm.lookup.length - 1) {
        return {
          flow: { goTo: "widen-lookup" },
          note: "not found: widening lookup tier",
        };
      }
      return {
        flow: "stop",
        note: `stopped: entity not found after ${String(arm.lookup.length)} tier(s)`,
      };
    },
  };
}

/** An array of strings, or `undefined` — the only shape `derive-state` accepts as a progression. */
function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/**
 * `derive-state` — projects `fromState` (off the entity), `nextState` (off
 * the payload), and `progression` (off the entity, when the arm declares a
 * path) into `values`, lowercased for case-insensitive case matching. A
 * missing `fromState`/`nextState` becomes `""` rather than stopping the run
 * — a case row may legitimately match on `eventType` or `signature` alone.
 */
export function deriveStateStep(): Step<"derive-state"> {
  return {
    id: "derive-state",
    label: "Derive the entity and message state",
    kind: "transform",
    execute: (context): Result => {
      const arm = requireArm(context);
      const fromRaw = readPath(context.deps.state.entity, arm.state.fromState);
      const nextRaw = readPath(context.deps.state.payload, arm.state.nextState);
      const progressionPath = arm.state.progression;
      const progressionRaw =
        progressionPath === undefined
          ? undefined
          : readPath(context.deps.state.entity, progressionPath);
      const progressionStates = asStringArray(progressionRaw);
      return {
        flow: "continue",
        values: {
          fromState: typeof fromRaw === "string" ? fromRaw.toLowerCase() : "",
          nextState: typeof nextRaw === "string" ? nextRaw.toLowerCase() : "",
          progression:
            progressionStates === undefined
              ? ""
              : normaliseProgression(progressionStates),
        },
      };
    },
  };
}

/** `match-known-cases` — resolves every declared case now; the fallback concludes on no match. */
export function matchKnownCasesStep(): Step<"match-known-cases"> {
  return {
    id: "match-known-cases",
    label: "Match the known-cases table",
    kind: "check",
    execute: (): Result => ({ flow: "resolve" }),
  };
}
