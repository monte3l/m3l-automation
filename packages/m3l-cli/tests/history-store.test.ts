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
  historyOutcomeFields,
  readHistory,
  recordHistoryEntry,
} from "../src/history/store.js";
import type { M3LCliHistoryEntry } from "../src/history/store.js";
import type {
  M3LCliRunOutcome,
  M3LCliRunReportSummary,
} from "../src/run/envelope.js";

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

describe("recordHistoryEntry — projects on write (bytes on disk are the projected shape)", () => {
  // Runs recordHistoryEntry against a fresh ("[]") existing history and
  // returns the parsed array actually handed to writeFileSync — the ground
  // truth for "what's on disk", as opposed to routing back through
  // readHistory (which re-projects on *read* regardless of what the write
  // path did, and so could not discriminate a write path that skips
  // projection).
  function captureWrittenEntries(entry: M3LCliHistoryEntry): unknown[] {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    let capturedJson = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, data) => {
      capturedJson = data as string;
    });

    recordHistoryEntry("/cache/history.json", entry);

    expect(capturedJson).not.toBe("");
    return JSON.parse(capturedJson) as unknown[];
  }

  // A structural superset of M3LCliHistoryEntry. Assigning an object of this
  // type to a M3LCliHistoryEntry-typed parameter compiles without a cast
  // (TypeScript's excess-property check only fires on a fresh object literal
  // assigned directly to the narrower type, not on a named variable of a
  // wider/superset type) — this is exactly the kind of hostile input a real
  // caller-side bug could hand to recordHistoryEntry.
  interface HostileHistoryEntry extends M3LCliHistoryEntry {
    readonly extraField: string;
  }

  test("a caller-supplied entry carrying an extra undeclared field does not reach the written JSON", () => {
    const hostileEntry: HostileHistoryEntry = {
      ...sampleEntry,
      extraField: "should-not-survive",
    };

    const [writtenEntry] = captureWrittenEntries(hostileEntry);

    expect(writtenEntry).not.toHaveProperty("extraField");
    expect(writtenEntry).toEqual(sampleEntry);
  });

  test("a NaN retryAttempts value is dropped from the written JSON", () => {
    const entry: M3LCliHistoryEntry = { ...sampleEntry, retryAttempts: NaN };

    const [writtenEntry] = captureWrittenEntries(entry);

    expect(writtenEntry).not.toHaveProperty("retryAttempts");
  });

  test("an Infinity retryAttempts value is dropped from the written JSON", () => {
    const entry: M3LCliHistoryEntry = {
      ...sampleEntry,
      retryAttempts: Infinity,
    };

    const [writtenEntry] = captureWrittenEntries(entry);

    expect(writtenEntry).not.toHaveProperty("retryAttempts");
  });

  test("an unrecognized outcome literal is dropped from the written JSON", () => {
    const entry: M3LCliHistoryEntry = {
      ...sampleEntry,
      // Deliberate hostile cast: "bogus-outcome" is not a member of
      // M3LCliRunOutcome. Simulates a caller (or a forward-incompatible
      // report reader) handing an unrecognized literal through the typed
      // API — the write path's projectHistoryEntry guard must drop it, the
      // same way the read path already does.
      outcome: "bogus-outcome" as unknown as M3LCliRunOutcome,
    };

    const [writtenEntry] = captureWrittenEntries(entry);

    expect(writtenEntry).not.toHaveProperty("outcome");
  });

  test("retryAttempts: 0 is written, not dropped as falsy", () => {
    const entry: M3LCliHistoryEntry = { ...sampleEntry, retryAttempts: 0 };

    const [writtenEntry] = captureWrittenEntries(entry);

    expect(writtenEntry).toHaveProperty("retryAttempts", 0);
  });

  test("outcome: 'success' is written, not dropped", () => {
    const entry: M3LCliHistoryEntry = { ...sampleEntry, outcome: "success" };

    const [writtenEntry] = captureWrittenEntries(entry);

    expect(writtenEntry).toHaveProperty("outcome", "success");
  });

  test("parameterNames is written as a fresh array, not the caller's reference", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    // A written STRING can never reveal aliasing — by the time the test
    // could mutate anything, writeFileSync's argument is already a fully
    // materialized string. Spying on JSON.stringify (and calling through to
    // the real implementation) lets us inspect the exact array reference
    // recordHistoryEntry hands to serialization, before any post-call
    // mutation of the caller's original array.
    const stringifySpy = vi.spyOn(JSON, "stringify");

    const params = ["region"];
    const entry: M3LCliHistoryEntry = {
      ...sampleEntry,
      parameterNames: params,
    };

    recordHistoryEntry("/cache/history.json", entry);

    const stringifyCall: unknown[] = stringifySpy.mock.calls[0] ?? [[]];
    const writtenEntries = stringifyCall[0] as M3LCliHistoryEntry[];
    const lastWritten = writtenEntries[writtenEntries.length - 1];
    const writtenParams = lastWritten?.parameterNames;

    // Mutate the caller's original array only *after* recordHistoryEntry has
    // returned. If the write path stored the reference directly (no defensive
    // copy), writtenParams is the same array object and would show this
    // mutation too.
    params.push("mutated-after-call");

    expect(writtenParams).toEqual(["region"]);
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

describe("historyOutcomeFields", () => {
  // Derived by hand — NOT from the implementation's own recognized-outcome
  // set nor from M3LCliHistoryEntry's declared type. Reconciling both sides
  // of this check from the same source would make it vacuous.
  const ALL_OUTCOMES = [
    "success",
    "failure",
    "dry-run",
    "interrupted",
    "partial",
  ] as const;

  function buildSummary(
    overrides: Partial<M3LCliRunReportSummary> = {},
  ): M3LCliRunReportSummary {
    return {
      outcome: null,
      timelineCount: null,
      timelineSourceCount: null,
      recoveryTotal: null,
      retryAttempts: null,
      ...overrides,
    };
  }

  test("an undefined summary maps to an empty object", () => {
    expect(historyOutcomeFields(undefined)).toStrictEqual({});
  });

  test("outcome: null and retryAttempts: null map to an empty object", () => {
    const summary = buildSummary({ outcome: null, retryAttempts: null });

    const result = historyOutcomeFields(summary);

    expect(result).not.toHaveProperty("outcome");
    // toStrictEqual({}) (not just the two not.toHaveProperty checks above)
    // additionally rules out `{ outcome: undefined }` — a key present but set
    // to undefined, which JSON.stringify would serialize as `"outcome":null`
    // in the written history file, the exact corruption this mapping exists
    // to prevent.
    expect(result).toStrictEqual({});
  });

  test("a fully-populated summary maps both fields through intact", () => {
    const summary = buildSummary({ outcome: "partial", retryAttempts: 3 });

    const result = historyOutcomeFields(summary);

    expect(result).toStrictEqual({ outcome: "partial", retryAttempts: 3 });
  });

  test("retryAttempts: 0 yields retryAttempts: 0, NOT an absent key — the case a truthiness-based implementation drops", () => {
    const summary = buildSummary({ retryAttempts: 0 });

    const result = historyOutcomeFields(summary);

    expect(Object.hasOwn(result, "retryAttempts")).toBe(true);
    expect(result).toStrictEqual({ retryAttempts: 0 });
  });

  test.each([NaN, Infinity, -Infinity])(
    "retryAttempts: %s yields an absent key",
    (value) => {
      const summary = buildSummary({ retryAttempts: value });

      const result = historyOutcomeFields(summary);

      expect(result).not.toHaveProperty("retryAttempts");
    },
  );

  test.each(ALL_OUTCOMES)("outcome %s passes through intact", (outcome) => {
    const summary = buildSummary({ outcome });

    const result = historyOutcomeFields(summary);

    expect(result).toStrictEqual({ outcome });
  });

  test("an unrecognized outcome literal yields an absent key (re-narrowed via toRunOutcome, not trusted from the input's declared type)", () => {
    const summary = buildSummary({
      // Deliberate hostile cast: "bogus-outcome" is not a member of
      // M3LCliRunOutcome — simulates a malformed report reaching this helper
      // despite its declared type, proving the helper re-validates rather
      // than trusting the summary's static type.
      outcome: "bogus-outcome" as unknown as M3LCliRunOutcome,
    });

    const result = historyOutcomeFields(summary);

    expect(result).not.toHaveProperty("outcome");
  });

  test("reads retryAttempts exactly once, never leaking a later-observed value", () => {
    let readCount = 0;
    const summary = buildSummary();
    Object.defineProperty(summary, "retryAttempts", {
      configurable: true,
      enumerable: true,
      get: () => {
        readCount += 1;
        return readCount === 1 ? 3 : "SECRET-LEAKED-ON-SECOND-READ";
      },
    });

    const result = historyOutcomeFields(summary);

    expect(readCount).toBe(1);
    expect(result).toStrictEqual({ retryAttempts: 3 });
  });

  test("reads outcome exactly once, never leaking a later-observed value", () => {
    let readCount = 0;
    const summary = buildSummary();
    Object.defineProperty(summary, "outcome", {
      configurable: true,
      enumerable: true,
      get: () => {
        readCount += 1;
        return readCount === 1 ? "success" : "SECRET-LEAKED-ON-SECOND-READ";
      },
    });

    const result = historyOutcomeFields(summary);

    expect(readCount).toBe(1);
    expect(result).toStrictEqual({ outcome: "success" });
  });

  test("the returned object is not the summary itself, nor a view onto it — mutating the summary after the call must not change the result", () => {
    const summary = buildSummary({ outcome: "partial", retryAttempts: 2 });

    const result = historyOutcomeFields(summary);

    // Direct identity check: a naive `return summary as Pick<...>` would
    // return the exact same object, which the mutation below would also
    // catch, but this check can't be defeated by any accidental partial
    // copy either.
    expect(result).not.toBe(summary);

    // Mutate the summary's own fields only *after* the call returns. Both
    // fields are primitives (a string literal, a number) — copied by value,
    // not by reference — so this only discriminates a bug where the helper
    // returns (or shares) the `summary` object itself rather than building a
    // fresh result object.
    Object.defineProperty(summary, "outcome", {
      configurable: true,
      value: "failure",
    });
    Object.defineProperty(summary, "retryAttempts", {
      configurable: true,
      value: 99,
    });

    expect(result).toStrictEqual({ outcome: "partial", retryAttempts: 2 });
  });
});

describe("prototype pollution — optional fields must not be read through the prototype chain", () => {
  // [REVIEW-FIX 1] projectHistoryEntry and historyOutcomeFields currently
  // read `outcome`/`retryAttempts` with a plain property access, which falls
  // through to Object.prototype when the object has no own property of that
  // name. Object.prototype is global, mutable state shared by the entire
  // worker — any test that pollutes it MUST restore it unconditionally,
  // regardless of assertion outcome, or every later test in this file (and
  // any other file sharing this worker) silently starts seeing a fabricated
  // `outcome`/`retryAttempts` on every plain object.
  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, "outcome");
    Reflect.deleteProperty(Object.prototype, "retryAttempts");
  });

  function pollutePrototype(): void {
    Object.defineProperty(Object.prototype, "outcome", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "success",
    });
    Object.defineProperty(Object.prototype, "retryAttempts", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: 424242,
    });
  }

  test("historyOutcomeFields: a summary lacking own outcome/retryAttempts ignores inherited values", () => {
    // Leak check: fails loudly here (rather than silently passing the real
    // assertion below for the wrong reason) if a prior test left pollution.
    expect({}).not.toHaveProperty("outcome");
    expect({}).not.toHaveProperty("retryAttempts");

    pollutePrototype();
    // Deliberately omits its own `outcome`/`retryAttempts` keys entirely — a
    // real caller could hand this via a partial JSON.parse widened with an
    // `as` cast, the same test-boundary-only technique used elsewhere in
    // this file. TypeScript would reject the literal directly (missing
    // required properties), hence the cast through `unknown`.
    const summary = {
      timelineCount: null,
      timelineSourceCount: null,
      recoveryTotal: null,
    } as unknown as M3LCliRunReportSummary;

    expect(historyOutcomeFields(summary)).toStrictEqual({});
  });

  test("projectHistoryEntry via readHistory: a persisted entry without its own outcome/retryAttempts keys ignores inherited values", () => {
    expect({}).not.toHaveProperty("outcome");
    expect({}).not.toHaveProperty("retryAttempts");

    pollutePrototype();
    // sampleEntry carries only the four core fields — no own outcome/
    // retryAttempts — so JSON.parse of its serialized form produces an
    // object whose only path to those two properties is the prototype.
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify([sampleEntry]));

    const result = readHistory("/cache/history.json");

    expect(result).toHaveLength(1);
    const [projectedEntry] = result;
    if (projectedEntry === undefined) {
      throw new Error("expected readHistory to return exactly one entry");
    }
    // Not `not.toHaveProperty` here: with Object.prototype still polluted at
    // this point in the test, `toHaveProperty` falls back to
    // `"outcome" in Object(projectedEntry)` for a non-own key, which walks
    // the whole prototype chain — so it would report the (inherited)
    // property as present on EVERY object, correctly-projected or not, and
    // could never fail. Object.hasOwn checks only the object's own keys, so
    // it actually discriminates a projection that fails to guard its reads.
    expect(Object.hasOwn(projectedEntry, "outcome")).toBe(false);
    expect(Object.hasOwn(projectedEntry, "retryAttempts")).toBe(false);
    expect(projectedEntry).toEqual(sampleEntry);
  });

  test("recordHistoryEntry: an entry without its own outcome/retryAttempts keys does not persist inherited values", () => {
    expect({}).not.toHaveProperty("outcome");
    expect({}).not.toHaveProperty("retryAttempts");

    pollutePrototype();
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    let capturedJson = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, data) => {
      capturedJson = data as string;
    });

    const recorded = recordHistoryEntry("/cache/history.json", sampleEntry);

    expect(recorded).toBe(true);
    const [writtenEntry] = JSON.parse(capturedJson) as unknown[];
    // Not `not.toHaveProperty` here: with Object.prototype still polluted at
    // this point in the test, `toHaveProperty` falls back to `"outcome" in
    // Object(writtenEntry)` for a non-own key, which walks the whole
    // prototype chain — so it would report the (inherited) property as
    // present on the written entry regardless of whether the write path
    // actually copied it, and could never fail. Object.hasOwn checks only
    // the object's own keys, so it actually discriminates a write path that
    // fails to guard its reads.
    expect(Object.hasOwn(writtenEntry as object, "outcome")).toBe(false);
    expect(Object.hasOwn(writtenEntry as object, "retryAttempts")).toBe(false);
  });

  test("a clean object has no inherited outcome/retryAttempts after every pollution test above (afterEach cleanup confirmed unconditional)", () => {
    expect({}).not.toHaveProperty("outcome");
    expect({}).not.toHaveProperty("retryAttempts");
    expect(historyOutcomeFields(undefined)).toStrictEqual({});
  });
});

