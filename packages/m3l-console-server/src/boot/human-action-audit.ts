/**
 * `boot/human-action-audit` — records a human-action audit entry for every
 * write route, and for the sensitive views X7b wires, by decorating each
 * route's own terminal handler (ADR-0070).
 *
 * **Why `boot/`, and not `http/`.** `eslint.config.js`'s ADR-0009 zone table
 * — asserted at exact `except` length by `bin/check-eslint-zones.mjs` —
 * forbids `http/`, `runs/`, `sessions/` and `store/` from importing
 * `audit/`. `src/boot/` is zone-free, which is why `boot/dispatch-router.ts`
 * legally imports both `http/router.js` and `store/store.js`. Putting the
 * gate here lets it import the REAL `audit/` types with zero duplication and
 * leaves `check:zones` passing unchanged. Moving it into `http/` would fail
 * that gate until the `["http", …]` row grew `"audit"` — treat that as a
 * design decision, not a mechanical fix.
 *
 * **Why an innermost handler decorator, and not router middleware.**
 * `http/handler.ts` attaches the request body INSIDE the terminal handler,
 * so a middleware cannot read `ctx.body` — the one field ADR-0070 most
 * insists on — and cannot see the matched path TEMPLATE either. A decorator
 * sits at the terminal position, so it sees `ctx.body`, `ctx.params`,
 * `ctx.operator`, `ctx.correlationId` and the route's own `path`. It also
 * means `http/routes/{runs,sessions}.ts` are not touched at all, and their
 * tests need no edits.
 *
 * **The tradeoff, stated plainly.** Reading `routes/sessions.ts` no longer
 * tells you a route is audited. The mitigation is load-bearing rather than
 * cosmetic: {@link applyHumanActionAudit} throws for any non-`GET` route with
 * no spec entry, so adding an unaudited write route fails at BOOT (and in
 * `tests/main-audit.test.ts`), not silently in production.
 *
 * @packageDocumentation
 */

import {
  humanActionPostureFor,
  humanActionRecordFrom,
} from "../audit/record.js";
import type {
  M3LHumanActionKind,
  M3LHumanActionOperator,
  M3LHumanActionOutcome,
  M3LHumanActionRecordInput,
  M3LHumanActionTarget,
} from "../audit/record.js";
import type { M3LHumanActionAuditPort } from "../audit/port.js";
import { createHumanActionAuditStream } from "../audit/stream.js";
import { resolveAuditStreamRoot } from "../config/paths.js";
import { M3LConsoleError } from "../errors/console-error.js";
import { chainSecondaryFailure } from "../errors/chain-secondary-failure.js";
import type { M3LRequestContext } from "../http/context.js";
import type { M3LConsoleHandler } from "../http/middleware.js";
import type { M3LRoute } from "../http/router.js";

/**
 * What a route's spec projects out of a live request: everything
 * {@link humanActionRecordFrom} needs except the fields every route shares
 * (`atMs`, `operator`, `correlationId`, `action`, `outcome`).
 */
interface HumanActionProjection {
  readonly target: M3LHumanActionTarget;
  readonly parameters?: Readonly<Record<string, unknown>> | undefined;
  readonly parameterRefs?: readonly string[] | undefined;
  readonly posture: M3LHumanActionRecordInput["posture"];
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** One route's audit contract. */
interface HumanActionSpec {
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
 * `M3LHumanActionOutcome` is the console's ADMISSION verdict, not the
 * domain's terminal result — `runs/audit.ts` and `runs/admission.ts` set
 * allowed/denied/rejected before anything runs. So a `phase: "before"`
 * record is always `"allowed"`: the console admitted the request.
 */
const ADMITTED: M3LHumanActionOutcome = "allowed";

/**
 * Maps a thrown domain error onto the outcome a COMPENSATING record carries.
 *
 * Deliberately narrow: only the two refusals ADR-0070 names as drivers get
 * their own verdict; anything else is `"failed"` rather than guessed at.
 */
function compensatingOutcome(cause: unknown): M3LHumanActionOutcome {
  if (!(cause instanceof M3LConsoleError)) return "failed";
  if (cause.code === "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED") return "denied";
  if (cause.code === "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED") return "rejected";
  return "failed";
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
const HUMAN_ACTION_SPECS: ReadonlyMap<string, HumanActionSpec> = new Map<
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
]);

/** The operator a record is attributed to; unauthenticated cannot reach an audited route. */
function operatorOf(ctx: M3LRequestContext): M3LHumanActionOperator {
  const operator = ctx.operator;
  if (operator === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `audited route '${ctx.method} ${ctx.path}' was reached with no resolved operator`,
    );
  }
  return { name: operator.name, email: operator.email };
}

/** Builds and writes one entry, letting the port's own rejection propagate. */
async function record(
  port: M3LHumanActionAuditPort,
  ctx: M3LRequestContext,
  spec: HumanActionSpec,
  outcome: M3LHumanActionOutcome,
  nowMs: () => number,
): Promise<void> {
  const projection = spec.project(ctx);
  await port.record(
    humanActionRecordFrom({
      atMs: nowMs(),
      operator: operatorOf(ctx),
      correlationId: ctx.correlationId,
      action: spec.action,
      target: projection.target,
      parameters: projection.parameters,
      parameterRefs: projection.parameterRefs,
      posture: projection.posture,
      outcome,
      detail: projection.detail,
    }),
  );
}

/**
 * Writes a best-effort compensating entry after the handler threw.
 *
 * Never replaces the domain error: if the compensating write itself fails,
 * that failure is chained onto the domain error and the DOMAIN error is
 * rethrown. A failure to record a failure must not become the error the
 * operator sees instead of the real one.
 */
