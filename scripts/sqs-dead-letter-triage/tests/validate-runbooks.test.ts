import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import type { RunbookProblem } from "../src/steps/validate-runbooks.js";
import {
  reportValidation,
  VALIDATE_CODE,
  validateRunbooks,
} from "../src/steps/validate-runbooks.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");

// Mirrors the value load-runbook.ts is specified to use for every thrown
// M3LError (see dlq-ops-spec.md's "Error codes" section, and
// tests/load-runbook.test.ts's own local copy of the same literal). Kept
// local rather than importing an unexported symbol.
const PRESET_CODE = "ERR_DLQ_TRIAGE_PRESET";
const paths = new Core.M3LPaths();

// ---------------------------------------------------------------------------
// Fixture factories — deliberately mirrors tests/load-runbook.test.ts's and
// tests/build-procedure.test.ts's style (a fully-populated base a test
// overrides just the field(s) it cares about), rebuilt here as plain JSON
// records because `validateRunbooks` drives the file-loading path
// (`loadRunbook`/`parseTriagePreset`), not the already-parsed `TriagePreset`
// object shape `build-procedure.test.ts` works from.
//
// Neither load-runbook.test.ts's nor build-procedure.test.ts's factories are
// exported, so this is a third, necessarily separate copy. Worth extracting
// to a shared `tests/support/preset-fixture.ts` (mirroring the sibling
// package's own tests/support dir) the next time a fourth file needs it —
// flagged here rather than silently duplicated a third time.
// ---------------------------------------------------------------------------

function baseKey(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { path: "detail.orderId", ...overrides };
}

function baseLookupTier(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    label: "orders",
    table: "orders",
    keyField: "orderId",
    ...overrides,
  };
}

function baseState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { fromState: "created", nextState: "paid", ...overrides };
}

function baseCase(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "case-hold",
    description: "Hold for review",
    prose: "Needs manual review before any action.",
    priority: 100,
    fromState: "created",
    verdict: "hold",
    followUps: [],
    ...overrides,
  };
}

function baseArm(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    label: "Default arm",
    key: baseKey(),
    lookup: [baseLookupTier()],
    onMissing: "hold",
    state: baseState(),
    cases: [baseCase()],
    ...overrides,
  };
}

/** The smallest record `parseTriagePreset` accepts: one default arm. */
function validPreset(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    queue: "orders-dlq",
    title: "Orders DLQ triage",
    handling: "runbook",
    escalateTo: "orders-team",
    routeOn: "eventType",
    envelope: { bodyIsJson: true },
    arms: [baseArm()],
    ...overrides,
  };
}

/** Stubs a runbook directory holding exactly `files`, keyed by file name. */
function stubDirectory(files: Record<string, unknown>): void {
  vi.spyOn(fsp, "readdir").mockResolvedValue(
    Object.keys(files) as unknown as Awaited<ReturnType<typeof fsp.readdir>>,
  );
  vi.spyOn(fsp, "readFile").mockImplementation((target) => {
    const resolved = typeof target === "string" ? target : "";
    const name = resolved.split("/").at(-1) ?? "";
    return Promise.resolve(Buffer.from(JSON.stringify(files[name])));
  });
}

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

