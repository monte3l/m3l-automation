/**
 * Tests for src/cli/suggest.ts — the shared Damerau-Levenshtein suggestion
 * routine (`Core.M3LConfigSchema` + `Core.M3LUnknownParameterDetector`) that
 * `main.ts` (unknown command), `commands/inspect.ts`, and `commands/run.ts`
 * (unknown script) all consume (m3l-cli 8c addendum, review finding CR#3).
 * Exercised against the real `@m3l-automation/m3l-common` library — no
 * mocks, since the point of the dedup is that its output is identical to the
 * previously-duplicated inline bodies.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { suggestNames } from "../src/cli/suggest.js";

describe("suggestNames — near-miss suggestion", () => {
  test("suggests the single near-miss known name for a one-edit-distance typo", () => {
    const result = suggestNames("json-etll", [
      "json-etl",
      "csv-import",
      "s3-sync",
    ]);

    expect(result).toEqual(["json-etl"]);
  });

  test("suggests near-miss command names, mirroring main.ts's previous inline usage", () => {
    const result = suggestNames("lsit", ["list", "inspect", "help"]);

    expect(result).toEqual(expect.arrayContaining(["list"]));
  });
});

describe("suggestNames — no close match", () => {
  test("returns an empty array when nothing among knownNames is close", () => {
    const result = suggestNames("zzzzzzzzzzzzzzzzzzzz", [
      "json-etl",
      "csv-import",
    ]);

    expect(result).toEqual([]);
  });
});

describe("suggestNames — empty knownNames", () => {
  test("returns an empty array when knownNames is empty", () => {
    expect(suggestNames("json-etl", [])).toEqual([]);
  });
});

describe("suggestNames — type contract", () => {
  test("returns a readonly string[]", () => {
    expectTypeOf(suggestNames("x", [])).toEqualTypeOf<readonly string[]>();
  });
});
