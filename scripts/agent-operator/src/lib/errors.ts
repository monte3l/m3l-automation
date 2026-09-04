/**
 * `lib/errors` — the single script-local error type for `agent-operator`.
 *
 * Every failure this script raises pins one of ten documented codes onto a
 * single `M3LAgentOperatorCliError` class rather than a dedicated subclass
 * per code: the codes differ only in the string that identifies them, not in
 * shape or behaviour, so a subclass hierarchy would add nothing but ceremony
 * a `catch (e) { switch (e.code) }` site already needs to do anyway.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of machine-readable codes `agent-operator` can raise.
 * Every {@link M3LAgentOperatorCliError} is constructed with exactly one of
 * these — narrow on `.code` at a catch site to distinguish failure modes.
 *
 * @example
 * ```ts
 * import type { M3LAgentOperatorErrorCode } from "./errors.js";
 *
 * function isConfigFailure(code: M3LAgentOperatorErrorCode): boolean {
 *   return code === "ERR_AGENT_OPERATOR_CONFIG";
 * }
 * ```
 */
export type M3LAgentOperatorErrorCode =
  | "ERR_AGENT_OPERATOR_CONFIG"
  | "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT"
  | "ERR_AGENT_OPERATOR_CLI_SPAWN"
  | "ERR_AGENT_OPERATOR_CLI_OUTPUT"
  | "ERR_AGENT_OPERATOR_SCRIPT_NAME"
  | "ERR_AGENT_OPERATOR_POLICY"
  // Distinct from `ERR_AGENT_OPERATOR_POLICY` on purpose: "your policy file is
  // invalid" and "the decision log could not record this run" need different
  // remediation, and collapsing both onto one code destroys the discriminant
  // at the only place a catch site would read it. This code covers every way
  // the audit trail itself fails: an unwritable decision-log directory, an
  // entry that would breach the library's single-line byte ceiling, and a
  // dry-run shape-ceiling breach.
  | "ERR_AGENT_OPERATOR_DECISION_LOG"
  // Also distinct from `ERR_AGENT_OPERATOR_POLICY`, and for the same reason
  // read the other way round: `ERR_AGENT_OPERATOR_POLICY` means the policy
  // file is missing, unreadable, malformed, or structurally invalid, whereas
  // this code means the policy worked correctly and declined to auto-approve
  // the run. "Fix your policy file" and "your policy declined this run" call
  // for different responses from an operator and from a catch site.
  | "ERR_AGENT_OPERATOR_ESCALATED"
  // A fourth distinct remediation, and the reason it is not folded onto
  // `ERR_AGENT_OPERATOR_DECISION_LOG`: that code sends an operator to
  // `data/agent-log/`, which in this failure mode is perfectly healthy. The
  // real fault is a DIFFERENT file, in a DIFFERENT directory
  // (`data/agent-state/`), with a different fix — delete the corrupt counter
  // and accept that today's prior spend is forgotten. Named for the concern
  // ("budget state"), not for the file, so a second piece of cross-run
  // budget state needs no code of its own.
  | "ERR_AGENT_OPERATOR_BUDGET_STATE"
  // Deliberately not folded onto `ERR_AGENT_OPERATOR_CONFIG`, because the
  // remediation is a different edit: this code means the operator's
  // `presetAllowlist` declaration is wrong, or the requested preset name is
  // absent from it — the script's config *schema* is satisfied either way. An
  // operator reading `ERR_AGENT_OPERATOR_CONFIG` goes looking for a missing or
  // mistyped parameter; here the parameter is present and well-typed, and the
  // fix is the allowlist entry itself (or the name that was requested).
  | "ERR_AGENT_OPERATOR_PRESET";

/**
 * Fault origin per code — the table that gives this family real exit codes.
 *
 * @remarks
 * Without it every `ERR_AGENT_OPERATOR_*` failure exits **1**
 * (`UNCLASSIFIED`), not the 2/3/4 the README used to claim. The reason is
 * structural: `Core.mapErrorToExitCode` resolves an exit code from a
 * structural `origin` field first and a `core/errors/catalog.ts` lookup by
 * `code` second — and this family sets no `origin` and appears in no catalog
 * (it cannot: the catalog is library-owned, and a script's codes are not the
 * library's business). Both lookups miss, so every failure of this script
 * collapses onto one code and a scheduler cannot tell a bad policy file from
 * an unreachable `m3l` CLI.
 *
 * The split follows ADR-0049's classification by **fault origin**, read for a
 * consumer script:
 *
 * - `"caller"` (exit 2) — the operator's own input is wrong or their policy
 *   declined the run. Re-running unchanged cannot help; edit config or the
 *   policy file. `ERR_AGENT_OPERATOR_ESCALATED` belongs here and not under
 *   `"external"`: the policy worked exactly as written.
 * - `"external"` (exit 3) — something outside this process failed: a spawned
 *   `m3l` child, the decision-log directory, the cross-run counter file.
 *
 * Nothing maps to `"library"` (exit 4). That code means a defect inside
 * `m3l-common`, and this script is never in a position to assert that about
 * its own failures.
 *
 * A per-instance `options.origin` still wins — the constructor only
 * *defaults* from this table — so a call site with better information can
 * override it.
 */
