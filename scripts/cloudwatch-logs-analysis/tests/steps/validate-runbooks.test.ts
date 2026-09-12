import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import { PRESET_CODE } from "../../src/steps/load-runbook.js";
import {
  reportValidation,
  VALIDATE_CODE,
  validateRunbooks,
} from "../../src/steps/validate-runbooks.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");

const paths = new Core.M3LPaths();

/** The smallest analysable preset record. */
function preset(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    alarm: "example-alarm",
    title: "Example alarm",
    entry: { logGroups: ["/example/entry"], query: "fields @message" },
    correlation: { field: "@message", pattern: "id=(\\w+)", label: "id" },
    signature: { field: "@message" },
    escalateTo: "example-owning-team",
    ...overrides,
  };
}

/** Stubs a runbook directory holding exactly `files`, keyed by file name. */
function stubDirectory(files: Record<string, unknown>): void {
  vi.spyOn(fsp, "readdir").mockResolvedValue(
    Object.keys(files) as unknown as Awaited<ReturnType<typeof fsp.readdir>>,
  );
  vi.spyOn(fsp, "readFile").mockImplementation((target) => {
    // The mocked signature admits a `FileHandle`; every call this stub sees
    // comes from `M3LInputFileReader`, which always passes a resolved path.
    const resolved = typeof target === "string" ? target : "";
    const name = resolved.split("/").at(-1) ?? "";
    return Promise.resolve(Buffer.from(JSON.stringify(files[name])));
  });
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
  it("reports no problems when every preset builds", async () => {
    const summary = await validate({ "a.json": preset(), "b.json": preset() });
    expect(summary).toEqual({ checked: 2, problems: [] });
  });

  it("reports a duplicate case priority as a structured engine problem", async () => {
    const rows = [
      {
        id: "one",
        description: "d",
        prose: "p",
        priority: 100,
        pattern: "a",
        verdict: "known-open-issue",
      },
      {
        id: "two",
        description: "d",
        prose: "p",
        priority: 100,
        pattern: "b",
        verdict: "known-open-issue",
      },
    ];
    const summary = await validate({ "a.json": preset({ cases: rows }) });
    expect(summary.problems).toHaveLength(1);
    expect(summary.problems[0]).toMatchObject({
      preset: "runbooks/a.json",
      code: "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
    });
  });

  it("reports every engine problem at once, not just the first", async () => {
    const rows = [
      {
        id: "same",
        description: "d",
        prose: "p",
        priority: 100,
        pattern: "a",
        verdict: "known-open-issue",
      },
      {
        id: "same",
        description: "d",
        prose: "p",
        priority: 100,
        pattern: "b",
        verdict: "known-open-issue",
      },
    ];
    const summary = await validate({ "a.json": preset({ cases: rows }) });
    expect(new Set(summary.problems.map((problem) => problem.code))).toEqual(
      new Set([
        "ERR_PROCEDURE_DUPLICATE_CASE_ID",
        "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
      ]),
    );
  });

  it("reports a trust-boundary rejection under the preset's own error code", async () => {
    const summary = await validate({ "a.json": { alarm: "only" } });
    expect(summary.problems[0]).toMatchObject({
      preset: "runbooks/a.json",
      code: PRESET_CODE,
    });
  });

  it("fails an unresolved conversion marker rather than warning about it", async () => {
    const summary = await validate({
      "a.json": preset({ todos: ["correlation: missing"] }),
    });
    expect(summary.problems[0]).toMatchObject({
      code: "ERR_LOGS_ANALYSIS_TODO",
    });
    expect(summary.problems[0]?.message).toContain("correlation: missing");
  });

  it("keeps checking the remaining presets after one fails", async () => {
    const summary = await validate({
      "a.json": { alarm: "broken" },
      "b.json": preset(),
    });
    expect(summary.checked).toBe(2);
    expect(summary.problems).toHaveLength(1);
  });
});

describe("reportValidation", () => {
  it("succeeds quietly, naming the count, when there is nothing to report", () => {
    const logger = new Core.M3LLogger([]);
    const success = vi.spyOn(logger, "success");
    reportValidation(logger, { checked: 3, problems: [] });
    expect(success).toHaveBeenCalledWith("3 preset(s) build clean");
  });

  it("logs every problem and throws so the run exits non-zero", () => {
    const logger = new Core.M3LLogger([]);
    const error = vi.spyOn(logger, "error");
    expect(() =>
      reportValidation(logger, {
        checked: 1,
        problems: [
          {
            preset: "runbooks/a.json",
            code: "ERR_PROCEDURE_DUPLICATE_CASE_ID",
            message: "duplicate id",
            caseId: "same",
            stepId: undefined,
          },
        ],
      }),
    ).toThrow(Core.M3LError);
    expect(error).toHaveBeenCalledWith("runbooks/a.json: duplicate id", {
      code: "ERR_PROCEDURE_DUPLICATE_CASE_ID",
      caseId: "same",
    });
  });

  it("throws under the validation code, carrying how many presets were checked", () => {
    try {
      reportValidation(new Core.M3LLogger([]), {
        checked: 4,
        problems: [
          {
            preset: "a",
            code: "X",
            message: "m",
            caseId: undefined,
            stepId: undefined,
          },
        ],
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Core.M3LError).code).toBe(VALIDATE_CODE);
      expect((error as Core.M3LError).context["checked"]).toBe(4);
    }
  });
});
