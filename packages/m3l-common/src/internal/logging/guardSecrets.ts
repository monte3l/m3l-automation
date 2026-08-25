/**
 * `internal/logging/guardSecrets` — guards an {@link M3LSecretNamesPort}
 * against a throwing `isSecret` implementation, and reports the resulting
 * failure to stderr.
 *
 * Not exported from any barrel — `internal/` is private API, freely
 * changeable without a semver bump. Shared by every call site that threads a
 * caller-supplied `secrets` port into {@link
 * "../../core/diagnostics/format-error.js".serializeErrorChain} or
 * {@link "../../core/logging/redact.js".redactSensitiveLogValue}: `M3LLogger`
 * (the original owner of this pattern), `M3LRunReporter`, and
 * `M3LBreadcrumbTrail`.
 *
 * @packageDocumentation
 */

import type { M3LSecretNamesPort } from "../../core/logging/redact.js";

/**
 * Writes a best-effort stderr diagnostic for a redaction failure — a hostile
 * `secrets.isSecret` implementation, or a structural failure (circular
 * reference, excessive depth) in the message/data being redacted — mirroring
 * `dispatch()`'s own adjacent per-handler-failure diagnostic convention.
 * Never includes the original message/data, since either may carry the very
 * secret redaction was trying to protect. Wrapped in its own try/catch: a
 * hostile `cause` (a `stack`/`message` getter, or `toString`, that itself
 * throws) must not defeat the very isolation this helper exists to provide —
 * a second-order failure here falls back to a fixed, detail-free line rather
 * than propagating.
 */
export function reportRedactionFailure(context: string, cause: unknown): void {
  try {
    const detail =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    process.stderr.write(
      `m3l-logging: redaction failed while emitting a "${context}" event: ${detail}\n`,
    );
  } catch {
    process.stderr.write(
      `m3l-logging: redaction failed while emitting a "${context}" event (unreadable failure detail)\n`,
    );
  }
}

/**
 * Wraps `secrets` so a throwing `isSecret` implementation can never escape to
 * a caller. This matters beyond `M3LLogger`'s own direct redaction calls: an
 * unguarded `secrets` handed to {@link serializeErrorChain} would throw
 * INSIDE that function's own body, which is wrapped in an unconditional,
 * silent catch-all (`core/diagnostics/format-error.ts`) that swallows the
 * exception and returns a generic placeholder chain — discarding the error's
 * real chain/context with no diagnostic at all. Guarding `isSecret` here
 * means the throw is caught at the call site, reported, and the name is
 * conservatively treated as secret (redacted) rather than the surrounding
 * redaction/serialization step losing everything it was building. A
 * redaction *decision* that can't be trusted should fail toward hiding a
 * value, never toward exposing it.
 */
export function guardSecrets(
  secrets: M3LSecretNamesPort | undefined,
  context: string,
): M3LSecretNamesPort | undefined {
  if (secrets === undefined) return undefined;
  return {
    isSecret: (name: string): boolean => {
      try {
        return secrets.isSecret(name) === true;
      } catch (cause) {
        reportRedactionFailure(context, cause);
        return true;
      }
    },
  };
}
