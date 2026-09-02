import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  ROTATE_SOURCES,
  rotate,
  shouldRotate,
} from "../../.claude/hooks/rotate-session-incidents.mjs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rotate-session-incidents-test-"));
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

describe("rotate", () => {
  test("returns false and does not throw when the path does not exist", () => {
    const cwd = makeTempDir();
    const incidentsPath = join(cwd, "session-incidents.jsonl");

    expect(existsSync(incidentsPath)).toBe(false);
    expect(() => rotate(incidentsPath)).not.toThrow();
    expect(rotate(incidentsPath)).toBe(false);
  });

  test("returns true and removes an existing file", () => {
    const cwd = makeTempDir();
    const incidentsPath = join(cwd, "session-incidents.jsonl");
    writeFileSync(incidentsPath, '{"kind":"truncation"}\n');

    expect(existsSync(incidentsPath)).toBe(true);

    const result = rotate(incidentsPath);

    expect(result).toBe(true);
    expect(existsSync(incidentsPath)).toBe(false);
  });

  test("returns false on a second rotate call after the file is already gone", () => {
    const cwd = makeTempDir();
    const incidentsPath = join(cwd, "session-incidents.jsonl");
    writeFileSync(incidentsPath, '{"kind":"truncation"}\n');

    expect(rotate(incidentsPath)).toBe(true);
    expect(rotate(incidentsPath)).toBe(false);
  });

  test("returns false and does not throw when the parent directory does not exist at all", () => {
    const cwd = makeTempDir();
    const incidentsPath = join(
      cwd,
      "nonexistent-parent",
      "session-incidents.jsonl",
    );

    expect(() => rotate(incidentsPath)).not.toThrow();
    expect(rotate(incidentsPath)).toBe(false);
  });
});

describe("ROTATE_SOURCES", () => {
  test("contains exactly 'startup' and 'clear', and nothing else", () => {
    expect([...ROTATE_SOURCES].sort()).toEqual(["clear", "startup"]);
  });
});

describe("shouldRotate", () => {
  test("returns true for the exact valid SessionStart-at-startup payload", () => {
    expect(shouldRotate({ source: "startup" })).toBe(true);
  });

  test.each([
    ["startup", true],
    ["clear", true],
    ["compact", false],
    ["resume", false],
    ["fork", false],
  ])(
    "source %s -> shouldRotate returns %s per ROTATE_SOURCES membership",
    (source, expected) => {
      expect(shouldRotate({ source })).toBe(expected);
    },
  );

  test("returns false, not throws, when input is null", () => {
    expect(() => shouldRotate(null)).not.toThrow();
    expect(shouldRotate(null)).toBe(false);
  });

  test.each([
    ["undefined", undefined],
    ["a plain string", "startup"],
    ["a number", 42],
    ["an array", ["startup"]],
    ["a boolean", true],
  ])("returns false, not throws, when input is %s", (_description, input) => {
    expect(() => shouldRotate(input)).not.toThrow();
    expect(shouldRotate(input)).toBe(false);
  });

  test("returns false when input is an object with no source key at all", () => {
    expect(shouldRotate({})).toBe(false);
  });

  test.each([
    ["a number", { source: 123 }],
    ["null", { source: null }],
    ["an array", { source: ["startup"] }],
    ["an object", { source: { nested: "startup" } }],
  ])(
    "returns false, not throws, when source is not a string: %s",
    (_description, input) => {
      expect(() => shouldRotate(input)).not.toThrow();
      expect(shouldRotate(input)).toBe(false);
    },
  );
});