describe("recordHistoryEntry — validates the four required fields on write, not only on read", () => {
  // [REVIEW-FIX 2] isValidHistoryEntry currently runs only inside
  // readHistory. projectHistoryEntry copies timestamp/script/exitCode/
  // parameterNames through unchecked on the write path, so recordHistoryEntry
  // will happily persist structurally invalid data. These tests pin the
  // fixed contract: recordHistoryEntry must run isValidHistoryEntry on the
  // incoming entry and return false, writing nothing, when it fails.

  // Deliberately malformed relative to M3LCliHistoryEntry's declared shape.
  // Cast at the test boundary only, mirroring the HostileHistoryEntry
  // technique used above in this file — this is exactly the hostile input a
  // real caller (a JS consumer, or a TS caller that bypassed the type via
  // `any`/`JSON.parse`) could hand to recordHistoryEntry.
  function malformedEntry(
    overrides: Record<string, unknown>,
  ): M3LCliHistoryEntry {
    return { ...sampleEntry, ...overrides };
  }

  const malformedFieldCases: readonly (readonly [
    string,
    Record<string, unknown>,
  ])[] = [
    ["exitCode: NaN", { exitCode: NaN }],
    ["exitCode: Infinity", { exitCode: Infinity }],
    ["timestamp: a number", { timestamp: 1_735_689_600_000 }],
    ["script: a number", { script: 42 }],
    [
      "parameterNames containing a non-string",
      { parameterNames: ["region", 42] },
    ],
  ];

  test.each(malformedFieldCases)(
    "an entry with %s returns false and writes nothing",
    (_label, overrides) => {
      vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
      vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
      const entry = malformedEntry(overrides);

      expect(recordHistoryEntry("/cache/history.json", entry)).toBe(false);
      expect(writeSpy).not.toHaveBeenCalled();
    },
  );

  test("a malformed entry (exitCode: NaN) leaves a pre-existing history file's bytes untouched — a bad append must not destroy good history", () => {
    const existingJson = JSON.stringify([sampleEntry], undefined, 2);
    vi.spyOn(fs, "readFileSync").mockReturnValue(existingJson);
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    const entry = malformedEntry({ exitCode: NaN });

    const recorded = recordHistoryEntry("/cache/history.json", entry);

    expect(recorded).toBe(false);
    // The only way this store mutates the file is via writeFileSync — if it
    // was never called, the on-disk bytes (represented here by existingJson,
    // the content a subsequent readFileSync would return) are untouched by
    // definition.
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("an object-valued script with a hostile toJSON does not leak its sentinel into any written bytes", () => {
    const sentinel = "SENTINEL-SHOULD-NEVER-BE-WRITTEN";
    const hostileScript = { toJSON: () => sentinel };
    const entry = malformedEntry({ script: hostileScript });
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const recorded = recordHistoryEntry("/cache/history.json", entry);

    expect(recorded).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    for (const call of writeSpy.mock.calls) {
      const data = call[1];
      if (typeof data === "string") {
        expect(data).not.toContain(sentinel);
      }
    }
  });
});

describe("recordHistoryEntry — write-path validation does not reject well-formed entries (regression guard)", () => {
  // Derived by hand, not from the implementation's recognized-outcome set —
  // reconciling both sides from the same source would make this vacuous.
  const ALL_OUTCOMES = [
    "success",
    "failure",
    "dry-run",
    "interrupted",
    "partial",
  ] as const;

  test("a well-formed entry without the optional fields still returns true and writes", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    expect(recordHistoryEntry("/cache/history.json", sampleEntry)).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test("retryAttempts: 0 still returns true and writes — not rejected as falsy", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    const entry: M3LCliHistoryEntry = { ...sampleEntry, retryAttempts: 0 };

    expect(recordHistoryEntry("/cache/history.json", entry)).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test.each(ALL_OUTCOMES.map((outcome) => [outcome] as const))(
    "outcome: %s still returns true and writes",
    (outcome) => {
      vi.spyOn(fs, "readFileSync").mockReturnValue("[]");
      vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
      const entry: M3LCliHistoryEntry = { ...sampleEntry, outcome };

      expect(recordHistoryEntry("/cache/history.json", entry)).toBe(true);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("historyOutcomeFields — totality", () => {
  // [REVIEW-FIX 3] historyOutcomeFields(null) currently throws
  // "TypeError: Cannot read properties of null (reading 'outcome')" instead
  // of degrading to {} the way an undefined summary already does. It's an
  // exported function, so it should be total over its declared input.
  test("a null summary maps to an empty object rather than throwing", () => {
    // The declared parameter type is `M3LCliRunReportSummary | undefined`;
    // `null` is a hostile-but-plausible runtime input (e.g. from a JSON
    // field explicitly set to null) that the type doesn't rule out for a
    // non-strict caller. Cast at the test boundary only.
    const nullSummary = null as unknown as M3LCliRunReportSummary;

    expect(historyOutcomeFields(nullSummary)).toStrictEqual({});
  });
});