const ORIGIN_BY_CODE: Readonly<
  Record<M3LAgentOperatorErrorCode, Core.M3LErrorOrigin>
> = Object.freeze({
  ERR_AGENT_OPERATOR_CONFIG: "caller",
  ERR_AGENT_OPERATOR_CLI_ENTRYPOINT: "caller",
  ERR_AGENT_OPERATOR_CLI_SPAWN: "external",
  ERR_AGENT_OPERATOR_CLI_OUTPUT: "external",
  ERR_AGENT_OPERATOR_SCRIPT_NAME: "caller",
  ERR_AGENT_OPERATOR_POLICY: "caller",
  ERR_AGENT_OPERATOR_DECISION_LOG: "external",
  ERR_AGENT_OPERATOR_ESCALATED: "caller",
  ERR_AGENT_OPERATOR_BUDGET_STATE: "external",
  ERR_AGENT_OPERATOR_PRESET: "caller",
});

/**
 * Enrichment fields for {@link M3LAgentOperatorCliError}, forwarded verbatim
 * to `Core.M3LError`'s options bag alongside the pinned `code`. Module-private
 * — callers catch `M3LAgentOperatorCliError` instances, they don't construct
 * them with a hand-built options bag, so this type has no reason to be public.
 */
interface M3LAgentOperatorCliErrorOptions {
  /** Structured diagnostic context. Never place raw stdout/stderr, a spawn
   * `error.message`, a filesystem path, or model-supplied text here. */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, if this error wraps another failure. */
  readonly cause?: unknown;
  /**
   * Overrides this instance's origin. Absent, the code's own entry in the
   * module-private origin table applies — see that table for why a default
   * is needed at all.
   */
  readonly origin?: Core.M3LErrorOrigin;
  /** Overrides the catalog-derived retryable classification for this instance. */
  readonly retryable?: Core.M3LErrorRetryable;
}

/**
 * The single error type raised by every `agent-operator` failure path.
 * Extends `Core.M3LError` so a caller can narrow with an `instanceof`
 * check against `Core.M3LError` first, then against
 * `M3LAgentOperatorCliError`, then on `.code` for the specific failure mode —
 * never a bare thrown string.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { M3LAgentOperatorCliError } from "./errors.js";
 *
 * function assertHasName(name: string | undefined): asserts name is string {
 *   if (name === undefined) {
 *     throw new M3LAgentOperatorCliError(
 *       "script name is required",
 *       "ERR_AGENT_OPERATOR_SCRIPT_NAME",
 *     );
 *   }
 * }
 *
 * try {
 *   assertHasName(undefined);
 * } catch (error) {
 *   if (error instanceof Core.M3LError) {
 *     console.error(error.code);
 *   }
 * }
 * ```
 */
export class M3LAgentOperatorCliError extends Core.M3LError {
  /**
   * Re-narrows `Core.M3LError.code` (typed `string` on the base class) down
   * to this class's own closed vocabulary. Declaration-only — it emits no
   * runtime field and adds no assignment; the constructor below already
   * establishes the invariant by always passing one
   * {@link M3LAgentOperatorErrorCode} literal to `super`. Without this, a
   * `switch (error.code)` at a catch site gets no exhaustiveness check and
   * no `never` default, despite the class's own guidance above to narrow on
   * `.code`.
   */
  declare readonly code: M3LAgentOperatorErrorCode;

  /**
   * @param message - Human-readable description of the failure. Must never
   *   echo a spawn `error.message`, a raw filesystem path, or
   *   model-supplied text.
   * @param code - The pinned {@link M3LAgentOperatorErrorCode} identifying
   *   the failure mode.
   * @param options - Optional `context`/`cause`/`origin`/`retryable`
   *   enrichment forwarded to `Core.M3LError`. An absent `origin` is
   *   defaulted from `code` — see the origin table's remarks for why this
   *   script's failures would otherwise all exit `1`.
   */
  constructor(
    message: string,
    code: M3LAgentOperatorErrorCode,
    options?: M3LAgentOperatorCliErrorOptions,
  ) {
    // The spread comes FIRST so an explicit `options.origin` still wins; the
    // table only supplies a default. `origin` is written unconditionally
    // (never a conditional spread) because it always resolves to a real
    // value here — every code has a table entry, and the `Record` type makes
    // a missing one a compile error rather than a silent `undefined`.
    super(message, {
      ...options,
      origin: options?.origin ?? ORIGIN_BY_CODE[code],
      code,
    });
  }
}
