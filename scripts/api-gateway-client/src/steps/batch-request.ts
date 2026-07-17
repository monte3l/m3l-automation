import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { destructiveGate } from "./destructive-gate.js";
import { resolveAuthHeaders } from "./resolve-auth-headers.js";

/**
 * `batch-request` — runs the `batch` command: streams `input` JSONL
 * request-parameter records through a shared request template
 * (`method`/`baseUrl` from config, `path`/`body` per record) with bounded
 * concurrency, gating the whole run once up front when `method` is
 * mutating. Successful responses append to `output`; per-request failures
 * (the original record plus normalized error info) append to the fixed
 * `failed.jsonl` re-drive file.
 */

/** The dependencies `batchRequest` (and its local helpers) receive. */
interface BatchRequestDeps {
  readonly config: Core.M3LConfig;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly correlationId: string;
  readonly httpClient: Core.M3LHttpClient;
  readonly signer: AWS.M3LRequestSigner | undefined;
  readonly prompt: Core.M3LPrompt;
}

/** HTTP verbs `destructive-gate` confirms before dispatch; GET/HEAD are never gated. */
const MUTATING_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** Falls back to the declared `maxInFlight` default (`config.ts`) when unset. */
const DEFAULT_MAX_IN_FLIGHT = 4;

/**
 * Reads a required string parameter (`method`/`input`), throwing when it is
 * missing (never declared `required: true` for `input` — F1b — so
 * per-command requiredness is guard-checked here) or was stored as a
 * non-string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"`.
 */
function readRequiredString(config: Core.M3LConfig, name: string): string {
  const value: unknown = config.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(`'${name}' is required for 'batch'`, {
      code: "ERR_API_GATEWAY_CLIENT_CONFIG",
      context: { name },
    });
  }
  return value;
}

/** Reads an optional string parameter, treating an empty string as unset. */
function readOptionalString(
  config: Core.M3LConfig,
  name: string,
): string | undefined {
  const value: unknown = config.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads the `maxInFlight` parameter, falling back to the declared default. */
function readMaxInFlight(config: Core.M3LConfig): number {
  const raw = config.get("maxInFlight");
  return typeof raw === "number" ? raw : DEFAULT_MAX_IN_FLIGHT;
}

/** Narrows `value` to a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerces a value into a JSONL-appendable record, wrapping a non-object value. */
function toJsonlRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : { value };
}

/** The resolved, guard-checked settings a `batch` run needs. */
interface BatchSettings {
  readonly method: Core.M3LHttpMethod;
  readonly input: string;
  readonly yes: boolean;
  readonly baseUrl: string | undefined;
  /** `baseUrl`'s origin, precomputed once so every record's resolved URL can be origin-checked against it (see {@link isOffOrigin}). */
  readonly baseOrigin: string | undefined;
  readonly outputName: string | undefined;
  readonly maxInFlight: number;
}

/** Resolves and guard-checks every declared parameter `batchRequest` needs. */
function resolveBatchSettings(config: Core.M3LConfig): BatchSettings {
  const baseUrl = readOptionalString(config, "baseUrl");
  return {
    method: readRequiredString(config, "method") as Core.M3LHttpMethod,
    input: readRequiredString(config, "input"),
    yes: config.get("yes") === true,
    baseUrl,
    baseOrigin: baseUrl === undefined ? undefined : new URL(baseUrl).origin,
    outputName: readOptionalString(config, "output"),
    maxInFlight: readMaxInFlight(config),
  };
}

/**
 * Streams `filePath` as newline-delimited JSON, JSON-parsing each non-empty
 * line and yielding the parsed value; a line that fails to parse is reported
 * to `onSkip` (index + cause) instead of aborting the stream.
 */
async function* readJsonlRecords(
  filePath: string,
  onSkip: (index: number, cause: unknown) => void,
): AsyncGenerator<unknown> {
  const buffer = await fsp.readFile(filePath);
  const lines = buffer
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let index = 0;
  for (const line of lines) {
    try {
      yield JSON.parse(line) as unknown;
    } catch (cause) {
      onSkip(index, cause);
    }
    index += 1;
  }
}

