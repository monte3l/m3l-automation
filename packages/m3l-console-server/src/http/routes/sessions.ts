/**
 * `http/routes/sessions` — the X6 workbench-sessions module's REST surface
 * (slice 4 Part B round 2, issue #554): creating and closing sessions,
 * listing and reading them, appending steps, and raising/answering
 * decisions.
 *
 * `http/` may never import `sessions/` or `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this
 * module declares its own narrow local ports ({@link SessionRouteReaderPort},
 * {@link SessionRouteWriterPort}) mirroring `sessions/service.ts`'s
 * `M3LSessionService` field for field — the same declared-not-imported trick
 * `http/routes/runs.ts` uses for its own `M3LRunLauncherPort`/
 * `M3LRunReaderPort`. `main.ts` passing the real service is the
 * compiler-checked proof it structurally conforms (a later round, not
 * touched here).
 *
 * The `POST .../steps` body's validation rules are likewise declared here
 * rather than imported, for the same zone reason. `?status=` validation is a
 * second duplication for the same reason: `http/` cannot import
 * `store/sessions-repository-types.ts`'s `M3LSessionStatus` directly, so this
 * module instead declares and exports its own {@link SESSION_STATUS_VALUES}
 * `as const` vocabulary — the same shape as this file's own
 * {@link EXPECTED_TYPE_VALUES}/`M3LSessionBindingExpectedType` pair — with
 * {@link M3LSessionStatusValue} derived from it rather than hand-typed
 * separately. The array is pinned exactly by `tests/routes-sessions.test.ts`,
 * which can additionally assert it type-level-matches `M3LSessionStatus`
 * now that both sides are closed literal unions.
 *
 * `answerDecision(id, answer)` takes only the decision id — verified against
 * the real `sessions/service.ts`, which does not take a session id for this
 * call, so `POST /api/v1/sessions/:id/decisions/:decisionId`'s `:id` route
 * param is unused by that one handler. `raiseDecision` is synchronous on the
 * real service; `addStep` is the one write method this module awaits.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

/** The status every creating/appending route in this module returns on success. */
const STATUS_CREATED = 201;
/** The status every other route in this module returns on success. */
const STATUS_OK = 200;
/** The page size `GET /api/v1/sessions` uses when `?limit=` is omitted. */
const DEFAULT_LIST_LIMIT = 50;
/** The longest caller-supplied `?status=` value ever echoed into an error message. */
const MAX_ECHOED_STATUS_LENGTH = 32;

/**
 * The accepted `?status=` vocabulary. Exported so `tests/routes-sessions.test.ts`
 * can pin the exact literal list.
 *
 * @example
 * ```ts
 * import { SESSION_STATUS_VALUES } from "@m3l-automation/m3l-console-server/http/routes/sessions.js";
 *
 * SESSION_STATUS_VALUES.includes("open"); // true
 * ```
 */
export const SESSION_STATUS_VALUES = ["open", "closed"] as const;

/** The set backing {@link isSessionStatus}'s O(1) membership check. */
const SESSION_STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUS_VALUES);

/** One member of {@link SESSION_STATUS_VALUES}, narrowed for {@link M3LSessionListQuery}. */
type M3LSessionStatusValue = (typeof SESSION_STATUS_VALUES)[number];

/** `true` when `value` is a member of {@link SESSION_STATUS_VALUES}. */
function isSessionStatus(value: string): value is M3LSessionStatusValue {
  return SESSION_STATUS_SET.has(value);
}

/** The closed vocabulary a step binding's `expectedType` field must be one of. */
const EXPECTED_TYPE_VALUES = ["string", "number", "boolean", "object"] as const;

/** The set backing {@link isExpectedType}'s O(1) membership check. */
const EXPECTED_TYPE_SET: ReadonlySet<string> = new Set(EXPECTED_TYPE_VALUES);

/** One member of {@link EXPECTED_TYPE_VALUES}. */
type M3LSessionBindingExpectedType = (typeof EXPECTED_TYPE_VALUES)[number];

/** `true` when `value` is a member of {@link EXPECTED_TYPE_VALUES}. */
function isExpectedType(value: string): value is M3LSessionBindingExpectedType {
  return EXPECTED_TYPE_SET.has(value);
}

/** One validated step-binding entry — mirrors `sessions/service.ts`'s binding input shape. */
interface M3LSessionStepBindingInput {
  readonly reference: string;
  readonly expectedType: M3LSessionBindingExpectedType;
  readonly multiSelect: boolean;
  readonly parameterName: string;
}

