/**
 * `internal/network/sanitizeRequestUrl` — the shared query-string/fragment
 * stripper used by `core/network/M3LHttpClient` and
 * `core/network/M3LFileDownloader` before a request URL reaches an error
 * message or an `M3LHttpClientError`'s `context`.
 *
 * Private: not re-exported through any public barrel.
 *
 * @packageDocumentation
 */

/**
 * Strips the query string and fragment from `url` before it reaches a
 * thrown error's message or context — a credential passed as a query
 * parameter (`?token=...`) or a URL fragment (`#access_token=...`, the
 * OAuth implicit-flow pattern) must never round-trip through a thrown
 * error.
 *
 * Does not handle userinfo (`user:pass@host`): `M3LHttpClient`'s own
 * `#resolveUrl` rejects any userinfo-bearing URL upfront, before this
 * function is ever reached, so by the time a `url` reaches this function it
 * is already guaranteed not to carry userinfo at all.
 *
 * @param url - The request URL to sanitize.
 * @returns `url` with everything from the first `?` or `#` onward removed;
 *   `url` unchanged when it contains neither.
 *
 * @example
 * ```ts
 * // Internal-only: illustrative shape, not part of the public API.
 * const safe = sanitizeRequestUrl("https://api.example.com/users?token=secret");
 * // "https://api.example.com/users"
 * ```
 */
export function sanitizeRequestUrl(url: string): string {
  const boundaryMatch = /[?#]/.exec(url);
  return boundaryMatch === null ? url : url.slice(0, boundaryMatch.index);
}