/**
 * Reads and buffers every record from `input` (a per-line skip is logged,
 * never aborting the read); a source-level failure (e.g. `input` cannot be
 * read) propagates unwrapped.
 */
async function collectRecords(
  paths: Core.M3LPaths,
  input: string,
  logger: Core.M3LLogger,
): Promise<unknown[]> {
  const inputPath = paths.resolveInput(input);
  const records = readJsonlRecords(inputPath, (index, cause) => {
    logger.warning(`skipped malformed JSONL line at index ${String(index)}`, {
      cause,
    });
  });

  const buffered: unknown[] = [];
  for await (const record of records) {
    buffered.push(record);
  }
  return buffered;
}

/** The request fields (`path`, optional `body`) one batch record carries. */
interface BatchRecordFields {
  readonly path: string;
  readonly body?: string;
}

/**
 * Reads a parsed record's request fields, throwing when it does not carry a
 * non-empty `path` string.
 *
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"`.
 */
function toRequestFields(record: unknown): BatchRecordFields {
  if (
    !isPlainObject(record) ||
    typeof record.path !== "string" ||
    record.path.length === 0
  ) {
    throw new Core.M3LError("batch record is missing a valid 'path' field", {
      code: "ERR_API_GATEWAY_CLIENT_CONFIG",
    });
  }
  const body = typeof record.body === "string" ? record.body : undefined;
  return { path: record.path, ...(body !== undefined && { body }) };
}

/** Resolves `path` against `settings.baseUrl` (per `new URL(path, baseUrl)`) when configured. */
function resolveRecordUrl(path: string, settings: BatchSettings): string {
  return settings.baseUrl === undefined
    ? path
    : new URL(path, settings.baseUrl).toString();
}

/**
 * Reports whether `url` resolves to an origin other than `settings.baseUrl`'s
 * — an absolute-URL `path` in an untrusted batch record (e.g.
 * `{"path":"https://attacker.example/x"}`) would otherwise have the SigV4
 * `authorization` header (or `x-api-key`) signed/sent for an arbitrary
 * origin, since `resolveAuthHeaders` signs whatever URL it is given. Always
 * `false` when `baseUrl` is unconfigured (nothing to enforce against).
 */
function isOffOrigin(url: string, settings: BatchSettings): boolean {
  return (
    settings.baseOrigin !== undefined &&
    new URL(url).origin !== settings.baseOrigin
  );
}

/** Normalized, secret-free failure info appended alongside a failed record. */
interface NormalizedFailure {
  readonly reason: string;
  readonly status?: number;
  readonly message: string;
}

/**
 * Normalizes any failure raised while dispatching one batch record into a
 * secret-free description safe to persist to `failed.jsonl` — an
 * {@link Core.M3LHttpClientError}'s `authorization`/`x-api-key` headers are
 * never part of its `message`/`context`, so nothing here can leak them.
 */
function normalizeFailure(cause: unknown): NormalizedFailure {
  if (cause instanceof Core.M3LHttpClientError) {
    return {
      reason: cause.reason,
      message: cause.message,
      ...(cause.failure.reason === "status" && {
        status: cause.failure.status,
      }),
    };
  }
  if (cause instanceof Error) {
    return { reason: "unknown", message: cause.message };
  }
  return { reason: "unknown", message: String(cause) };
}

/** The two JSONL sinks a `batch` run writes to: `output` (optional) and `failed.jsonl` (always). */
interface BatchWriters {
  readonly failedWriter: Core.M3LListExporterStreamWriter<
    Record<string, unknown>
  >;
  readonly outputWriter:
    Core.M3LListExporterStreamWriter<Record<string, unknown>> | undefined;
}

/**
 * Best-effort close of one writer (a no-op for `undefined`); a close
 * failure is logged, never thrown — closing one writer must never prevent
 * (or be masked by) closing the other, nor mask a real error the caller is
 * already propagating.
 */
