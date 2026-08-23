import { afterEach, describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import {
  convertMarkdown,
  convertRunbook,
} from "../src/steps/convert-runbook.js";
import { parseTriagePreset } from "../src/steps/load-runbook.js";
import { RESERVED_PRIORITY_CEILING } from "../src/steps/preset.js";

// Mirrors tests/validate-runbooks.test.ts's node:fs/promises mocking
// harness (the bot's own hint), rather than inventing a fourth mocking
// style — only needed by the `convertRunbook` I/O-wrapper suite below;
// `convertMarkdown`'s existing suite above is pure and untouched.
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");

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

describe("convertMarkdown — auto-assigned priorities are disclosed (finding 5)", () => {
  it("records a todo about the auto-assigned priority for every emitted case row", () => {
    const markdown = [
      "| From State | Next State | Verdict |",
      "| ---------- | ---------- | ------- |",
      "| a          | b          | remove  |",
      "| c          | d          | hold    |",
    ].join("\n");
    const { preset, todos } = convertMarkdown(markdown, "orders-dlq");
    const arm = definite(
      (preset["arms"] as readonly Record<string, unknown>[] | undefined)?.[0],
      "arms[0]",
    );
    const cases = arm["cases"] as readonly Record<string, unknown>[];
    expect(cases).toHaveLength(2);
    const priorityTodos = todos.filter((todo) =>
      todo.toLowerCase().includes("priorit"),
    );
    // At least one todo per emitted row, naming the auto-assignment — never
    // zero, which is what the well-formed round-trip test (above) would have
    // let slip through before this disclosure existed.
    expect(priorityTodos.length).toBeGreaterThanOrEqual(cases.length);
  });

  it("still assigns strictly descending priorities in table order (behaviour unchanged, only the disclosure is added)", () => {
    // Duplicates the existing assertion above by design: this pins that the
    // finding-5 fix is additive (a new todo) and does not alter the
    // priority-assignment behaviour itself.
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
    let previous: number | undefined;
    for (const value of priorities) {
      if (previous !== undefined) expect(value).toBeLessThan(previous);
      previous = value;
    }
  });
});

describe("convertMarkdown — a synthesised description is disclosed (finding 6)", () => {
  it("emits the case and records a todo naming the row when no description column is recognised", () => {
    const markdown = [
      "| From State | Next State | Verdict |",
      "| ---------- | ---------- | ------- |",
      "| created    | paid       | remove  |",
    ].join("\n");
    const { preset, todos } = convertMarkdown(markdown, "orders-dlq");
    const arm = definite(
      (preset["arms"] as readonly Record<string, unknown>[] | undefined)?.[0],
      "arms[0]",
    );
    const cases = arm["cases"] as readonly Record<string, unknown>[];
    // The row is still emitted, never dropped for lacking a description.
    expect(cases).toHaveLength(1);
    expect(cases[0]?.["description"]).toBeDefined();
    expect(
      todos.some(
        (todo) => todo.includes("cases[0]") && todo.includes("description"),
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

// ---------------------------------------------------------------------------
// convertRunbook — the I/O wrapper (reads via the reader, writes via
// M3LJSONFileExporter, mkdir's the destination). convertMarkdown itself is
// already densely covered above; these tests exercise ONLY the wrapping.
// ---------------------------------------------------------------------------

/** A small recording log handler: captures {@link category}/message pairs. */
interface RecordedEvent {
  readonly category: string;
  readonly message: string;
}
function recordingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: readonly RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle(event) {
      events.push({ category: event.category, message: event.message });
    },
    reset() {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events };
}

/** Stubs the source-file read and no-ops the write side (mkdir + JSON export), returning the export spy. */
function stubIo(markdown: string) {
  vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(markdown, "utf8"));
  vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
  const exportSpy = vi
    .spyOn(Core.M3LJSONFileExporter.prototype, "export")
    .mockResolvedValue(undefined);
  return { exportSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("convertRunbook — reads via the reader, writes the skeleton, resolves 'output'", () => {
  it("reads the markdown through the reader, writes the skeleton under the output dir, and returns 'output' defaulted to '<queue>.json'", async () => {
    const { exportSpy } = stubIo(WELL_FORMED);
    const { logger } = recordingLogger();

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/orders-dlq.md",
      queue: undefined,
      output: undefined,
    });

    expect(fsp.readFile).toHaveBeenCalledWith(
      paths.resolveInput("runbooks/orders-dlq.md"),
    );
    expect(result.output).toBe("orders-dlq.json");
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result.preset);
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.dirname(paths.resolveOutput("orders-dlq.json")),
      { recursive: true },
    );
  });

  it("derives the queue from the source file's stem when 'queue' is omitted", async () => {
    stubIo(WELL_FORMED);
    const { logger } = recordingLogger();

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/payments-dlq.md",
      queue: undefined,
      output: undefined,
    });

    expect(result.output).toBe("payments-dlq.json");
    expect((result.preset as Record<string, unknown>)["queue"]).toBe(
      "payments-dlq",
    );
  });

  it("honours an explicit 'output' name, overriding the '<queue>.json' default", async () => {
    stubIo(WELL_FORMED);
    const { logger } = recordingLogger();

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/orders-dlq.md",
      queue: undefined,
      output: "custom-name.json",
    });

    expect(result.output).toBe("custom-name.json");
  });

  it("honours an explicit 'queue', overriding the source-file-stem default", async () => {
    stubIo(WELL_FORMED);
    const { logger } = recordingLogger();

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/anything.md",
      queue: "orders-dlq",
      output: undefined,
    });

    expect(result.output).toBe("orders-dlq.json");
    expect((result.preset as Record<string, unknown>)["queue"]).toBe(
      "orders-dlq",
    );
  });
});

