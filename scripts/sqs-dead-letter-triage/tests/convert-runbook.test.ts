import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { convertMarkdown } from "../src/steps/convert-runbook.js";
import { parseTriagePreset } from "../src/steps/load-runbook.js";
import { RESERVED_PRIORITY_CEILING } from "../src/steps/preset.js";

// Mirrors load-runbook.ts's own thrown code (see dlq-ops-spec.md's "Error
// codes" section, and tests/load-runbook.test.ts's/validate-runbooks.test.ts's
// own local copies of the same literal). Not exported, so kept local here too
// — the fourth copy; worth centralising the next time a file needs it.
const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";

const paths = new Core.M3LPaths();
const reader = new Core.M3LInputFileReader({ paths, code: PRESET_CODE });

/** Narrows `value`, failing the test with a clear message when absent. */
function definite<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/** A well-formed runbook: title, a stated handling mode, and one valid case row. */
const WELL_FORMED = [
  "# Orders DLQ triage",
  "",
  "Handling: redrive",
  "",
  "| From State | Next State | Verdict |",
  "| ---------- | ---------- | ------- |",
  "| created    | paid       | remove  |",
].join("\n");

describe("convertMarkdown — deriving what the prose actually states", () => {
  it("derives the title, the handling mode, and the case row, with no todo for any of them", () => {
    const { preset, todos } = convertMarkdown(WELL_FORMED, "orders-dlq");
    expect(preset["title"]).toBe("Orders DLQ triage");
    expect(preset["handling"]).toBe("redrive");
    expect(todos.some((todo) => todo.startsWith("title"))).toBe(false);
    expect(todos.some((todo) => todo.startsWith("handling"))).toBe(false);
    expect(
      todos.some((todo) => todo.includes("no known-cases table found")),
    ).toBe(false);
  });

  it("falls back to the queue name for title, with a todo, when there is no '# ' heading", () => {
    const { preset, todos } = convertMarkdown(
      "just prose, no heading",
      "orders-dlq",
    );
    expect(preset["title"]).toBe("orders-dlq");
    expect(todos.some((todo) => todo.includes("title"))).toBe(true);
  });

  // Load-bearing: `runbook` is the one handling mode that makes the script
  // act on a queue automatically. A conversion that cannot find a stated
  // mode in the prose must never guess it — the safe default is a mode that
  // stops at `resolve-mode` rather than one that runs the whole procedure.
  it("[load-bearing] defaults handling to 'under-analysis', never 'runbook', when no mode is stated in the prose", () => {
    const { preset, todos } = convertMarkdown(
      "# Bare queue\n\nNo handling mode mentioned anywhere.",
      "orders-dlq",
    );
    expect(preset["handling"]).toBe("under-analysis");
    expect(preset["handling"]).not.toBe("runbook");
    expect(
      todos.some(
        (todo) => todo.includes("handling") && todo.includes("under-analysis"),
      ),
    ).toBe(true);
  });

  it("does not mistake an incidental mention of a mode word for a declared handling mode", () => {
    // The document's own title says "runbook" but never in a line that also
    // says "handling" — extractHandling must not match on that alone.
    const { preset } = convertMarkdown(
      "# The orders-dlq runbook\n\nThis document is a runbook.",
      "orders-dlq",
    );
    expect(preset["handling"]).toBe("under-analysis");
  });
});

