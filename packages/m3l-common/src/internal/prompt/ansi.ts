/**
 * `internal/prompt/ansi` — ANSI escape-sequence helpers shared by
 * {@link M3LMultiSpinner} and {@link M3LLoadingBar}.
 *
 * Private to `core/prompt`; never re-exported through a public barrel.
 */

import { M3LExecutionEnvironment } from "../../core/environment/index.js";

/**
 * Determines whether output should render as live, ANSI-redrawn frames.
 *
 * Live mode requires both an interactive execution environment AND a TTY
 * destination stream; either the `interactive` option (when supplied)
 * overrides this auto-detection entirely.
 *
 * @param options - The resolved interactivity signals: `interactiveOption` is
 *   the explicit `interactive` constructor option (if the caller supplied
 *   one; overrides auto-detection), `isEnvironmentInteractive` is the result
 *   of `M3LExecutionEnvironment.isInteractive()`, and `isStreamTTY` is
 *   whether the destination stream is a TTY — both signals read lazily at
 *   call time.
 * @returns `true` when output should use live ANSI rendering.
 */
export function resolveInteractive(options: {
  readonly interactiveOption: boolean | undefined;
  readonly isEnvironmentInteractive: boolean;
  readonly isStreamTTY: boolean;
}): boolean {
  if (options.interactiveOption !== undefined) {
    return options.interactiveOption;
  }
  return options.isEnvironmentInteractive && options.isStreamTTY;
}

/**
 * Resolves the destination stream and the live/plain rendering mode shared
 * by {@link M3LMultiSpinner} and {@link M3LLoadingBar}. Centralizes the
 * "default to `process.stdout`, read lazily" + {@link resolveInteractive}
 * pairing both classes need on every write.
 *
 * @param stream - The constructor-supplied stream, or `undefined` to default
 *   to `process.stdout` — read lazily here, at call time, never captured
 *   at construction.
 * @param interactiveOption - The constructor-supplied `interactive` override,
 *   or `undefined` to auto-detect.
 * @returns The resolved destination `stream` and whether to render `live`
 *   (ANSI-redrawn) frames.
 */
export function resolveRenderTarget(
  stream: NodeJS.WritableStream | undefined,
  interactiveOption: boolean | undefined,
): { readonly stream: NodeJS.WritableStream; readonly live: boolean } {
  const resolvedStream = stream ?? process.stdout;
  const isStreamTTY =
    "isTTY" in resolvedStream ? resolvedStream.isTTY === true : false;
  const live = resolveInteractive({
    interactiveOption,
    isEnvironmentInteractive: M3LExecutionEnvironment.isInteractive(),
    isStreamTTY,
  });
  return { stream: resolvedStream, live };
}
