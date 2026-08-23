import { afterEach, describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import { explainRunbook, presetPathFor } from "../src/steps/explain-runbook.js";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s `explain`
 * operation, backed by `explainRunbook` (`src/steps/explain-runbook.ts`).
 * Mirrors `tests/validate-runbooks.test.ts`'s `node:fs/promises` mocking
 * harness (the bot's own hint), rather than inventing a fourth mocking
 * style for this file.
 *
 * Fixture note: `tests/validate-runbooks.test.ts`, `tests/load-runbook.test.ts`,
 * `tests/build-procedure.test.ts` and `tests/convert-runbook.test.ts` already
 * each carry their own copy of a `baseKey`/`baseArm`/`baseCase`/`validPreset`
 * factory family (flagged in `convert-runbook.test.ts` as "the fourth copy").
 * This file deliberately does NOT add a fifth copy of that factory family —
 * it needs only a handful of one-off preset literals, not a reusable
 * composable-factory surface, so they are written inline below instead.
 */

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");

// Mirrors load-runbook.ts's own thrown code (see the other four test files'
// local copies of the same literal — not exported).
const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";
const paths = new Core.M3LPaths();

/** A minimal, fully valid preset with two authored case rows at distinct priorities. */
const VALID_PRESET: Record<string, unknown> = {
  queue: "orders-dlq",
  title: "Orders DLQ triage",
  handling: "runbook",
  escalateTo: "orders-team",
  routeOn: "eventType",
  envelope: { bodyIsJson: true },
  arms: [
    {
      label: "Default arm",
      key: { path: "detail.orderId" },
      lookup: [{ label: "orders", table: "orders", keyField: "orderId" }],
      onMissing: "hold",
      state: { fromState: "created", nextState: "paid" },
      cases: [
        {
          id: "case-low",
          description: "Low priority case",
          prose: "Low priority prose.",
          priority: 100,
          fromState: "created",
          verdict: "hold",
        },
        {
          id: "case-high",
          description: "High priority case",
          prose: "High priority prose.",
          priority: 500,
          fromState: "created",
          verdict: "escalate",
        },
      ],
    },
  ],
};

/** Structurally invalid: missing every field parseTriagePreset requires beyond 'queue'. */
const MALFORMED_PRESET: Record<string, unknown> = { queue: "orders-dlq" };

/**
 * Loads cleanly (passes every trust-boundary check in load-runbook.ts) but
 * fails only once compiled into a procedure — mirrors
 * validate-runbooks.test.ts's own fixture for this exact "loads but fails
 * build()" path: `(a+)+` is a classic ReDoS-shaped nested-quantifier
 * pattern the procedure engine's own `isPatternSafe` check rejects at
 * `build()` time as `ERR_PROCEDURE_INVALID_PATTERN`, even though it compiles
 * fine and is under the length limit so `parseTriagePreset` accepts it.
 */
const UNSAFE_PATTERN_PRESET: Record<string, unknown> = {
  ...VALID_PRESET,
  arms: [
    {
      label: "Default arm",
      key: { path: "detail.orderId" },
      lookup: [{ label: "orders", table: "orders", keyField: "orderId" }],
      onMissing: "hold",
      state: { fromState: "created", nextState: "paid" },
      cases: [
        {
          id: "case-unsafe",
          description: "Unsafe pattern case",
          prose: "prose",
          priority: 100,
          signature: "(a+)+",
          verdict: "hold",
        },
      ],
    },
  ],
};

/** A small recording log handler: captures {@link category}/message pairs, in emission order. */
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

/** Stubs the one preset file `loadRunbook` reads, regardless of the exact resolved path. */
function stubPresetFile(record: unknown): void {
  vi.spyOn(fsp, "readFile").mockResolvedValue(
    Buffer.from(JSON.stringify(record)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explainRunbook — happy path", () => {
  it("returns a nine-step, seven-case summary and logs the digest, steps in execution order, and cases in descending priority with the fallback last", async () => {
    stubPresetFile(VALID_PRESET);
    const { logger, events } = recordingLogger();

    const summary = await explainRunbook({
      reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
      logger,
      runbookDir: "runbooks",
      queue: "orders-dlq",
    });

    // Nine codified steps, always; five codified terminal cases plus the
    // two authored rows above.
    expect(summary.steps).toHaveLength(9);
    expect(summary.cases).toHaveLength(7);

    const digestEvent = events.find((event) =>
      event.message.startsWith("digest: "),
    );
    expect(digestEvent).toBeDefined();
    expect(digestEvent?.message.length).toBeGreaterThan("digest: ".length);

    const stepsSectionIndex = events.findIndex(
      (event) => event.message === "Steps, in execution order",
    );
    const casesSectionIndex = events.findIndex(
      (event) => event.message === "Cases, in priority order",
    );
    expect(stepsSectionIndex).toBeGreaterThan(-1);
    expect(casesSectionIndex).toBeGreaterThan(stepsSectionIndex);

    const stepLines = events.slice(stepsSectionIndex + 1, casesSectionIndex);
    const stepIds = stepLines.map(
      (event) => /^- (\S+) \(/.exec(event.message)?.[1],
    );
    expect(stepIds).toEqual([
      "resolve-mode",
      "parse-envelope",
      "route-event",
      "extract-key",
      "widen-lookup",
      "lookup-entity",
      "check-entity-present",
      "derive-state",
      "match-known-cases",
    ]);

    const caseLines = events.slice(casesSectionIndex + 1);
    expect(caseLines).toHaveLength(8); // 7 cases + the fallback line
    expect(caseLines.at(-1)?.message).toMatch(/^- fallback: /);
    const priorities = caseLines.slice(0, -1).map((event) => {
      const match = /^- (-?\d+) /.exec(event.message);
      if (match?.[1] === undefined) {
        throw new Error(`unexpected case line: ${event.message}`);
      }
      return Number(match[1]);
    });
    expect(priorities).toHaveLength(7);
    expect(priorities[0]).toBe(500); // the authored high-priority row wins
    for (let index = 1; index < priorities.length; index += 1) {
      const current = priorities[index];
      const previous = priorities[index - 1];
      if (current === undefined || previous === undefined) {
        throw new Error("expected every priority to be defined");
      }
      expect(current).toBeLessThan(previous);
    }
  });
});

describe("explainRunbook — failure paths", () => {
  it("propagates a structurally invalid preset as Core.M3LError under the preset's own code, rather than a bare throw", async () => {
    stubPresetFile(MALFORMED_PRESET);

    let thrown: unknown;
    try {
      await explainRunbook({
        reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
        logger: new Core.M3LLogger([]),
        runbookDir: "runbooks",
        queue: "orders-dlq",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(PRESET_CODE);
  });

  it("propagates a preset that loads cleanly but fails buildTriageProcedure() as the engine's own invalid-definition error, naming the unsafe pattern in its problems", async () => {
    stubPresetFile(UNSAFE_PATTERN_PRESET);

    let thrown: unknown;
    try {
      await explainRunbook({
        reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
        logger: new Core.M3LLogger([]),
        runbookDir: "runbooks",
        queue: "orders-dlq",
      });
    } catch (error) {
      thrown = error;
    }

    // Unlike validateRunbooks (which catches this same build() failure and
    // re-projects its per-problem codes onto RunbookProblem entries),
    // explainRunbook does not catch build() at all — it propagates the
    // engine's own M3LProcedureInvalidDefinitionError unchanged, whose
    // *context.problems* (not its own top-level `code`) carries the
    // per-case ERR_PROCEDURE_INVALID_PATTERN finding.
    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe("ERR_PROCEDURE_INVALID_DEFINITION");
    const problems = error.context["problems"];
    expect(Array.isArray(problems)).toBe(true);
    expect(
      (problems as readonly { readonly code: string }[]).some(
        (problem) => problem.code === "ERR_PROCEDURE_INVALID_PATTERN",
      ),
    ).toBe(true);
  });

  it("surfaces a missing preset file as a typed error naming the queue's preset path, not a bare ENOENT", async () => {
    const cause = new Error(
      "ENOENT: no such file or directory, open 'runbooks/missing-dlq.json'",
    );
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);

    let thrown: unknown;
    try {
      await explainRunbook({
        reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
        logger: new Core.M3LLogger([]),
        runbookDir: "runbooks",
        queue: "missing-dlq",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(PRESET_CODE);
    expect(error.message).toContain("missing-dlq");
    expect(error.cause).toBe(cause);
  });
});

describe("presetPathFor", () => {
  // A pure, total string-interpolation function — `${runbookDir}/${queue}.json`
  // — with nothing to throw on for any string input; `config.ts`'s traversal
  // guard is what rejects a hostile `queue` value before it ever reaches
  // here, so there is no failure path of this function's own to cover.
  it("joins runbookDir and queue with the .json preset extension", () => {
    expect(presetPathFor("runbooks", "orders-dlq")).toBe(
      "runbooks/orders-dlq.json",
    );
  });

  it("honours a non-default runbookDir", () => {
    expect(presetPathFor("custom-runbooks", "shipments-dlq")).toBe(
      "custom-runbooks/shipments-dlq.json",
    );
  });
});
