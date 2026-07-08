/**
 * `core/script/M3LPresetCycleError` — thrown by
 * {@link M3LScriptPresetLoader.load} when a preset's `extends` graph forms a
 * cycle, or when an `extends` chain runs pathologically deep.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/** Machine-readable code for {@link M3LPresetCycleError}. */
const PRESET_CYCLE_CODE = "ERR_PRESET_CYCLE";

/**
 * Thrown when {@link M3LScriptPresetLoader.load} detects a cycle in a
 * preset's `extends` graph (a preset that, directly or transitively, extends
 * itself), or an `extends` chain longer than `MAX_PRESET_EXTENDS_DEPTH`
 * (a runaway or pathological chain is treated as a cycle for safety).
 *
 * The ordered list of resolved file paths that form the cycle is available
 * both as a typed, readonly `chain` property (the preferred access path) and,
 * for structured-logging convenience, inside the inherited `context` bag
 * under the same name.
 *
 * @example
 * ```ts
 * import { M3LPresetCycleError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // loader.load(...)
 * } catch (e) {
 *   if (e instanceof M3LPresetCycleError) {
 *     console.error(e.message, e.chain);
 *   }
 * }
 * ```
 */
export class M3LPresetCycleError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_PRESET_CYCLE"`. */
  override readonly code: typeof PRESET_CYCLE_CODE = PRESET_CYCLE_CODE;

  /**
   * The ordered list of resolved absolute file paths that form the cycle (or,
   * for a depth-limit trip, the resolved paths visited up to the limit).
   */
  readonly chain: readonly string[];

  /**
   * Creates a new `M3LPresetCycleError`.
   *
   * @param message - Human-readable description of the failure.
   * @param chain - The ordered list of resolved file paths that form the
   *   cycle (or were visited before the depth limit was reached).
   */
  constructor(message: string, chain: readonly string[]) {
    super(message, { code: PRESET_CYCLE_CODE, context: { chain } });
    this.chain = chain;
  }
}
