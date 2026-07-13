import { describe, expect, it } from "vitest";

import { planTimeWindows } from "../../src/steps/time-range.js";

/**
 * Contract: docs/reference/scripts/logs-insights.md, `time-range` row. Pure
 * function splitting `[startEpochSeconds, endEpochSeconds)` into an ordered
 * array of fixed-size `{ startTime, endTime }` windows of
 * `windowMinutes * 60` seconds — the final window is shorter when the range
 * doesn't divide evenly. No I/O, so no mocks are needed here.
 */

const START = 1_700_000_000;
const WINDOW_MINUTES = 60;
const WINDOW_SECONDS = WINDOW_MINUTES * 60;

describe("planTimeWindows", () => {
  it("a range smaller than one window produces exactly one (shorter) window", () => {
    const end = START + 1_800; // 30 minutes, half a 60-minute window
    const windows = planTimeWindows(START, end, WINDOW_MINUTES);

    expect(windows).toEqual([{ startTime: START, endTime: end }]);
  });

  it("a range dividing evenly produces no short trailing window", () => {
    const end = START + WINDOW_SECONDS * 3;
    const windows = planTimeWindows(START, end, WINDOW_MINUTES);

    expect(windows).toEqual([
      { startTime: START, endTime: START + WINDOW_SECONDS },
      {
        startTime: START + WINDOW_SECONDS,
        endTime: START + WINDOW_SECONDS * 2,
      },
      {
        startTime: START + WINDOW_SECONDS * 2,
        endTime: START + WINDOW_SECONDS * 3,
      },
    ]);
  });

  it("a range with a remainder produces a shorter final window", () => {
    const remainder = 900; // 15 minutes
    const end = START + WINDOW_SECONDS * 2 + remainder;
    const windows = planTimeWindows(START, end, WINDOW_MINUTES);

    expect(windows).toHaveLength(3);
    expect(windows[2]).toEqual({
      startTime: START + WINDOW_SECONDS * 2,
      endTime: end,
    });
    // Every window except the last is exactly windowMinutes * 60 seconds.
    for (const window of windows.slice(0, -1)) {
      expect(window.endTime - window.startTime).toBe(WINDOW_SECONDS);
    }
  });

  it("windows are contiguous, non-overlapping, and exactly cover [start, end)", () => {
    const remainder = 371; // an arbitrary, non-round remainder
    const end = START + WINDOW_SECONDS * 5 + remainder;
    const windows = planTimeWindows(START, end, WINDOW_MINUTES);

    expect(windows[0]?.startTime).toBe(START);
    expect(windows.at(-1)?.endTime).toBe(end);
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1];
      const current = windows[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous !== undefined && current !== undefined) {
        expect(current.startTime).toBe(previous.endTime);
      }
    }
  });

  it("an empty range (start === end) produces no windows", () => {
    expect(planTimeWindows(START, START, WINDOW_MINUTES)).toEqual([]);
  });
});
