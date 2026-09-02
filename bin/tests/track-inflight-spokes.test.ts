import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  SPOKE_LIFECYCLE_REL_PATH,
  LIFECYCLE_EVENTS,
  eventKindFor,
  appendLifecycleRecord,
} from "../../.claude/hooks/track-inflight-spokes.mjs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "track-inflight-spokes-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("LIFECYCLE_EVENTS", () => {
  test("contains exactly 'SubagentStart' and 'SubagentStop', and nothing else", () => {
    expect([...LIFECYCLE_EVENTS].sort()).toEqual([
      "SubagentStart",
      "SubagentStop",
    ]);
  });
});

describe("eventKindFor", () => {
  test("returns 'start' for SubagentStart", () => {
    expect(eventKindFor("SubagentStart")).toBe("start");
  });

  test("returns 'stop' for SubagentStop", () => {
    expect(eventKindFor("SubagentStop")).toBe("stop");
  });

  test.each([
    ["a different string", "PreToolUse"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an empty string", ""],
  ])("returns null for %s", (_description, input) => {
    expect(eventKindFor(input)).toBeNull();
  });
});

describe("SPOKE_LIFECYCLE_REL_PATH", () => {
  test("is exactly 'tmp/spoke-lifecycle.jsonl'", () => {
    expect(SPOKE_LIFECYCLE_REL_PATH).toBe("tmp/spoke-lifecycle.jsonl");
  });
});

describe("appendLifecycleRecord", () => {
  test("writes a file whose content parses back to the record passed in", () => {
    const cwd = makeTempDir();
    const record = {
      event: "start" as const,
      agentId: "spoke-1",
      agentType: "code-implementer",
      ts: "2026-09-02T00:00:00.000Z",
    };

    appendLifecycleRecord(record, cwd);

    const content = readFileSync(join(cwd, SPOKE_LIFECYCLE_REL_PATH), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(record);
  });

  test("appends a second line rather than overwriting on a second call", () => {
    const cwd = makeTempDir();
    const first = {
      event: "start" as const,
      agentId: "spoke-1",
      agentType: "code-implementer",
      ts: "2026-09-02T00:00:00.000Z",
    };
    const second = {
      event: "stop" as const,
      agentId: "spoke-1",
      agentType: "code-implementer",
      ts: "2026-09-02T00:05:00.000Z",
    };

    appendLifecycleRecord(first, cwd);
    appendLifecycleRecord(second, cwd);

    const content = readFileSync(join(cwd, SPOKE_LIFECYCLE_REL_PATH), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    const parsed = lines.map((line) => JSON.parse(line) as unknown);

    expect(parsed).toHaveLength(2);
    expect(parsed).toEqual([first, second]);
  });

  test("creates the tmp/ subdirectory automatically when it does not yet exist", () => {
    const cwd = makeTempDir();
    const record = {
      event: "start" as const,
      agentType: "code-implementer",
      ts: "2026-09-02T00:00:00.000Z",
    };

    // No tmp/ directory exists under cwd yet.
    appendLifecycleRecord(record, cwd);

    expect(() =>
      readFileSync(join(cwd, SPOKE_LIFECYCLE_REL_PATH), "utf8"),
    ).not.toThrow();
  });

  test("does not throw when the tmp path collides with an existing regular file, and swallows the write failure", () => {
    const cwd = makeTempDir();
    // Create a regular FILE named "tmp" so mkdirSync(cwd/tmp, {recursive:true})
    // cannot create a directory there.
    writeFileSync(join(cwd, "tmp"), "not a directory");
    const record = {
      event: "start" as const,
      agentType: "code-implementer",
      ts: "2026-09-02T00:00:00.000Z",
    };

    expect(() => appendLifecycleRecord(record, cwd)).not.toThrow();
  });
});
