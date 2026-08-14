/**
 * Tests for src/history/store.ts — the best-effort, never-throwing run
 * history ring buffer (m3l-cli 8f addendum). History entries never carry
 * parameter *values* — only names, so this store cannot leak a secret even
 * accidentally.
 */
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  HISTORY_CAP,
  readHistory,
  recordHistoryEntry,
} from "../src/history/store.js";
import type { M3LCliHistoryEntry } from "../src/history/store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const sampleEntry: M3LCliHistoryEntry = {
  timestamp: "2026-08-14T00:00:00.000Z",
  script: "exporter",
  parameterNames: ["region", "verbose"],
  exitCode: 0,
};

describe("readHistory", () => {
  test("parses a valid history file into the typed array", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify([sampleEntry]));

    expect(readHistory("/cache/history.json")).toEqual([sampleEntry]);
  });

  test("returns [] when the file does not exist (ENOENT)", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    expect(readHistory("/cache/history.json")).toEqual([]);
  });

  test("returns [] when the file is unreadable for a non-ENOENT reason", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw errnoError("EACCES");
    });

    expect(readHistory("/cache/history.json")).toEqual([]);
  });

  test("returns [] on invalid JSON", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{not json");

    expect(readHistory("/cache/history.json")).toEqual([]);
  });

  test.each([
    ["an object", '{"foo":"bar"}'],
    ["a number", "42"],
    ["a string", '"just a string"'],
    ["null", "null"],
  ])(
    "returns [] when the parsed payload is %s, not an array",
    (_label, json) => {
      vi.spyOn(fs, "readFileSync").mockReturnValue(json);

      expect(readHistory("/cache/history.json")).toEqual([]);
    },
  );

  test("drops only the invalid entries from a payload mixing valid and malformed entries", () => {
    const payload = [
      sampleEntry,
      null,
      {
        timestamp: "x",
        script: "y",
        parameterNames: "not-an-array",
        exitCode: 0,
      },
      {
        timestamp: "x",
        script: "y",
        parameterNames: [],
        exitCode: "not-a-number",
      },
      { script: "missing-timestamp", parameterNames: [], exitCode: 0 },
    ];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readHistory("/cache/history.json")).toEqual([sampleEntry]);
  });

  test("never throws even on an unexpected synchronous fs error", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("disk exploded");
    });

    expect(() => readHistory("/cache/history.json")).not.toThrow();
    expect(readHistory("/cache/history.json")).toEqual([]);
  });

  test("drops any hand-added extra field on an entry, projecting to exactly the declared entry shape", () => {
    const payload = [{ ...sampleEntry, extraField: "should-not-survive" }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readHistory("/cache/history.json");

    expect(result).toEqual([sampleEntry]);
    expect(result[0]).not.toHaveProperty("extraField");
  });
});

describe("recordHistoryEntry", () => {
  test("appends the entry and writes pretty JSON, returning true", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const result = recordHistoryEntry("/cache/history.json", sampleEntry);

    expect(result).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [, writtenData] = writeSpy.mock.calls[0] ?? ["", ""];
    expect(typeof writtenData).toBe("string");
    const parsed = JSON.parse(writtenData as string) as unknown[];
    expect(parsed).toEqual([sampleEntry]);
  });

  test("creates the parent directory before writing", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    recordHistoryEntry("/cache/m3l-cli/history.json", sampleEntry);

    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    const [, mkdirOptions] = mkdirSpy.mock.calls[0] ?? ["", {}];
    expect(mkdirOptions).toMatchObject({ recursive: true });
  });

  test(`caps the persisted history at HISTORY_CAP (${String(HISTORY_CAP)}) entries via a sliding window, dropping the oldest`, () => {
    const existing: M3LCliHistoryEntry[] = Array.from(
      { length: HISTORY_CAP },
      (_unused, index) => ({
        timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        script: `script-${String(index)}`,
        parameterNames: [],
        exitCode: 0,
      }),
    );
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(existing));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const newEntry: M3LCliHistoryEntry = {
      timestamp: "2026-01-02T00:00:00.000Z",
      script: "newest",
      parameterNames: [],
      exitCode: 0,
    };
    recordHistoryEntry("/cache/history.json", newEntry);

    const [, writtenData] = writeSpy.mock.calls[0] ?? ["", ""];
    const parsed = JSON.parse(writtenData as string) as M3LCliHistoryEntry[];
    expect(parsed).toHaveLength(HISTORY_CAP);
    expect(parsed[parsed.length - 1]).toEqual(newEntry);
    expect(parsed.some((entry) => entry.script === "script-0")).toBe(false);
  });

  test("returns false, never throws, when mkdirSync fails", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw errnoError("EACCES");
    });
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    expect(recordHistoryEntry("/cache/history.json", sampleEntry)).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("returns false, never throws, when writeFileSync fails", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw errnoError("ENOSPC");
    });

    expect(recordHistoryEntry("/cache/history.json", sampleEntry)).toBe(false);
  });

  test("returns false, never throws, when reading the existing history file explodes unexpectedly", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("disk exploded");
    });
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    expect(() =>
      recordHistoryEntry("/cache/history.json", sampleEntry),
    ).not.toThrow();
  });
});

describe("M3LCliHistoryEntry contract", () => {
  test("declares the documented readonly shape (no value-carrying field)", () => {
    expectTypeOf<M3LCliHistoryEntry>().toEqualTypeOf<{
      readonly timestamp: string;
      readonly script: string;
      readonly parameterNames: readonly string[];
      readonly exitCode: number;
    }>();
  });

  test("HISTORY_CAP is exactly 100", () => {
    expect(HISTORY_CAP).toBe(100);
  });
});
