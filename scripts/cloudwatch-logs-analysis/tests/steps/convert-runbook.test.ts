import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import {
  BASE_PRIORITY,
  CONVERT_CODE,
  convertMarkdown,
  convertRunbook,
  extractFences,
  extractLogGroups,
  extractOverrides,
  extractQuery,
  extractTable,
  extractTitle,
  OVERRIDE_FENCE,
  PRIORITY_STEP,
} from "../../src/steps/convert-runbook.js";
import {
  parseRunbookPreset,
  PRESET_CODE,
} from "../../src/steps/load-runbook.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");

const paths = new Core.M3LPaths();
const reader = new Core.M3LInputFileReader({ paths, code: PRESET_CODE });

/** A synthetic runbook carrying every shape the converter reads. */
const COMPLETE = [
  "# Example alarm",
  "",
  "Query `/example/entry` and `/example/other` for the window.",
  "",
  "```text",
  "fields @timestamp, @message | filter level = 'ERROR'",
  "```",
  "",
  "| Error       | Cause            | Verdict          | Ticket | Resolution |",
  "| ----------- | ---------------- | ---------------- | ------ | ---------- |",
  "| BoomError   | it went bang     | known open issue | EX-1   | restart    |",
  "| QuietError  | it went quiet    | known no action  | EX-2   | nothing    |",
  "",
  "```" + OVERRIDE_FENCE,
  JSON.stringify({
    correlation: { field: "@message", pattern: "id=(\\w+)", label: "id" },
    escalateTo: "example-owning-team",
  }),
  "```",
].join("\n");