async function closeWriterBestEffort(
  writer: Core.M3LListExporterStreamWriter<Record<string, unknown>> | undefined,
  logger: Core.M3LLogger,
  label: string,
): Promise<void> {
  try {
    await writer?.close();
  } catch (cause) {
    logger.warning(`failed to close the '${label}' writer`, { cause });
  }
}

/** Best-effort close of both writers, each isolated from the other's outcome. */
async function closeWritersBestEffort(
  writers: BatchWriters,
  logger: Core.M3LLogger,
): Promise<void> {
  await closeWriterBestEffort(writers.failedWriter, logger, "failed.jsonl");
  await closeWriterBestEffort(writers.outputWriter, logger, "output");
}

/**
 * Opens `failed.jsonl` (always) and `output` (only when configured). If
 * opening `failed.jsonl` fails after `output` was already opened, the
 * already-opened `output` stream is closed best-effort rather than leaked.
 */
async function openBatchWriters(
  paths: Core.M3LPaths,
  outputName: string | undefined,
  logger: Core.M3LLogger,
): Promise<BatchWriters> {
  const outputWriter =
    outputName === undefined
      ? undefined
      : new Core.M3LJSONListExporter<Record<string, unknown>>({
          filePath: paths.resolveOutput(outputName),
          format: "jsonl",
        }).exportStream();

  try {
    const failedExporter = new Core.M3LJSONListExporter<
      Record<string, unknown>
    >({ filePath: paths.resolveOutput("failed.jsonl"), format: "jsonl" });
    return { failedWriter: failedExporter.exportStream(), outputWriter };
  } catch (cause) {
    await closeWriterBestEffort(outputWriter, logger, "output");
    throw cause;
  }
}

/** One record's dispatch outcome, tallied by the caller after `runEach` resolves. */
type DispatchOutcome = "succeeded" | "failed";

/**
 * Appends `error` (alongside the original `record`) to `failed.jsonl` and
 * returns `"failed"`. The append itself is guarded: if writing the failure
 * entry throws (disk full, `EACCES`, …), that write failure is logged as a
 * warning instead of propagating — `M3LConcurrencyPool.runEach` is fail-fast,
 * so an unguarded throw here would abort every other in-flight record and
 * silently lose their accounting, breaking `dispatchRecord`'s documented
 * "never throws" contract.
 */
async function appendFailure(
  writers: BatchWriters,
  record: unknown,
  error: NormalizedFailure,
  logger: Core.M3LLogger,
): Promise<DispatchOutcome> {
  try {
    await writers.failedWriter.append({ ...toJsonlRecord(record), error });
  } catch (writeCause) {
    logger.warning("failed to append a per-record failure to 'failed.jsonl'", {
      cause: writeCause,
      record: toJsonlRecord(record),
      error,
    });
  }
  return "failed";
}

/**
 * Dispatches one batch record: resolves its fields/URL, rejects an
 * off-origin `path` before ever resolving auth headers or dispatching (see
 * {@link isOffOrigin}), resolves auth headers, calls `httpClient.request()`,
 * and appends the outcome to the matching writer. Never throws — every
 * failure (malformed record, off-origin path, auth resolution, the HTTP call
 * itself, or an `output` write failure) is caught and appended to
 * `failed.jsonl` instead, so a single record's failure never aborts its
 * siblings.
 */
