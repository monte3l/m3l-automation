/**
 * `core/cli-contract/types` — the descriptor a script exports, the port bag a
 * host supplies to it, and the discriminated result it resolves to.
 *
 * These types are the whole seam: a host may run an opted-in script
 * in-process instead of spawning `dist/main.js` and reading an integer off a
 * dead child (ADR-0054). They live in `m3l-common` rather than `m3l-cli`
 * because ADR-0029 fixes the dependency direction — a descriptor type owned
 * by the CLI would invert it.
 *
 * @packageDocumentation
 */

import type { M3LConfigParameter } from "../config/M3LConfigParameter.js";
import type { M3LLogger } from "../logging/M3LLogger.js";

import type { M3LCommandOutput } from "./output.js";

/**
 * The discriminated result a hosted command's `execute` resolves to.
 *
 * A union rather than a flat bag so `error` is reachable only after narrowing
 * to `"failure"` and `recovered` only after `"partial"` — a
 * `{ status: "success", error }` does not compile. Contrast what this
 * replaces: a bare integer exit code carrying no evidence of what produced it.
 *
 * The `status` vocabulary is deliberately identical to `core/diagnostics`'
 * `M3LRunOutcome` (pinned in `exit-codes.ts`) so an in-process run and a run
 * report describe the same event with the same word.
 *
 * A non-positive or non-integer `recovered` stays representable and is *not*
 * typed away — `{ status: "partial", recovered: 0 }` is the obvious lie, but
 * `-3` and `1.5` compile just as readily. Making any of them unrepresentable
 * would need a branded positive integer and a runtime smart constructor, new
 * public surface for a case that degrades gracefully — the exit code keys off
 * `status` alone, so such an outcome is mislabelled, never miscoded.
 *
 * @example
 * ```ts
 * import type { M3LCommandOutcome } from "@m3l-automation/m3l-common/core";
 *
 * function describe(outcome: M3LCommandOutcome): string {
 *   return outcome.status === "partial"
 *     ? `absorbed ${String(outcome.recovered)} failures`
 *     : outcome.status;
 * }
 * ```
 */
export type M3LCommandOutcome =
  | { readonly status: "success" }
  | { readonly status: "dry-run" }
  | { readonly status: "interrupted" }
  | { readonly status: "partial"; readonly recovered: number }
  | { readonly status: "failure"; readonly error: unknown };

/**
 * The port bag a host supplies to {@link M3LCommandModule.execute}.
 *
 * Every field is a *port*, never an ambient global: a hosted command that
 * reached for `process.stdout`, `process.env`, or its own `AbortController`
 * would be uncapturable and uncancellable from the host that invoked it.
 *
 * @example
 * ```ts
 * import type { M3LCommandContext } from "@m3l-automation/m3l-common/core";
 *
 * function shouldStop(context: M3LCommandContext): boolean {
 *   return context.signal !== undefined && context.signal.aborted;
 * }
 * ```
 */
export interface M3LCommandContext {
  /** The operator-facing writer; see {@link M3LCommandOutput}. */
  readonly output: M3LCommandOutput;
  /**
   * `core/logging`'s existing logger, assignable straight into
   * `M3LScriptOptions.logger`. A host routes command logs into its own stream
   * by implementing `core/logging`'s `M3LLoggerHandler` port, so no logging
   * symbol is promoted here.
   */
  readonly logger: M3LLogger;
  /**
   * The cooperative cancellation signal (ADR-0049), or `undefined` when the
   * host offers none.
   *
   * A *required* property holding `AbortSignal | undefined` rather than an
   * optional key — the `M3LProcedureContext.signal` convention. Under
   * `exactOptionalPropertyTypes` an optional key lets a host-side helper
   * forget the field exists; the required form forces the narrow. This
   * differs from `M3LPollerOptions.signal?`, which is a *caller-built*
   * options bag where omission legitimately means "no cancellation"; a
   * context is host-built and handed to callee code, so the stricter form
   * applies.
   */
  readonly signal: AbortSignal | undefined;
  /**
   * Whether this invocation must perform no real work.
   *
   * Required, mirroring `M3LScriptHookContext.dryRun`: `false` is meaningful
   * information (this invocation does perform real work), not an absence of
   * it, so a command branches on it directly without a `?? false` at every
   * call site.
   */
  readonly dryRun: boolean;
}

