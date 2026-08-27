/**
 * Tests for src/cli/flags.ts — the CLI-reserved `--json` flag constant and
 * the exact-token partitioning helper `main.ts`/`commands/dynamic.ts` use to
 * recognize it ahead of any script's own declared parameters (V2 slice 1,
 * ADR-0063 / #539), plus its U7 sibling `--in-process`/`partitionInProcessFlag`
 * (ADR-0054), which mirrors the exact same exact-token-match semantics.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  IN_PROCESS_FLAG,
  JSON_FLAG,
  partitionInProcessFlag,
  partitionJsonFlag,
} from "../src/cli/flags.js";

describe("JSON_FLAG", () => {
  test("is the literal '--json' token", () => {
    expect(JSON_FLAG).toBe("--json");
    expectTypeOf(JSON_FLAG).toEqualTypeOf<"--json">();
  });
});

describe("partitionJsonFlag — presence detection", () => {
  test("detects a lone '--json' token, removing it from rest", () => {
    const result = partitionJsonFlag(["--json"]);

    expect(result.jsonOutput).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("reports jsonOutput false and leaves rest unchanged when '--json' is absent", () => {
    const args = ["--region", "us-east-1"];

    const result = partitionJsonFlag(args);

    expect(result.jsonOutput).toBe(false);
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("does NOT match '--json=true' (exact-token only) — it stays in rest and jsonOutput is false", () => {
    const result = partitionJsonFlag(["--json=true"]);

    expect(result.jsonOutput).toBe(false);
    expect(result.rest).toEqual(["--json=true"]);
  });

  test("detects repeated '--json --json', removing both occurrences", () => {
    const result = partitionJsonFlag(["--json", "--json"]);

    expect(result.jsonOutput).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("preserves the original order of the remaining tokens", () => {
    const result = partitionJsonFlag([
      "--region",
      "us-east-1",
      "--json",
      "--verbose",
    ]);

    expect(result.jsonOutput).toBe(true);
    expect(result.rest).toEqual(["--region", "us-east-1", "--verbose"]);
  });

  test("returns jsonOutput false and an empty rest for an empty array", () => {
    const result = partitionJsonFlag([]);

    expect(result.jsonOutput).toBe(false);
    expect(result.rest).toEqual([]);
  });
});

describe("partitionJsonFlag — type contract", () => {
  test("returns a readonly { jsonOutput: boolean; rest: readonly string[] } shape", () => {
    expectTypeOf(partitionJsonFlag([])).toEqualTypeOf<{
      readonly jsonOutput: boolean;
      readonly rest: readonly string[];
    }>();
  });
});

describe("IN_PROCESS_FLAG", () => {
  test("is the literal '--in-process' token", () => {
    expect(IN_PROCESS_FLAG).toBe("--in-process");
    expectTypeOf(IN_PROCESS_FLAG).toEqualTypeOf<"--in-process">();
  });
});

describe("partitionInProcessFlag — presence detection", () => {
  test("detects a lone '--in-process' token, removing it from rest", () => {
    const result = partitionInProcessFlag(["--in-process"]);

    expect(result.inProcess).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("reports inProcess false and leaves rest unchanged when '--in-process' is absent", () => {
    const args = ["--region", "us-east-1"];

    const result = partitionInProcessFlag(args);

    expect(result.inProcess).toBe(false);
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("does NOT match '--in-process=true' (exact-token only) — it stays in rest and inProcess is false", () => {
    const result = partitionInProcessFlag(["--in-process=true"]);

    expect(result.inProcess).toBe(false);
    expect(result.rest).toEqual(["--in-process=true"]);
  });

  test("detects repeated '--in-process --in-process', removing both occurrences", () => {
    const result = partitionInProcessFlag(["--in-process", "--in-process"]);

    expect(result.inProcess).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("preserves the original order of the remaining tokens", () => {
    const result = partitionInProcessFlag([
      "--region",
      "us-east-1",
      "--in-process",
      "--verbose",
    ]);

    expect(result.inProcess).toBe(true);
    expect(result.rest).toEqual(["--region", "us-east-1", "--verbose"]);
  });

  test("returns inProcess false and an empty rest for an empty array", () => {
    const result = partitionInProcessFlag([]);

    expect(result.inProcess).toBe(false);
    expect(result.rest).toEqual([]);
  });
});

describe("partitionInProcessFlag — type contract", () => {
  test("returns a readonly { inProcess: boolean; rest: readonly string[] } shape", () => {
    expectTypeOf(partitionInProcessFlag([])).toEqualTypeOf<{
      readonly inProcess: boolean;
      readonly rest: readonly string[];
    }>();
  });
});
