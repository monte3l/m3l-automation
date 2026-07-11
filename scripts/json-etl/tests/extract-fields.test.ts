import { describe, expect, test } from "vitest";

import { extractFields } from "../src/steps/extract-fields.js";

/**
 * Contract: docs/reference/scripts/json-etl.md, `extract-fields` row +
 * core/json.md's `extractAll`. Each `fields` entry is `name=path`; keys in
 * the output record follow `fields` ORDER. A wildcard multi-match either
 * `join`s into one field or `explode`s into one record per match. A missing
 * path (extractAll -> []) leaves the field present with an empty/undefined
 * value — never dropped.
 */

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function* oneRecord(record: unknown): AsyncGenerator<unknown> {
  await Promise.resolve();
  yield record;
}

describe("extractFields", () => {
  test("builds a flat record with keys in fields order, independent of the underlying paths", async () => {
    const records = oneRecord({ x: 1, y: 2 });

    const [result] = await drain(
      extractFields({ records, fields: ["b=y", "a=x"], multiValue: "join" }),
    );

    expect(Object.keys(result ?? {})).toEqual(["b", "a"]);
    expect(result).toEqual({ b: 2, a: 1 });
  });

  test("multiValue 'explode' fans a wildcard multi-match out into one record per match, in document order", async () => {
    const record = { id: 1, items: [{ tag: "a" }, { tag: "b" }, { tag: "c" }] };
    const records = oneRecord(record);

    const result = await drain(
      extractFields({
        records,
        fields: ["id=id", "tag=items.*.tag"],
        multiValue: "explode",
      }),
    );

    expect(result).toEqual([
      { id: 1, tag: "a" },
      { id: 1, tag: "b" },
      { id: 1, tag: "c" },
    ]);
  });

  test("multiValue 'join' collapses a wildcard multi-match into a single record with one field", async () => {
    const record = { id: 1, items: [{ tag: "a" }, { tag: "b" }, { tag: "c" }] };
    const records = oneRecord(record);

    const result = await drain(
      extractFields({
        records,
        fields: ["id=id", "tag=items.*.tag"],
        multiValue: "join",
      }),
    );

    expect(result).toHaveLength(1);
    const [joined] = result;
    expect(joined?.["id"]).toBe(1);
    const joinedTag = String(joined?.["tag"]);
    expect(joinedTag).toContain("a");
    expect(joinedTag).toContain("b");
    expect(joinedTag).toContain("c");
  });

  test("a missing extraction path leaves the field present with an empty/undefined value", async () => {
    const records = oneRecord({ id: 5 });

    const [result] = await drain(
      extractFields({
        records,
        fields: ["id=id", "missing=nope.path"],
        multiValue: "join",
      }),
    );

    expect(result).toBeDefined();
    expect(Object.hasOwn(result ?? {}, "missing")).toBe(true);
    expect([undefined, ""]).toContain(result?.["missing"]);
  });
});
