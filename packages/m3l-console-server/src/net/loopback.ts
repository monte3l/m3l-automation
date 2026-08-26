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
