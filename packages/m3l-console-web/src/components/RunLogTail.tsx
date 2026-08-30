import type { ReactElement } from "react";

import type { M3LRunStreamState } from "../hooks/useRunStream.js";

/** Props accepted by {@link RunLogTail}. */
export interface RunLogTailProps {
  /** Buffered `run.line` text, oldest first, as produced by `useRunStream`. */
  readonly lines: readonly string[];
  /** Count of `stream.gap` control frames observed so far. */
  readonly gapCount: number;
  /**
   * Connection lifecycle phase, as produced by `useRunStream`. Optional so
   * a caller that has not adopted the phase-aware contract yet keeps
   * compiling; when omitted, "ended" is still reported from `endReason`
   * alone (the shape this prop replaces).
   */
  readonly phase?: M3LRunStreamState["phase"];
  /** The `stream.end` frame's `reason`, or `null` until the stream ends. */
  readonly endReason: string | null;
}

/**
 * Whether the stream should be reported as ended: any terminal `phase`
 * (`"ended"`, `"lost"`, `"unavailable"`) counts, not just a well-formed
 * `stream.end` — a dead connection with no `stream.end` at all (`"lost"`)
 * or a never-opened stream (`"unavailable"`) must be just as visible to the
 * operator as a normal end, even though neither carries an `endReason`.
 * `endReason !== null` is kept as a fallback for callers that have not
 * threaded `phase` through yet.
 */
function isStreamEnded(
  phase: M3LRunStreamState["phase"] | undefined,
  endReason: string | null,
): boolean {
  return (
    phase === "ended" ||
    phase === "lost" ||
    phase === "unavailable" ||
    endReason !== null
  );
}

/**
 * Renders a run's buffered live-tail output as literal text.
 *
 * `run.line` carries raw, unredacted script stdout — untrusted display data
 * — so every line is rendered through JSX text interpolation and never via
 * `dangerouslySetInnerHTML`; a line containing HTML-looking text (e.g. an
 * `<img onerror=...>` payload echoed by a script) must render as inert text,
 * never as markup.
 *
 * @example
 * ```tsx
 * import { RunLogTail } from "@m3l-automation/m3l-console-web/components/RunLogTail.js";
 *
 * <RunLogTail
 *   lines={["starting…", "done"]}
 *   gapCount={0}
 *   phase="open"
 *   endReason={null}
 * />;
 * ```
 */
export function RunLogTail(props: RunLogTailProps): ReactElement {
  const { lines, gapCount, phase, endReason } = props;
  const ended = isStreamEnded(phase, endReason);

  return (
    <div data-testid="run-log-tail">
      {gapCount > 0 && (
        <p>
          {gapCount === 1
            ? "1 gap detected — resyncing…"
            : `${gapCount} gaps detected — resyncing…`}
        </p>
      )}
      <pre>{lines.join("\n")}</pre>
      {ended && <p>Stream ended{endReason !== null ? `: ${endReason}` : ""}</p>}
    </div>
  );
}
