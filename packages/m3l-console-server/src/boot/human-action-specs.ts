/**
 * `boot/human-action-specs` — the table of which routes are audited, what
 * kind each records, and how each projects a live request into a record.
 *
 * **Why this is its own file.** `boot/human-action-audit.ts` owns the
 * DECORATION mechanism — phase ordering, compensation, the exhaustiveness
 * guard — and this file owns the DATA that mechanism reads. They change for
 * different reasons: wiring a new audited route touches only this table,
 * while changing how an entry is written touches only that module. Splitting
 * them also keeps both sides clear of `check:file-budget`'s 25,000-char
 * ceiling, which the combined file was approaching (ADR-0072).
 *
 * Zone note: this lives in `boot/` for the same reason its sibling does —
 * `eslint.config.js`'s ADR-0009 zone table forbids `http/` from importing
 * `audit/`, and `boot/` is the only zone-free home that may legally see both
 * vocabularies. See `boot/human-action-audit.ts`'s own header.
 *
 * @packageDocumentation
 */

import { humanActionPostureFor } from "../audit/record.js";
import type {
  M3LHumanActionKind,
  M3LHumanActionRecordInput,
  M3LHumanActionTarget,
} from "../audit/record.js";
import type { M3LRequestContext } from "../http/context.js";

/**
 * What a route's spec projects out of a live request: everything
 * `humanActionRecordFrom` needs except the fields every route shares
 * (`atMs`, `operator`, `correlationId`, `action`, `outcome`).
 *
 * Deliberately NOT exported: only {@link HumanActionSpec.project}'s return
 * type names it, and knip flags an exported type with no consumer outside
 * its own module. A caller writing a spec never has to name it — the table's
 * entries infer it from `project`'s own signature.
 */
interface HumanActionProjection {
  readonly target: M3LHumanActionTarget;
  readonly parameters?: Readonly<Record<string, unknown>> | undefined;
  readonly parameterRefs?: readonly string[] | undefined;
  readonly posture: M3LHumanActionRecordInput["posture"];
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** One route's audit contract. */
export interface HumanActionSpec {
  /** The kind recorded for this route. */
  readonly action: M3LHumanActionKind;
  /**
   * Whether the entry is written BEFORE the handler runs or after it
   * resolves.
   *
   * `"before"` for every write. A store mutation cannot be undone by a later
   * failed append, so recording first is the only ordering that satisfies
   * ADR-0070's "an unauditable action is refused" — and the shipped port
   * TSDoc already rules that both of its error codes mean "the action was
   * never attempted".
   *
   * `"after"` only where recording first would make the trail LIE — see
   * `view.run.stream`, whose handler does its own 404 check internally.
   */
  readonly phase: "before" | "after";
  /** Projects the record's route-specific fields out of the live request. */
  readonly project: (ctx: M3LRequestContext) => HumanActionProjection;
}

/**
 * Reads the request body's `parameters` map, but only when both the body and
 * that field are plain objects.
 *
 * Defensive on purpose: a malformed body must yield the handler's own
 * `ERR_CONSOLE_BAD_REQUEST`, not an `ERR_CONSOLE_AUDIT_RECORD_INVALID` that
 * misdescribes whose fault it is. Only the KEYS of whatever this returns
 * ever reach the record.
 */
function parametersOf(
  ctx: M3LRequestContext,
): Readonly<Record<string, unknown>> | undefined {
  const body: unknown = ctx.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const parameters: unknown = (body as Record<string, unknown>)["parameters"];
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    return undefined;
  }
  return parameters as Readonly<Record<string, unknown>>;
}

/** Reads a plain-object body field, or `undefined` when the body is malformed. */
function bodyField(ctx: M3LRequestContext, key: string): unknown {
  const body: unknown = ctx.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  return (body as Record<string, unknown>)[key];
}

/** The posture a run/step request stands behind, read defensively off the body. */
function postureOf(ctx: M3LRequestContext): HumanActionProjection["posture"] {
  return humanActionPostureFor({
    dryRun: bodyField(ctx, "dryRun") === true,
    confirmed: bodyField(ctx, "confirmed") === true,
  });
}

/** A route param, or `""` when absent — never `undefined` into a record. */
function param(ctx: M3LRequestContext, key: string): string {
  return ctx.params[key] ?? "";
}