describe("convertRunbook — todo disclosure logging", () => {
  it("logs every todo through logger.warning, and never logs success, when at least one todo remains", async () => {
    stubIo(WELL_FORMED);
    const { logger, events } = recordingLogger();

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/orders-dlq.md",
      queue: undefined,
      output: undefined,
    });

    expect(result.todos.length).toBeGreaterThan(0);
    const warningEvents = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warningEvents).toHaveLength(result.todos.length);
    for (const todo of result.todos) {
      expect(warningEvents.some((event) => event.message.includes(todo))).toBe(
        true,
      );
    }
    expect(
      events.some(
        (event) => event.category === Core.M3LLogEventCategory.SUCCESS,
      ),
    ).toBe(false);
  });

  // ADR-0077: routeOn/escalateTo/the default arm's key/lookup/state are not
  // derivable from prose by design, so convertMarkdown (convert-runbook.ts's
  // non-derivable-fields block) ALWAYS pushes a todo naming each of them,
  // regardless of markdown content. A converted skeleton must therefore
  // never be mistaken for a runnable preset — this is the invariant that
  // stops it. (Confirmed with the coordinator as by-design, not a defect;
  // tracked separately as an open follow-up that convertRunbook's own
  // zero-todo `logger.success` branch is consequently unreachable — that
  // finding is out of this loop's test-coverage scope.)
  it("always leaves structural todos on a well-formed conversion, so a converted skeleton is never runnable as-is", async () => {
    stubIo(WELL_FORMED);
    const { logger, events } = recordingLogger();

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/orders-dlq.md",
      queue: undefined,
      output: undefined,
    });

    expect(result.todos.length).toBeGreaterThan(0);
    for (const field of [
      "routeOn",
      "escalateTo",
      "arms[0].key",
      "arms[0].lookup",
      "arms[0].state",
    ]) {
      expect(
        result.todos.some((todo) => todo.includes(field)),
        `expected a todo naming '${field}'`,
      ).toBe(true);
    }
    expect(
      events.some(
        (event) => event.category === Core.M3LLogEventCategory.WARNING,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.category === Core.M3LLogEventCategory.SUCCESS,
      ),
    ).toBe(false);
  });
});

describe("convertRunbook — failure path", () => {
  it("surfaces an unreadable source file as Core.M3LError under the reader's own code, chaining the raw cause", async () => {
    const cause = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);
    const { logger } = recordingLogger();

    let thrown: unknown;
    try {
      await convertRunbook({
        reader,
        paths,
        logger,
        source: "runbooks/missing.md",
        queue: undefined,
        output: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(PRESET_CODE);
    expect(error.cause).toBe(cause);
  });
});
