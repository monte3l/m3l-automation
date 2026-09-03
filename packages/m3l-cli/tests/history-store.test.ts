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
import type { M3LCliRunOutcome } from "../src/run/envelope.js";

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

describe("readHistory — outcome and retryAttempts optional fields", () => {
  // Guards the load-bearing optionality guarantee: entries written before this
  // change was shipped carry only the four core fields.  If the new fields were
  // required by isValidHistoryEntry, every pre-existing history file would read
  // back as empty — silently discarding a real operator's run history.
  test("an entry carrying only the four core fields passes validation and is returned", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify([sampleEntry]));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry; // safe: length asserted above
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(entry.script).toBe(sampleEntry.script);
    expect(entry.exitCode).toBe(sampleEntry.exitCode);
    // The two new optional fields must be absent, not set to undefined —
    // exactOptionalPropertyTypes makes undefined distinct from absent.
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(false);
  });

  // Validates that projectHistoryEntry includes outcome in its allowlist.  Without
  // this projection step the field would be present in isValidHistoryEntry's output
  // but silently stripped before reaching the caller.
  test.each([
    "success",
    "failure",
    "dry-run",
    "interrupted",
    "partial",
  ] as const)(
    "valid outcome value %s is preserved through the readHistory projection",
    (outcome) => {
      const payload = [{ ...sampleEntry, outcome }];
      vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

      const result = readHistory("/cache/history.json");

      expect(result).toHaveLength(1);
      const entry = result[0] as M3LCliHistoryEntry;
      expect(Object.hasOwn(entry, "outcome")).toBe(true);
      expect(entry).toHaveProperty("outcome", outcome);
    },
  );

  // Guards the "drop the field, keep the entry" contract for a hand-edited or
  // machine-generated file that contains an unrecognised outcome literal.  A
  // validator that rejects the whole entry for one bad optional field would
  // contradict the doc's "history must never block a command" guarantee.
  test("an unrecognised outcome string is dropped; the four core fields survive intact", () => {
    const payload = [{ ...sampleEntry, outcome: "bogus" }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    // Entry retained — not dropped
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(entry.script).toBe(sampleEntry.script);
    expect(entry.exitCode).toBe(sampleEntry.exitCode);
    // Malformed field silently dropped — not carried through
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
  });

  test("a non-string outcome value (number) is dropped; the four core fields survive intact", () => {
    const payload = [{ ...sampleEntry, outcome: 42 }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
  });

  // Guards the projectHistoryEntry allowlist for retryAttempts — if the field is
  // omitted from the projection return object it would be stripped even for valid values.
  test("a valid retryAttempts count is preserved through the readHistory projection", () => {
    const payload = [{ ...sampleEntry, retryAttempts: 3 }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(true);
    expect(entry).toHaveProperty("retryAttempts", 3);
  });

  test("a string retryAttempts value is dropped; the four core fields survive intact", () => {
    const payload = [{ ...sampleEntry, retryAttempts: "3" }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(false);
  });

  // JSON.stringify(NaN) produces "null", so a caller passing retryAttempts: NaN to
  // recordHistoryEntry would persist it as null.  Without a finite-number check in
  // the projection, null would read back as neither a valid count nor an absent
  // field — a silent data corruption that only surfaces in downstream display code.
  test("null retryAttempts (from NaN serialisation) is dropped; the four core fields survive intact", () => {
    // JSON.stringify({retryAttempts: NaN}) → {"retryAttempts":null}
    const payload = JSON.stringify([{ ...sampleEntry, retryAttempts: NaN }]);
    vi.spyOn(fs, "readFileSync").mockReturnValue(payload);

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(false);
  });

  // JSON.stringify(Infinity) also produces "null" — the same persistence risk as
  // NaN.  Covered separately so both are explicitly documented as rejected literals.
  test("null retryAttempts (from Infinity serialisation) is dropped; the four core fields survive intact", () => {
    // JSON.stringify({retryAttempts: Infinity}) → {"retryAttempts":null}
    const payload = JSON.stringify([
      { ...sampleEntry, retryAttempts: Infinity },
    ]);
    vi.spyOn(fs, "readFileSync").mockReturnValue(payload);

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(false);
  });

  // Object.hasOwn (not `in`, not toHaveProperty) is used throughout so the
  // assertion cannot be satisfied by an inherited prototype value.  exactOptional-
  // PropertyTypes makes absent distinct from {field: undefined}; toEqual with an
  // undefined value would pass either way and make the test vacuous.
  test("absent optional fields are omitted from the projected entry, not set to undefined", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify([sampleEntry]));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(false);
  });

  // Guards the allowlist against becoming a hole: adding outcome and retryAttempts
  // to projectHistoryEntry must not accidentally pass every field through.  An
  // undeclared field injected alongside the new declared ones must still be stripped.
  test("an undeclared extra field is still stripped even when the new optional fields are present", () => {
    const payload = [
      {
        ...sampleEntry,
        outcome: "success",
        retryAttempts: 1,
        injected: "must-not-survive",
      },
    ];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    // New declared fields present
    expect(Object.hasOwn(entry, "outcome")).toBe(true);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(true);
    // Undeclared field absent — allowlist not widened
    expect(Object.hasOwn(entry, "injected")).toBe(false);
  });
});

