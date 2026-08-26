/**
 * `core/cli-contract/output` — the operator-facing writer port a host hands to
 * a hosted command.
 *
 * Only the *shape* is promoted into the library. The rendering half —
 * colourisation, TTY detection, terminal-escape sanitisation — stays private
 * to `packages/m3l-cli` (ADR-0054), so nothing here renders anything.
 *
 * A writable-stream shape ({@link M3LCommandOutputStream}) *does* now ship
 * here, reversing this module's earlier deferral. Be precise about why: **one**
 * consumer exists in this slice — the three pilot scripts whose byte-identical
 * private `consoleOutput` const {@link createCommandOutput} replaces. The
 * second, `packages/m3l-cli`'s in-process command host, is committed for U7's
 * next slice and is **not** in this diff. So this port ships one slice ahead of
 * the host that binds it, deliberately: the host is written *against* this
 * shape rather than the shape being extracted from it afterwards. Since adding
 * an export later is additive and removing one is breaking, that ordering is
 * the risk taken here — it should not be read as an already-satisfied
 * two-consumer bar.
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

/**
 * The minimal writable-stream shape {@link createCommandOutput} writes
 * through.
 *
 * Deliberately structural and two-membered rather than `NodeJS.WriteStream`:
 * a host binds an in-memory collector, a socket, or a log buffer here just as
 * readily as a process stream, and the wider Node type would force every one
 * of those to implement a stream's whole surface.
 *
 * `write` returns `unknown`, not `boolean`: `process.stdout.write` reports
 * back-pressure that way, but a collector stub legitimately returns `void`,
 * and this port never consults the answer.
 *
 * @example
 * ```ts
 * import type { M3LCommandOutputStream } from "@m3l-automation/m3l-common/core";
 *
 * const collected: string[] = [];
 * const stream: M3LCommandOutputStream = {
 *   write(text: string): void {
 *     collected.push(text);
 *   },
 * };
 * ```
 */
export interface M3LCommandOutputStream {
  /** Writes `text` verbatim — the caller has already appended any newline. */
  write(text: string): unknown;
  /**
   * Whether this stream is attached to a terminal, when the stream knows.
   * Absent (not merely `false`) on a non-TTY stream, which is why the member
   * is optional. Nothing in this module reads it — TTY resolution stays
   * private to `packages/m3l-cli` (ADR-0054) — but a host binding a real
   * `process.stdout` here should not have to strip the property.
   */
  readonly isTTY?: boolean | undefined;
}

/**
 * The options bag {@link createCommandOutput} accepts. Every member is
 * optional; `createCommandOutput()` with no argument is the supported
 * "just write to the process streams" form.
 *
 * @example
 * ```ts
 * import type { M3LCommandOutputOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LCommandOutputOptions = { colorEnabled: true };
 * ```
 */
export interface M3LCommandOutputOptions {
  /** The sink `info`/`heading` write to. Defaults to `process.stdout`. */
  readonly stdout?: M3LCommandOutputStream;
  /** The sink `error` writes to. Defaults to `process.stderr`. */
  readonly stderr?: M3LCommandOutputStream;
  /**
   * The value the built port reports as {@link M3LCommandOutput.colorEnabled}.
   * Defaults to `false`: this module resolves nothing about the terminal, so
   * a TTY-flagged stream does not enable colour on its own.
   */
  readonly colorEnabled?: boolean;
}

/**
 * Writes `text` plus a trailing newline to `stream`, falling back to
 * `fallback()` when the caller bound no stream of its own.
 *
 * The fallback is a thunk rather than a value so `process.stdout` is read at
 * write time, never captured when the port was built: a host that swaps or
 * spies the stream after building the port must still be observed.
 */
function writeLine(
  stream: M3LCommandOutputStream | undefined,
  fallback: () => M3LCommandOutputStream,
  text: string,
): void {
  (stream ?? fallback()).write(`${text}\n`);
}

/**
 * Builds an {@link M3LCommandOutput} over caller-supplied streams, defaulting
 * to `process.stdout`/`process.stderr`.
 *
 * This replaces the byte-identical private `consoleOutput` const three pilot
 * scripts each carried: a command needs *some* writer when no host bound one
 * (a direct `node dist/command.js` invocation, or a test), and re-declaring
 * the same six-line object per script made the fleet's fallback behaviour
 * three things that merely happened to agree.
 *
 * It renders nothing — no styling, no terminal-escape sanitisation — per
 * ADR-0054, which keeps the rendering half private to `packages/m3l-cli`.
 * `error` always lands on the stderr sink, whatever `colorEnabled` says, so a
 * caller piping stdout never swallows diagnostics.
 *
 * @param options - Optional stream bindings and colour flag.
 * @returns A writer port over those streams.
 *
 * @example
 * ```ts
 * import { createCommandOutput } from "@m3l-automation/m3l-common/core";
 *
 * const output = createCommandOutput();
 * output.heading("Export");
 * output.info("wrote 1200 rows");
 * ```
 */
export function createCommandOutput(
  options?: M3LCommandOutputOptions,
): M3LCommandOutput {
  const toStdout = (text: string): void => {
    writeLine(options?.stdout, () => process.stdout, text);
  };
  return {
    colorEnabled: options?.colorEnabled === true,
    info: toStdout,
    heading: toStdout,
    error(text: string): void {
      writeLine(options?.stderr, () => process.stderr, text);
    },
  };
}