/** One validated `POST .../steps` body, before merging `operator`/`correlationId`. */
interface M3LSessionAddStepRequestBody {
  readonly operation: string;
  readonly bindings: readonly M3LSessionStepBindingInput[];
  readonly confirmed: boolean;
  readonly dryRun: boolean;
}

/** One `addStep` input — mirrors `sessions/service.ts`'s `M3LSessionAddStepInput`. */
interface M3LSessionAddStepInput extends M3LSessionAddStepRequestBody {
  readonly operator: string;
  readonly correlationId: string;
}

/** One validated `POST .../decision` body. */
interface M3LSessionRaiseDecisionBody {
  readonly prompt: string;
  readonly options: unknown;
}

/** One list query — mirrors `sessions/service.ts`'s session list query shape. */
interface M3LSessionListQuery {
  readonly status?: M3LSessionStatusValue;
  readonly operator?: string;
  readonly limit: number;
}

/**
 * The local reader port this module depends on — mirrors
 * `sessions/service.ts`'s `M3LSessionService.getSession`/`.listSessions`
 * field for field, so the real service satisfies it structurally without an
 * `http -> sessions` import.
 *
 * @example
 * ```ts
 * const reader: SessionRouteReaderPort = {
 *   getSession: () => undefined,
 *   listSessions: () => [],
 * };
 * ```
 */
export interface SessionRouteReaderPort {
  /** Reads one session row by id, or `undefined` when no such row exists. */
  getSession(id: string): unknown;
  /** Lists session rows matching `query`. */
  listSessions(query: M3LSessionListQuery): readonly unknown[];
}

/**
 * The open-session shape {@link SessionRouteWriterPort.createSession} returns
 * on success — mirrors `store/sessions-repository-types.ts`'s
 * `M3LSessionRecord`'s `'open'` variant field for field (`http/` may not
 * import `store/`; see this module's own TSDoc for why this is declared
 * locally rather than imported).
 *
 * @example
 * ```ts
 * const record: M3LSessionRouteRecord = {
 *   id: "session-1",
 *   operator: "alice",
 *   correlationId: "corr-1",
 *   status: "open",
 *   createdAtMs: Date.now(),
 *   updatedAtMs: Date.now(),
 * };
 * ```
 */
export interface M3LSessionRouteRecord {
  /** The session's id, unique within the store. */
  readonly id: string;
  /** The operator this session belongs to. */
  readonly operator: string;
  /** The correlation id this session's diagnostics are tagged with. */
  readonly correlationId: string;
  /** Always `"open"` — the shape `createSession` returns on success. */
  readonly status: "open";
  /** Epoch-millisecond timestamp this session was created at. */
  readonly createdAtMs: number;
  /** Epoch-millisecond timestamp this session was last updated at. */
  readonly updatedAtMs: number;
}

/**
 * The local writer port this module depends on — mirrors
 * `sessions/service.ts`'s `M3LSessionService` write methods field for field.
 *
 * @example
 * ```ts
 * const writer: SessionRouteWriterPort = {
 *   createSession: () => ({
 *     id: "session-1",
 *     operator: "alice",
 *     correlationId: "corr-1",
 *     status: "open",
 *     createdAtMs: Date.now(),
 *     updatedAtMs: Date.now(),
 *   }),
 *   closeSession: () => true,
 *   addStep: async () => ({ step: { id: "step-1" } }),
 *   raiseDecision: () => ({ id: "decision-1" }),
 *   answerDecision: () => true,
 * };
 * ```
 */
export interface SessionRouteWriterPort {
  /** Creates a new open session for `operator`, tagged with `correlationId`. */
  createSession(operator: string, correlationId: string): M3LSessionRouteRecord;
  /** Closes the session with `id`; `true` when a transition applied. */
  closeSession(id: string): boolean;
  /** Appends a validated step to session `sessionId`. */
  addStep(sessionId: string, input: M3LSessionAddStepInput): Promise<unknown>;
  /** Raises a decision on step `stepId` within session `sessionId`. */
  raiseDecision(
    sessionId: string,
    stepId: string,
    prompt: string,
    options?: unknown,
  ): unknown;
  /** Answers the decision with `id`; `true` when a transition applied. */
  answerDecision(id: string, answer: unknown): boolean;
}

