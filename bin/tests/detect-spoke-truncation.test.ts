import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  looksTruncated,
  INCIDENTS_REL_PATH,
  appendIncident,
} from "../../.claude/hooks/detect-spoke-truncation.mjs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "detect-spoke-truncation-test-"));
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

describe("looksTruncated", () => {
  test("returns true when message is undefined", () => {
    expect(looksTruncated(undefined)).toBe(true);
  });

  test("returns true for an empty string", () => {
    expect(looksTruncated("")).toBe(true);
  });

  test("returns true for a whitespace-only string", () => {
    expect(looksTruncated("   \n\t  ")).toBe(true);
  });

  test("returns true when the message ends with '...'", () => {
    expect(looksTruncated("Now updating the config module...")).toBe(true);
  });

  test("returns true when the message ends with an ellipsis character", () => {
    expect(looksTruncated("Still working on this…")).toBe(true);
  });

  test("returns false for a complete sentence ending in a period", () => {
    expect(looksTruncated("The change is complete and tests pass.")).toBe(
      false,
    );
  });

  test("returns false when a trailing-intent phrase appears mid-sentence but the message continues past it with a complete clause", () => {
    expect(
      looksTruncated(
        "Let me know if you need anything else, the work is done.",
      ),
    ).toBe(false);
  });

  test("returns true for an unclosed fragment ending in a trailing-intent phrase", () => {
    expect(looksTruncated("Now the config module —")).toBe(true);
  });

  test("returns false for the historical 'Let me replace these prepares.' example, since it ends on terminal punctuation", () => {
    expect(looksTruncated("Let me replace these prepares.")).toBe(false);
  });

  test("returns false for a clean multi-line digest ending on a bare count bullet", () => {
    const digest = [
      "Summary of changes:",
      "- Files touched: 4",
      "- Tests added: 6",
      "- Nits: 3 items",
    ].join("\n");

    expect(looksTruncated(digest)).toBe(false);
  });
});

describe("INCIDENTS_REL_PATH", () => {
  test("is exactly 'tmp/session-incidents.jsonl'", () => {
    expect(INCIDENTS_REL_PATH).toBe("tmp/session-incidents.jsonl");
  });
});

describe("appendIncident", () => {
  test("writes a file whose content parses back to the record passed in", () => {
    const cwd = makeTempDir();
    const record = {
      timestamp: "2026-09-02T00:00:00.000Z",
      agentType: "code-implementer",
      kind: "truncation" as const,
    };

    appendIncident(record, cwd);

    const content = readFileSync(join(cwd, INCIDENTS_REL_PATH), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(record);
  });

  test("appends a second line rather than overwriting on a second call", () => {
    const cwd = makeTempDir();
    const first = {
      timestamp: "2026-09-02T00:00:00.000Z",
      agentType: "code-implementer",
      kind: "truncation" as const,
    };
    const second = {
      timestamp: "2026-09-02T00:05:00.000Z",
      agentType: "test-author",
      agentId: "spoke-2",
      kind: "truncation" as const,
    };

    appendIncident(first, cwd);
    appendIncident(second, cwd);

    const content = readFileSync(join(cwd, INCIDENTS_REL_PATH), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    const parsed = lines.map((line) => JSON.parse(line) as unknown);

    expect(parsed).toHaveLength(2);
    expect(parsed).toEqual([first, second]);
  });

  test("creates the tmp/ subdirectory automatically when it does not yet exist", () => {
    const cwd = makeTempDir();
    const record = {
      timestamp: "2026-09-02T00:00:00.000Z",
      agentType: "code-implementer",
      kind: "truncation" as const,
    };

    // No tmp/ directory exists under cwd yet.
    appendIncident(record, cwd);

    expect(() =>
      readFileSync(join(cwd, INCIDENTS_REL_PATH), "utf8"),
    ).not.toThrow();
  });

  test("does not throw when the tmp path collides with an existing regular file, and swallows the write failure", () => {
    const cwd = makeTempDir();
    // Create a regular FILE named "tmp" so mkdirSync(cwd/tmp, {recursive:true})
    // cannot create a directory there.
    writeFileSync(join(cwd, "tmp"), "not a directory");
    const record = {
      timestamp: "2026-09-02T00:00:00.000Z",
      agentType: "code-implementer",
      kind: "truncation" as const,
    };

    expect(() => appendIncident(record, cwd)).not.toThrow();
  });
});
