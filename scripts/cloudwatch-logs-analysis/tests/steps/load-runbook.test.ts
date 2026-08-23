import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import {
  listRunbooks,
  loadRunbook,
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

/** The smallest record `parseRunbookPreset` accepts. */
function minimal(
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

/** Parses `record`, returning the thrown `M3LError`'s message. */
function rejectionOf(record: Record<string, unknown>): string {
  try {
    parseRunbookPreset(reader, record, "example.json");
  } catch (error) {
    expect(error).toBeInstanceOf(Core.M3LError);
    expect((error as Core.M3LError).code).toBe(PRESET_CODE);
    return (error as Error).message;
  }
  throw new Error("expected parseRunbookPreset to reject the record");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("parseRunbookPreset", () => {
  it("accepts a minimal analysable preset and defaults its optional stages", () => {
    const preset = parseRunbookPreset(reader, minimal(), "example.json");
    expect(preset.alarm).toBe("example-alarm");
    expect(preset.authorizer).toBeUndefined();
    expect(preset.trace).toEqual([]);
    expect(preset.cases).toEqual([]);
    expect(preset.severityLadder).toEqual([]);
    expect(preset.todos).toEqual([]);
  });

  it("defaults the window offsets when the preset declares none", () => {
    expect(parseRunbookPreset(reader, minimal(), "e.json").window).toEqual({
      leadMinutes: 5,
      lagMinutes: 15,
    });
  });

  it("reads a declared window verbatim", () => {
    expect(
      parseRunbookPreset(
        reader,
        minimal({ window: { leadMinutes: 30, lagMinutes: 1 } }),
        "e.json",
      ).window,
    ).toEqual({ leadMinutes: 30, lagMinutes: 1 });
  });

  it("accepts an unsupported preset with none of the analysis stages", () => {
    const preset = parseRunbookPreset(
      reader,
      {
        alarm: "a",
        title: "t",
        unsupported: {
          reason: "metric-only",
          manualSteps: ["look at the graph"],
        },
        escalateTo: "team",
      },
      "e.json",
    );
    expect(preset.unsupported?.manualSteps).toEqual(["look at the graph"]);
    expect(preset.entry).toBeUndefined();
  });

  it("rejects a supported preset missing entry, correlation and signature, naming all three", () => {
    const message = rejectionOf({
      alarm: "a",
      title: "t",
      escalateTo: "team",
    });
    expect(message).toContain("entry");
    expect(message).toContain("correlation");
    expect(message).toContain("signature");
  });

  it.each(["alarm", "title", "escalateTo"])(
    "rejects a preset missing the required '%s' field",
    (field) => {
      const record = minimal();
      delete record[field];
      expect(rejectionOf(record)).toContain(field);
    },
  );

  it("rejects an entry stage with an empty log-group list", () => {
    expect(
      rejectionOf(
        minimal({ entry: { logGroups: [], query: "fields @message" } }),
      ),
    ).toContain("logGroups");
  });

  it("rejects a non-string element inside a string array", () => {
    expect(
      rejectionOf(
        minimal({ entry: { logGroups: ["/ok", 7], query: "fields @message" } }),
      ),
    ).toContain("logGroups[1]");
  });

  it("rejects a pattern that does not compile, naming the preset field", () => {
    expect(
      rejectionOf(
        minimal({
          correlation: { field: "@message", pattern: "([", label: "id" },
        }),
      ),
    ).toContain("correlation.pattern");
  });

  it("rejects a pattern beyond the engine's own length ceiling", () => {
    expect(
      rejectionOf(
        minimal({
          correlation: {
            field: "@message",
            pattern: "a".repeat(513),
            label: "id",
          },
        }),
      ),
    ).toContain("512");
  });

  it("rejects a case row claiming a reserved terminal priority", () => {
    expect(
      rejectionOf(
        minimal({
          cases: [
            {
              id: "c",
              description: "d",
              prose: "p",
              priority: 3,
              pattern: "x",
              verdict: "known-open-issue",
            },
          ],
        }),
      ),
    ).toContain("reserved");
  });

  it("rejects a case row whose verdict is one of the codified terminal verdicts", () => {
    expect(
      rejectionOf(
        minimal({
          cases: [
            {
              id: "c",
              description: "d",
              prose: "p",
              priority: 100,
              pattern: "x",
              verdict: "no-evidence",
            },
          ],
        }),
      ),
    ).toContain("cases[0].verdict");
  });

  it("reads a fully specified case row, including its optional pins", () => {
    const preset = parseRunbookPreset(
      reader,
      minimal({
        cases: [
          {
            id: "c",
            description: "d",
            prose: "p",
            priority: 100,
            pattern: "x",
            level: "ERROR",
            service: "worker",
            verdict: "transient-downstream",
            ticket: "EXAMPLE-1",
            resolution: "retry",
            escalateTo: "other-team",
            followUps: ["check the graph"],
          },
        ],
      }),
      "e.json",
    );
    expect(preset.cases[0]).toMatchObject({
      level: "ERROR",
      service: "worker",
      verdict: "transient-downstream",
      escalateTo: "other-team",
      followUps: ["check the graph"],
    });
  });

  it("rejects an authorizer stage missing its latency threshold", () => {
    expect(
      rejectionOf(
        minimal({
          authorizer: {
            logGroups: ["/example/auth"],
            query: "fields @message",
            latencyField: "l",
          },
        }),
      ),
    ).toContain("latencyThresholdMs");
  });

  it("reads a trace chain in declared order, keeping each hop's label", () => {
    const preset = parseRunbookPreset(
      reader,
      minimal({
        trace: [
          { label: "first", logGroups: ["/a"], query: "q" },
          {
            label: "second",
            logGroups: ["/b"],
            query: "q",
            rekeyPattern: "t=(\\w+)",
          },
        ],
      }),
      "e.json",
    );
    expect(preset.trace.map((hop) => hop.label)).toEqual(["first", "second"]);
    expect(preset.trace[1]?.rekeyPattern).toBe("t=(\\w+)");
  });

  it("carries conversion TODO markers through, so validate can reject them", () => {
    expect(
      parseRunbookPreset(
        reader,
        minimal({ todos: ["correlation: missing"] }),
        "e.json",
      ).todos,
    ).toEqual(["correlation: missing"]);
  });
});

describe("loadRunbook", () => {
  it("reads, parses and validates a preset file", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(minimal())),
    );
    await expect(loadRunbook(reader, "runbooks/a.json")).resolves.toMatchObject(
      {
        alarm: "example-alarm",
      },
    );
  });

  it("surfaces malformed JSON as a coded preset error", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from("{ not json"));
    await expect(loadRunbook(reader, "runbooks/a.json")).rejects.toThrow(
      Core.M3LError,
    );
  });
});

describe("listRunbooks", () => {
  it("returns only .json entries, sorted, joined onto the runbook directory", async () => {
    vi.spyOn(fsp, "readdir").mockResolvedValue([
      "b.json",
      "notes.md",
      "a.json",
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);
    await expect(listRunbooks(paths, "runbooks")).resolves.toEqual([
      "runbooks/a.json",
      "runbooks/b.json",
    ]);
  });

  it("surfaces an unreadable directory as a coded preset error", async () => {
    vi.spyOn(fsp, "readdir").mockRejectedValue(new Error("ENOENT"));
    await expect(listRunbooks(paths, "missing")).rejects.toThrow(
      /failed reading runbook directory/u,
    );
  });
});
