/**
 * `http/origin-guard` — the DNS-rebinding control on every inbound request
 * (ADR-0071).
 *
 * MEASURED on Node v26.7.0: a request carrying `Host: evil.example` reaches
 * a `node:http` request listener with a 200 — Node does nothing to validate
 * the `Host` header against the address it actually bound. This guard is
 * therefore the ONLY control against DNS rebinding, not a second layer atop
 * some platform default.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import {
  isAcceptedRequestHostname,
  unwrapBracketedHost,
} from "../net/loopback.js";
import type { M3LConsoleHandler, M3LConsoleMiddleware } from "./middleware.js";
import type { M3LRequestContext } from "./context.js";
import type { M3LConsoleResult } from "./stream-response.js";

/** The literal string a sandboxed/`file://` origin sends — not a nullish value. */
const NULL_ORIGIN = "null";

/**
 * Returns `true` when `value` is one or more ASCII digits — the only shape a
 * real port number can take. An empty string is rejected:
 * `Host: 127.0.0.1:` names no port at all, not a droppable one.
 */
function isDigitsOnly(value: string): boolean {
  return value.length > 0 && /^[0-9]+$/.test(value);
}

/**
 * Strips an optional trailing `:port` from `authority`, returning the bare
 * hostname. Bracket-aware: an IPv6 literal such as `[::1]:8787` carries its
 * own colons, so the port is only ever the segment after the closing `]` —
 * {@link unwrapBracketedHost} handles the bracketed form once the port (if
 * any) has been split off.
 *
 * The port's *value* is deliberately discarded rather than compared: see
 * {@link createOriginGuard}'s module-level rationale for why this guard
 * never compares it. Its *shape* is still validated — a security audit
 * measured `Host: 127.0.0.1:8787.evil.example` and
 * `Host: localhost:80.evil.example` being served 200: naively splitting at
 * the last colon silently drops a bogus, non-numeric "port" and lets the
 * attacker hostname pass the loopback check underneath it. When the suffix
 * after the colon (or after a bracketed IPv6 literal) is not entirely
 * digits, the authority is malformed and this throws
 * `ERR_CONSOLE_BAD_REQUEST` rather than falling back to treating the whole
 * string as a hostname.
 */
function extractHostname(authority: string): string {
  if (authority.startsWith("[")) {
    const closeBracket = authority.indexOf("]");
    if (closeBracket === -1) return unwrapBracketedHost(authority);
    const suffix = authority.slice(closeBracket + 1);
    const hasValidPort =
      suffix === "" ||
      (suffix.startsWith(":") && isDigitsOnly(suffix.slice(1)));
    if (!hasValidPort) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_BAD_REQUEST",
        "request Host header has a malformed port suffix",
      );
    }
    return unwrapBracketedHost(authority.slice(0, closeBracket + 1));
  }
  const lastColon = authority.lastIndexOf(":");
  if (lastColon === -1) return authority;
  if (!isDigitsOnly(authority.slice(lastColon + 1))) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request Host header has a malformed port suffix",
    );
  }
  return authority.slice(0, lastColon);
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` unless `headers.host` is present and its
 * hostname (port stripped) satisfies {@link isAcceptedRequestHostname}. Never echoes
 * the raw header value in the thrown message.
 */
function assertLoopbackHost(
  headers: Readonly<Record<string, string | undefined>>,
): void {
  const host = headers["host"];
  if (host === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request is missing a Host header",
    );
  }
  const hostname = extractHostname(host);
  if (!isAcceptedRequestHostname(hostname)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request Host header does not resolve to a loopback address",
    );
  }
}

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` when `headers.origin` is present and
 * fails the loopback check. An absent `Origin` is allowed (curl and
 * same-origin navigations often omit it). The literal string `"null"` — the
 * value a sandboxed iframe or a `file://` document sends — is rejected
 * outright rather than parsed, since it is exactly the rebinding case this
 * guard exists to catch. An `Origin` that fails to parse as a URL is
 * rejected, not silently ignored.
 */
function assertLoopbackOriginIfPresent(
  headers: Readonly<Record<string, string | undefined>>,
): void {
  const origin = headers["origin"];
  if (origin === undefined) return;

  if (origin === NULL_ORIGIN) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request Origin header is the sandboxed/file:// literal 'null'",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request Origin header could not be parsed as a url",
      { cause },
    );
  }

  if (!isAcceptedRequestHostname(parsed.hostname)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "request Origin header does not resolve to a loopback address",
    );
  }
}

/**
 * Builds the `preRouting` middleware that guards against DNS rebinding: it
 * requires a `Host` header whose hostname (an optional `:port` suffix is
 * stripped, never compared) satisfies {@link isAcceptedRequestHostname}, and,
 * when an `Origin` header is present, requires it too to parse as a loopback
 * URL. See {@link isAcceptedRequestHostname}'s TSDoc for why the port is
 * deliberately never compared (a DNS-rebinding attack forges only the
 * hostname, and ADR-0071's Docker Compose deployment relies on a legitimate
 * published-port remap).
 *
 * @returns A {@link M3LConsoleMiddleware} that throws
 *   {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` on a
 *   failing request and otherwise calls `next` unchanged. Never echoes a raw
 *   header value in its thrown message.
 *
 * @example
 * ```ts
 * import { createOriginGuard } from "@m3l-automation/m3l-console-server/http/origin-guard.js";
 *
 * const guard = createOriginGuard();
 * ```
 */
export function createOriginGuard(): M3LConsoleMiddleware {
  return (
    ctx: M3LRequestContext,
    next: M3LConsoleHandler,
  ): Promise<M3LConsoleResult> | M3LConsoleResult => {
    assertLoopbackHost(ctx.headers);
    assertLoopbackOriginIfPresent(ctx.headers);
    return next(ctx);
  };
}
