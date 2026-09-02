/**
 * `http/routes/runs` — the X4 run-governor's REST surface: `POST /api/v1/runs`
 * to launch a run, `GET /api/v1/runs` to list, `GET /api/v1/runs/:id` to read
 * one.
 *
 * `http/` may never import `runs/` or `store/` (zone rules, checked by
 * `bin/check-eslint-zones.mjs`) — including type-only imports. So this
 * module declares its own narrow local ports ({@link M3LRunLauncherPort},
 * {@link M3LRunReaderPort}) mirroring `runs/orchestrator.ts`'s
 * `M3LRunOrchestrator.launch` and `runs/registry.ts`'s
 * `M3LRunRegistry.list`/`.get` field for field — the same
 * declared-not-imported trick `http/routes/health.ts`'s `M3LReadinessProbe`
 * uses. `main.ts` passing the real orchestrator and registry is the
 * compiler-checked proof that both structurally conform.
 *
 * The `POST` body's validation rules (`scriptName`/`confirmed`/`dryRun`/
 * `parameters`) are likewise duplicated from `runs/parameters.ts`'s
 * `parseRunRequest`, for the same zone reason — this module cannot import
 * that function. `?status=` validation is a THIRD duplication for the same
 * reason: `store/run-status.ts`'s `RUN_STATUSES` is a `store/` export, so
 * this module declares and exports its own {@link RUN_STATUS_VALUES}
 * vocabulary (drift-guarded by `tests/routes-runs.test.ts`, which — unlike
 * this module — is free to import both sides of the duplication).
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../../errors/console-error.js";
import type { M3LRequestContext } from "../context.js";
import type { M3LConsoleHandler } from "../middleware.js";
import { jsonResponse } from "../respond.js";
import type { M3LRoute } from "../router.js";

/** The status `POST /api/v1/runs` returns on an accepted launch. */
const STATUS_CREATED = 201;
/** The status every other route in this module returns on success. */
const STATUS_OK = 200;
/** The page size `GET /api/v1/runs` uses when `?limit=` is omitted. */
const DEFAULT_LIST_LIMIT = 50;
/** The longest caller-supplied `?status=` value ever echoed into an error message. */
const MAX_ECHOED_STATUS_LENGTH = 32;
/**
 * The pattern a valid `scriptName` must match — duplicated verbatim from
 * `runs/parameters.ts`'s `SCRIPT_NAME_PATTERN` (`http/` may not import
 * `runs/`; see this module's own TSDoc). Exported so
 * `tests/routes-scripts.test.ts` can assert the duplication has not
 * drifted, alongside `http/routes/scripts.ts`'s own THIRD copy
 * (`SCRIPT_ROUTE_NAME_PATTERN`).
 *
 * @example
 * ```ts
 * import { SCRIPT_NAME_PATTERN } from "@m3l-automation/m3l-console-server/http/routes/runs.js";
 *
 * SCRIPT_NAME_PATTERN.test("sqs-etl"); // true
 * ```
 */
export const SCRIPT_NAME_PATTERN: RegExp = /^[a-z][a-z0-9-]*$/;

/**
 * The accepted `?status=` vocabulary — duplicated verbatim, in the same
 * order, from `store/run-status.ts`'s `RUN_STATUSES` (`http/` may not import
 * `store/`; see this module's own TSDoc). Exported so
 * `tests/routes-runs.test.ts` can assert the duplication has not drifted.
 *
 * @example
 * ```ts
 * import { RUN_STATUS_VALUES } from "@m3l-automation/m3l-console-server/http/routes/runs.js";
 *
 * RUN_STATUS_VALUES.includes("queued"); // true
 * ```
 */
export const RUN_STATUS_VALUES: readonly string[] = [
  "queued",
  "running",
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
];

/** The set backing {@link isAcceptedStatus}'s O(1) membership check. */
const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUS_VALUES);

/** `true` when `value` is a member of {@link RUN_STATUS_VALUES}. */
function isAcceptedStatus(value: string): boolean {
  return RUN_STATUS_SET.has(value);
}