/**
 * The descriptor a script exports so a host can invoke it in-process.
 *
 * `name` and `version` are flat rather than nested under an `identity` object
 * so that an `M3LCommandModule` **is** structurally an `M3LScriptMetadata` —
 * the adopting script passes the descriptor straight into
 * `new M3LScript({ metadata })` with no adapter and no second source of truth
 * for its own name.
 *
 * A host holding an *arbitrary* descriptor must name it
 * `M3LCommandModule<object>`. The bare `M3LCommandModule` cannot serve as the
 * "any module" type: it defaults `TParameters` to `Record<string, never>`, and
 * a concrete interface is not assignable to that (TS2375 — no index
 * signature). `execute` is declared with method syntax and is therefore
 * *bivariant*, so `M3LCommandModule<object>` does accept a descriptor with a
 * concrete parameter shape — which also means the generic is erased at the
 * host boundary, not merely unenforced against the author's own schema.
 *
 * `TParameters` is deliberately *not* derived from `configParameters`:
 * `M3LConfigParameter` is a runtime class, not a const-generic declaration,
 * so its names and coerced types are not liftable into a mapped type.
 *
 * Nothing here proves that a given `execute` composed `M3LScript`/`runScript`
 * — this module cannot even name them (an ADR-0009 layering zone forbids any
 * `core/**` module from importing `core/script`). ADR-0054's parity guarantee
 * is enforced by the adopting script's shape and by `check:script-scaffold`,
 * not by these types.
 *
 * @example
 * ```ts
 * import type {
 *   M3LCommandModule,
 *   M3LCommandOutcome,
 * } from "@m3l-automation/m3l-common/core";
 *
 * interface ExportParameters {
 *   readonly bucket: string;
 * }
 *
 * export const commandModule: M3LCommandModule<ExportParameters> = {
 *   name: "s3-export",
 *   version: "1.0.0",
 *   description: "Exports a bucket listing to CSV.",
 *   configParameters,
 *   async execute(parameters, context): Promise<M3LCommandOutcome> {
 *     if (context.dryRun) {
 *       context.output.info(`Would export ${parameters.bucket}.`);
 *       return { status: "dry-run" };
 *     }
 *     try {
 *       await exportBucket(parameters, { signal: context.signal });
 *       return { status: "success" };
 *     } catch (error: unknown) {
 *       return { status: "failure", error };
 *     }
 *   },
 * };
 * ```
 */
export interface M3LCommandModule<
  TParameters extends object = Record<string, never>,
> {
  /**
   * The command's name. A bare `string`: reserved-name and slug rules live in
   * `packages/m3l-cli`, and importing them would invert ADR-0029.
   */
  readonly name: string;
  /** The command's version string, e.g. `"1.0.0"`. */
  readonly version: string;
  /** A one-line summary a host renders in help output. */
  readonly description?: string;
  /**
   * The command's declared configuration parameters — the existing seam,
   * unchanged. Because {@link M3LConfigParameter} carries private fields it
   * is *nominal*, so only a value that went through the constructor (with its
   * eager `defaultValue` validation) can appear here; a hand-rolled
   * `{ name, type }` literal is rejected.
   */
  readonly configParameters: readonly M3LConfigParameter[];
  /**
   * Runs the command and **resolves an outcome**.
   *
   * It does not throw to signal failure and it never calls `process.exit` —
   * in-process, either would take the host down with it. `Promise<void>` is
   * not assignable, so a command cannot finish without declaring what
   * happened.
   */
  execute(
    parameters: TParameters,
    context: M3LCommandContext,
  ): Promise<M3LCommandOutcome>;
}