/**
 * Constructor options for {@link createSessionRoutes}.
 *
 * @example
 * ```ts
 * const options: SessionRouteOptions = {
 *   reader: { getSession: () => undefined, listSessions: () => [] },
 *   writer: {
 *     createSession: () => ({
 *       id: "session-1",
 *       operator: "alice",
 *       correlationId: "corr-1",
 *       status: "open",
 *       createdAtMs: Date.now(),
 *       updatedAtMs: Date.now(),
 *     }),
 *     closeSession: () => true,
 *     addStep: async () => ({ step: { id: "step-1" } }),
 *     raiseDecision: () => ({ id: "decision-1" }),
 *     answerDecision: () => true,
 *   },
 * };
 * ```
 */
export interface SessionRouteOptions {
  /** The session-reading port; `main.ts` passes the real `M3LSessionService`. */
  readonly reader: SessionRouteReaderPort;
  /** The session-writing port; `main.ts` passes the real `M3LSessionService`. */
  readonly writer: SessionRouteWriterPort;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` naming `field` and the reason it failed. */
function rejectBody(field: string, reason: string): never {
  throw new M3LConsoleError(
    "ERR_CONSOLE_BAD_REQUEST",
    `invalid session request: '${field}' ${reason}`,
    { context: { field } },
  );
}

/** Reads `ctx.operator.name`, throwing `ERR_CONSOLE_UNAUTHENTICATED` when no operator resolved. */
function requireOperatorName(ctx: M3LRequestContext): string {
  if (ctx.operator === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_UNAUTHENTICATED",
      "no operator resolved for this request",
    );
  }
  return ctx.operator.name;
}

/** Reads `ctx.params[name]`, throwing `ERR_CONSOLE_BAD_REQUEST` when absent. */
function requireParam(ctx: M3LRequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `missing ':${name}' route parameter`,
    );
  }
  return value;
}

/**
 * Validates and returns a required, non-empty string field.
 *
 * @param body - The object to read `field` from.
 * @param field - The actual object key to look up.
 * @param label - The field name reported in a rejection message; defaults
 *   to `field` (differs from it for a nested binding entry, e.g.
 *   `bindings[0].reference`).
 */
function readRequiredNonEmptyString(
  body: Record<string, unknown>,
  field: string,
  label: string = field,
): string {
  if (!Object.hasOwn(body, field)) {
    rejectBody(label, "is required");
  }
  const value = body[field];
  if (!Core.isString(value)) {
    rejectBody(label, "must be a string");
  }
  if (value.length === 0) {
    rejectBody(label, "must not be empty");
  }
  return value;
}

/**
 * Validates and returns a required boolean field.
 *
 * @param body - The object to read `field` from.
 * @param field - The actual object key to look up.
 * @param label - The field name reported in a rejection message; defaults
 *   to `field` (differs from it for a nested binding entry).
 */
function readRequiredBoolean(
  body: Record<string, unknown>,
  field: string,
  label: string = field,
): boolean {
  if (!Object.hasOwn(body, field)) {
    rejectBody(label, "is required");
  }
  const value = body[field];
  if (!Core.isBoolean(value)) {
    rejectBody(label, "must be a boolean");
  }
  return value;
}

/** Validates and returns one step-binding entry at `index`. */
function readBindingEntry(
  raw: unknown,
  index: number,
): M3LSessionStepBindingInput {
  const label = `bindings[${index}]`;
  if (!Core.isPlainObject(raw)) {
    rejectBody(label, "must be a plain object");
  }
  const reference = readRequiredNonEmptyString(
    raw,
    "reference",
    `${label}.reference`,
  );
  const rawExpectedType = readRequiredNonEmptyString(
    raw,
    "expectedType",
    `${label}.expectedType`,
  );
  if (!isExpectedType(rawExpectedType)) {
    rejectBody(`${label}.expectedType`, "must be a recognised binding type");
  }
  const multiSelect = readRequiredBoolean(
    raw,
    "multiSelect",
    `${label}.multiSelect`,
  );
  const parameterName = readRequiredNonEmptyString(
    raw,
    "parameterName",
    `${label}.parameterName`,
  );
  return {
    reference,
    expectedType: rawExpectedType,
    multiSelect,
    parameterName,
  };
}

/** Validates and returns the required `bindings` array field. */
function readBindings(
  body: Record<string, unknown>,
): readonly M3LSessionStepBindingInput[] {
  if (!Object.hasOwn(body, "bindings")) {
    rejectBody("bindings", "is required");
  }
  const bindings = body["bindings"];
  if (!Array.isArray(bindings)) {
    rejectBody("bindings", "must be an array");
  }
  return bindings.map((entry: unknown, index: number) =>
    readBindingEntry(entry, index),
  );
}

/**
 * Validates an untrusted `rawBody` into a closed {@link M3LSessionAddStepRequestBody}.
 * Duplicates `sessions/service.ts`'s own `addStep` input rules — see this
 * module's own TSDoc for why it cannot simply import them.
 */
function parseAddStepBody(rawBody: unknown): M3LSessionAddStepRequestBody {
  if (!Core.isPlainObject(rawBody)) {
    rejectBody("body", "must be a JSON object");
  }
  return {
    operation: readRequiredNonEmptyString(rawBody, "operation"),
    bindings: readBindings(rawBody),
    confirmed: readRequiredBoolean(rawBody, "confirmed"),
    dryRun: readRequiredBoolean(rawBody, "dryRun"),
  };
}

/** Validates an untrusted `rawBody` into a closed {@link M3LSessionRaiseDecisionBody}. */
function parseRaiseDecisionBody(rawBody: unknown): M3LSessionRaiseDecisionBody {
  if (!Core.isPlainObject(rawBody)) {
    rejectBody("body", "must be a JSON object");
  }
  return {
    prompt: readRequiredNonEmptyString(rawBody, "prompt"),
    options: Object.hasOwn(rawBody, "options") ? rawBody["options"] : undefined,
  };
}

/** Validates an untrusted `rawBody` into the `answer` value; the value itself is unconstrained. */
function readAnswerBody(rawBody: unknown): unknown {
  if (!Core.isPlainObject(rawBody)) {
    rejectBody("body", "must be a JSON object");
  }
  if (!Object.hasOwn(rawBody, "answer")) {
    rejectBody("answer", "is required");
  }
  return rawBody["answer"];
}

/** Builds the `POST /api/v1/sessions` handler: creates a new open session. */
function buildCreateHandler(writer: SessionRouteWriterPort): M3LConsoleHandler {
  return (ctx) => {
    const operator = requireOperatorName(ctx);
    const created = writer.createSession(operator, ctx.correlationId);
    return jsonResponse(STATUS_CREATED, created);
  };
}

/**
 * Validates and returns the `?limit=` query parameter, defaulting to
 * {@link DEFAULT_LIST_LIMIT} when omitted.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is present but not a positive integer.
 */
function parseListLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIST_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `invalid 'limit' query parameter: '${raw}'`,
    );
  }
  return parsed;
}

/**
 * Validates the `?status=` query parameter against {@link SESSION_STATUS_VALUES},
 * returning `undefined` when it was absent.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is present but not a recognised status. The rejected value is
 *   never echoed unbounded into the message — this is caller-supplied query
 *   input reaching a response body — so it is truncated to
 *   {@link MAX_ECHOED_STATUS_LENGTH} characters first.
 */
function parseListStatus(
  raw: string | null,
): M3LSessionStatusValue | undefined {
  if (raw === null) return undefined;
  if (isSessionStatus(raw)) return raw;
  const truncated = raw.slice(0, MAX_ECHOED_STATUS_LENGTH);
  throw new M3LConsoleError(
    "ERR_CONSOLE_BAD_REQUEST",
    `invalid 'status' query parameter: '${truncated}'`,
  );
}

/** Builds the {@link M3LSessionListQuery} from `ctx`'s `?status=`/`?operator=`/`?limit=` query params. */
function buildListQuery(ctx: M3LRequestContext): M3LSessionListQuery {
  const status = parseListStatus(ctx.query.get("status"));
  const operator = ctx.query.get("operator");
  const limit = parseListLimit(ctx.query.get("limit"));
  return {
    limit,
    ...(status !== undefined && { status }),
    ...(operator !== null && { operator }),
  };
}

/** Builds the `GET /api/v1/sessions` handler: the bare row list, query-filtered. */
function buildListHandler(reader: SessionRouteReaderPort): M3LConsoleHandler {
  return (ctx) =>
    jsonResponse(STATUS_OK, reader.listSessions(buildListQuery(ctx)));
}

/** Builds the `GET /api/v1/sessions/:id` handler: the row, or a 404. */
function buildGetHandler(reader: SessionRouteReaderPort): M3LConsoleHandler {
  return (ctx) => {
    const id = requireParam(ctx, "id");
    const row = reader.getSession(id);
    if (row === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_NOT_FOUND",
        `no session found with id '${id}'`,
      );
    }
    return jsonResponse(STATUS_OK, row);
  };
}

/**
 * Builds the `POST /api/v1/sessions/:id/steps` handler: validates the body
 * at the boundary (before the writer is ever called), then awaits the write.
 */
function buildAddStepHandler(
  writer: SessionRouteWriterPort,
): M3LConsoleHandler {
  return async (ctx) => {
    const body = parseAddStepBody(ctx.body);
    const operator = requireOperatorName(ctx);
    const sessionId = requireParam(ctx, "id");
    const result = await writer.addStep(sessionId, {
      ...body,
      operator,
      correlationId: ctx.correlationId,
    });
    return jsonResponse(STATUS_CREATED, result);
  };
}

/** Builds the `POST /api/v1/sessions/:id/steps/:stepId/decision` handler. */
function buildRaiseDecisionHandler(
  writer: SessionRouteWriterPort,
): M3LConsoleHandler {
  return (ctx) => {
    const sessionId = requireParam(ctx, "id");
    const stepId = requireParam(ctx, "stepId");
    const body = parseRaiseDecisionBody(ctx.body);
    const decision = writer.raiseDecision(
      sessionId,
      stepId,
      body.prompt,
      body.options,
    );
    return jsonResponse(STATUS_CREATED, decision);
  };
}

/**
 * Builds the `POST /api/v1/sessions/:id/decisions/:decisionId` handler.
 * Uses only `:decisionId` — the real service's `answerDecision` does not
 * take a session id, so `:id` is unused here (see this module's own TSDoc).
 */
function buildAnswerDecisionHandler(
  writer: SessionRouteWriterPort,
): M3LConsoleHandler {
  return (ctx) => {
    const decisionId = requireParam(ctx, "decisionId");
    const answer = readAnswerBody(ctx.body);
    const applied = writer.answerDecision(decisionId, answer);
    return jsonResponse(STATUS_OK, { applied });
  };
}

/** Builds the `POST /api/v1/sessions/:id/close` handler. */
function buildCloseHandler(writer: SessionRouteWriterPort): M3LConsoleHandler {
  return (ctx) => {
    const id = requireParam(ctx, "id");
    const applied = writer.closeSession(id);
    return jsonResponse(STATUS_OK, { applied });
  };
}

/**
 * Builds the X6 workbench-sessions module's REST route table: creating,
 * listing, reading, and closing sessions, appending steps, and raising and
 * answering decisions — all `auth: "required"`, a console operator only,
 * never an unauthenticated caller.
 *
 * @param options - See {@link SessionRouteOptions}.
 * @returns The seven-route table.
 *
 * @example
 * ```ts
 * import { createSessionRoutes } from "@m3l-automation/m3l-console-server/http/routes/sessions.js";
 *
 * const routes = createSessionRoutes({
 *   reader: { getSession: () => undefined, listSessions: () => [] },
 *   writer: {
 *     createSession: () => ({
 *       id: "session-1",
 *       operator: "alice",
 *       correlationId: "corr-1",
 *       status: "open",
 *       createdAtMs: Date.now(),
 *       updatedAtMs: Date.now(),
 *     }),
 *     closeSession: () => true,
 *     addStep: async () => ({ step: { id: "step-1" } }),
 *     raiseDecision: () => ({ id: "decision-1" }),
 *     answerDecision: () => true,
 *   },
 * });
 * ```
 */
export function createSessionRoutes(
  options: SessionRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "POST",
      path: "/api/v1/sessions",
      auth: "required",
      handler: buildCreateHandler(options.writer),
    },
    {
      method: "GET",
      path: "/api/v1/sessions",
      auth: "required",
      handler: buildListHandler(options.reader),
    },
    {
      method: "GET",
      path: "/api/v1/sessions/:id",
      auth: "required",
      handler: buildGetHandler(options.reader),
    },
    {
      method: "POST",
      path: "/api/v1/sessions/:id/steps",
      auth: "required",
      handler: buildAddStepHandler(options.writer),
    },
    {
      method: "POST",
      path: "/api/v1/sessions/:id/steps/:stepId/decision",
      auth: "required",
      handler: buildRaiseDecisionHandler(options.writer),
    },
    {
      method: "POST",
      path: "/api/v1/sessions/:id/decisions/:decisionId",
      auth: "required",
      handler: buildAnswerDecisionHandler(options.writer),
    },
    {
      method: "POST",
      path: "/api/v1/sessions/:id/close",
      auth: "required",
      handler: buildCloseHandler(options.writer),
    },
  ];
}
