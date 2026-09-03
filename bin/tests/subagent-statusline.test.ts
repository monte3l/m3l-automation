import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { displayWidth } from "../../.claude/hooks/statusline-layout.mjs";
import {
  GREEN,
  YELLOW,
  RED,
  DIM,
  RESET,
  formatTokenCount,
} from "../../.claude/hooks/statusline-context-pressure.mjs";
import {
  ELAPSED_WARN_THRESHOLD_SEC,
  ELAPSED_HIGH_THRESHOLD_SEC,
  parseStartTime,
  formatElapsed,
  elapsedColor,
  formatTokenFraction,
  formatEffort,
  formatSubagentRow,
} from "../../.claude/hooks/subagent-statusline.mjs";

describe("ELAPSED_WARN_THRESHOLD_SEC", () => {
  test("is 900 (15 minutes)", () => {
    expect(ELAPSED_WARN_THRESHOLD_SEC).toBe(900);
  });
});

describe("ELAPSED_HIGH_THRESHOLD_SEC", () => {
  test("is 1800 (30 minutes)", () => {
    expect(ELAPSED_HIGH_THRESHOLD_SEC).toBe(1800);
  });
});

describe("parseStartTime", () => {
  test("returns the value unchanged for an epoch-ms number", () => {
    expect(parseStartTime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  test("parses an ISO string to its epoch-ms equivalent", () => {
    const iso = "2026-09-02T00:00:00.000Z";
    expect(parseStartTime(iso)).toBe(Date.parse(iso));
  });

  test("returns null for an invalid date string", () => {
    expect(parseStartTime("not-a-date")).toBeNull();
  });

  test("returns null for NaN", () => {
    expect(parseStartTime(Number.NaN)).toBeNull();
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["an object", { foo: "bar" }],
  ])("returns null for %s", (_description, value) => {
    expect(parseStartTime(value)).toBeNull();
  });
});

describe("formatElapsed", () => {
  test.each([
    [0, "0m"],
    [59, "0m"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h00m"],
    [3900, "1h05m"],
  ])("formats %i seconds as %s", (elapsedSec, expected) => {
    expect(formatElapsed(elapsedSec)).toBe(expected);
  });

  test("clamps negative input to 0", () => {
    expect(formatElapsed(-500)).toBe("0m");
  });
});

describe("elapsedColor", () => {
  test("is GREEN just under the warn threshold", () => {
    expect(elapsedColor(ELAPSED_WARN_THRESHOLD_SEC - 1)).toBe(GREEN);
  });

  test("is YELLOW exactly at the warn threshold", () => {
    expect(elapsedColor(ELAPSED_WARN_THRESHOLD_SEC)).toBe(YELLOW);
  });

  test("is YELLOW just under the high threshold", () => {
    expect(elapsedColor(ELAPSED_HIGH_THRESHOLD_SEC - 1)).toBe(YELLOW);
  });

  test("is RED exactly at the high threshold", () => {
    expect(elapsedColor(ELAPSED_HIGH_THRESHOLD_SEC)).toBe(RED);
  });
});

describe("formatTokenFraction", () => {
  test("formats both present and valid figures, including percentage rounding", () => {
    expect(formatTokenFraction(1, 3)).toBe("1/3 (33%)");
  });

  test("returns null when tokenCount is missing", () => {
    expect(formatTokenFraction(undefined, 1000)).toBeNull();
  });

  test("returns null when tokenCount is not a number", () => {
    expect(formatTokenFraction("50000", 1000)).toBeNull();
  });

  test("returns null when contextWindowSize is missing", () => {
    expect(formatTokenFraction(500, undefined)).toBeNull();
  });

  test("returns null when contextWindowSize is not a number", () => {
    expect(formatTokenFraction(500, "1000")).toBeNull();
  });

  test("returns null when contextWindowSize is zero", () => {
    expect(formatTokenFraction(500, 0)).toBeNull();
  });

  test("returns null when contextWindowSize is negative", () => {
    expect(formatTokenFraction(500, -1)).toBeNull();
  });

  test("returns null when contextWindowSize is non-finite (Infinity)", () => {
    expect(formatTokenFraction(500, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatEffort", () => {
  test("returns a non-empty effort-level string unchanged", () => {
    expect(formatEffort("high")).toBe("high");
  });

  test("returns null for an empty string", () => {
    expect(formatEffort("")).toBeNull();
  });

  test("formats a finite number through formatTokenCount", () => {
    expect(formatEffort(5000)).toBe(formatTokenCount(5000));
  });

  test("returns null for NaN", () => {
    expect(formatEffort(Number.NaN)).toBeNull();
  });

  test("returns null for Infinity", () => {
    expect(formatEffort(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("returns null for %s", (_description, value) => {
    expect(formatEffort(value)).toBeNull();
  });
});

describe("formatSubagentRow", () => {
  const now = 1_700_000_000_000;

  test("composes name, effort, token fraction, and a colored elapsed segment, separated by the dim separator", () => {
    const task = {
      id: "task-1",
      name: "code-implementer",
      effort: "high",
      startTime: new Date(now - 5 * 60 * 1000).toISOString(),
      tokenCount: 50_000,
      contextWindowSize: 200_000,
    };

    const result = formatSubagentRow(task, { now });

    const separator = `${DIM} · ${RESET}`;
    const expectedContent = [
      "code-implementer",
      "high",
      "50k/200k (25%)",
      `${GREEN}5m${RESET}`,
    ].join(separator);

    expect(result).toEqual({ id: "task-1", content: expectedContent });
  });

  test("returns null when id is missing", () => {
    const task = { name: "code-implementer" };
    expect(formatSubagentRow(task, { now })).toBeNull();
  });

  test("returns null when name is missing", () => {
    const task = { id: "task-1" };
    expect(formatSubagentRow(task, { now })).toBeNull();
  });

  test("returns null when name is an empty string", () => {
    const task = { id: "task-1", name: "" };
    expect(formatSubagentRow(task, { now })).toBeNull();
  });

  test("renders just the name, with no trailing separators, when only name and id are present", () => {
    const task = { id: "task-1", name: "code-implementer" };
    expect(formatSubagentRow(task, { now })).toEqual({
      id: "task-1",
      content: "code-implementer",
    });
  });

  test("omits the elapsed segment (no color, no crash) when startTime is unparseable", () => {
    const task = {
      id: "task-1",
      name: "code-implementer",
      startTime: "not-a-date",
    };
    expect(formatSubagentRow(task, { now })).toEqual({
      id: "task-1",
      content: "code-implementer",
    });
  });

  test.each([
    ["null", null],
    ["a string", "code-implementer"],
    ["an array", ["code-implementer"]],
  ])("returns null for a non-object task (%s)", (_description, value) => {
    expect(formatSubagentRow(value, { now })).toBeNull();
  });
});

describe("CLI entry (real child process)", () => {
  const scriptPath = fileURLToPath(
    new URL("../../.claude/hooks/subagent-statusline.mjs", import.meta.url),
  );
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

  function runCli(input: string): string {
    return execFileSync("node", [scriptPath], {
      input,
      cwd: repoRoot,
      encoding: "utf8",
    });
  }

  test("emits one NDJSON line with the right id for a payload with one full task", () => {
    const stdout = runCli(
      JSON.stringify({
        tasks: [{ id: "task-1", name: "code-implementer" }],
      }),
    );

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: "task-1" });
  });

  test("produces empty stdout for an empty tasks array", () => {
    const stdout = runCli(JSON.stringify({ tasks: [] }));
    expect(stdout).toBe("");
  });

  test("produces empty stdout and exits 0 on malformed JSON stdin", () => {
    const stdout = runCli("{ this is not json");
    expect(stdout).toBe("");
  });

  test("omits a task missing name entirely, while a sibling valid task still gets its override line", () => {
    const stdout = runCli(
      JSON.stringify({
        tasks: [
          { id: "bad-task" },
          { id: "good-task", name: "code-implementer" },
        ],
      }),
    );

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: "good-task" });
  });

  test("truncates a long content string to fit a narrow columns value", () => {
    const columns = 15;
    const stdout = runCli(
      JSON.stringify({
        columns,
        tasks: [
          {
            id: "task-1",
            name: "a-very-long-descriptive-subagent-name-that-exceeds-the-width",
          },
        ],
      }),
    );

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as {
      id: string;
      content: string;
    };
    expect(displayWidth(parsed.content)).toBeLessThanOrEqual(columns);
  });
});
