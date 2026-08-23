import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  extractCorrelationKey,
  extractFromRows,
  extractSignature,
  matchPattern,
  MAX_SCAN_LENGTH,
  maxNumericField,
} from "../../src/steps/correlation.js";

describe("matchPattern", () => {
  it("returns the first capture group when the pattern declares one", () => {
    expect(matchPattern("req [abc-123] failed", "\\[([^\\]]+)\\]", "p")).toBe(
      "abc-123",
    );
  });

  it("returns the whole match when the pattern declares no group", () => {
    expect(matchPattern("TimeoutException here", "\\w+Exception", "p")).toBe(
      "TimeoutException",
    );
  });

  it("returns undefined when nothing matches", () => {
    expect(matchPattern("quiet", "boom", "p")).toBeUndefined();
  });

  it("refuses to scan a value beyond the input ceiling", () => {
    const oversized = `${"x".repeat(MAX_SCAN_LENGTH)}boom`;
    expect(matchPattern(oversized, "boom", "p")).toBeUndefined();
  });

  it("surfaces an uncompilable pattern as a coded M3LError, not a SyntaxError", () => {
    expect(() =>
      matchPattern("value", "([unclosed", "signature.pattern"),
    ).toThrow(Core.M3LError);
    try {
      matchPattern("value", "([unclosed", "signature.pattern");
    } catch (error) {
      expect((error as Core.M3LError).code).toBe(
        "ERR_LOGS_ANALYSIS_EXTRACTION",
      );
      expect((error as Error).message).toContain("signature.pattern");
    }
  });
});

describe("extractFromRows", () => {
  it("takes the field verbatim when no pattern is supplied", () => {
    expect(
      extractFromRows([{ "@message": "boom" }], "@message", undefined, "l"),
    ).toBe("boom");
  });

  it("skips rows whose field is absent or empty and keeps scanning", () => {
    expect(
      extractFromRows(
        [{ other: "x" }, { "@message": "" }, { "@message": "id=7" }],
        "@message",
        "id=(\\d+)",
        "l",
      ),
    ).toBe("7");
  });

  it("returns undefined when no row yields a match", () => {
    expect(
      extractFromRows([{ "@message": "quiet" }], "@message", "id=(\\d+)", "l"),
    ).toBeUndefined();
  });
});

describe("extractCorrelationKey", () => {
  it("extracts the key the preset's rule names", () => {
    expect(
      extractCorrelationKey([{ "@message": "req id=abc-1 done" }], {
        field: "@message",
        pattern: "id=([\\w-]+)",
        label: "request id",
      }),
    ).toBe("abc-1");
  });

  it("returns undefined when the evidence carries no key", () => {
    expect(
      extractCorrelationKey([{ "@message": "no key" }], {
        field: "@message",
        pattern: "id=([\\w-]+)",
        label: "request id",
      }),
    ).toBeUndefined();
  });
});

describe("extractSignature", () => {
  it("derives the signature plus the level and service a case row may pin", () => {
    expect(
      extractSignature(
        [
          {
            "@message": "ERROR TimeoutException",
            level: "ERROR",
            service: "worker",
          },
        ],
        {
          field: "@message",
          pattern: "(\\w+Exception)",
          levelField: "level",
          serviceField: "service",
        },
      ),
    ).toEqual({
      signature: "TimeoutException",
      level: "ERROR",
      service: "worker",
    });
  });

  it("reports an absent level or service as an empty string, not undefined", () => {
    expect(
      extractSignature([{ "@message": "boom" }], {
        field: "@message",
        pattern: undefined,
        levelField: "level",
        serviceField: undefined,
      }),
    ).toEqual({ signature: "boom", level: "", service: "" });
  });

  it("returns undefined when no row yields a signature", () => {
    expect(
      extractSignature([{ other: "x" }], {
        field: "@message",
        pattern: undefined,
        levelField: undefined,
        serviceField: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("maxNumericField", () => {
  it("returns the highest parseable value across the rows", () => {
    expect(
      maxNumericField([{ l: "120" }, { l: "480" }, { l: "90" }], "l"),
    ).toBe(480);
  });

  it("ignores rows whose value is absent or not a finite number", () => {
    expect(
      maxNumericField([{ l: "n/a" }, { other: "1" }, { l: "7" }], "l"),
    ).toBe(7);
  });

  it("returns undefined when no row carries a number", () => {
    expect(maxNumericField([{ l: "n/a" }], "l")).toBeUndefined();
  });
});
