/**
 * Tests for src/discovery/cache.ts — the best-effort, never-throwing
 * discovery cache (m3l-cli 8b contract).
 */
import * as fs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../src/discovery/cache.js";
import type {
  M3LCliDiscoveryCache,
  M3LCliDiscoveryCacheEntry,
} from "../src/discovery/cache.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A well-formed cache entry fixture, reused across the read/write/freshness tests. */
const sampleEntry: M3LCliDiscoveryCacheEntry = {
  srcMtimeMs: 100,
  distMtimeMs: 200,
  parameters: [],
};

/**
 * A well-formed parameters-element fixture (8f contract): every
 * `M3LCliDiscoveryCacheEntry.parameters` element must carry name/type/
 * description strings, an aliases string-array, required/secret booleans,
 * and a `defaultValue` of `string | undefined`.
 */
const wellFormedParameter = {
  name: "region",
  aliases: ["r"],
  type: "STRING",
  required: true,
  defaultValue: "us-east-1",
  description: "AWS region",
  secret: false,
  operations: [],
};

/**
 * A well-formed operation-descriptor fixture (U8 contract): every
 * `M3LCliParameterDescriptor.operations` element must carry name/description
 * strings and a `requiredParameters` string array (never optional/omitted).
 */
const wellFormedOperation = {
  name: "get",
  description: "Fetch one item.",
  requiredParameters: ["key"],
};

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("readDiscoveryCache", () => {
  test("parses a valid cache file into the typed record", () => {
    const payload: M3LCliDiscoveryCache = { foo: sampleEntry };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual(payload);
  });

  test("returns {} when the file does not exist (ENOENT)", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test("returns {} when the file is unreadable for a non-ENOENT reason", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw errnoError("EACCES");
    });

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test("returns {} on invalid JSON", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{not json");

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test.each([
    ["an array", "[1,2,3]"],
    ["a number", "42"],
    ["a string", '"just a string"'],
    ["null", "null"],
  ])(
    "returns {} when the parsed payload is %s, not a plain object",
    (_label, json) => {
      vi.spyOn(fs, "readFileSync").mockReturnValue(json);

      expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
    },
  );

  test("drops only the invalid entries from a payload mixing valid and malformed entries", () => {
    const payload = {
      ok: sampleEntry,
      bad1: null,
      bad2: { srcMtimeMs: "x", distMtimeMs: 200, parameters: [] },
      bad3: { srcMtimeMs: 1, distMtimeMs: null },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({
      ok: sampleEntry,
    });
  });

  test("keeps an entry whose parameters elements are all well-formed, including the secret boolean (8f)", () => {
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [wellFormedParameter],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual(payload);
  });

  test("drops an entry whose parameters element lacks the 'secret' field, invalidating a pre-8f cache entry (8f)", () => {
    const { secret: _drop, ...preSecretParameter } = wellFormedParameter;
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [preSecretParameter],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test.each([
    ["secret is a string, not boolean", { secret: "false" }],
    ["name is missing", { name: undefined }],
    ["aliases is not an array", { aliases: "r" }],
    ["required is a string, not boolean", { required: "true" }],
    ["type is a number, not a string", { type: 1 }],
    ["description is a number, not a string", { description: 1 }],
    [
      "defaultValue is a number (must be string | undefined)",
      { defaultValue: 1 },
    ],
  ])(
    "drops an entry whose parameters element is malformed: %s (8f)",
    (_label, override) => {
      const payload = {
        exporter: {
          srcMtimeMs: 1,
          distMtimeMs: 2,
          parameters: [{ ...wellFormedParameter, ...override }],
        },
      };
      vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

      expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
    },
  );

  test("keeps an entry whose parameters element has a well-formed, populated operations array (U8)", () => {
    const parameterWithOperations = {
      ...wellFormedParameter,
      operations: [wellFormedOperation],
    };
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [parameterWithOperations],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual(payload);
  });

  test("drops an entry whose parameters element has no 'operations' key at all — today's real pre-U8 on-disk shape, invalidating the cache exactly once on upgrade (U8)", () => {
    const { operations: _drop, ...preU8Parameter } = wellFormedParameter;
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [preU8Parameter],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test("drops an entry whose operation is missing requiredParameters entirely — it is not optional on the descriptor (U8)", () => {
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [
          {
            ...wellFormedParameter,
            operations: [{ name: "get", description: "Fetch one item." }],
          },
        ],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test.each([
    ["operations is not an array", { operations: "nope" }],
    ["operations is undefined", { operations: undefined }],
    [
      "operations array element has a non-array requiredParameters",
      { operations: [{ ...wellFormedOperation, requiredParameters: "key" }] },
    ],
    [
      "operations array element has a non-string name",
      { operations: [{ ...wellFormedOperation, name: 1 }] },
    ],
    [
      "operations array element has a non-string description",
      { operations: [{ ...wellFormedOperation, description: 1 }] },
    ],
    [
      "operations array element's requiredParameters contains a non-string element",
      {
        operations: [
          { ...wellFormedOperation, requiredParameters: ["key", 1] },
        ],
      },
    ],
  ])(
    "drops an entry whose parameters element has a malformed operations field: %s (U8)",
    (_label, override) => {
      const payload = {
        exporter: {
          srcMtimeMs: 1,
          distMtimeMs: 2,
          parameters: [{ ...wellFormedParameter, ...override }],
        },
      };
      vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

      expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
    },
  );

  test("drops an extra unknown field inside a kept entry's operation object, projecting to exactly the declared operation shape (U8)", () => {
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [
          {
            ...wellFormedParameter,
            operations: [
              {
                ...wellFormedOperation,
                extraOperationField: "should-not-survive",
              },
            ],
          },
        ],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readDiscoveryCache("/cache/discovery.json");

    expect(result["exporter"]?.parameters[0]?.operations).toEqual([
      wellFormedOperation,
    ]);
    expect(
      result["exporter"]?.parameters[0]?.operations?.[0],
    ).not.toHaveProperty("extraOperationField");
  });

  test("projects operations into a fresh array (and fresh requiredParameters array), so mutating the parsed cache object after the read leaves the returned descriptor unaffected (U8)", () => {
    const requiredParameters = ["key"];
    const parsedPayload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [
          {
            ...wellFormedParameter,
            operations: [{ ...wellFormedOperation, requiredParameters }],
          },
        ],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "ignored-since-JSON.parse-is-mocked",
    );
    vi.spyOn(JSON, "parse").mockReturnValue(parsedPayload);

    const result = readDiscoveryCache("/cache/discovery.json");
    // Mutate the very array `JSON.parse` handed back internally to
    // readDiscoveryCache — if projectCachedParameter/projectCacheEntry
    // aliased it instead of copying, this mutation would leak into `result`.
    requiredParameters.push("mutated-after-read");

    expect(
      result["exporter"]?.parameters[0]?.operations?.[0]?.requiredParameters,
    ).toEqual(["key"]);
  });

  test("drops only the entry with a malformed parameters element, keeping a well-formed sibling entry (8f)", () => {
    const { secret: _drop, ...preSecretParameter } = wellFormedParameter;
    const payload = {
      good: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [wellFormedParameter],
      },
      stale: {
        srcMtimeMs: 3,
        distMtimeMs: 4,
        parameters: [preSecretParameter],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({
      good: payload.good,
    });
  });

  test("never throws even on an unexpected synchronous fs error", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("disk exploded");
    });

    expect(() => readDiscoveryCache("/cache/discovery.json")).not.toThrow();
    expect(readDiscoveryCache("/cache/discovery.json")).toEqual({});
  });

  test.each(["__proto__", "constructor"])(
    "skips a dangerous key entry named %s entirely, never surfacing it as an own key of the returned cache",
    (dangerousKey) => {
      const payload = `{"${dangerousKey}": ${JSON.stringify(sampleEntry)}, "ok": ${JSON.stringify(sampleEntry)}}`;
      vi.spyOn(fs, "readFileSync").mockReturnValue(payload);

      const result = readDiscoveryCache("/cache/discovery.json");

      expect(result).toEqual({ ok: sampleEntry });
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(result, dangerousKey)).toBe(
        false,
      );
    },
  );

  test("drops any hand-added extra field on a kept entry, projecting to exactly the declared entry shape", () => {
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [],
        extraTopLevelField: "should-not-survive",
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readDiscoveryCache("/cache/discovery.json");

    expect(result).toEqual({
      exporter: { srcMtimeMs: 1, distMtimeMs: 2, parameters: [] },
    });
    expect(result["exporter"]).not.toHaveProperty("extraTopLevelField");
  });

  test("drops any hand-added extra field on a kept entry's parameters element, projecting to exactly the declared descriptor shape", () => {
    const payload = {
      exporter: {
        srcMtimeMs: 1,
        distMtimeMs: 2,
        parameters: [
          { ...wellFormedParameter, extraParameterField: "should-not-survive" },
        ],
      },
    };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(payload));

    const result = readDiscoveryCache("/cache/discovery.json");

    expect(result["exporter"]?.parameters).toEqual([wellFormedParameter]);
    expect(result["exporter"]?.parameters[0]).not.toHaveProperty(
      "extraParameterField",
    );
  });
});

describe("writeDiscoveryCache", () => {
  test("creates the parent directory and writes pretty JSON, returning true", () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    const cache: M3LCliDiscoveryCache = { foo: sampleEntry };
    const result = writeDiscoveryCache(
      join("/cache", "m3l-cli", "discovery.json"),
      cache,
    );

    expect(result).toBe(true);
    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    const [mkdirPath, mkdirOptions] = mkdirSpy.mock.calls[0] ?? ["", {}];
    expect(String(mkdirPath)).toBe(join("/cache", "m3l-cli"));
    expect(mkdirOptions).toMatchObject({ recursive: true });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [, dataArg] = writeSpy.mock.calls[0] ?? ["", ""];
    if (typeof dataArg !== "string") {
      throw new Error("expected writeFileSync to be called with string data");
    }
    expect(JSON.parse(dataArg)).toEqual(cache);
    // "pretty JSON" implies indentation, i.e. more than one line.
    expect(dataArg.split("\n").length).toBeGreaterThan(1);
  });

  test("returns false, never throws, when mkdirSync fails", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw errnoError("EACCES");
    });
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);

    expect(
      writeDiscoveryCache(join("/cache", "m3l-cli", "discovery.json"), {}),
    ).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("returns false, never throws, when writeFileSync fails", () => {
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw errnoError("ENOSPC");
    });

    expect(
      writeDiscoveryCache(join("/cache", "m3l-cli", "discovery.json"), {}),
    ).toBe(false);
  });
});

