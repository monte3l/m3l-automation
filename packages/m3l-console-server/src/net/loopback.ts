/**
 * `net/loopback` — pure network-address predicates for loopback
 * classification (ADR-0071). This module is a layering leaf: it imports
 * nothing else in this package, and is imported by `config/` (validating the
 * requested bind host at boot), `lifecycle/` (re-asserting loopback against
 * the address the server actually bound), and `http/` (the Host/Origin
 * rebinding guard on every inbound request).
 *
 * @packageDocumentation
 */

/** The exact number of dot-separated segments a dotted-decimal IPv4 literal has. */
const IPV4_OCTET_COUNT = 4;
/** The highest valid value of a single IPv4 octet. */
const IPV4_MAX_OCTET = 255;
/** The first octet every address in the `127.0.0.0/8` loopback block carries. */
const LOOPBACK_FIRST_OCTET = "127";

/** Matches a single IPv4 octet's digit-only textual form (1-3 digits). */
const IPV4_OCTET_PATTERN = /^\d{1,3}$/;

/**
 * Returns `true` when `host` is a dotted-decimal IPv4 literal inside the
 * `127.0.0.0/8` loopback block.
 */
function isIPv4Loopback(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== IPV4_OCTET_COUNT) return false;

  const allValid = octets.every((octet) => {
    if (!IPV4_OCTET_PATTERN.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= IPV4_MAX_OCTET;
  });
  return allValid && octets[0] === LOOPBACK_FIRST_OCTET;
}

/**
 * Strips the bracketed URL-authority wrapping (turns `[::1]` into `::1`)
 * from an IPv6 host literal, when present. Returns `host` unchanged
 * otherwise.
 * Shared by {@link isIPv6Loopback} (which tests the unbracketed form) and
 * `resolveHost` (which must *return* the unbracketed form — Node's
 * `net`/`http` binder resolves `[::1]` as a literal, unbindable hostname,
 * not the address `::1`).
 */
export function unwrapBracketedHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Returns `true` when `host` is the IPv6 loopback address, in either its
 * compressed (`::1`) or fully expanded (`0:0:0:0:0:0:0:1`) form, optionally
 * wrapped in the bracketed URL-authority form (`[::1]`).
 */
function isIPv6Loopback(host: string): boolean {
  const unbracketed = unwrapBracketedHost(host);
  return unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1";
}

/**
 * Returns `true` when `host` is a loopback-only address or hostname, per
 * ADR-0071: `localhost` (case-insensitively), any IPv4 literal in
 * `127.0.0.0/8`, or the IPv6 loopback address (compressed, expanded, or
 * bracketed).
 *
 * The accepted set is deliberately narrow and fails closed: forms that are
 * genuinely loopback but not recognized here — `127.1` (short IPv4),
 * `2130706433`/`0x7f000001` (integer/hex IPv4), `::ffff:127.0.0.1`
 * (IPv4-mapped IPv6), `localhost.` (trailing-dot FQDN) — are rejected rather
 * than silently accepted. Widening this set is a conscious follow-up, not an
 * oversight; do not "fix" a rejection of one of these forms without adding
 * it here deliberately.
 *
 * @param host - The candidate host string.
 * @returns `true` when `host` resolves exclusively to the local loopback
 *   interface.
 *
 * @example
 * ```ts
 * isLoopbackHost("127.0.0.1"); // true
 * isLoopbackHost("0.0.0.0"); // false
 * ```
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost") return true;
  if (isIPv6Loopback(normalized)) return true;
  return isIPv4Loopback(normalized);
}

/**
 * Answers "may we request this bind address?" — the intended-exposure
 * question checked at boot, before the process ever binds a socket. Used by
 * `config/env.ts`'s `resolveHost` to reject a non-loopback
 * `M3L_CONSOLE_HOST` before the server is ever started.
 *
 * Delegates entirely to {@link isLoopbackHost} — see its TSDoc for the
 * underlying classification rules (which literal forms count as loopback).
 *
 * @param host - The candidate bind host, as configured.
 * @returns `true` when `host` is a permitted loopback bind target.
 *
 * @example
 * ```ts
 * isPermittedBindHost("127.0.0.1"); // true
 * isPermittedBindHost("0.0.0.0"); // false
 * ```
 */