describe("convertMarkdown — case-row derivation never guesses", () => {
  it("skips a row with an unrecognised verdict, recording a todo, rather than emitting a guessed verdict", () => {
    const markdown = [
      "| From State | Next State | Verdict   |",
      "| ---------- | ---------- | --------- |",
      "| created    | paid       | who knows |",
    ].join("\n");
    const { preset, todos } = convertMarkdown(markdown, "orders-dlq");
    const arm = definite(
      (preset["arms"] as readonly Record<string, unknown>[] | undefined)?.[0],
      "arms[0]",
    );
    expect(arm["cases"]).toEqual([]);
    expect(todos.some((todo) => todo.includes("verdict not recognised"))).toBe(
      true,
    );
  });

  it("skips a row with neither a from-state nor a next-state column, recording a todo", () => {
    const markdown = ["| Verdict |", "| ------- |", "| remove  |"].join("\n");
    const { preset, todos } = convertMarkdown(markdown, "orders-dlq");
    const arm = definite(
      (preset["arms"] as readonly Record<string, unknown>[] | undefined)?.[0],
      "arms[0]",
    );
    expect(arm["cases"]).toEqual([]);
    expect(
      todos.some((todo) => todo.includes("no from/next state column found")),
    ).toBe(true);
  });

  it("assigns strictly descending priorities in table order", () => {
    const markdown = [
      "| From State | Next State | Verdict |",
      "| ---------- | ---------- | ------- |",
      "| a          | b          | remove  |",
      "| c          | d          | hold    |",
      "| e          | f          | escalate|",
    ].join("\n");
    const { preset } = convertMarkdown(markdown, "orders-dlq");
    const arm = definite(
      (preset["arms"] as readonly Record<string, unknown>[] | undefined)?.[0],
      "arms[0]",
    );
    const cases = arm["cases"] as readonly Record<string, unknown>[];
    expect(cases).toHaveLength(3);
    const priorities = cases.map((row) => row["priority"] as number);
    expect(priorities.every((value) => value > RESERVED_PRIORITY_CEILING)).toBe(
      true,
    );
    let previous: number | undefined;
    for (const value of priorities) {
      if (previous !== undefined) expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  // Enough rows to certainly cross the reserved-priority floor regardless of
  // the converter's own (unexported) base/step constants, so this test does
  // not need to duplicate those literals to pin an exact row count.
  it("skips a row whose auto-assigned priority would land at or below RESERVED_PRIORITY_CEILING, recording a todo", () => {
    const rows = Array.from(
      { length: 400 },
      (_unused, index) =>
        `| state${String(index)} | next${String(index)} | remove |`,
    );
    const markdown = [
      "| From State | Next State | Verdict |",
      "| ---------- | ---------- | ------- |",
      ...rows,
    ].join("\n");
    const { preset, todos } = convertMarkdown(markdown, "orders-dlq");
    const arm = definite(
      (preset["arms"] as readonly Record<string, unknown>[] | undefined)?.[0],
      "arms[0]",
    );
    const cases = arm["cases"] as readonly Record<string, unknown>[];
    expect(cases.length).toBeLessThan(400);
    for (const row of cases) {
      expect(row["priority"] as number).toBeGreaterThan(
        RESERVED_PRIORITY_CEILING,
      );
    }
    expect(
      todos.some((todo) =>
        todo.includes("too many rows to auto-assign a priority"),
      ),
    ).toBe(true);
  });
});

describe("convertMarkdown — non-derivable structural fields", () => {
  it("records a todo naming each of routeOn, escalateTo, arms[0].key, arms[0].lookup and arms[0].state", () => {
    const { todos } = convertMarkdown(WELL_FORMED, "orders-dlq");
    for (const field of [
      "routeOn",
      "escalateTo",
      "arms[0].key",
      "arms[0].lookup",
      "arms[0].state",
    ]) {
      expect(
        todos.some((todo) => todo.includes(field)),
        `expected a todo naming '${field}'`,
      ).toBe(true);
    }
  });
});

describe("convertMarkdown — round-trip with the trust boundary", () => {
  it("accepts the skeleton once every todo is hand-closed and every named field is filled in", () => {
    const converted = convertMarkdown(WELL_FORMED, "orders-dlq");
    const arm = definite(
      (
        converted.preset["arms"] as
          readonly Record<string, unknown>[] | undefined
      )?.[0],
      "arms[0]",
    );
    const closed: Record<string, unknown> = {
      ...converted.preset,
      routeOn: "detail.eventType",
      escalateTo: "orders-team",
      todos: [],
      arms: [
        {
          ...arm,
          key: { path: "detail.orderId" },
          lookup: [{ label: "orders", table: "orders", keyField: "orderId" }],
          state: { fromState: "status", nextState: "status" },
        },
      ],
    };
    expect(() =>
      parseTriagePreset(reader, closed, "converted.json"),
    ).not.toThrow();
  });
});