/** One validated launch request body — mirrors `runs/parameters.ts`'s `M3LRunRequestBody`. */
interface M3LRunLaunchRequestBody {
  readonly scriptName: string;
  readonly confirmed: boolean;
  readonly dryRun: boolean;
  readonly parameters: Readonly<Record<string, string>>;
}

/** One launch request — mirrors `runs/orchestrator-types.ts`'s `M3LRunLaunchRequest`. */
interface M3LRunLaunchRequest {
  readonly body: M3LRunLaunchRequestBody;
  readonly operator: string;
  readonly correlationId: string;
}

/**
 * The local launcher port this module depends on — mirrors
 * `runs/orchestrator.ts`'s `M3LRunOrchestrator.launch` field for field, so
 * the real orchestrator satisfies it structurally without an `http -> runs`
 * import.
 *
 * @example
 * ```ts
 * const launcher: M3LRunLauncherPort = {
 *   launch: () => ({
 *     id: "run-1",
 *     scriptName: "sqs-etl",
 *     status: "running",
 *     dryRun: false,
 *     executionMode: "spawn",
 *   }),
 * };
 * ```
 */
export interface M3LRunLauncherPort {
  /** Launches a validated run request; throws propagated unchanged from the orchestrator. */
  launch(request: M3LRunLaunchRequest): {
    readonly id: string;
    readonly scriptName: string;
    readonly status: "queued" | "running";
    readonly dryRun: boolean;
    readonly executionMode: string;
  };
}

/** One list query — mirrors `runs/registry.ts`'s `M3LRunListQuery`. */
interface M3LRunListQuery {
  readonly status?: string;
  readonly limit: number;
}

/**
 * The local reader port this module depends on — mirrors `runs/registry.ts`'s
 * `M3LRunRegistry.list`/`.get`.
 *
 * @example
 * ```ts
 * const reader: M3LRunReaderPort = {
 *   list: () => [],
 *   get: () => undefined,
 * };
 * ```
 */
export interface M3LRunReaderPort {
  /** Lists rows matching `query`. */
  list(query: M3LRunListQuery): readonly unknown[];
  /** Reads one row by id, or `undefined` when no such row exists. */
  get(id: string): unknown;
}

/**
 * The local run-report port this module depends on — mirrors
 * `runs/report.ts`'s `M3LRunReportReader.read`, so the real reader satisfies
 * it structurally without an `http -> runs` import.
 *
 * The reader, not this module, owns the filesystem: locating a run's single
 * timestamp directory, the containment assertion, the symlink refusal and
 * the read cap all live there (`runs/report.ts`). This module's only job is
 * turning "no report" into the right 404.
 *
 * @example
 * ```ts
 * const reportReader: M3LRunReportPort = {
 *   read: () => Promise.resolve(undefined),
 * };
 * ```
 */
export interface M3LRunReportPort {
  /** Reads one run's persisted report, or `undefined` when there is none. */
  read(runId: string): Promise<unknown>;
}

/**
 * Constructor options for {@link createRunRoutes}.
 *
 * @example
 * ```ts
 * const options: RunRouteOptions = {
 *   orchestrator: { launch: () => ({ id: "run-1", scriptName: "sqs-etl", status: "running", dryRun: false, executionMode: "spawn" }) },
 *   registry: { list: () => [], get: () => undefined },
 * };
 * ```
 */