export function isPermittedBindHost(host: string): boolean {
  return isLoopbackHost(host);
}

/**
 * Answers "did we actually bind somewhere safe?" — the realized-exposure
 * question checked against `server.address()` once `listening` fires,
 * because `listen()` alone does not guarantee a loopback bind: the host
 * string a caller requests is only a *request*, and Node resolves it
 * independently. Used by `lifecycle/http-server.ts`'s
 * `resolveLoopbackAddress`.
 *
 * Observed on Node v26.7.0, on one machine, against a real listener:
 *
 * | `listen` host      | `address().address` | verdict |
 * | ------------------- | -------------------- | ------- |
 * | `127.0.0.1`          | `127.0.0.1`           | accept  |
 * | `localhost`          | `::1`                 | accept  |
 * | `::1`                | `::1`                 | accept  |
 * | `0.0.0.0`            | `0.0.0.0`             | REJECT  |
 * | `::`                 | `::`                  | REJECT  |
 * | *(host omitted)*     | `::`                  | REJECT  |
 *
 * The `localhost` row reflects that one machine, not a universal Node fact:
 * which loopback address `localhost` resolves to is decided by the host's
 * `/etc/hosts` and `getaddrinfo` ordering, so a CI runner, a container, or an
 * IPv6-disabled host can resolve it to `127.0.0.1` instead of `::1`. The
 * `0.0.0.0`, `::`, and *(host omitted)* rows are genuine Node behaviours that
 * hold on every host: omitting the host binds `::` (every interface on the
 * host), which is the likeliest way to accidentally expose the console to
 * the network — the failure mode this predicate exists to catch.
 *
 * The invariant this predicate actually enforces is unconditional, unlike
 * the `localhost` row above: it accepts any loopback form — `127.0.0.1` or
 * `::1` — and rejects everything else, so it behaves correctly whichever
 * address a given host resolves `localhost` to. Rejecting the IPv6 loopback
 * form would break hosts that resolve `localhost` to `::1`, which is why
 * both forms are accepted. This is why the bound address must be re-derived
 * from `server.address()` after bind rather than trusted from the request:
 * the request and the verified result can legitimately differ (the
 * `localhost` row), so only the post-bind address is a fact.
 *
 * Delegates entirely to {@link isLoopbackHost} — see its TSDoc for the
 * underlying classification rules (which literal forms count as loopback).
 *
 * @param host - The `address` field of a real `AddressInfo`, post-bind.
 * @returns `true` when `host` is a verified loopback bind result.
 *
 * @example
 * ```ts
 * isVerifiedBoundAddress("::1"); // true
 * isVerifiedBoundAddress("0.0.0.0"); // false
 * ```
 */
export function isVerifiedBoundAddress(host: string): boolean {
  return isLoopbackHost(host);
}

/**
 * Answers "does this inbound request's `Host`/`Origin` name us
 * acceptably?" — an anti-DNS-rebinding property of the *client's claim*, not
 * our own exposure. Used by `http/origin-guard.ts`'s `assertLoopbackHost`
 * (against the `Host` header) and `assertLoopbackOriginIfPresent` (against a
 * present `Origin` header) on every inbound request.
 *
 * The port carried alongside either header is deliberately never compared
 * here, for two reasons. First, under a DNS-rebinding attack the browser
 * sends the attacker-controlled *hostname* while the connection itself still
 * reaches the real loopback listener — the hostname is the entire signal an
 * attacker can forge; the port carries none of it. Second, ADR-0071 runs the
 * console behind Docker Compose, where a published-to-container port remap
 * (e.g. `9000:8787`) is a normal deployment shape; comparing the port here
 * would reject every legitimate request through such a remap.
 *
 * Delegates entirely to {@link isLoopbackHost} — see its TSDoc for the
 * underlying classification rules (which literal forms count as loopback).
 *
 * @param host - The hostname parsed out of a request's `Host` or `Origin`
 *   header, with any port suffix already stripped.
 * @returns `true` when `host` names an acceptable loopback client claim.
 *
 * @example
 * ```ts
 * isAcceptedRequestHostname("localhost"); // true
 * isAcceptedRequestHostname("evil.example"); // false
 * ```
 */
export function isAcceptedRequestHostname(host: string): boolean {
  return isLoopbackHost(host);
}
