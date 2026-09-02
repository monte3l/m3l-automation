import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { rotate } from "../../.claude/hooks/rotate-session-incidents.mjs";

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
