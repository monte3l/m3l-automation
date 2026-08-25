import { describe, expect, expectTypeOf, it } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";

import { coerceRdsDataValueForOutput } from "../../src/steps/export-results.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `export-results` row —
 * "Coerces `M3LRDSDataValue` to its output representation at this boundary
 * only (`null`/`string`/`long`/`double`/`boolean` pass through; `blob`
 * becomes base64), with an exhaustive `switch` on `output.format`." Covers
 * every `M3LRDSDataValue` discriminant across all three `output.format`
 * values (`json`/`jsonl`/`csv`).
 */

const OUTPUT_FORMATS = ["json", "jsonl", "csv"] as const;

interface CoercionCase {
  readonly name: string;
  readonly value: AWS.M3LRDSDataValue;
  readonly expected: unknown;
}

const CASES: readonly CoercionCase[] = [
  { name: "null", value: { kind: "null" }, expected: null },
  {
    name: "string",
    value: { kind: "string", value: "hello" },
    expected: "hello",
  },
  { name: "long", value: { kind: "long", value: 42 }, expected: 42 },
  {
    name: "double",
    value: { kind: "double", value: 3.14 },
    expected: 3.14,
  },
  {
    name: "boolean (true)",
    value: { kind: "boolean", value: true },
    expected: true,
  },
  {
    name: "boolean (false)",
    value: { kind: "boolean", value: false },
    expected: false,
  },
];

describe("coerceRdsDataValueForOutput", () => {
  describe.each(OUTPUT_FORMATS)("output.format = '%s'", (format) => {
    it.each(CASES)(
      "passes '$name' through unchanged",
      ({ value, expected }) => {
        expect(coerceRdsDataValueForOutput(value, format)).toBe(expected);
      },
    );

    it("encodes a 'blob' value as base64", () => {
      const bytes = new Uint8Array([0x68, 0x69, 0x21]); // "hi!"
      const value: AWS.M3LRDSDataValue = { kind: "blob", value: bytes };

      expect(coerceRdsDataValueForOutput(value, format)).toBe(
        Buffer.from(bytes).toString("base64"),
      );
    });

    it("encodes an empty 'blob' value as an empty base64 string", () => {
      const value: AWS.M3LRDSDataValue = {
        kind: "blob",
        value: new Uint8Array([]),
      };

      expect(coerceRdsDataValueForOutput(value, format)).toBe("");
    });
  });

  it("has the documented (value, format) -> unknown signature (type contract)", () => {
    expectTypeOf(coerceRdsDataValueForOutput)
      .parameter(0)
      .toExtend<AWS.M3LRDSDataValue>();
    expectTypeOf(coerceRdsDataValueForOutput)
      .parameter(1)
      .toEqualTypeOf<"json" | "jsonl" | "csv">();
  });
});