/**
 * Collects the `reference` string off each entry of a body array field —
 * `POST …/steps`' bindings, whose references are the only parameter values
 * ADR-0070 records, and by reference only.
 *
 * A step reference (`step-<n>.output…`) does not trip the port's inline-ref
 * refusal: `isInlineArtifactRefText` only fires for text that `JSON.parse`s
 * to `{ kind: "inline" }`.
 */
function bindingRefs(ctx: M3LRequestContext): readonly string[] {
  const bindings: unknown = bodyField(ctx, "bindings");
  if (!Array.isArray(bindings)) return [];
  const refs: string[] = [];
  for (const entry of bindings) {
    if (entry === null || typeof entry !== "object") continue;
    const reference: unknown = (entry as Record<string, unknown>)["reference"];
    if (typeof reference === "string") refs.push(reference);
  }
  return refs;
}

/**
 * The binding parameter NAMES a step request declares, shaped as a map so
 * `humanActionRecordFrom` reads its keys through the one code path that is
 * documented to read only `Object.keys`.
 */
function bindingParameterNames(
  ctx: M3LRequestContext,
): Readonly<Record<string, unknown>> {
  const bindings: unknown = bodyField(ctx, "bindings");
  if (!Array.isArray(bindings)) return {};
  const names: Record<string, unknown> = {};
  for (const entry of bindings) {
    if (entry === null || typeof entry !== "object") continue;
    const name: unknown = (entry as Record<string, unknown>)["parameterName"];
    if (typeof name === "string") names[name] = true;
  }
  return names;
}

/**
 * `{ lastEventId }` when the client is RESUMING an SSE stream, else empty.
 *
 * A resume is a genuinely different exposure event from a first open — it
 * replays history the operator may not have seen — so it is recorded as its
 * own entry, distinguishable by this field. Header name and parse rule
 * mirror `http/routes/run-stream.ts`'s own `parseLastEventId`: a
 * non-integer or negative value is treated as absent rather than recorded
 * as caller-controlled text.
 */
function resumeDetail(
  ctx: M3LRequestContext,
): Readonly<Record<string, string | number | boolean>> {
  const raw = ctx.headers["last-event-id"];
  if (raw === undefined) return {};
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? { lastEventId: parsed } : {};
}

/**
 * Every audited route, keyed `"<METHOD> <path-template>"`.
 *
 * `run.launch` targets the SCRIPT, not the run — `M3LHumanActionTarget`'s
 * `script` arm is the only one carrying a name, and a launch is the one
 * action an operator recognises by name. That is also why `phase: "before"`
 * works here with no run id in scope yet.
 *
 * `session.create` has no session id pre-flight, so its target id is the
 * correlation id — the honest AND joinable value, since `routes/sessions.ts`
 * passes that same id into `createSession`, where it lands in
 * `console_sessions.correlation_id`.
 *
 * A raised decision carries its id in `detail`, not in `target`: there is no
 * `decision` target kind, and inventing one would force a second `CHECK`
 * recreate on `target_kind` for no query anyone runs.
 */
export const HUMAN_ACTION_SPECS: ReadonlyMap<string, HumanActionSpec> = new Map<
  string,
  HumanActionSpec