describe("recordHistoryEntry — outcome and retryAttempts round-trip", () => {
  // Proves both fields survive the full write→read path.  The projectHistoryEntry
  // function is called on both sides of this cycle; a field missing from the
  // projection would be absent from the written JSON and therefore absent on read-
  // back, causing the assertion to fail.
  test("both new optional fields survive a recordHistoryEntry → readHistory round-trip", () => {
    const entryWithFields: M3LCliHistoryEntry = {
      ...sampleEntry,
      outcome: "partial",
      retryAttempts: 2,
    };

    let capturedJson = "";
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, data) => {
      capturedJson = data as string;
    });

    const recorded = recordHistoryEntry("/cache/history.json", entryWithFields);
    expect(recorded).toBe(true);
    expect(capturedJson).not.toBe("");

    // Feed the written JSON back into readHistory to complete the round-trip.
    readSpy.mockReturnValue(capturedJson);
    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(Object.hasOwn(entry, "outcome")).toBe(true);
    expect(entry).toHaveProperty("outcome", "partial");
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(true);
    expect(entry).toHaveProperty("retryAttempts", 2);
    // Core fields intact
    expect(entry.timestamp).toBe(sampleEntry.timestamp);
    expect(entry.script).toBe(sampleEntry.script);
  });

  // Confirms the projection does not inject outcome or retryAttempts when the
  // caller omits them — exactOptionalPropertyTypes distinguishes absent from
  // undefined and Object.hasOwn catches a projection that sets the field to
  // undefined instead of omitting it.
  test("an entry recorded without the new optional fields reads back without them", () => {
    let capturedJson = "";
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, data) => {
      capturedJson = data as string;
    });

    recordHistoryEntry("/cache/history.json", sampleEntry);
    expect(capturedJson).not.toBe("");

    readSpy.mockReturnValue(capturedJson);
    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const entry = result[0] as M3LCliHistoryEntry;
    expect(Object.hasOwn(entry, "outcome")).toBe(false);
    expect(Object.hasOwn(entry, "retryAttempts")).toBe(false);
  });
});

describe("M3LCliHistoryEntry contract", () => {
  test("declares the documented readonly shape with outcome and retryAttempts as optional", () => {
    // The exact-shape check. Including the two optional fields causes this test to
    // fail when they are absent from the interface — the guard that keeps the type
    // contract honest. It also fails when a field is added without being documented
    // here, preventing silent interface drift.
    expectTypeOf<M3LCliHistoryEntry>().toEqualTypeOf<{
      readonly timestamp: string;
      readonly script: string;
      readonly parameterNames: readonly string[];
      readonly exitCode: number;
      readonly outcome?: M3LCliRunOutcome;
      readonly retryAttempts?: number;
    }>();
  });

  test("all five M3LCliRunOutcome literals are keys of the outcome field type", () => {
    // Validates that the outcome field's type precisely matches the union declared
    // in run/envelope.ts — an added or removed literal in either location breaks
    // this without requiring a runtime fixture.
    expectTypeOf<NonNullable<M3LCliHistoryEntry["outcome"]>>().toEqualTypeOf<
      "success" | "failure" | "dry-run" | "interrupted" | "partial"
    >();
  });

  test("keyof M3LCliHistoryEntry includes outcome and retryAttempts", () => {
    // Confirms both new fields are present as named properties of the interface.
    // A toMatchTypeOf check on optional fields is vacuous (a type with no field is
    // a subtype of one with an optional field), so asserting the keyset directly is
    // the only reliable type-level proof that the fields exist.
    expectTypeOf<keyof M3LCliHistoryEntry>().toEqualTypeOf<
      | "timestamp"
      | "script"
      | "parameterNames"
      | "exitCode"
      | "outcome"
      | "retryAttempts"
    >();
  });

  test("HISTORY_CAP is exactly 100", () => {
    expect(HISTORY_CAP).toBe(100);
  });
});
