/**
 * `http/routes/session-bindings` — the two binding routes:
 * `GET /api/v1/sessions/:id/bindings` (X6, relocated here unchanged) and
 * `POST /api/v1/sessions/:id/bindings` (X7d, new).
 *
 * Both moved out of `http/routes/sessions.ts` together rather than the new
 * one being bolted on there: that file was at 23,647 of ADR-0072's
 * 25,000-char ceiling, and the write route needs a body validator and a
 * writer port its other eight routes do not. Keeping the read beside the
 * write also means the resource has one module, not two halves.
 *
 * **What X7d ships here, and what stays X11's.** This is the server seam:
 * an operator names a value out of a prior step's output, and the console
 * records it. The JSON tree viewer, the pre-filled next operation and the
 * decision prompts are X11's, along with its Playwright acceptance. Nothing
 * here builds any of them, and X11 is not re-scoped by this landing — it
 * simply no longer has to build the endpoint first.
 *
 * This module also OWNS the binding-entry validator, which
 * `http/routes/sessions.ts` imports back for `POST …/steps`' inline
 * bindings. One implementation with two callers, in the module the resource
 * belongs to: an inline binding and a standalone one are the same shape, and
 * two validators for one shape is how a route ends up accepting what its
 * sibling rejects. The direction is deliberate — `sessions.ts` imports this
 * module and never the reverse, so there is no cycle for `check:zones` to
 * catch.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

import {
  readRequiredBoolean,
  readRequiredNonEmptyString,
  rejectBody,
} from "./session-body.js";

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

/**
 * One validated step-binding entry — mirrors `sessions/service.ts`'s binding
 * input shape. Exported alongside {@link readBindingEntry}, which returns it,
 * and named by `http/routes/sessions.ts`'s own ports.
 */
export interface M3LSessionStepBindingInput {
  readonly reference: string;
  readonly expectedType: M3LSessionBindingExpectedType;
  readonly multiSelect: boolean;
  readonly parameterName: string;
}

/**
 * Validates and returns one step-binding entry under `label`.
 *
 * Exported so `http/routes/sessions.ts` validates `POST …/steps`' inline
 * bindings with THIS function rather than a second copy of the same rules.
 * `label` is what differs between the two callers: the inline path reports
 * `bindings[0].reference`, the standalone one just `binding.reference`.
 *
 * @param raw - The untrusted entry.
 * @param label - The field path a rejection message names.
 * @returns The validated entry.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_BAD_REQUEST` naming the
 *   offending field.
 *
 * @example
 * ```ts
 * import { readBindingEntry } from "@m3l-automation/m3l-console-server/http/routes/session-bindings.js";
 *
 * readBindingEntry(
 *   { reference: "step-1.output", expectedType: "string", multiSelect: false, parameterName: "q" },
 *   "binding",
 * );
 * ```
 */
export function readBindingEntry(
  raw: unknown,
  label: string,
): M3LSessionStepBindingInput {
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

/** The status `POST …/bindings` returns on a recorded selection. */
const STATUS_CREATED = 201;
/** The status `GET …/bindings` returns. */
const STATUS_OK = 200;

/**
 * The local binding-reading port — mirrors `sessions/service-reads.ts`'s
 * `listBindingsForSession`, so the real session service satisfies it
 * structurally without an `http -> sessions` import.
 *
 * @example
 * ```ts
 * const reader: SessionBindingReaderPort = { listBindingsForSession: () => [] };
 * ```
 */
interface SessionBindingReaderPort {
  /** Lists every binding persisted for `sessionId`; throws for an unknown id. */
  listBindingsForSession(sessionId: string): readonly unknown[];
}

/**
 * The local binding-writing port — mirrors `sessions/service-bindings.ts`'s
 * `selectBinding`.
 *
 * @example
 * ```ts
 * const writer: SessionBindingWriterPort = {
 *   selectBinding: () => Promise.resolve({ id: "binding-1" }),
 * };
 * ```
 */
interface SessionBindingWriterPort {
  /** Records an operator's binding selection; throws for an unresolvable reference. */
  selectBinding(
    sessionId: string,
    binding: M3LSessionStepBindingInput,
  ): Promise<unknown>;
}

/**
 * Constructor options for {@link createSessionBindingRoutes}.
 *
 * @example
 * ```ts
 * const options: SessionBindingRouteOptions = {
 *   reader: { listBindingsForSession: () => [] },
 *   writer: { selectBinding: () => Promise.resolve({ id: "binding-1" }) },
 * };
 * ```
 */
export interface SessionBindingRouteOptions {
  /** The binding-reading port; `main.ts` passes the real session service. */
  readonly reader: SessionBindingReaderPort;
  /** The binding-writing port; `main.ts` passes the same service. */
  readonly writer: SessionBindingWriterPort;
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
 * Builds the `GET /api/v1/sessions/:id/bindings` handler: the bare binding
 * row array; 404s via the service's own session guard for an unknown id.
 *
 * Relocated from `http/routes/sessions.ts` verbatim — its contract did not
 * change, and `tests/routes-sessions.test.ts` still owns its cases.
 */
function buildListBindingsHandler(
  reader: SessionBindingReaderPort,
): M3LConsoleHandler {
  return (ctx) => {
    const id = requireParam(ctx, "id");
    return jsonResponse(STATUS_OK, reader.listBindingsForSession(id));
  };
}

/**
 * Builds the `POST /api/v1/sessions/:id/bindings` handler: validates the
 * body at the boundary, then records the selection.
 *
 * `201`, not `200`: this creates a binding row, exactly as `POST …/steps`
 * creates a step. The response is the persisted record — which carries no
 * resolved VALUE, because the table has no column for one and putting
 * arbitrary step output in an operator's binding trail is precisely what
 * ADR-0070's display-vs-persist split forbids.
 *
 * Every reference failure is the SERVICE's, propagated unchanged: an
 * unknown ordinal, a step with no recorded output, a value of the wrong
 * shape. This handler validates the body's SHAPE and nothing about what the
 * reference points at.
 */
function buildSelectBindingHandler(
  writer: SessionBindingWriterPort,
): M3LConsoleHandler {
  return async (ctx) => {
    const sessionId = requireParam(ctx, "id");
    if (!Core.isPlainObject(ctx.body)) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "invalid session request: 'body' must be a JSON object",
        { context: { field: "body" } },
      );
    }
    const binding = readBindingEntry(ctx.body, "binding");
    const record = await writer.selectBinding(sessionId, binding);
    return jsonResponse(STATUS_CREATED, record);
  };
}

/**
 * Builds the session-binding route table: the X6 list route and X7d's
 * selection route, both `auth: "required"` — a console operator only, never
 * an unauthenticated caller.
 *
 * @param options - See {@link SessionBindingRouteOptions}.
 * @returns The two-route table.
 *
 * @example
 * ```ts
 * import { createSessionBindingRoutes } from "@m3l-automation/m3l-console-server/http/routes/session-bindings.js";
 *
 * const routes = createSessionBindingRoutes({
 *   reader: { listBindingsForSession: () => [] },
 *   writer: { selectBinding: () => Promise.resolve({ id: "binding-1" }) },
 * });
 * ```
 */
export function createSessionBindingRoutes(
  options: SessionBindingRouteOptions,
): readonly M3LRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/sessions/:id/bindings",
      auth: "required",
      handler: buildListBindingsHandler(options.reader),
    },
    {
      method: "POST",
      path: "/api/v1/sessions/:id/bindings",
      auth: "required",
      handler: buildSelectBindingHandler(options.writer),
    },
  ];
}