describe("the markdown readers", () => {
  it("reads the first H1 as the title", () => {
    expect(extractTitle("intro\n# The title\n# later")).toBe("The title");
  });

  it("reports no title when the document has no H1", () => {
    expect(extractTitle("## only an H2")).toBeUndefined();
  });

  it("pairs every fence with its tag", () => {
    expect(extractFences("```ts\na\n```\ntext\n```\nb\n```")).toEqual([
      { tag: "ts", body: "a" },
      { tag: "", body: "b" },
    ]);
  });

  it("takes the first fence that reads like a Logs Insights query", () => {
    expect(
      extractQuery("```json\n{}\n```\n```text\nfields @message\n```"),
    ).toBe("fields @message");
  });

  it("never mistakes the override fence for a query", () => {
    expect(
      extractQuery(
        ["```" + OVERRIDE_FENCE, '{"filter":"fields"}', "```"].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("collects distinct log-group-shaped code spans in document order", () => {
    expect(extractLogGroups("see `/a/b` then `/c/d` then `/a/b`")).toEqual([
      "/a/b",
      "/c/d",
    ]);
  });

  it("keys the first table's data rows by their lower-cased headers", () => {
    expect(
      extractTable("| Error | Fix |\n| --- | --- |\n| boom | retry |\n\nafter"),
    ).toEqual([{ error: "boom", fix: "retry" }]);
  });

  it("returns no rows when the document has no table", () => {
    expect(extractTable("just prose")).toEqual([]);
  });
});

describe("extractOverrides", () => {
  it("returns the parsed override object", () => {
    expect(
      extractOverrides(
        ["```" + OVERRIDE_FENCE, '{"escalateTo":"team"}', "```"].join("\n"),
      ),
    ).toEqual({ escalateTo: "team" });
  });

  it("returns an empty object when the runbook carries no override fence", () => {
    expect(extractOverrides("# just a title")).toEqual({});
  });

  it("rejects an override fence that is not valid JSON", () => {
    expect(() =>
      extractOverrides(["```" + OVERRIDE_FENCE, "{ nope", "```"].join("\n")),
    ).toThrow(Core.M3LError);
  });

  it("rejects an override fence holding a JSON array rather than an object", () => {
    try {
      extractOverrides(["```" + OVERRIDE_FENCE, "[1]", "```"].join("\n"));
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Core.M3LError).code).toBe(CONVERT_CODE);
    }
  });
});

describe("convertMarkdown", () => {
  it("converts a complete runbook with nothing left to fill in", () => {
    const { preset, todos } = convertMarkdown(COMPLETE, "example-alarm");
    expect(todos).toEqual([]);
    expect(preset["title"]).toBe("Example alarm");
    expect(preset["entry"]).toEqual({
      logGroups: ["/example/entry", "/example/other"],
      query: "fields @timestamp, @message | filter level = 'ERROR'",
    });
  });

  it("emits a preset the trust boundary then accepts unchanged", () => {
    const { preset } = convertMarkdown(COMPLETE, "example-alarm");
    expect(() =>
      parseRunbookPreset(reader, preset, "converted.json"),
    ).not.toThrow();
  });

  it("assigns descending, unique priorities in table order", () => {
    const cases = convertMarkdown(COMPLETE, "a").preset[
      "cases"
    ] as readonly Record<string, unknown>[];
    expect(cases.map((row) => row["priority"])).toEqual([
      BASE_PRIORITY,
      BASE_PRIORITY - PRIORITY_STEP,
    ]);
  });

  it("maps a prose verdict cell onto the authorable vocabulary", () => {
    const cases = convertMarkdown(COMPLETE, "a").preset[
      "cases"
    ] as readonly Record<string, unknown>[];
    expect(cases.map((row) => row["verdict"])).toEqual([
      "known-open-issue",
      "known-no-action",
    ]);
  });

  it("derives a unique slug id per row from its cause cell", () => {
    const cases = convertMarkdown(COMPLETE, "a").preset[
      "cases"
    ] as readonly Record<string, unknown>[];
    expect(cases.map((row) => row["id"])).toEqual([
      "it-went-bang",
      "it-went-quiet",
    ]);
  });

  it("records a TODO rather than guessing an unrecognised verdict", () => {
    const markdown = [
      "| Error | Verdict |",
      "| --- | --- |",
      "| Boom | who knows |",
    ].join("\n");
    const { preset, todos } = convertMarkdown(markdown, "a");
    expect(todos.some((todo) => todo.includes("verdict not recognised"))).toBe(
      true,
    );
    const cases = preset["cases"] as readonly Record<string, unknown>[];
    expect(cases[0]?.["verdict"]).toBe("unrecognised");
  });

  it("records a TODO for every part of a bare runbook it cannot extract", () => {
    const { todos } = convertMarkdown("# Bare", "a");
    expect(todos).toEqual([
      "entry.query: no Logs Insights query block found",
      "entry.logGroups: no log group names found",
      "cases: no known-cases table found",
      `correlation: not derivable from prose — add a '${OVERRIDE_FENCE}' block or edit the skeleton`,
      "escalateTo: no owning team declared",
    ]);
  });

  it("emits its TODO markers onto the preset, so validate rejects a partial conversion", () => {
    const { preset } = convertMarkdown("# Bare", "a");
    expect((preset["todos"] as readonly string[]).length).toBeGreaterThan(0);
  });
});

describe("convertRunbook", () => {
  it("reads the source, writes the skeleton, and names it after the file stem", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(COMPLETE));
    const mkdir = vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    const writeFile = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);

    const result = await convertRunbook({
      reader,
      paths,
      logger: new Core.M3LLogger([]),
      source: "runbooks/example-alarm.md",
      alarm: undefined,
      output: undefined,
    });

    expect(result.output).toBe("example-alarm.json");
    expect(result.todos).toEqual([]);
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("honours an explicit alarm and output name", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(COMPLETE));
    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);

    const result = await convertRunbook({
      reader,
      paths,
      logger: new Core.M3LLogger([]),
      source: "runbooks/whatever.md",
      alarm: "chosen-alarm",
      output: "chosen.json",
    });

    expect(result.output).toBe("chosen.json");
    expect(result.preset["alarm"]).toBe("chosen-alarm");
    vi.restoreAllMocks();
  });

  it("warns once per unresolved marker so a partial conversion is loud", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from("# Bare"));
    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    const logger = new Core.M3LLogger([]);
    const warning = vi.spyOn(logger, "warning");

    const result = await convertRunbook({
      reader,
      paths,
      logger,
      source: "runbooks/bare.md",
      alarm: undefined,
      output: undefined,
    });

    expect(warning).toHaveBeenCalledTimes(result.todos.length);
    vi.restoreAllMocks();
  });
});
