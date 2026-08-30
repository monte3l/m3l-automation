import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { RunLogTail } from "../../src/components/RunLogTail.js";

describe("RunLogTail", () => {
  test("renders buffered lines as literal text, never as markup", () => {
    // `run.line` carries raw, unredacted script stdout — untrusted display
    // data that must never reach the DOM via dangerouslySetInnerHTML.
    const maliciousLine = "<img src=x onerror=alert(1)>";
    render(
      <RunLogTail
        lines={["safe line one", maliciousLine]}
        gapCount={0}
        endReason={null}
      />,
    );

    const tail = screen.getByTestId("run-log-tail");
    expect(tail.textContent).toContain(maliciousLine);
    expect(tail.querySelector("img")).toBeNull();
  });

  test("renders no gap notice when gapCount is 0", () => {
    render(<RunLogTail lines={["line one"]} gapCount={0} endReason={null} />);

    const tail = screen.getByTestId("run-log-tail");
    expect(tail.textContent?.toLowerCase()).not.toContain("gap");
  });

  test("renders a gap notice when gapCount > 0", () => {
    render(<RunLogTail lines={["line one"]} gapCount={2} endReason={null} />);

    const tail = screen.getByTestId("run-log-tail");
    expect(tail.textContent?.toLowerCase()).toContain("gap");
  });

  test("renders no end-reason text when the stream has not ended", () => {
    render(<RunLogTail lines={["line one"]} gapCount={0} endReason={null} />);

    const tail = screen.getByTestId("run-log-tail");
    expect(tail.textContent).not.toContain("completed");
    expect(tail.textContent).not.toContain("draining");
  });

  test.each(["completed", "draining"])(
    "renders the end reason (%s) when ended",
    (reason) => {
      render(
        <RunLogTail lines={["line one"]} gapCount={0} endReason={reason} />,
      );

      const tail = screen.getByTestId("run-log-tail");
      expect(tail.textContent).toContain(reason);
    },
  );

  // [KNOWN BUG] RunLogTail keys its "ended" notice off `endReason !== null`
  // (RunLogTail.tsx:42) rather than off the stream's actual lifecycle phase.
  // The type-design review's `M3LRunStreamState` now has a `phase: "lost"`
  // branch (a dead connection with no stream.end at all) and a
  // `phase: "unavailable"` branch (no EventSource constructor) — neither
  // carries an `endReason`, so a component keyed only on `endReason` shows
  // nothing at all for either: a dead/never-opened stream renders
  // identically to a healthy, still-open one. `RunLogTailProps` needs to
  // carry `phase` itself so every terminal phase — not just "ended" — is
  // reported.
  test("reports the stream as ended when phase is 'lost' (a dead connection), even though no endReason exists for that phase", () => {
    render(
      <RunLogTail
        lines={["line one"]}
        gapCount={0}
        phase="lost"
        endReason={null}
      />,
    );

    const tail = screen.getByTestId("run-log-tail");
    expect(tail.textContent?.toLowerCase()).toContain("ended");
  });

  test("reports the stream as ended when phase is 'unavailable' (no EventSource constructor), even though no endReason exists for that phase either", () => {
    render(
      <RunLogTail
        lines={[]}
        gapCount={0}
        phase="unavailable"
        endReason={null}
      />,
    );

    const tail = screen.getByTestId("run-log-tail");
    expect(tail.textContent?.toLowerCase()).toContain("ended");
  });
});