>([
  [
    "POST /api/v1/runs",
    {
      action: "run.launch",
      phase: "before",
      project: (ctx) => {
        const scriptName = bodyField(ctx, "scriptName");
        const name = typeof scriptName === "string" ? scriptName : "";
        return {
          target: { kind: "script", id: name, scriptName: name },
          parameters: parametersOf(ctx),
          posture: postureOf(ctx),
        };
      },
    },
  ],
  [
    "POST /api/v1/sessions",
    {
      action: "session.create",
      phase: "before",
      project: (ctx) => ({
        target: { kind: "session", id: ctx.correlationId },
        posture: "confirmed",
      }),
    },
  ],
  [
    "POST /api/v1/sessions/:id/steps",
    {
      action: "session.step.add",
      phase: "before",
      project: (ctx) => ({
        target: { kind: "session", id: param(ctx, "id") },
        parameters: bindingParameterNames(ctx),
        parameterRefs: bindingRefs(ctx),
        posture: postureOf(ctx),
      }),
    },
  ],
  [
    "POST /api/v1/sessions/:id/steps/:stepId/decision",
    {
      action: "session.decision.raise",
      phase: "before",
      project: (ctx) => ({
        target: { kind: "step", id: param(ctx, "stepId") },
        posture: "confirmed",
      }),
    },
  ],
  [
    "POST /api/v1/sessions/:id/decisions/:decisionId",
    {
      action: "session.decision.answer",
      phase: "before",
      project: (ctx) => ({
        target: { kind: "session", id: param(ctx, "id") },
        posture: "confirmed",
        detail: { decisionId: param(ctx, "decisionId") },
      }),
    },
  ],
  [
    "POST /api/v1/sessions/:id/close",
    {
      action: "session.close",
      phase: "before",
      project: (ctx) => ({
        target: { kind: "session", id: param(ctx, "id") },
        posture: "confirmed",
      }),
    },
  ],
  [
    "POST /api/v1/sessions/:id/reopen",
    {
      action: "session.reopen",
      phase: "before",
      project: (ctx) => ({
        target: { kind: "session", id: param(ctx, "id") },
        posture: "confirmed",
      }),
    },
  ],
  [
    // X7d's step-artifact view. `phase: "after"` for the same reason as the
    // two views below it: `readStepArtifact` does its own not-found checks
    // (unknown session, unknown step, a step owned by another session, a
    // step with no output yet), so recording first would assert the operator
    // saw an artifact that was never served.
    //
    // Targets the STEP, not the session: `M3LHumanActionTarget`'s `artifact`
    // arm carries an opaque id and the console has none to give — a step's
    // output has no identity of its own, only the step's. The session id
    // goes in `detail`, which is where a non-target scope belongs (the same
    // choice `session.decision.answer` makes for its decision id).
    //
    // NO `parameterRefs`, deliberately. ADR-0070's display-vs-persist rule
    // says the entry carries the reference and never the payload — and here
    // the `(sessionId, stepId)` pair above IS the reference: it is the whole
    // of what the request addressed. The step's own encoded `resultRef` is
    // read inside the service and never reaches this projection, so the only
    // string that could go in `parameterRefs` would be one invented here,
    // duplicating `target.id` under a grammar nothing else uses. An audit
    // field that restates another field in a made-up format is worse than an
    // absent one: it reads like a real artifact reference and is not.
    "GET /api/v1/sessions/:id/steps/:stepId/artifact",
    {
      action: "view.session.artifact",
      phase: "after",
      project: (ctx) => ({
        target: { kind: "step", id: param(ctx, "stepId") },
        posture: "confirmed",
        detail: { sessionId: param(ctx, "id") },
      }),
    },
  ],
  [
    // X7d's run-report view. `phase: "after"` for the SAME reason
    // `view.run.stream` below carries it: the handler does its own 404
    // checks internally (unknown run id, and a known run with nothing
    // written yet), so recording first would assert the operator saw a
    // report that was never served. Recording after the handler resolves is
    // honest and still refuses — the response body has not been written when
    // a rejected append throws.
    //
    // Records the run id and nothing else. ADR-0070's display-vs-persist
    // split means the entry carries the REFERENCE to what was rendered,
    // never the rendering: a run report can contain a script's own
    // diagnostic output, and copying it into the audit trail would turn an
    // access log into a second, unbounded, unredacted copy of the data.
    "GET /api/v1/runs/:id/report",
    {
      action: "view.run.report",
      phase: "after",
      project: (ctx) => ({
        target: { kind: "run", id: param(ctx, "id") },
        posture: "confirmed",
      }),
    },
  ],
  [
    // `/health`, `/ready` and every list/collection endpoint are out of
    // scope by decision — `view.*` covers sensitive-class renderings only.
    //
    // ONE entry per subscription, not per event. Per-event would write
    // thousands of lines per watcher into a trail with no pruning path
    // shipped, and ADR-0070 describes the rendering as an audited view
    // action per rendering ACT — i.e. per subscription. Reconnects stay
    // visible regardless, since a resume is a new request with a new
    // correlation id.
    //
    // `phase: "after"` is REQUIRED here, not a preference.
    // `buildStreamHandler` does its 404 check INSIDE the handler, so
    // recording first would write `"served"` for a run that was never
    // served — the trail would lie. Recording after the handler resolves is
    // honest and still refuses: `open(sink)` has not run yet, so no SSE byte
    // has reached the operator when a rejected append throws. Note that
    // `buildActiveStreamResponse`'s `hub.get(id) ?? hub.open(id)` is a side
    // effect that renders nothing, so it does not violate
    // display-vs-persist.
    "GET /api/v1/runs/:id/stream",
    {
      action: "view.run.stream",
      phase: "after",
      project: (ctx) => ({
        target: { kind: "run", id: param(ctx, "id") },
        posture: "confirmed",
        detail: resumeDetail(ctx),
      }),
    },
  ],
]);