describe("configMtimes", () => {
  const scriptDirectory = join("/repo", "scripts", "foo");

  test("returns both mtimes when src and dist config files exist", () => {
    vi.spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) => {
      const value = String(path);
      const mtimeMs = value.endsWith(join("src", "config.ts")) ? 111 : 222;
      return { mtimeMs };
    }) as unknown as typeof fs.statSync);

    expect(configMtimes(scriptDirectory)).toEqual({
      srcMtimeMs: 111,
      distMtimeMs: 222,
    });
  });

  test("returns null for whichever config file is absent (dist missing)", () => {
    vi.spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) => {
      const value = String(path);
      if (value.endsWith(join("dist", "config.js"))) {
        throw errnoError("ENOENT");
      }
      return { mtimeMs: 111 };
    }) as unknown as typeof fs.statSync);

    expect(configMtimes(scriptDirectory)).toEqual({
      srcMtimeMs: 111,
      distMtimeMs: null,
    });
  });

  test("returns null for both when neither config file exists", () => {
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    expect(configMtimes(scriptDirectory)).toEqual({
      srcMtimeMs: null,
      distMtimeMs: null,
    });
  });
});

describe("isCacheEntryFresh", () => {
  test("true when both mtimes strictly equal the entry's recorded mtimes", () => {
    expect(
      isCacheEntryFresh(sampleEntry, { srcMtimeMs: 100, distMtimeMs: 200 }),
    ).toBe(true);
  });

  test("false when srcMtimeMs differs", () => {
    expect(
      isCacheEntryFresh(sampleEntry, { srcMtimeMs: 101, distMtimeMs: 200 }),
    ).toBe(false);
  });

  test("false when distMtimeMs differs", () => {
    expect(
      isCacheEntryFresh(sampleEntry, { srcMtimeMs: 100, distMtimeMs: 201 }),
    ).toBe(false);
  });

  test("true when both sides are null (never-built script counts as fresh)", () => {
    const entry: M3LCliDiscoveryCacheEntry = {
      srcMtimeMs: null,
      distMtimeMs: null,
      parameters: [],
    };

    expect(
      isCacheEntryFresh(entry, { srcMtimeMs: null, distMtimeMs: null }),
    ).toBe(true);
  });

  test("false when the entry has a number but the probe found null (config deleted)", () => {
    expect(
      isCacheEntryFresh(sampleEntry, { srcMtimeMs: null, distMtimeMs: 200 }),
    ).toBe(false);
  });
});

describe("M3LCliDiscoveryCache contract", () => {
  test("is a readonly record of entry keyed by script name", () => {
    expectTypeOf<M3LCliDiscoveryCache>().toEqualTypeOf<
      Readonly<Record<string, M3LCliDiscoveryCacheEntry>>
    >();
  });

  test("M3LCliDiscoveryCacheEntry declares the documented readonly shape", () => {
    expectTypeOf<M3LCliDiscoveryCacheEntry>().toExtend<{
      readonly srcMtimeMs: number | null;
      readonly distMtimeMs: number | null;
    }>();
  });
});