async function compensate(
  port: M3LHumanActionAuditPort,
  ctx: M3LRequestContext,
  spec: HumanActionSpec,
  cause: unknown,
  nowMs: () => number,
): Promise<never> {
  try {
    await record(port, ctx, spec, compensatingOutcome(cause), nowMs);
  } catch (secondary) {
    chainSecondaryFailure(cause, secondary);
  }
  throw cause;
}

/**
 * Wraps one route's handler so the action it performs is audited.
 *
 * On the `"before"` path the entry is awaited BEFORE the handler runs, so a
 * rejected append refuses the action outright — the port's own
 * `ERR_CONSOLE_AUDIT_WRITE_FAILED` (503, retryable) or
 * `ERR_CONSOLE_AUDIT_RECORD_INVALID` (400, caller) propagates unchanged, and
 * `http/envelope.ts` already maps both, so no new status code is needed.
 *
 * A `"before"` entry is written even when the handler then 400s or 404s.
 * That is deliberate: ADR-0070 makes auditing REFUSALS a stated driver, and
 * the flood vector is bounded — every audited route is `auth: "required"`
 * against one declared operator on a loopback-only bind. A validate-first
 * shortcut is explicitly NOT added, because it would manufacture
 * unaudited requests.
 */
function decorate(
  route: M3LRoute,
  spec: HumanActionSpec,
  port: M3LHumanActionAuditPort,
  nowMs: () => number,
): M3LRoute {
  const handler: M3LConsoleHandler = async (ctx) => {
    if (spec.phase === "after") {
      const result = await route.handler(ctx);
      await record(port, ctx, spec, "served", nowMs);
      return result;
    }
    await record(port, ctx, spec, ADMITTED, nowMs);
    try {
      return await route.handler(ctx);
    } catch (cause) {
      return await compensate(port, ctx, spec, cause, nowMs);
    }
  };
  return { ...route, handler };
}

/**
 * Decorates every audited route in `routes` and returns the new table.
 *
 * @param routes - The console's OWN route table. A caller's `options.routes`
 *   extensions are deliberately NOT passed here: this module's spec table is
 *   keyed by the console's own path templates, so it can never hold a spec
 *   for a route a caller invented, and enforcing the guard against those
 *   would make that documented seam unusable. The consequence is worth
 *   stating: a write route added through `options.routes` is not audited.
 *   Every write route the console itself serves is.
 * @param port - The audit trail every entry is written to.
 * @param nowMs - Clock for `atMs`; defaults to `Date.now`.
 * @returns The same routes, with audited ones' handlers wrapped.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_INTERNAL` when a non-`GET`
 *   route has no spec entry. This is the exhaustiveness guard that pays for
 *   moving the audit decision out of the route modules: a new write route
 *   fails at boot rather than shipping unaudited.
 * @example
 * ```ts
 * const audited = applyHumanActionAudit(routes, auditPort);
 * ```
 */
export function applyHumanActionAudit(
  routes: readonly M3LRoute[],
  port: M3LHumanActionAuditPort,
  nowMs: () => number = Date.now,
): readonly M3LRoute[] {
  return routes.map((route) => {
    const spec = HUMAN_ACTION_SPECS.get(`${route.method} ${route.path}`);
    if (spec === undefined) {
      if (route.method !== "GET") {
        throw new M3LConsoleError(
          "ERR_CONSOLE_INTERNAL",
          `route '${route.method} ${route.path}' performs a write but has no human-action audit spec; ` +
            `add one in boot/human-action-audit.ts rather than shipping an unaudited write route`,
        );
      }
      return route;
    }
    return decorate(route, spec, port, nowMs);
  });
}

/**
 * The env var naming the human-action audit root; see `config/paths.ts`'s
 * `resolveAuditStreamRoot`. Mirrors `subsystems.ts`'s own
 * `SESSIONS_ARTIFACT_ROOT_ENV` convention.
 */
const AUDIT_ROOT_ENV = "M3L_CONSOLE_AUDIT_ROOT";

/**
 * Builds the audit port the console writes its human-action trail through.
 *
 * Resolved at composition time from the environment, exactly as
 * `subsystems.ts` resolves the sibling session-artifact root — deliberately
 * NOT added to `M3LConsoleConfig`, where the artifact root does not live
 * either.
 *
 * **"Audit unconfigured" is not a reachable state.** `resolveAuditStreamRoot`
 * always yields a path, and its data-dir resolution is already on the boot
 * path via `loadConsoleConfig`, so this introduces no new boot-failure mode.
 * Auditing is unconditionally on: a console that cannot resolve its audit
 * trail must not boot.
 *
 * **Scope: the JSONL stream only, not the SQLite index.** The index has no
 * reader endpoint yet and its rebuild path is truncate-and-reinsert, so
 * dual-write ordering is its own reviewable unit. Because this module is
 * zone-free, a composite port can be added here later with no zone change.
 *
 * @param env - The environment to read `M3L_CONSOLE_AUDIT_ROOT` from.
 * @returns The port every audited route writes through.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_CONFIG_INVALID` when the
 *   configured root is unusable. The underlying failure is a bare
 *   `Core.M3LError` from the stream constructor; it is wrapped because
 *   `createConsoleRuntime`'s own `@throws` promises an `M3LConsoleError`.
 * @example
 * ```ts
 * const port = buildHumanActionAuditPort(process.env);
 * ```
 */
export function buildHumanActionAuditPort(
  env: NodeJS.ProcessEnv,
): M3LHumanActionAuditPort {
  try {
    return createHumanActionAuditStream({
      directory: resolveAuditStreamRoot({
        configuredPath: env[AUDIT_ROOT_ENV],
      }),
    });
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    throw new M3LConsoleError(
      "ERR_CONSOLE_CONFIG_INVALID",
      "the human-action audit root could not be resolved",
      { cause },
    );
  }
}
