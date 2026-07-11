import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { filterRecords } from "../src/steps/filter-records.js";

/**
 * Contract: docs/reference/scripts/json-etl.md, `filter-records` row. Each
 * filter rule is `path op value`; ops: eq ne contains regex gt lt exists. A
 * record must satisfy EVERY rule to pass. Numerics (gt/lt) are parsed via
 * `Core.parseLocaleNumber`; an unparsable operand makes the comparison FAIL,
 * not fall through to a NaN comparison.
 */

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function* recordsOf(
  ...records: readonly Record<string, unknown>[]
): AsyncGenerator<Record<string, unknown>> {
  await Promise.resolve();
  yield* records;
}

describe("filterRecords", () => {
  test.each([
    ["eq", "status eq active", { status: "active" }, true],
    ["eq", "status eq active", { status: "inactive" }, false],
    ["ne", "status ne active", { status: "inactive" }, true],
    ["ne", "status ne active", { status: "active" }, false],
    ["contains", "name contains Ada", { name: "Ada Lovelace" }, true],
    ["contains", "name contains Ziggy", { name: "Ada Lovelace" }, false],
    ["regex", "name regex ^Ada", { name: "Ada Lovelace" }, true],
    ["regex", "name regex ^Ada", { name: "Grace Hopper" }, false],
    ["gt", "age gt 18", { age: "21" }, true],
    ["gt", "age gt 18", { age: "10" }, false],
    ["lt", "age lt 18", { age: "10" }, true],
    ["lt", "age lt 18", { age: "21" }, false],
    ["exists", "nickname exists", { nickname: "Ace" }, true],
    ["exists", "nickname exists", {}, false],
  ] as const)("op %s ('%s') passes=%s", async (_op, rule, record, expected) => {
    const result = await drain(
      filterRecords({ records: recordsOf(record), filters: [rule] }),
    );
    expect(result.length > 0).toBe(expected);
  });

  test("a record must satisfy every rule to pass", async () => {
    const passesBoth = { status: "active", age: "30" };
    const failsOneRule = { status: "active", age: "10" };

    const result = await drain(
      filterRecords({
        records: recordsOf(passesBoth, failsOneRule),
        filters: ["status eq active", "age gt 18"],
      }),
    );

    expect(result).toEqual([passesBoth]);
  });

  test("an unparsable numeric operand makes gt/lt fail rather than compare against NaN", async () => {
    const record = { age: "not-a-number" };

    const result = await drain(
      filterRecords({
        records: recordsOf(record),
        filters: ["age gt 10"],
      }),
    );

    expect(result).toEqual([]);
  });

  test("a gt/lt rule whose literal value is not a parseable number throws before any record is read, not a silent empty result", async () => {
    await expect(
      drain(
        filterRecords({
          records: recordsOf({ age: "21" }),
          filters: ["age gt eighteen"],
        }),
      ),
    ).rejects.toBeInstanceOf(Core.M3LError);

    let thrown: unknown;
    try {
      await drain(
        filterRecords({
          records: recordsOf({ age: "21" }),
          filters: ["age gt eighteen"],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_JSON_ETL_FILTER_RULE");
  });

  test("a regex rule with an invalid pattern throws a typed M3LError at parse time, not a raw SyntaxError", async () => {
    let thrown: unknown;
    try {
      await drain(
        filterRecords({
          records: recordsOf({ name: "Ada" }),
          filters: ["name regex ["],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect((thrown as Core.M3LError).code).toBe("ERR_JSON_ETL_FILTER_RULE");
  });
});
