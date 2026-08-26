/**
 * `core/cli-contract/output` — the operator-facing writer port a host hands to
 * a hosted command.
 *
 * Only the *shape* is promoted into the library. The rendering half —
 * colourisation, TTY detection, terminal-escape sanitisation — stays private
 * to `packages/m3l-cli` (ADR-0054), so nothing here renders anything.
 *
 * No writable-stream shape (`M3LCommandOutputStream`) ships here. Nothing in
 * {@link M3LCommandOutput} or the rest of the contract names such a type, so
 * its only consumer would be the CLI's future in-process stream binder — one
 * speculative consumer, which is exactly the argument used to defer a
 * descriptor guard (`isM3LCommandModule`). It lands with that binder as a
 * second additive minor: adding an export later is additive, removing one is
 * breaking, so the speculative direction is the risky one.
 *
 * @packageDocumentation
 */

/**
 * The operator-facing writer a hosted command renders human-readable text
 * through.
 *
 * A command writes through this port rather than `process.stdout` so its
 * output inherits the host's TTY, `NO_COLOR`, and redaction handling — an
 * in-process command that reached for the real stream would bypass all three
 * and could not be captured by a test or by an orchestrating parent.
 *
 * `colorEnabled` is exposed (rather than hidden behind the writer) because a
 * command sometimes has to choose *what* to emit, not just how it is
 * decorated — e.g. a box-drawing table versus a plain one.
 *
 * @example
 * ```ts
 * import type { M3LCommandOutput } from "@m3l-automation/m3l-common/core";
 *
 * function report(output: M3LCommandOutput, rows: number): void {
 *   output.heading("Export");
 *   output.info(`wrote ${String(rows)} rows`);
 * }
 * ```
 */
export interface M3LCommandOutput {
  /**
   * Whether the host resolved colour output as enabled for the **stdout**
   * channel — the one {@link M3LCommandOutput.info} and
   * {@link M3LCommandOutput.heading} write to.
   *
   * The shape this promotes resolves colour *per stream*, so a host whose
   * stdout is a TTY and whose stderr is not will style `info`/`heading` while
   * leaving {@link M3LCommandOutput.error} unstyled; a command reading this
   * flag to decide what to emit on the error channel gets the stdout answer.
   * Per-channel resolution is deliberately not exposed — a command should not
   * be branching on it.
   */
  readonly colorEnabled: boolean;
  /** Writes an informational line. */
  info(text: string): void;
  /** Writes an error line — routed to the host's error sink. */
  error(text: string): void;
  /** Writes a section heading. */
  heading(text: string): void;
}