/** Runs `validateRunbooks` over a stubbed directory. */
async function validate(
  files: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof validateRunbooks>>> {
  stubDirectory(files);
  const summary = await validateRunbooks({
    paths,
    reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
    logger: new Core.M3LLogger([]),
    runbookDir: "runbooks",
  });
  vi.restoreAllMocks();
  return summary;
}

describe("validateRunbooks", () => {
  it("reports no problems when every preset builds clean", async () => {
    const summary = await validate({
      "orders-dlq.json": validPreset({ queue: "orders-dlq" }),
      "payments-dlq.json": validPreset({ queue: "payments-dlq" }),
    });
    expect(summary).toEqual({ checked: 2, problems: [] });
  });

  // ADR-0077: a partially converted runbook must never produce a confident
  // wrong verdict, so a non-empty `todos` is a validate-time failure, not a
  // silent pass.
  it("reports a non-empty todos entry as a problem", async () => {
    const summary = await validate({
      "orders-dlq.json": validPreset({
        todos: ["arms[0].key.capture: pattern unclear"],
      }),
    });
    expect(summary.checked).toBe(1);
    expect(summary.problems.length).toBeGreaterThan(0);
    expect(
      summary.problems.some((problem) =>
        problem.message.includes("arms[0].key.capture: pattern unclear"),
      ),
    ).toBe(true);
  });

  it("reports a structurally invalid preset (trust-boundary rejection) under the preset's own error code", async () => {
    const summary = await validate({
      "orders-dlq.json": { queue: "orders-dlq" }, // missing every other required field
    });
    expect(summary.problems).toHaveLength(1);
    expect(summary.problems[0]).toMatchObject({
      preset: "runbooks/orders-dlq.json",
      code: PRESET_CODE,
    });
  });

  // A preset that PARSES cleanly (passes every trust-boundary check in
  // load-runbook.ts) but fails only once compiled into a procedure: a
  // `signature` regex like `(a+)+` compiles fine and is under the 512-char
  // limit, so `parseTriagePreset` accepts it — but it is a classic
  // ReDoS-shaped pattern (nested quantified group), which the procedure
  // engine's own `isPatternSafe` check (internal/procedure/validate) rejects
  // only at `build()` time as `ERR_PROCEDURE_INVALID_PATTERN`. This is the
  // "loads but fails build()" path load-runbook's own trust boundary cannot
  // catch (case-id/priority collisions ARE already caught at load time by
  // `requireUniqueCases`, so those are unreachable via this seam).
  it("reports a preset that loads cleanly but fails build() as a structured engine problem", async () => {
    const summary = await validate({
      "orders-dlq.json": validPreset({
        arms: [baseArm({ cases: [baseCase({ signature: "(a+)+" })] })],
      }),
    });
    expect(summary.checked).toBe(1);
    expect(summary.problems.length).toBeGreaterThan(0);
    expect(summary.problems[0]).toMatchObject({
      preset: "runbooks/orders-dlq.json",
      code: "ERR_PROCEDURE_INVALID_PATTERN",
    });
  });

  // The whole point of a CI gate: one bad preset must never hide the rest.
  it("checks and reports every preset in the directory, not just the first bad one", async () => {
    const summary = await validate({
      "a.json": { queue: "a" }, // structurally invalid
      "b.json": { queue: "b" }, // structurally invalid
      "c.json": { queue: "c" }, // structurally invalid
    });
    expect(summary.checked).toBe(3);
    expect(summary.problems.length).toBeGreaterThanOrEqual(3);
    expect(new Set(summary.problems.map((problem) => problem.preset))).toEqual(
      new Set(["runbooks/a.json", "runbooks/b.json", "runbooks/c.json"]),
    );
  });

  it("keeps checking the remaining presets after one fails, mixing good and bad", async () => {
    const summary = await validate({
      "a.json": { queue: "broken" },
      "b.json": validPreset({ queue: "payments-dlq" }),
    });
    expect(summary.checked).toBe(2);
    expect(summary.problems).toHaveLength(1);
    expect(summary.problems[0]?.preset).toBe("runbooks/a.json");
  });
});

describe("reportValidation", () => {
  it("logs success and does not throw when there is nothing to report", () => {
    const { logger, events } = recordingLogger();
    expect(() =>
      reportValidation(logger, { checked: 3, problems: [] }),
    ).not.toThrow();
    expect(
      events.some(
        (event) =>
          event.category === Core.M3LLogEventCategory.SUCCESS &&
          event.message.includes("3"),
      ),
    ).toBe(true);
  });

  it("logs every problem via logger.error before throwing", () => {
    const { logger, events } = recordingLogger();
    expect(() =>
      reportValidation(logger, {
        checked: 1,
        problems: [
          {
            preset: "runbooks/orders-dlq.json",
            code: "ERR_PROCEDURE_DUPLICATE_CASE_ID",
            message: "duplicate id",
            caseId: "same",
          } satisfies RunbookProblem,
        ],
      }),
    ).toThrow(Core.M3LError);
    const errorEvents = events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.message).toContain("duplicate id");
  });

  it("throws Core.M3LError under the validation code, naming both counts", () => {
    let thrown: unknown;
    try {
      reportValidation(new Core.M3LLogger([]), {
        checked: 4,
        problems: [
          {
            preset: "runbooks/a.json",
            code: "X",
            message: "m",
          } satisfies RunbookProblem,
          {
            preset: "runbooks/b.json",
            code: "Y",
            message: "n",
          } satisfies RunbookProblem,
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(VALIDATE_CODE);
    expect(error.message).toContain("2");
    expect(error.message).toContain("4");
  });
});
