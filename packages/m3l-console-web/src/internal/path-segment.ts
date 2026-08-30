/**
 * `internal/path-segment` — encodes a single caller-supplied value (a run
 * id, a script name) for safe inclusion as one path segment of a request
 * URL. Private to this package: never re-exported from a public entry
 * point.
 *
 * @packageDocumentation
 */

/**
 * Encodes `segment` for safe inclusion as a single path segment, guarding
 * against the WHATWG URL parser's dot-segment normalisation in addition to
 * the escaping `encodeURIComponent` already provides.
 *
 * `encodeURIComponent` stops a segment from injecting a query string or
 * fragment (`?`, `#`, `/`, and friends all get percent-escaped), but it
 * leaves `.` unescaped — `.` is an RFC 3986 *unreserved* character — so a
 * segment value of exactly `"."` or `".."` round-trips through
 * `encodeURIComponent` unchanged. The URL parser that ultimately resolves
 * the request then recognises that unchanged value as a dot segment and
 * removes it (and, for `".."`, the segment before it) while building the
 * final path, walking it up a level —
 * `new URL("/api/v1/runs/..", base).pathname` is `"/api/v1/"`.
 * Percent-escaping the dots by hand does not close this gap either — the
 * WHATWG URL spec explicitly recognises
 * `"..", ".%2e", "%2e.", "%2e%2e"` (case-insensitively) as the *same*
 * double-dot segment, so a manually-escaped `%2e%2e` collapses identically
 * to the unescaped form. The only way to keep the segment from collapsing
 * is to make sure it is never *exactly* one of those recognised forms in
 * the first place: append a trailing marker to a bare `"."`/`".."` value
 * before the usual encoding runs, so what reaches the URL parser is a
 * segment that is unambiguously *not* a dot segment.
 *
 * @example
 * ```ts
 * encodePathSegment("abc#def"); // => "abc%23def"
 * encodePathSegment(".."); // => "..-" (never collapses to a dot segment)
 * ```
 */
export function encodePathSegment(segment: string): string {
  const collapseSafe =
    segment === "." || segment === ".." ? `${segment}-` : segment;
  return encodeURIComponent(collapseSafe);
}