export interface RunRouteOptions {
  /** The run-launching port; `main.ts` passes the real `M3LRunOrchestrator`. */
  readonly orchestrator: M3LRunLauncherPort;
  /** The run-reading port; `main.ts` passes the real `M3LRunRegistry`. */
  readonly registry: M3LRunReaderPort;
  /** The run-report port; `main.ts` passes the run subsystem's `reportReader`. */
  readonly reportReader: M3LRunReportPort;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` naming `field` and the reason it failed. */
function rejectBody(field: string, reason: string): never {
  throw new M3LConsoleError(
    "ERR_CONSOLE_BAD_REQUEST",
    `invalid run request: '${field}' ${reason}`,
    { context: { field } },
  );
}

/** Validates and returns the required `scriptName` field. */
function readScriptName(body: Record<string, unknown>): string {
  if (!Object.hasOwn(body, "scriptName")) {
    rejectBody("scriptName", "is required");
  }
  const scriptName = body["scriptName"];
  if (!Core.isString(scriptName)) {
    rejectBody("scriptName", "must be a string");
  }
  if (!SCRIPT_NAME_PATTERN.test(scriptName)) {
    rejectBody("scriptName", "must be a kebab-case identifier");
  }
  return scriptName;
}

/** Validates and returns an optional boolean field, defaulting to `false`. */
function readOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean {
  if (!Object.hasOwn(body, field)) return false;
  const value = body[field];
  if (!Core.isBoolean(value)) {
    rejectBody(field, "must be a boolean");
  }
  return value;
}

/** Validates and returns the optional `parameters` field, defaulting to `{}`. */
function readParameters(
  body: Record<string, unknown>,
): Readonly<Record<string, string>> {
  if (!Object.hasOwn(body, "parameters")) return {};
  const parameters = body["parameters"];
  if (!Core.isPlainObject(parameters)) {
    rejectBody("parameters", "must be a plain object");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!Core.isString(value)) {
      rejectBody(`parameters.${key}`, "must be a string");
    }
    result[key] = value;
  }
  return result;
}

/**
 * Validates an untrusted `rawBody` into a closed {@link M3LRunLaunchRequestBody}.
 * Duplicates `runs/parameters.ts`'s `parseRunRequest` rules — see this
 * module's own TSDoc for why it cannot simply import that function.
 */
function parseRunLaunchBody(rawBody: unknown): M3LRunLaunchRequestBody {
  if (!Core.isPlainObject(rawBody)) {
    rejectBody("body", "must be a JSON object");
  }
  return {
    scriptName: readScriptName(rawBody),
    confirmed: readOptionalBoolean(rawBody, "confirmed"),
    dryRun: readOptionalBoolean(rawBody, "dryRun"),
    parameters: readParameters(rawBody),
  };
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

/**
 * Builds the `POST /api/v1/runs` handler: validates the body at the
 * boundary (before the orchestrator is ever called), then launches.
 */
function buildLaunchHandler(
  orchestrator: M3LRunLauncherPort,
): M3LConsoleHandler {
  return (ctx) => {
    const body = parseRunLaunchBody(ctx.body);
    const operator = requireOperatorName(ctx);
    const handle = orchestrator.launch({
      body,
      operator,
      correlationId: ctx.correlationId,
    });
    return jsonResponse(STATUS_CREATED, handle);
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
 * Validates the `?status=` query parameter against {@link RUN_STATUS_VALUES},
 * returning `undefined` when it was absent.
 *
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `raw` is present but not a recognised status. The rejected value is
 *   never echoed unbounded into the message — this is caller-supplied query
 *   input reaching a response body — so it is truncated to
 *   {@link MAX_ECHOED_STATUS_LENGTH} characters first.
 */
function parseListStatus(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  if (isAcceptedStatus(raw)) return raw;
  const truncated = raw.slice(0, MAX_ECHOED_STATUS_LENGTH);
  throw new M3LConsoleError(
    "ERR_CONSOLE_BAD_REQUEST",
    `invalid 'status' query parameter: '${truncated}'`,
  );
}

/** Builds the {@link M3LRunListQuery} from `ctx`'s `?status=`/`?limit=` query params. */
function buildListQuery(ctx: M3LRequestContext): M3LRunListQuery {
  const status = parseListStatus(ctx.query.get("status"));
  const limit = parseListLimit(ctx.query.get("limit"));
  return { limit, ...(status !== undefined && { status }) };
}

/** Builds the `GET /api/v1/runs` handler: the bare row list, query-filtered. */
function buildListHandler(registry: M3LRunReaderPort): M3LConsoleHandler {
  return (ctx) => jsonResponse(STATUS_OK, registry.list(buildListQuery(ctx)));
}

/** Builds the `GET /api/v1/runs/:id` handler: the row, or a 404. */
function buildGetHandler(registry: M3LRunReaderPort): M3LConsoleHandler {
  return (ctx) => {
    const id = ctx.params["id"];
    if (id === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "missing ':id' route parameter",
      );
    }
    const row = registry.get(id);
    if (row === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_NOT_FOUND",
        `no run found with id '${id}'`,
      );
    }
    return jsonResponse(STATUS_OK, row);
  };
}

/**
 * Builds the `GET /api/v1/runs/:id/report` handler: the run's persisted
 * `run-report.json`, or a 404.
 *
 * TWO distinct 404s, both `ERR_CONSOLE_RUN_NOT_FOUND` and both deliberate:
 * an unknown run id, and a known run with no report on disk. The registry is
 * consulted FIRST so "this run does not exist" is never reported as "this
 * run has no report yet" — the messages differ even though the code and
 * status do not, because an operator polling a still-running run needs to
 * tell those apart while an unauthenticated prober learns nothing either
 * way. No new error code is minted: `http/envelope.ts` already maps this one
 * to 404, and a second 404 code would buy nothing a message does not.
 *
 * A run that ran IN-PROCESS never has a report here — a hosted command
 * cannot be handed a per-run `M3L_OUTPUT_DIR` (see
 * `runs/executor.ts`'s `outputDir`), so it lands on the second 404. That is
 * stated in `docs/reference/console.md` rather than hidden behind a
 * different code.
 */
function buildReportHandler(
  registry: M3LRunReaderPort,
  reportReader: M3LRunReportPort,
): M3LConsoleHandler {
  return async (ctx) => {
    const id = ctx.params["id"];
    if (id === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "missing ':id' route parameter",
      );
    }
    if (registry.get(id) === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_NOT_FOUND",
        `no run found with id '${id}'`,
      );
    }
    const report = await reportReader.read(id);
    if (report === undefined) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_NOT_FOUND",
        `run '${id}' has no persisted report`,
      );
    }
    return jsonResponse(STATUS_OK, report);
  };
}

/**
 * Builds the X4 run-governor's REST route table: `POST /api/v1/runs`,
 * `GET /api/v1/runs`, `GET /api/v1/runs/:id`, and (X7d)
 * `GET /api/v1/runs/:id/report`, all `auth: "required"` — a console operator
 * only, never an unauthenticated caller.
 *
 * @param options - See {@link RunRouteOptions}.
 * @returns The four-route table.
 *
 * @example
 * ```ts
 * import { createRunRoutes } from "@m3l-automation/m3l-console-server/http/routes/runs.js";
 *
 * const routes = createRunRoutes({
 *   orchestrator: {
 *     launch: () => ({
 *       id: "run-1",
 *       scriptName: "sqs-etl",
 *       status: "running",
 *       dryRun: false,
 *       executionMode: "spawn",
 *     }),
 *   },
 *   registry: { list: () => [], get: () => undefined },
 * });
 * ```
 */
export function createRunRoutes(options: RunRouteOptions): readonly M3LRoute[] {
  return [
    {
      method: "POST",
      path: "/api/v1/runs",
      auth: "required",
      handler: buildLaunchHandler(options.orchestrator),
    },
    {
      method: "GET",
      path: "/api/v1/runs",
      auth: "required",
      handler: buildListHandler(options.registry),
    },
    {
      method: "GET",
      path: "/api/v1/runs/:id",
      auth: "required",
      handler: buildGetHandler(options.registry),
    },
    {
      method: "GET",
      path: "/api/v1/runs/:id/report",
      auth: "required",
      handler: buildReportHandler(options.registry, options.reportReader),
    },
  ];
}
