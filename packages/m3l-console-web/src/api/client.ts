import type {
  M3LErrorOrigin,
  M3LErrorRetryable,
} from "@m3l-automation/m3l-common/core";

/**
 * Shape of a fetch failure surfaced by {@link fetchConsoleJson}. Every
 * failure mode (network, HTTP error, malformed body) is represented as a
 * plain object rather than a thrown error so callers never need a
 * try/catch around the call.
 */
export interface M3LConsoleFetchError {
  readonly kind: "network" | "http" | "malformed-body";
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly correlationId?: string;
  readonly origin?: M3LErrorOrigin;
  readonly retryable?: M3LErrorRetryable;
}

/**
 * Discriminated result of a {@link fetchConsoleJson} call: either a
 * successful decode of `T` or a typed {@link M3LConsoleFetchError}.
 */
export type M3LConsoleFetchResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: M3LConsoleFetchError };

/**
 * Structural shape of the console-server's error envelope
 * (`M3LConsoleErrorEnvelope`), checked without importing the server
 * package. `origin`/`retryable` mirror the same two optional classification
 * fields the server envelope carries. They stay `unknown` here — envelope
 * recognition depends only on the required fields below, never on these two,
 * so an unrecognized/invalid classification value can never sink an
 * otherwise well-formed envelope (see {@link buildHttpError}, which validates
 * and conditionally includes each one individually).
 */
interface ConsoleErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly correlationId: string;
    readonly origin?: unknown;
    readonly retryable?: unknown;
  };
}

const CONSOLE_ERROR_ORIGINS: Record<M3LErrorOrigin, true> = {
  caller: true,
  library: true,
  external: true,
};

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function isValidOrigin(value: unknown): value is M3LErrorOrigin {
  return (
    typeof value === "string" && Object.hasOwn(CONSOLE_ERROR_ORIGINS, value)
  );
}

function isValidRetryable(value: unknown): value is M3LErrorRetryable {
  return typeof value === "boolean" || value === "situational";
}

function hasRequiredErrorFields(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate["code"] === "string" &&
    typeof candidate["message"] === "string" &&
    typeof candidate["status"] === "number" &&
    typeof candidate["correlationId"] === "string"
  );
}

function isConsoleErrorEnvelope(body: unknown): body is ConsoleErrorEnvelope {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }
  const error = (body as { readonly error: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return hasRequiredErrorFields(error as Record<string, unknown>);
}

async function buildHttpError(
  response: Response,
): Promise<M3LConsoleFetchError> {
  try {
    const body: unknown = await response.json();
    if (isConsoleErrorEnvelope(body)) {
      const { origin, retryable } = body.error;
      return {
        kind: "http",
        message: body.error.message,
        status: body.error.status,
        code: body.error.code,
        correlationId: body.error.correlationId,
        ...(isValidOrigin(origin) && { origin }),
        ...(isValidRetryable(retryable) && { retryable }),
      };
    }
  } catch {
    // body isn't JSON — fall through to the statusText fallback below
  }
  return {
    kind: "http",
    // `statusText` is legitimately empty for HTTP/2 responses and many
    // reverse proxies — falling back to a status-naming message keeps the
    // operator from seeing a blank error.
    message: response.statusText || `HTTP ${String(response.status)}`,
    status: response.status,
  };
}

/**
 * Optional per-call overrides for {@link fetchConsoleJson}. All fields are
 * optional so every existing single-argument call site keeps compiling
 * unchanged.
 */
export interface M3LConsoleRequestOptions {
  /** HTTP method; defaults to the browser's implicit `GET` when omitted. */
  readonly method?: "GET" | "POST";
  /**
   * A JSON-serializable request body. When present, the body is
   * JSON-stringified and `content-type: application/json` is set. A value
   * that cannot be serialized (a `BigInt`, a circular object) resolves
   * `{ ok: false }` rather than throwing — see {@link fetchConsoleJson}'s
   * never-throws contract.
   */
  readonly body?: unknown;
  /**
   * When present, set as the `x-correlation-id` request header. This exact
   * lowercase spelling is fixed by ADR-0066's 2026-08-29 correction; it is
   * not `m3l-correlation-id`.
   */
  readonly correlationId?: string;
}

/**
 * Result of serializing a request body: either the (possibly `undefined`,
 * when no body was given) JSON string, or a typed error when serialization
 * itself threw. Split out of {@link fetchConsoleJson} purely to keep that
 * function's cyclomatic complexity down.
 */
type SerializedRequestBody =
  | { readonly ok: true; readonly bodyString: string | undefined }
  | { readonly ok: false; readonly error: M3LConsoleFetchError };

function serializeRequestBody(body: unknown): SerializedRequestBody {
  if (body === undefined) {
    return { ok: true, bodyString: undefined };
  }
  try {
    return { ok: true, bodyString: JSON.stringify(body) };
  } catch (caught) {
    return {
      ok: false,
      error: { kind: "malformed-body", message: deriveErrorMessage(caught) },
    };
  }
}

function buildRequestInit(
  options: M3LConsoleRequestOptions | undefined,
  bodyString: string | undefined,
): RequestInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bodyString !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options?.correlationId !== undefined) {
    headers["x-correlation-id"] = options.correlationId;
  }
  return {
    headers,
    ...(options?.method !== undefined && { method: options.method }),
    ...(bodyString !== undefined && { body: bodyString }),
  };
}

/**
 * Fetches `path` and decodes the JSON body as `T`, never throwing.
 *
 * @example
 * ```ts
 * import { fetchConsoleJson } from "@m3l-automation/m3l-console-web/api/client.js";
 *
 * const result = await fetchConsoleJson<{ status: string }>("/health");
 * if (result.ok) {
 *   console.log(result.data.status);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 *
 * @example
 * Launching a run with a JSON body and a correlation id:
 * ```ts
 * import { fetchConsoleJson } from "@m3l-automation/m3l-console-web/api/client.js";
 *
 * const result = await fetchConsoleJson<{ id: string }>("/api/v1/runs", {
 *   method: "POST",
 *   body: { scriptName: "json-etl" },
 *   correlationId: "corr-42",
 * });
 * ```
 */
export async function fetchConsoleJson<T>(
  path: string,
  options?: M3LConsoleRequestOptions,
): Promise<M3LConsoleFetchResult<T>> {
  const serialized = serializeRequestBody(options?.body);
  if (!serialized.ok) {
    return { ok: false, error: serialized.error };
  }
  const init = buildRequestInit(options, serialized.bodyString);

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (caught) {
    return {
      ok: false,
      error: { kind: "network", message: deriveErrorMessage(caught) },
    };
  }

  if (!response.ok) {
    return { ok: false, error: await buildHttpError(response) };
  }

  try {
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (caught) {
    return {
      ok: false,
      error: { kind: "malformed-body", message: deriveErrorMessage(caught) },
    };
  }
}
