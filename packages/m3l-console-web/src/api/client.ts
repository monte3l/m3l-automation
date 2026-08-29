import type {
  M3LErrorOrigin,
  M3LErrorRetryable,
} from "@m3l-automation/m3l-common/core/errors";

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
 * fields the server envelope carries, typed against the shared library's
 * leaf error subpath rather than duplicated as ad hoc literal unions.
 */
interface ConsoleErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly correlationId: string;
    readonly origin?: M3LErrorOrigin;
    readonly retryable?: M3LErrorRetryable;
  };
}

const CONSOLE_ERROR_ORIGINS: ReadonlySet<M3LErrorOrigin> = new Set([
  "caller",
  "library",
  "external",
]);

function deriveErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function isValidOrigin(value: unknown): value is M3LErrorOrigin {
  return (
    typeof value === "string" &&
    CONSOLE_ERROR_ORIGINS.has(value as M3LErrorOrigin)
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

function hasValidOptionalClassificationFields(
  candidate: Record<string, unknown>,
): boolean {
  if (
    Object.hasOwn(candidate, "origin") &&
    !isValidOrigin(candidate["origin"])
  ) {
    return false;
  }
  return (
    !Object.hasOwn(candidate, "retryable") ||
    isValidRetryable(candidate["retryable"])
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
  const candidate = error as Record<string, unknown>;
  return (
    hasRequiredErrorFields(candidate) &&
    hasValidOptionalClassificationFields(candidate)
  );
}

async function buildHttpError(
  response: Response,
): Promise<M3LConsoleFetchError> {
  try {
    const body: unknown = await response.json();
    if (isConsoleErrorEnvelope(body)) {
      return {
        kind: "http",
        message: body.error.message,
        status: body.error.status,
        code: body.error.code,
        correlationId: body.error.correlationId,
        ...(body.error.origin !== undefined && { origin: body.error.origin }),
        ...(body.error.retryable !== undefined && {
          retryable: body.error.retryable,
        }),
      };
    }
  } catch {
    // body isn't JSON — fall through to the statusText fallback below
  }
  return {
    kind: "http",
    message: response.statusText,
    status: response.status,
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
 */
export async function fetchConsoleJson<T>(
  path: string,
): Promise<M3LConsoleFetchResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: "application/json" } });
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