async function dispatchRecord(
  record: unknown,
  settings: BatchSettings,
  writers: BatchWriters,
  deps: BatchRequestDeps,
): Promise<DispatchOutcome> {
  let fields: BatchRecordFields;
  let url: string;
  try {
    fields = toRequestFields(record);
    url = resolveRecordUrl(fields.path, settings);
  } catch (cause) {
    return appendFailure(writers, record, normalizeFailure(cause), deps.logger);
  }

  if (isOffOrigin(url, settings)) {
    return appendFailure(
      writers,
      record,
      {
        reason: "path-origin-mismatch",
        message: `record path resolves to an origin other than 'baseUrl': ${url}`,
      },
      deps.logger,
    );
  }

  let response: unknown;
  try {
    const headers = await resolveAuthHeaders({
      config: deps.config,
      signer: deps.signer,
      method: settings.method,
      url,
      ...(fields.body !== undefined && { body: fields.body }),
    });
    response = await deps.httpClient.request<unknown>({
      method: settings.method,
      path: fields.path,
      headers,
      ...(fields.body !== undefined && { body: fields.body }),
    });
  } catch (cause) {
    return appendFailure(writers, record, normalizeFailure(cause), deps.logger);
  }

  if (writers.outputWriter === undefined) return "succeeded";

  try {
    await writers.outputWriter.append(toJsonlRecord(response));
    return "succeeded";
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return appendFailure(
      writers,
      record,
      {
        reason: "output-write-failed",
        message: `request succeeded but writing the response to 'output' failed: ${detail}`,
      },
      deps.logger,
    );
  }
}

/**
 * Runs the `batch` command: guard-resolves `input`, runs `destructive-gate`
 * once up front when `method` is mutating, streams `input` JSONL records,
 * resolves auth headers and dispatches each record through a
 * `Core.M3LConcurrencyPool(maxInFlight)`, appending successful responses to
 * `output` and per-record failures (original record + normalized error
 * info) to `failed.jsonl`. A best-effort writer `close()` — on both the
 * error path and the happy path — never masks the original throw and never
 * lets one writer's close failure prevent the other's.
 *
 * @param deps - The resolved config, `M3LPaths`, logger, correlation id, the
 *   script-constructed `Core.M3LHttpClient`, the optional
 *   `AWS.M3LRequestSigner`, and the interactive-prompt facade.
 * @returns A promise that resolves once every record has been dispatched.
 * @throws {@link Core.M3LError} coded `"ERR_API_GATEWAY_CLIENT_CONFIG"` when
 *   `input` is missing, or `"ERR_API_GATEWAY_CLIENT_ABORTED"` when a
 *   mutating verb's confirmation is declined. A source-level failure (e.g.
 *   `input` cannot be read) rejects with the original, unwrapped cause.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { batchRequest } from "./batch-request.js";
 *
 * await batchRequest({
 *   config: await new Core.M3LScript({
 *     metadata: { name: "api-gateway-client", version: "0.0.0" },
 *     config: { params: [] },
 *   }).getConfiguration(),
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   correlationId: "run-1",
 *   httpClient: new Core.M3LHttpClient({ baseUrl: "https://api.example.com" }),
 *   signer: undefined,
 *   prompt: new Core.M3LPrompt(),
 * });
 * ```
 */
export async function batchRequest(deps: BatchRequestDeps): Promise<void> {
  const settings = resolveBatchSettings(deps.config);

  if (MUTATING_METHODS.includes(settings.method)) {
    await destructiveGate({
      prompt: deps.prompt,
      logger: deps.logger,
      description: `${settings.method} batch requests from '${settings.input}'`,
      yes: settings.yes,
    });
  }

  const writers = await openBatchWriters(
    deps.paths,
    settings.outputName,
    deps.logger,
  );
  let outcomes: readonly DispatchOutcome[];

  try {
    const buffered = await collectRecords(
      deps.paths,
      settings.input,
      deps.logger,
    );
    const pool = new Core.M3LConcurrencyPool(settings.maxInFlight);
    outcomes = await pool.runEach(buffered, (record) =>
      dispatchRecord(record, settings, writers, deps),
    );
  } catch (cause) {
    await closeWritersBestEffort(writers, deps.logger);
    throw cause;
  }

  await closeWritersBestEffort(writers, deps.logger);

  const succeeded = outcomes.filter(
    (outcome) => outcome === "succeeded",
  ).length;
  deps.logger.step(`api-gateway-client batch ${deps.correlationId} complete`, {
    succeeded,
    failed: outcomes.length - succeeded,
  });
}
