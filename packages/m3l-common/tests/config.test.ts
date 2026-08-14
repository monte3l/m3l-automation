/**
 * Tests for core/config submodule.
 *
 * Contract source: docs/reference/core/config.md (+ frozen contract supplied
 * for this change set — see scratchpad/config-contract.md, settled Q1–Q21).
 *
 * Exports under test: M3LConfig, M3LConfigReader, M3LConfigProvider,
 *   M3LConfigParameter, M3LConfigParameterType, M3LCoercedValue,
 *   M3LConfigSchema, M3LCommandLineConfigProvider, M3LJSONConfigProvider,
 *   M3LYAMLConfigProvider, M3LEnvironmentConfigProvider,
 *   M3LInMemoryConfigProvider, M3LLambdaEventConfigProvider,
 *   M3LPresetConfigProvider, coerceConfigValue, M3LSecretsSpecifier,
 *   M3LUnknownParameterDetector, M3LConfigCoercionError, M3LConfigParseError,
 *   M3LUnsafeConfigKeyError (20 symbols).
 *
 * WS-E addition (schema-time validation, docs/reference/core/config.md
 * "Schema-time validation" — RED until implemented): M3LConfigValidator
 *   (type), M3LConfigValidators (stock range/regex/oneOf), the
 *   M3LConfigParameter `validate?` option, and M3LConfigValidationError
 *   (code: ERR_CONFIG_VALIDATION). Validation runs on the COERCED value at
 *   three points — eagerly on a declared defaultValue (constructor), after
 *   provider coercion, and after asyncFallback — and its context never
 *   carries the value itself (redaction-safe by construction).
 *
 * F1/F2 addition (additive, semver-minor — RED until implemented):
 *   M3LConfigValidators.nonEmpty (a validator VALUE, not a factory) and
 *   .minLength(min) (a factory), both M3LConfigValidator<{ readonly length:
 *   number }>; M3LConfigParameter's `required?: boolean` constructor option;
 *   and M3LConfigMissingError (code: ERR_CONFIG_MISSING), thrown by
 *   getValueAsync when `required` is true and no provider/defaultValue/
 *   asyncFallback supplies a value. Its context carries only
 *   `{ parameter }` — there is no value to redact.
 *
 * Key behavioral contracts:
 *  - Providers are SYNCHRONOUS: getRawValue(key) returns unknown, undefined
 *    when absent. File parsing happens at construction.
 *  - M3LConfigReader.getRawValueForKeys is providers-outer, keys-inner: a
 *    higher-priority provider's alias beats a lower-priority provider's
 *    canonical key.
 *  - M3LConfigParameter.getValueAsync resolves an 8-level chain: reader
 *    (coerced) -> defaultValue (pass-through) -> asyncFallback (pass-through)
 *    -> undefined, short-circuiting strictly.
 *  - coerceConfigValue is the sole public parser; per-type coercion failures
 *    throw M3LConfigCoercionError. It is generic over the target
 *    M3LConfigParameterType member, returning M3LCoercedValue<T> (not
 *    unknown) — runtime coercion behavior is unchanged, only the static type.
 *  - M3LConfigParameter is TYPE-DRIVEN: defaultValue, asyncFallback's
 *    resolved value, and getValueAsync()'s resolution are all
 *    M3LCoercedValue<declared type>, inferred from the `type` field rather
 *    than a caller-supplied generic.
 *  - File providers (JSON/YAML) tolerate a missing file (ENOENT, all
 *    undefined) but throw M3LConfigParseError on malformed content.
 *  - Any provider touching parsed/external input screens keys with
 *    isDangerousKey and throws M3LUnsafeConfigKeyError on a hit.
 */

import * as fs from "fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// Make the 'fs' module configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable by default).
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual };
});

import { M3LError } from "../src/core/errors/index.js";
import {
  coerceConfigValue,
  M3LCommandLineConfigProvider,
  M3LConfig,
  M3LConfigCoercionError,
  M3LConfigHelpFormatter,
  M3LConfigMissingError,
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LConfigParseError,
  M3LConfigProvider,
  M3LConfigReader,
  M3LConfigSchema,
  M3LConfigValidationError,
  M3LConfigValidators,
  M3LEnvironmentConfigProvider,
  M3LInMemoryConfigProvider,
  M3LJSONConfigProvider,
  M3LLambdaEventConfigProvider,
  M3LPresetConfigProvider,
  M3LSecretsSpecifier,
  M3LUnknownParameterDetector,
  M3LUnsafeConfigKeyError,
  M3LYAMLConfigProvider,
} from "../src/core/config/index.js";
import type {
  M3LCoercedValue,
  M3LConfigResolution,
  M3LConfigSchemaValidator,
  M3LConfigValidator,
  M3LUnknownParameterSuggestion,
  M3LUnknownParameterSuggestOptions,
} from "../src/core/config/index.js";
import { damerauLevenshteinDistance } from "../src/internal/config/damerauLevenshtein.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// M3LConfigParameterType
// =============================================================================
describe("M3LConfigParameterType", () => {
  test.each([
    ["STRING", "STRING"],
    ["INT", "INT"],
    ["DOUBLE", "DOUBLE"],
    ["BOOL", "BOOL"],
    ["STRING_ARRAY", "STRING_ARRAY"],
    ["INT_ARRAY", "INT_ARRAY"],
    ["DOUBLE_ARRAY", "DOUBLE_ARRAY"],
    ["BUFFER", "BUFFER"],
  ] as const)("member %s is accessible as the value %j", (member, value) => {
    expect(M3LConfigParameterType[member]).toBe(value);
  });

  test("exposes exactly the 8 documented members", () => {
    expect(Object.keys(M3LConfigParameterType).sort()).toEqual(
      [
        "STRING",
        "INT",
        "DOUBLE",
        "BOOL",
        "STRING_ARRAY",
        "INT_ARRAY",
        "DOUBLE_ARRAY",
        "BUFFER",
      ].sort(),
    );
  });

  describe("type-level contract", () => {
    test("is a narrow union of its 8 string literal members", () => {
      expectTypeOf<M3LConfigParameterType>().toEqualTypeOf<
        | "STRING"
        | "INT"
        | "DOUBLE"
        | "BOOL"
        | "STRING_ARRAY"
        | "INT_ARRAY"
        | "DOUBLE_ARRAY"
        | "BUFFER"
      >();
    });
  });
});

// =============================================================================
// M3LCoercedValue<T> — conditional type mapping each M3LConfigParameterType
// member to its coerced result type.
// =============================================================================
describe("M3LCoercedValue<T>", () => {
  test("STRING maps to string", () => {
    expectTypeOf<M3LCoercedValue<"STRING">>().toEqualTypeOf<string>();
  });

  test("INT maps to number", () => {
    expectTypeOf<M3LCoercedValue<"INT">>().toEqualTypeOf<number>();
  });

  test("DOUBLE maps to number", () => {
    expectTypeOf<M3LCoercedValue<"DOUBLE">>().toEqualTypeOf<number>();
  });

  test("BOOL maps to boolean", () => {
    expectTypeOf<M3LCoercedValue<"BOOL">>().toEqualTypeOf<boolean>();
  });

  test("STRING_ARRAY maps to readonly string[]", () => {
    expectTypeOf<M3LCoercedValue<"STRING_ARRAY">>().toEqualTypeOf<
      readonly string[]
    >();
  });

  test("INT_ARRAY maps to readonly number[]", () => {
    expectTypeOf<M3LCoercedValue<"INT_ARRAY">>().toEqualTypeOf<
      readonly number[]
    >();
  });

  test("DOUBLE_ARRAY maps to readonly number[]", () => {
    expectTypeOf<M3LCoercedValue<"DOUBLE_ARRAY">>().toEqualTypeOf<
      readonly number[]
    >();
  });

  test("BUFFER maps to Buffer", () => {
    expectTypeOf<M3LCoercedValue<"BUFFER">>().toEqualTypeOf<Buffer>();
  });

  test("is keyed by the M3LConfigParameterType union, not a wider string", () => {
    expectTypeOf<M3LCoercedValue<M3LConfigParameterType>>().toMatchTypeOf<
      string | number | boolean | readonly string[] | readonly number[] | Buffer
    >();
  });
});

// =============================================================================
// M3LConfigProvider (abstract base)
// =============================================================================
describe("M3LConfigProvider", () => {
  test("is abstract: a minimal subclass can implement getRawValue", () => {
    class TestProvider extends M3LConfigProvider {
      override getRawValue(key: string): unknown {
        return key === "known" ? "value" : undefined;
      }
    }
    const provider = new TestProvider();
    expect(provider.getRawValue("known")).toBe("value");
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("getRawValue takes a string and returns unknown", () => {
      expectTypeOf<M3LConfigProvider["getRawValue"]>()
        .parameter(0)
        .toBeString();
      expectTypeOf<M3LConfigProvider["getRawValue"]>().returns.toBeUnknown();
    });
  });

  // ---------------------------------------------------------------------
  // A6: getSourceLabel() — a concrete (non-abstract) method every provider
  // inherits, so a bare subclass overriding only getRawValue still gets a
  // usable default label.
  // ---------------------------------------------------------------------
  describe("getSourceLabel() (A6)", () => {
    test("a minimal subclass that does not override getSourceLabel defaults to 'other'", () => {
      class TestProvider extends M3LConfigProvider {
        override getRawValue(key: string): unknown {
          return key === "known" ? "value" : undefined;
        }
      }
      const provider = new TestProvider();
      expect(provider.getSourceLabel()).toBe("other");
    });

    describe("type-level contract", () => {
      test("getSourceLabel takes no arguments and returns string", () => {
        expectTypeOf<
          M3LConfigProvider["getSourceLabel"]
        >().parameters.toEqualTypeOf<[]>();
        expectTypeOf<
          M3LConfigProvider["getSourceLabel"]
        >().returns.toBeString();
      });
    });
  });
});

// =============================================================================
// M3LInMemoryConfigProvider
// =============================================================================
describe("M3LInMemoryConfigProvider", () => {
  test("getRawValue returns the value for a key present in a Record", () => {
    const provider = new M3LInMemoryConfigProvider({ "canonical.name": "Ada" });
    expect(provider.getRawValue("canonical.name")).toBe("Ada");
  });

  test("getRawValue returns undefined for a missing key", () => {
    const provider = new M3LInMemoryConfigProvider({ a: 1 });
    expect(provider.getRawValue("b")).toBeUndefined();
  });

  test("getRawValue returns the value for a key present in a ReadonlyMap", () => {
    const provider = new M3LInMemoryConfigProvider(
      new Map<string, unknown>([["region", "eu-west-1"]]),
    );
    expect(provider.getRawValue("region")).toBe("eu-west-1");
  });

  test("throws M3LUnsafeConfigKeyError for a dangerous key in the seed Record", () => {
    const dangerousPayload = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    ) as Record<string, unknown>;
    expect(() => new M3LInMemoryConfigProvider(dangerousPayload)).toThrow(
      M3LUnsafeConfigKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("getSourceLabel() returns 'in-memory' (A6)", () => {
    const provider = new M3LInMemoryConfigProvider({});
    expect(provider.getSourceLabel()).toBe("in-memory");
  });
});

// =============================================================================
// M3LPresetConfigProvider
// =============================================================================
describe("M3LPresetConfigProvider", () => {
  test("getRawValue returns the value for a key present in the preset", () => {
    const provider = new M3LPresetConfigProvider({ stage: "prod" });
    expect(provider.getRawValue("stage")).toBe("prod");
  });

  test("getRawValue returns undefined for a missing key", () => {
    const provider = new M3LPresetConfigProvider({ stage: "prod" });
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  test("throws M3LUnsafeConfigKeyError for a dangerous key in the preset", () => {
    const dangerousPayload = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    ) as Record<string, unknown>;
    expect(() => new M3LPresetConfigProvider(dangerousPayload)).toThrow(
      M3LUnsafeConfigKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("getSourceLabel() returns 'preset' (A6)", () => {
    const provider = new M3LPresetConfigProvider({});
    expect(provider.getSourceLabel()).toBe("preset");
  });
});

// =============================================================================
// M3LLambdaEventConfigProvider
// =============================================================================
describe("M3LLambdaEventConfigProvider", () => {
  test("getRawValue returns the value for a top-level key present in the event", () => {
    const provider = new M3LLambdaEventConfigProvider({ region: "eu-west-1" });
    expect(provider.getRawValue("region")).toBe("eu-west-1");
  });

  test("getRawValue returns undefined for a missing key", () => {
    const provider = new M3LLambdaEventConfigProvider({ region: "eu-west-1" });
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  test("getRawValue returns undefined when the event is not an object", () => {
    const provider = new M3LLambdaEventConfigProvider("not-an-object");
    expect(provider.getRawValue("anything")).toBeUndefined();
  });

  test("throws M3LUnsafeConfigKeyError for a dangerous key in the event payload", () => {
    const dangerousEvent: unknown = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    );
    expect(() => new M3LLambdaEventConfigProvider(dangerousEvent)).toThrow(
      M3LUnsafeConfigKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("getSourceLabel() returns 'lambda-event' (A6)", () => {
    const provider = new M3LLambdaEventConfigProvider({});
    expect(provider.getSourceLabel()).toBe("lambda-event");
  });

  describe("type-level contract", () => {
    test("constructor accepts unknown", () => {
      expectTypeOf(
        M3LLambdaEventConfigProvider,
      ).constructorParameters.toEqualTypeOf<[unknown]>();
    });
  });
});

// =============================================================================
// M3LCommandLineConfigProvider
// =============================================================================
describe("M3LCommandLineConfigProvider", () => {
  test("no-arg constructor compiles and constructs (defaults to process.argv.slice(2))", () => {
    expect(() => new M3LCommandLineConfigProvider()).not.toThrow();
  });

  test("getRawValue returns the value for a --key=value argv entry", () => {
    const provider = new M3LCommandLineConfigProvider(["--region=eu-west-1"]);
    expect(provider.getRawValue("region")).toBe("eu-west-1");
  });

  test("getRawValue returns undefined for a flag not present in argv", () => {
    const provider = new M3LCommandLineConfigProvider(["--region=eu-west-1"]);
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  test("getRawValue returns the value for a space-separated --key value argv pair", () => {
    const provider = new M3LCommandLineConfigProvider([
      "--region",
      "eu-west-1",
    ]);
    expect(provider.getRawValue("region")).toBe("eu-west-1");
  });

  test("getRawValue returns a real boolean true for a bare --flag with no following value", () => {
    const provider = new M3LCommandLineConfigProvider(["--verbose"]);
    expect(provider.getRawValue("verbose")).toBe(true);
  });

  test("a bare --flag does NOT consume a following --other-flag token as its value", () => {
    const provider = new M3LCommandLineConfigProvider(["--verbose", "--other"]);
    expect(provider.getRawValue("verbose")).toBe(true);
    expect(provider.getRawValue("other")).toBe(true);
  });

  test("a bare-boolean raw value coerces through a BOOL parameter to true", async () => {
    const provider = new M3LCommandLineConfigProvider(["--verbose"]);
    const reader = new M3LConfigReader([provider]);
    const parameter = new M3LConfigParameter({
      name: "verbose",
      type: M3LConfigParameterType.BOOL,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(true);
  });

  test("mixed argv forms (--a=1, --b 2, --flag) resolve each entry correctly", () => {
    const provider = new M3LCommandLineConfigProvider([
      "--a=1",
      "--b",
      "2",
      "--flag",
    ]);
    expect(provider.getRawValue("a")).toBe("1");
    expect(provider.getRawValue("b")).toBe("2");
    expect(provider.getRawValue("flag")).toBe(true);
  });

  test("getSourceLabel() returns 'cli' (A6)", () => {
    const provider = new M3LCommandLineConfigProvider([]);
    expect(provider.getSourceLabel()).toBe("cli");
  });
});

// =============================================================================
// M3LEnvironmentConfigProvider
// =============================================================================
describe("M3LEnvironmentConfigProvider", () => {
  test("no-arg constructor compiles and constructs (defaults to process.env)", () => {
    expect(() => new M3LEnvironmentConfigProvider()).not.toThrow();
  });

  test("getRawValue returns the value for an exact-match env key", () => {
    const provider = new M3LEnvironmentConfigProvider({
      env: { REGION: "eu-west-1" },
    });
    expect(provider.getRawValue("REGION")).toBe("eu-west-1");
  });

  test("getRawValue maps a dotted/dashed key to its SCREAMING_SNAKE_CASE form", () => {
    const provider = new M3LEnvironmentConfigProvider({
      env: { CANONICAL_NAME: "Ada" },
    });
    expect(provider.getRawValue("canonical.name")).toBe("Ada");
  });

  test("getRawValue returns undefined for a key with no matching env entry", () => {
    const provider = new M3LEnvironmentConfigProvider({ env: {} });
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  test("process.env wins over a .env file value for the same key", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("STAGE=from-dotenv\n");

    const provider = new M3LEnvironmentConfigProvider({
      env: { STAGE: "from-process-env" },
      dotenvPath: "/fixtures/.env",
    });

    expect(provider.getRawValue("STAGE")).toBe("from-process-env");
  });

  test("a .env file value fills a key absent from process.env", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("STAGE=from-dotenv\n");

    const provider = new M3LEnvironmentConfigProvider({
      env: {},
      dotenvPath: "/fixtures/.env",
    });

    expect(provider.getRawValue("STAGE")).toBe("from-dotenv");
  });

  describe("dotenv syntax", () => {
    test("strips a whitespace-preceded inline comment and trims trailing whitespace", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        "PORT=8080 # default port\n",
      );

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("PORT")).toBe("8080");
    });

    test("a '#' with no preceding whitespace is NOT treated as a comment start", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue("HASHTAG=trending#now\n");

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("HASHTAG")).toBe("trending#now");
    });

    test("strips a leading 'export ' prefix from the key", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue("export STAGE=prod\n");

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("STAGE")).toBe("prod");
    });

    test("strips surrounding double quotes from the value", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue('NAME="some value"\n');

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("NAME")).toBe("some value");
    });

    test("preserves a '#' inside double quotes (not treated as a comment)", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue('URL="http://x#y"\n');

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("URL")).toBe("http://x#y");
    });

    test("strips surrounding single quotes from the value", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue("NAME='x'\n");

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("NAME")).toBe("x");
    });

    test("a bare comment line contributes no key", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue("# a comment\nSTAGE=prod\n");

      const provider = new M3LEnvironmentConfigProvider({
        env: {},
        dotenvPath: "/fixtures/.env",
      });

      expect(provider.getRawValue("STAGE")).toBe("prod");
      expect(provider.getRawValue("# a comment")).toBeUndefined();
    });
  });

  test("a missing .env file is tolerated (no throw, falls back to process.env only)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(
      () =>
        new M3LEnvironmentConfigProvider({
          env: { STAGE: "prod" },
          dotenvPath: "/fixtures/does-not-exist.env",
        }),
    ).not.toThrow();
  });

  test("getSourceLabel() returns 'environment-variable' (A6)", () => {
    const provider = new M3LEnvironmentConfigProvider({ env: {} });
    expect(provider.getSourceLabel()).toBe("environment-variable");
  });
});

// =============================================================================
// M3LJSONConfigProvider
// =============================================================================
describe("M3LJSONConfigProvider", () => {
  test("getRawValue returns a value parsed from a well-formed JSON file", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ "canonical.name": "Ada" }),
    );

    const provider = new M3LJSONConfigProvider("/fixtures/config.json");
    expect(provider.getRawValue("canonical.name")).toBe("Ada");
  });

  test("getRawValue returns undefined for a key absent from the parsed JSON", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ a: 1 }));

    const provider = new M3LJSONConfigProvider("/fixtures/config.json");
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  test("throws M3LConfigParseError for malformed JSON content", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("{ not: valid json");

    expect(() => new M3LJSONConfigProvider("/fixtures/bad.json")).toThrow(
      M3LConfigParseError,
    );
  });

  test("the M3LConfigParseError chains the underlying SyntaxError as cause", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("{ not: valid json");

    let thrown: unknown;
    try {
      new M3LJSONConfigProvider("/fixtures/bad.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConfigParseError);
    expect((thrown as M3LConfigParseError).cause).toBeDefined();
  });

  test("a missing file is tolerated: getRawValue is undefined for every key, no throw", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    let provider: M3LJSONConfigProvider | undefined;
    expect(() => {
      provider = new M3LJSONConfigProvider("/fixtures/does-not-exist.json");
    }).not.toThrow();
    expect(provider?.getRawValue("anything")).toBeUndefined();
  });

  test("re-throws (does not swallow) an EACCES filesystem error", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    });

    expect(() => new M3LJSONConfigProvider("/fixtures/locked.json")).toThrow();
  });

  test("throws M3LUnsafeConfigKeyError for a dangerous key in the parsed JSON", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      '{"__proto__": {"polluted": true}}',
    );

    expect(() => new M3LJSONConfigProvider("/fixtures/dangerous.json")).toThrow(
      M3LUnsafeConfigKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("getSourceLabel() returns 'json-file' (A6)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const provider = new M3LJSONConfigProvider("/fixtures/does-not-exist.json");
    expect(provider.getSourceLabel()).toBe("json-file");
  });
});

// =============================================================================
// M3LYAMLConfigProvider
// =============================================================================
describe("M3LYAMLConfigProvider", () => {
  test("getRawValue returns a value parsed from a well-formed YAML file", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("canonical.name: Ada\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/config.yaml");
    expect(provider.getRawValue("canonical.name")).toBe("Ada");
  });

  test("getRawValue returns undefined for a key absent from the parsed YAML", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("a: 1\n");

    const provider = new M3LYAMLConfigProvider("/fixtures/config.yaml");
    expect(provider.getRawValue("missing")).toBeUndefined();
  });

  test("throws M3LConfigParseError for malformed YAML content", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("a: [unterminated\n  - b");

    expect(() => new M3LYAMLConfigProvider("/fixtures/bad.yaml")).toThrow(
      M3LConfigParseError,
    );
  });

  test("the M3LConfigParseError chains the underlying YAML error as cause", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("a: [unterminated\n  - b");

    let thrown: unknown;
    try {
      new M3LYAMLConfigProvider("/fixtures/bad.yaml");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LConfigParseError);
    expect((thrown as M3LConfigParseError).cause).toBeDefined();
  });

  test("a missing file is tolerated: getRawValue is undefined for every key, no throw", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    let provider: M3LYAMLConfigProvider | undefined;
    expect(() => {
      provider = new M3LYAMLConfigProvider("/fixtures/does-not-exist.yaml");
    }).not.toThrow();
    expect(provider?.getRawValue("anything")).toBeUndefined();
  });

  test("re-throws (does not swallow) an EACCES filesystem error", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    });

    expect(() => new M3LYAMLConfigProvider("/fixtures/locked.yaml")).toThrow();
  });

  test("throws M3LUnsafeConfigKeyError for a dangerous key in the parsed YAML", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "__proto__:\n  polluted: true\n",
    );

    expect(() => new M3LYAMLConfigProvider("/fixtures/dangerous.yaml")).toThrow(
      M3LUnsafeConfigKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("getSourceLabel() returns 'yaml-file' (A6)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const provider = new M3LYAMLConfigProvider("/fixtures/does-not-exist.yaml");
    expect(provider.getSourceLabel()).toBe("yaml-file");
  });
});

// =============================================================================
// M3LConfigReader — alias resolution (the high-value must-test)
// =============================================================================
describe("M3LConfigReader", () => {
  test("getRawValueForKeys returns the first defined value found across all keys of the first provider that has one", () => {
    const cli = new M3LInMemoryConfigProvider({ "alias-name": "from-cli" });
    const json = new M3LInMemoryConfigProvider({
      "canonical.name": "from-json",
    });
    const reader = new M3LConfigReader([cli, json]);

    // Providers-outer, keys-inner: CLI (priority 0) is checked for BOTH keys
    // before JSON (priority 1) is checked at all. CLI supplies the alias, so
    // the CLI value wins even though the canonical key is listed first.
    expect(reader.getRawValueForKeys(["canonical.name", "alias-name"])).toBe(
      "from-cli",
    );
  });

  test("falls through to a lower-priority provider when the higher-priority provider has neither key", () => {
    const cli = new M3LInMemoryConfigProvider({});
    const json = new M3LInMemoryConfigProvider({
      "canonical.name": "from-json",
    });
    const reader = new M3LConfigReader([cli, json]);

    expect(reader.getRawValueForKeys(["canonical.name", "alias-name"])).toBe(
      "from-json",
    );
  });

  test("getRawValueForKeys returns undefined when no provider has any of the keys", () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({}),
      new M3LInMemoryConfigProvider({}),
    ]);
    expect(reader.getRawValueForKeys(["missing"])).toBeUndefined();
  });

  test("getRawValue is a single-key convenience delegating to getRawValueForKeys", () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ region: "eu-west-1" }),
    ]);
    expect(reader.getRawValue("region")).toBe("eu-west-1");
    expect(reader.getRawValue("missing")).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("getRawValueForKeys returns unknown", () => {
      expectTypeOf<
        M3LConfigReader["getRawValueForKeys"]
      >().returns.toBeUnknown();
    });

    test("constructor accepts a ReadonlyArray<M3LConfigProvider>", () => {
      expectTypeOf(M3LConfigReader).constructorParameters.toEqualTypeOf<
        [ReadonlyArray<M3LConfigProvider>]
      >();
    });
  });

  // ---------------------------------------------------------------------
  // A6: resolveForKeys — same providers-outer/keys-inner traversal as
  // getRawValueForKeys, but returns { value, source } tagging the WINNING
  // provider's label. getRawValueForKeys itself keeps its exact existing
  // signature/behavior (regression-covered above, unchanged).
  // ---------------------------------------------------------------------
  describe("resolveForKeys() (A6)", () => {
    test("an alias hit on the higher-priority provider wins over a canonical-key hit on a lower-priority provider, and source reflects the WINNING provider's label", () => {
      // Two distinct provider types (distinct getSourceLabel() values) so the
      // assertion cannot be satisfied by accident when both providers would
      // otherwise report the same label.
      const higherPriority = new M3LInMemoryConfigProvider({
        "alias-name": "from-in-memory",
      });
      const lowerPriority = new M3LPresetConfigProvider({
        "canonical.name": "from-preset",
      });
      const reader = new M3LConfigReader([higherPriority, lowerPriority]);

      const resolution = reader.resolveForKeys([
        "canonical.name",
        "alias-name",
      ]);

      expect(resolution).toEqual({
        value: "from-in-memory",
        source: "in-memory",
      });
    });

    test("falls through to a lower-priority provider's value and label when the higher-priority provider has neither key", () => {
      const higherPriority = new M3LInMemoryConfigProvider({});
      const lowerPriority = new M3LPresetConfigProvider({
        "canonical.name": "from-preset",
      });
      const reader = new M3LConfigReader([higherPriority, lowerPriority]);

      const resolution = reader.resolveForKeys([
        "canonical.name",
        "alias-name",
      ]);

      expect(resolution).toEqual({ value: "from-preset", source: "preset" });
    });

    test("returns undefined when no provider has any of the keys", () => {
      const reader = new M3LConfigReader([
        new M3LInMemoryConfigProvider({}),
        new M3LPresetConfigProvider({}),
      ]);

      expect(reader.resolveForKeys(["missing"])).toBeUndefined();
    });

    test("getRawValueForKeys keeps returning only the raw value (unchanged) once resolveForKeys exists", () => {
      const reader = new M3LConfigReader([
        new M3LInMemoryConfigProvider({ region: "eu-west-1" }),
      ]);

      expect(reader.getRawValueForKeys(["region"])).toBe("eu-west-1");
    });
  });
});

// =============================================================================
// coerceConfigValue
// =============================================================================
describe("coerceConfigValue()", () => {
  describe("STRING", () => {
    test("passes a string value through", () => {
      expect(coerceConfigValue("hello", M3LConfigParameterType.STRING)).toBe(
        "hello",
      );
    });
  });

  describe("INT", () => {
    test("coerces a numeric string to an integer", () => {
      expect(coerceConfigValue("42", M3LConfigParameterType.INT)).toBe(42);
    });

    test.each(["3.14", "abc", "NaN", "Infinity", ""])(
      "rejects non-integer input %j with M3LConfigCoercionError",
      (raw) => {
        expect(() =>
          coerceConfigValue(raw, M3LConfigParameterType.INT),
        ).toThrow(M3LConfigCoercionError);
      },
    );
  });

  describe("DOUBLE", () => {
    test("coerces a numeric string to a double", () => {
      expect(coerceConfigValue("3.14", M3LConfigParameterType.DOUBLE)).toBe(
        3.14,
      );
    });

    test.each(["NaN", "Infinity", "-Infinity", "not-a-number"])(
      "rejects %j with M3LConfigCoercionError",
      (raw) => {
        expect(() =>
          coerceConfigValue(raw, M3LConfigParameterType.DOUBLE),
        ).toThrow(M3LConfigCoercionError);
      },
    );
  });

  describe("BOOL", () => {
    test.each([
      ["true", true],
      ["TRUE", true],
      ["false", false],
      ["FALSE", false],
      ["1", true],
      ["0", false],
      ["yes", true],
      ["YES", true],
      ["no", false],
      ["NO", false],
    ] as const)("coerces %j to %j (case-insensitive)", (raw, expected) => {
      expect(coerceConfigValue(raw, M3LConfigParameterType.BOOL)).toBe(
        expected,
      );
    });

    test.each(["maybe", "2", "on", "off", ""])(
      "rejects %j with M3LConfigCoercionError",
      (raw) => {
        expect(() =>
          coerceConfigValue(raw, M3LConfigParameterType.BOOL),
        ).toThrow(M3LConfigCoercionError);
      },
    );
  });

  describe("STRING_ARRAY", () => {
    test("coerces a comma-separated string into an array of strings", () => {
      const result = coerceConfigValue(
        "a,b,c",
        M3LConfigParameterType.STRING_ARRAY,
      );
      expect(result[0]).toBe("a");
      expect(result[1]).toBe("b");
      expect(result[2]).toBe("c");
      expect(result).toHaveLength(3);
    });

    test("coerces an empty string to an empty array, not an array containing one empty string", () => {
      const result = coerceConfigValue("", M3LConfigParameterType.STRING_ARRAY);
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });

  describe("INT_ARRAY", () => {
    test("coerces a comma-separated string into an array of integers", () => {
      const result = coerceConfigValue(
        "1,2,3",
        M3LConfigParameterType.INT_ARRAY,
      );
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      expect(result[2]).toBe(3);
    });

    test("a single bad element fails the whole array coercion", () => {
      expect(() =>
        coerceConfigValue("1,bad,3", M3LConfigParameterType.INT_ARRAY),
      ).toThrow(M3LConfigCoercionError);
    });
  });

  describe("DOUBLE_ARRAY", () => {
    test("coerces a comma-separated string into an array of doubles", () => {
      const result = coerceConfigValue(
        "1.5,2.5",
        M3LConfigParameterType.DOUBLE_ARRAY,
      );
      expect(result[0]).toBe(1.5);
      expect(result[1]).toBe(2.5);
    });

    test("a single bad element (NaN-producing) fails the whole array coercion", () => {
      expect(() =>
        coerceConfigValue(
          "1.5,not-a-number",
          M3LConfigParameterType.DOUBLE_ARRAY,
        ),
      ).toThrow(M3LConfigCoercionError);
    });
  });

  describe("BUFFER", () => {
    test("coerces a valid base64 string to a Buffer", () => {
      const encoded = Buffer.from("hello world", "utf8").toString("base64");
      const result = coerceConfigValue(encoded, M3LConfigParameterType.BUFFER);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString("utf8")).toBe("hello world");
    });

    test("rejects invalid base64 with M3LConfigCoercionError", () => {
      expect(() =>
        coerceConfigValue("not valid base64!!!", M3LConfigParameterType.BUFFER),
      ).toThrow(M3LConfigCoercionError);
    });

    test("passes an existing Buffer through unchanged", () => {
      const buf = Buffer.from("raw bytes");
      expect(coerceConfigValue(buf, M3LConfigParameterType.BUFFER)).toBe(buf);
    });

    test("wraps a bare Uint8Array passthrough into a real Buffer with the same bytes", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const result = coerceConfigValue(bytes, M3LConfigParameterType.BUFFER);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });
  });

  test("coercion failure error is an M3LError with code ERR_CONFIG_COERCION", () => {
    let thrown: unknown;
    try {
      coerceConfigValue("abc", M3LConfigParameterType.INT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(M3LConfigCoercionError);
    expect((thrown as M3LConfigCoercionError).code).toBe("ERR_CONFIG_COERCION");
  });

  test("a coercion error does not embed the raw value verbatim in its message or serialized form (redaction)", () => {
    const secret = "SUPER_SECRET_TOKEN";
    let thrown: unknown;
    try {
      coerceConfigValue(secret, M3LConfigParameterType.INT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigCoercionError);
    const coercionError = thrown as M3LConfigCoercionError;
    expect(coercionError.message).not.toContain(secret);
    expect(JSON.stringify(coercionError.toJSON())).not.toContain(secret);
  });

  describe("type-level contract", () => {
    test("accepts (unknown, T) and is generic on T, returning M3LCoercedValue<T> rather than unknown", () => {
      expectTypeOf(coerceConfigValue).parameter(0).toBeUnknown();
      expectTypeOf(coerceConfigValue)
        .parameter(1)
        .toEqualTypeOf<M3LConfigParameterType>();
    });

    test("STRING narrows the return type to string", () => {
      expectTypeOf(
        coerceConfigValue("x", M3LConfigParameterType.STRING),
      ).toEqualTypeOf<string>();
    });

    test("INT narrows the return type to number", () => {
      expectTypeOf(
        coerceConfigValue("1", M3LConfigParameterType.INT),
      ).toEqualTypeOf<number>();
    });

    test("DOUBLE narrows the return type to number", () => {
      expectTypeOf(
        coerceConfigValue("1.5", M3LConfigParameterType.DOUBLE),
      ).toEqualTypeOf<number>();
    });

    test("BOOL narrows the return type to boolean", () => {
      expectTypeOf(
        coerceConfigValue("true", M3LConfigParameterType.BOOL),
      ).toEqualTypeOf<boolean>();
    });

    test("STRING_ARRAY narrows the return type to readonly string[]", () => {
      expectTypeOf(
        coerceConfigValue("a,b", M3LConfigParameterType.STRING_ARRAY),
      ).toEqualTypeOf<readonly string[]>();
    });

    test("INT_ARRAY narrows the return type to readonly number[]", () => {
      expectTypeOf(
        coerceConfigValue("1,2", M3LConfigParameterType.INT_ARRAY),
      ).toEqualTypeOf<readonly number[]>();
    });

    test("DOUBLE_ARRAY narrows the return type to readonly number[]", () => {
      expectTypeOf(
        coerceConfigValue("1.5,2.5", M3LConfigParameterType.DOUBLE_ARRAY),
      ).toEqualTypeOf<readonly number[]>();
    });

    test("BUFFER narrows the return type to Buffer", () => {
      expectTypeOf(
        coerceConfigValue(Buffer.from("x"), M3LConfigParameterType.BUFFER),
      ).toEqualTypeOf<Buffer>();
    });
  });
});

// =============================================================================
// M3LConfigParameter.getValueAsync — 8-level resolution order
// =============================================================================
describe("M3LConfigParameter", () => {
  test("returns the provider value, coerced to the declared type, when present", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "8080" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      defaultValue: 1,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(8080);
  });

  test("resolves through an alias when the canonical name is absent", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ "alias-name": "Ada" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "canonical.name",
      type: M3LConfigParameterType.STRING,
      aliases: ["alias-name"],
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe("Ada");
  });

  test("falls back to defaultValue, unmodified (not re-coerced), when the provider has no value", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const defaultValue = "not-a-number-but-typed-as-int" as unknown as number;
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      defaultValue,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(defaultValue);
  });

  test("falls back to asyncFallback, unmodified (not re-coerced), when provider and defaultValue are both absent", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    // Injects a value that does not actually match `M3LCoercedValue<"STRING">`
    // (string) to prove the resolved value flows through UNCOERCED — the
    // type-lying cast is deliberate; runtime never re-parses it.
    const fallbackValue = { notCoerced: true } as unknown as string;
    const asyncFallback = vi.fn(() => Promise.resolve(fallbackValue));
    const parameter = new M3LConfigParameter({
      name: "widget",
      type: M3LConfigParameterType.STRING,
      asyncFallback,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(fallbackValue);
    expect(asyncFallback).toHaveBeenCalledTimes(1);
  });

  test("returns undefined when provider, defaultValue, and asyncFallback are all absent", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "missing",
      type: M3LConfigParameterType.STRING,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBeUndefined();
  });

  test("does NOT call asyncFallback when the provider supplies a value", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "8080" }),
    ]);
    const asyncFallback = vi.fn(() => Promise.resolve(0));
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      asyncFallback,
    });

    await parameter.getValueAsync(reader);
    expect(asyncFallback).not.toHaveBeenCalled();
  });

  test("does NOT call asyncFallback when defaultValue is present and the provider has no value", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const asyncFallback = vi.fn(() => Promise.resolve(0));
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      defaultValue: 3000,
      asyncFallback,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(3000);
    expect(asyncFallback).not.toHaveBeenCalled();
  });

  test("throws M3LConfigCoercionError when the raw provider value cannot be coerced to the declared type", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "not-a-number" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigCoercionError,
    );
  });

  // The class is no longer caller-generic on an arbitrary value T: its value
  // type is DERIVED from the declared `type` field via M3LCoercedValue<T>.
  describe("type-level contract", () => {
    test("an INT-typed parameter's getValueAsync resolves Promise<number | undefined>", async () => {
      const intParameter = new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 1,
      });
      const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);

      expectTypeOf(intParameter.getValueAsync(reader)).toEqualTypeOf<
        Promise<number | undefined>
      >();
      await intParameter.getValueAsync(reader);
    });

    test("a STRING_ARRAY-typed parameter's getValueAsync resolves Promise<readonly string[] | undefined>", async () => {
      const stringArrayParameter = new M3LConfigParameter({
        name: "tags",
        type: M3LConfigParameterType.STRING_ARRAY,
      });
      const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);

      expectTypeOf(stringArrayParameter.getValueAsync(reader)).toEqualTypeOf<
        Promise<readonly string[] | undefined>
      >();
      await stringArrayParameter.getValueAsync(reader);
    });

    test("declaring defaultValue with a type disagreeing with the declared type is a compile error", () => {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        // @ts-expect-error -- defaultValue must be `number` for an INT param, not a string
        defaultValue: "3000",
      });
    });

    test("declaring defaultValue matching the declared type compiles (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "port",
            type: M3LConfigParameterType.INT,
            defaultValue: 3000,
          }),
      ).not.toThrow();
    });
  });

  // PR4: description option + getType/isRequired/getDefaultValue/
  // getDescription getters (RED until implemented).
  describe("declaration-introspection getters (PR4)", () => {
    test("getDescription() returns the declared description verbatim", () => {
      const parameter = new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        description: "The AWS region to target.",
      });

      expect(parameter.getDescription()).toBe("The AWS region to target.");
    });

    test("getDescription() returns undefined when no description was declared", () => {
      const parameter = new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      });

      expect(parameter.getDescription()).toBeUndefined();
    });

    test("getType() returns the declared coercion target type", () => {
      const parameter = new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
      });

      expect(parameter.getType()).toBe(M3LConfigParameterType.INT);
    });

    test("isRequired() is false by default", () => {
      const parameter = new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      });

      expect(parameter.isRequired()).toBe(false);
    });

    test("isRequired() is true when `required: true` was declared", () => {
      const parameter = new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        required: true,
      });

      expect(parameter.isRequired()).toBe(true);
    });

    test("getDefaultValue() returns the declared defaultValue", () => {
      const parameter = new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 3000,
      });

      expect(parameter.getDefaultValue()).toBe(3000);
    });

    test("getDefaultValue() returns undefined when no defaultValue was declared", () => {
      const parameter = new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
      });

      expect(parameter.getDefaultValue()).toBeUndefined();
    });

    test("type-level: getDescription() returns string | undefined", () => {
      const parameter = new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      });

      expectTypeOf(parameter.getDescription()).toEqualTypeOf<
        string | undefined
      >();
    });

    test("type-level: an INT-typed parameter's getDefaultValue() returns number | undefined", () => {
      const parameter = new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 3000,
      });

      expectTypeOf(parameter.getDefaultValue()).toEqualTypeOf<
        number | undefined
      >();
    });
  });
});

// =============================================================================
// M3LConfigParameter.resolveAsync (A6) — mirrors getValueAsync's 4-branch
// chain, additionally tagging the source per branch. getValueAsync's own
// signature/behavior is unchanged (regression-covered by the whole
// "M3LConfigParameter" describe block above, none of which was touched).
// =============================================================================
describe("M3LConfigParameter.resolveAsync (A6)", () => {
  test("branch 1 (provider hit): resolves { value, source } where source is the resolved provider's label", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "8080" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
    });

    await expect(parameter.resolveAsync(reader)).resolves.toEqual({
      value: 8080,
      source: "in-memory",
    });
  });

  test("branch 2 (defaultValue): resolves { value: defaultValue, source: 'default' }", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      defaultValue: 3000,
    });

    await expect(parameter.resolveAsync(reader)).resolves.toEqual({
      value: 3000,
      source: "default",
    });
  });

  test("branch 3 (asyncFallback): resolves { value: resolved fallback, source: 'async-fallback' }", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const asyncFallback = vi.fn(() => Promise.resolve("fallback-value"));
    const parameter = new M3LConfigParameter({
      name: "widget",
      type: M3LConfigParameterType.STRING,
      asyncFallback,
    });

    await expect(parameter.resolveAsync(reader)).resolves.toEqual({
      value: "fallback-value",
      source: "async-fallback",
    });
    expect(asyncFallback).toHaveBeenCalledTimes(1);
  });

  test("branch 4 (true fall-through): resolves to undefined when not required", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "missing",
      type: M3LConfigParameterType.STRING,
    });

    await expect(parameter.resolveAsync(reader)).resolves.toBeUndefined();
  });

  test("branch 4 (true fall-through): rejects with M3LConfigMissingError when required and nothing supplies a value", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    await expect(parameter.resolveAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigMissingError,
    );
  });

  test("rejects with M3LConfigCoercionError when the raw provider value cannot be coerced (mirrors getValueAsync)", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "not-a-number" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
    });

    await expect(parameter.resolveAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigCoercionError,
    );
  });

  describe("type-level contract", () => {
    test("an INT-typed parameter's resolveAsync resolves a value/source pair typed as M3LConfigResolution<number>", async () => {
      const intParameter = new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 1,
      });
      const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);

      const resolved = await intParameter.resolveAsync(reader);
      if (resolved === undefined) {
        throw new Error("expected resolveAsync to resolve a value");
      }
      expectTypeOf(resolved).toMatchTypeOf<M3LConfigResolution<number>>();
      expect(resolved.value).toBe(1);
    });
  });
});

// =============================================================================
// M3LConfigParameter — getValueAsync regression coverage after resolveAsync
// (A6). Ensures the pre-existing method's signature/behavior did not change
// once resolveAsync was added alongside it.
// =============================================================================
describe("M3LConfigParameter.getValueAsync — regression after resolveAsync (A6)", () => {
  test("still returns the bare coerced value (not a resolution object) from a provider hit", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "8080" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(8080);
  });

  test("still returns defaultValue unmodified when the provider has no value", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      defaultValue: 3000,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(3000);
  });

  test("still throws M3LConfigMissingError when required and no value is supplied anywhere", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigMissingError,
    );
  });
});

// =============================================================================
// M3LConfig — resolved-value store + source tracker
// =============================================================================
describe("M3LConfig", () => {
  test("set() followed by get() returns the stored value", () => {
    const config = new M3LConfig();
    config.set("region", "eu-west-1", "cli");
    expect(config.get("region")).toBe("eu-west-1");
  });

  test("has() is true after set(), false before", () => {
    const config = new M3LConfig();
    expect(config.has("region")).toBe(false);
    config.set("region", "eu-west-1");
    expect(config.has("region")).toBe(true);
  });

  test("sourceOf() returns the source string supplied to set()", () => {
    const config = new M3LConfig();
    config.set("region", "eu-west-1", "environment-variable");
    expect(config.sourceOf("region")).toBe("environment-variable");
  });

  test("sourceOf() is undefined for a name that was never set", () => {
    const config = new M3LConfig();
    expect(config.sourceOf("never-set")).toBeUndefined();
  });

  test("last write wins: a second set() overwrites both value and source", () => {
    const config = new M3LConfig();
    config.set("region", "eu-west-1", "cli");
    config.set("region", "us-east-1", "json-file");
    expect(config.get("region")).toBe("us-east-1");
    expect(config.sourceOf("region")).toBe("json-file");
  });

  test("get() returns undefined for a name that was never set", () => {
    const config = new M3LConfig();
    expect(config.get("never-set")).toBeUndefined();
  });

  test("source defaults sensibly when omitted (no throw)", () => {
    const config = new M3LConfig();
    expect(() => config.set("region", "eu-west-1")).not.toThrow();
  });

  describe("type-level contract", () => {
    test("set() accepts an unknown value and an optional string source", () => {
      // `expectTypeOf<Parameters<M3LConfig["set"]>>()` (whole-tuple form) trips
      // a zero-arg overload-resolution defect in this expect-type version —
      // assert per-position instead, which is unambiguous and equivalent.
      expectTypeOf<M3LConfig["set"]>().parameter(0).toBeString();
      expectTypeOf<M3LConfig["set"]>().parameter(1).toBeUnknown();
      expectTypeOf<M3LConfig["set"]>()
        .parameter(2)
        .toEqualTypeOf<string | undefined>();
    });

    test("source is typed as a plain string, not a literal union", () => {
      // If `source` were narrowed to a literal union, an arbitrary string
      // like "any-custom-source-name" would fail to type-check here.
      const config = new M3LConfig();
      config.set("k", "v", "any-custom-source-name");
      expectTypeOf<ReturnType<M3LConfig["sourceOf"]>>().toEqualTypeOf<
        string | undefined
      >();
    });
  });
});

// =============================================================================
// M3LConfigSchema
// =============================================================================
describe("M3LConfigSchema", () => {
  test("declaredNames() includes each parameter's name and aliases", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        aliases: ["r", "aws-region"],
      }),
    ]);

    expect(schema.declaredNames()).toEqual(
      expect.arrayContaining(["region", "r", "aws-region"]),
    );
  });

  test("has() is true for a declared name, false for an undeclared one", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      }),
    ]);

    expect(schema.has("region")).toBe(true);
    expect(schema.has("typo")).toBe(false);
  });

  test("parameters exposes the constructor-supplied list", () => {
    const parameter = new M3LConfigParameter({
      name: "region",
      type: M3LConfigParameterType.STRING,
    });
    const schema = new M3LConfigSchema([parameter]);
    expect(schema.parameters).toEqual([parameter]);
  });

  // ---------------------------------------------------------------------
  // F1b: cross-parameter validation — a second, optional constructor
  // argument carrying a list of M3LConfigSchemaValidator functions, plus
  // the schema.validate(config) method that runs them once, fail-fast, in
  // declaration order. docs/reference/core/config.md
  // "### Cross-parameter validation" / "### When schema-level validation runs".
  // ---------------------------------------------------------------------
  describe("validators (F1b — cross-parameter validation)", () => {
    test("defaults to an empty array when no second constructor argument is supplied", () => {
      const schema = new M3LConfigSchema([]);
      expect(schema.validators).toEqual([]);
    });

    test("exposes the constructor-supplied validator list verbatim", () => {
      const validator: M3LConfigSchemaValidator = () => true;
      const schema = new M3LConfigSchema([], [validator]);
      expect(schema.validators).toEqual([validator]);
    });

    test("a single-argument construction still works exactly as today (no regression)", () => {
      const parameter = new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      });
      const schema = new M3LConfigSchema([parameter]);
      expect(schema.parameters).toEqual([parameter]);
      expect(schema.validators).toEqual([]);
    });

    describe("validate()", () => {
      test("does nothing (no throw) when the schema has no validators", () => {
        const schema = new M3LConfigSchema([]);
        const config = new M3LConfig();
        expect(() => {
          schema.validate(config);
        }).not.toThrow();
      });

      test("does not throw when every validator returns true", () => {
        const schema = new M3LConfigSchema(
          [],
          [(): true | string => true, (): true | string => true],
        );
        const config = new M3LConfig();
        expect(() => {
          schema.validate(config);
        }).not.toThrow();
      });

      test("throws M3LConfigValidationError coded ERR_CONFIG_VALIDATION when a validator returns a failure reason", () => {
        const schema = new M3LConfigSchema(
          [],
          [(): true | string => "sort requires limit"],
        );
        const config = new M3LConfig();

        let thrown: unknown;
        try {
          schema.validate(config);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LConfigValidationError);
        expect((thrown as M3LConfigValidationError).code).toBe(
          "ERR_CONFIG_VALIDATION",
        );
        expect((thrown as M3LConfigValidationError).context).toEqual({
          validatorIndex: 0,
          reason: "sort requires limit",
        });
      });

      test("fail-fast: the first failing validator throws immediately (validatorIndex 0) and a later validator never runs", () => {
        const secondValidator = vi.fn(
          (_cfg: M3LConfig): true | string => "should never run",
        );
        const schema = new M3LConfigSchema(
          [],
          [(): true | string => "first failure", secondValidator],
        );
        const config = new M3LConfig();

        let thrown: unknown;
        try {
          schema.validate(config);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LConfigValidationError);
        expect((thrown as M3LConfigValidationError).context).toEqual({
          validatorIndex: 0,
          reason: "first failure",
        });
        expect(secondValidator).not.toHaveBeenCalled();
      });

      test("a later validator's failure (not the first) reports its own index", () => {
        const schema = new M3LConfigSchema(
          [],
          [(): true | string => true, (): true | string => "second failure"],
        );
        const config = new M3LConfig();

        let thrown: unknown;
        try {
          schema.validate(config);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LConfigValidationError);
        expect((thrown as M3LConfigValidationError).context).toEqual({
          validatorIndex: 1,
          reason: "second failure",
        });
      });

      test("passes the exact M3LConfig instance handed to validate() through to each validator", () => {
        const config = new M3LConfig();
        const validator = vi.fn((_cfg: M3LConfig): true | string => true);
        const schema = new M3LConfigSchema([], [validator]);

        schema.validate(config);

        expect(validator).toHaveBeenCalledTimes(1);
        expect(validator.mock.calls[0]?.[0]).toBe(config);
      });
    });
  });
});

// =============================================================================
// M3LConfigSchemaValidator (F1b) — type: (config: M3LConfig) => true | string
// =============================================================================
describe("M3LConfigSchemaValidator (F1b)", () => {
  test("a validator returning true is callable directly and returns true", () => {
    const config = new M3LConfig();
    const validator: M3LConfigSchemaValidator = () => true;
    expect(validator(config)).toBe(true);
  });

  test("a validator returning a string reason is callable directly and returns that string", () => {
    const config = new M3LConfig();
    const validator: M3LConfigSchemaValidator = (cfg: M3LConfig) =>
      cfg.has("sort") ? true : "'sort' requires 'limit' to be set";
    expect(validator(config)).toBe("'sort' requires 'limit' to be set");
  });

  test("receives the M3LConfig instance passed to it (can read via get/has/sourceOf)", () => {
    const config = new M3LConfig();
    config.set("sort", "asc", "cli");
    const validator: M3LConfigSchemaValidator = (cfg: M3LConfig) =>
      cfg.get("sort") === "asc" ? true : "unexpected sort value";
    expect(validator(config)).toBe(true);
  });

  describe("type-level contract", () => {
    test("is (config: M3LConfig) => true | string", () => {
      expectTypeOf<M3LConfigSchemaValidator>().toEqualTypeOf<
        (config: M3LConfig) => true | string
      >();
    });

    test("a boolean-returning function is NOT assignable (return must be true | string, not boolean)", () => {
      expectTypeOf<
        (config: M3LConfig) => boolean
      >().not.toMatchTypeOf<M3LConfigSchemaValidator>();
    });
  });
});

// =============================================================================
// M3LUnknownParameterDetector
// =============================================================================
describe("M3LUnknownParameterDetector", () => {
  test("detect() returns only the undeclared supplied keys", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        aliases: ["r"],
      }),
    ]);
    const detector = new M3LUnknownParameterDetector(schema);

    expect(detector.detect(["region", "typo"])).toEqual(["typo"]);
  });

  test("a supplied key matching a declared alias is NOT flagged", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
        aliases: ["r"],
      }),
    ]);
    const detector = new M3LUnknownParameterDetector(schema);

    expect(detector.detect(["r"])).toEqual([]);
  });

  test("returns an empty array when every supplied key is declared", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "region",
        type: M3LConfigParameterType.STRING,
      }),
    ]);
    const detector = new M3LUnknownParameterDetector(schema);

    expect(detector.detect(["region"])).toEqual([]);
  });

  test("does not throw — detection is non-throwing by contract", () => {
    const schema = new M3LConfigSchema([]);
    const detector = new M3LUnknownParameterDetector(schema);
    expect(() => detector.detect(["anything", "else"])).not.toThrow();
  });

  // PR4: detectWithSuggestions — additive, does not touch detect() above
  // (RED until implemented).
  describe("detectWithSuggestions", () => {
    test("ranks candidates by ascending Damerau-Levenshtein distance, closest first", () => {
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "region",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);

      const result = detector.detectWithSuggestions(["regoin"]);

      expect(result).toHaveLength(1);
      expect(result[0]?.key).toBe("regoin");
      expect(result[0]?.suggestions[0]).toBe("region");
    });

    test("a declared key is excluded entirely from the returned array", () => {
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "region",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);

      const result = detector.detectWithSuggestions(["region", "regoin"]);

      expect(result).toHaveLength(1);
      expect(result.some((entry) => entry.key === "region")).toBe(false);
    });

    test("a supplied key with nothing close returns an empty suggestions array (not omitted)", () => {
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "region",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);

      const result = detector.detectWithSuggestions(["zzzzzzzzzzzzzzz"]);

      expect(result).toHaveLength(1);
      expect(result[0]?.key).toBe("zzzzzzzzzzzzzzz");
      expect(result[0]?.suggestions).toEqual([]);
    });

    test("maxDistance boundary: a key exactly maxDistance+1 away is excluded at the default, included when maxDistance is raised", () => {
      // "abc" -> "abcxyz" is 3 insertions away (distance 3), one past the
      // default maxDistance of 2.
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "abc",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);

      const atDefault = detector.detectWithSuggestions(["abcxyz"]);
      expect(atDefault[0]?.suggestions).toEqual([]);

      const raised = detector.detectWithSuggestions(["abcxyz"], {
        maxDistance: 3,
      });
      expect(raised[0]?.suggestions).toContain("abc");
    });

    test("maxSuggestions caps the number of candidates: default 3, overridable", () => {
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "aaaaa",
          type: M3LConfigParameterType.STRING,
        }),
        new M3LConfigParameter({
          name: "aaaab",
          type: M3LConfigParameterType.STRING,
        }),
        new M3LConfigParameter({
          name: "aaaac",
          type: M3LConfigParameterType.STRING,
        }),
        new M3LConfigParameter({
          name: "aaaad",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);

      const atDefault = detector.detectWithSuggestions(["aaaae"]);
      expect(atDefault[0]?.suggestions).toHaveLength(3);

      const capped = detector.detectWithSuggestions(["aaaae"], {
        maxSuggestions: 1,
      });
      expect(capped[0]?.suggestions).toHaveLength(1);
    });

    test("ties are broken by schema.declaredNames() order", () => {
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "cat",
          type: M3LConfigParameterType.STRING,
        }),
        new M3LConfigParameter({
          name: "car",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);
      const declaredOrder = schema.declaredNames();

      const result = detector.detectWithSuggestions(["cab"]);

      const suggestionsInDeclaredOrder = declaredOrder.filter((name) =>
        result[0]?.suggestions.includes(name),
      );
      expect(result[0]?.suggestions).toEqual(suggestionsInDeclaredOrder);
    });

    test("the overall array order mirrors suppliedKeys input order", () => {
      const schema = new M3LConfigSchema([
        new M3LConfigParameter({
          name: "region",
          type: M3LConfigParameterType.STRING,
        }),
      ]);
      const detector = new M3LUnknownParameterDetector(schema);

      const result = detector.detectWithSuggestions(["zzz1", "zzz2", "zzz3"]);

      expect(result.map((entry) => entry.key)).toEqual([
        "zzz1",
        "zzz2",
        "zzz3",
      ]);
    });

    test("type-level: return type shape is readonly M3LUnknownParameterSuggestion[]", () => {
      expectTypeOf<
        ReturnType<M3LUnknownParameterDetector["detectWithSuggestions"]>
      >().toEqualTypeOf<readonly M3LUnknownParameterSuggestion[]>();
      expectTypeOf<M3LUnknownParameterSuggestion>().toEqualTypeOf<{
        readonly key: string;
        readonly suggestions: readonly string[];
      }>();
      expectTypeOf<M3LUnknownParameterSuggestOptions>().toEqualTypeOf<{
        readonly maxDistance?: number;
        readonly maxSuggestions?: number;
      }>();
    });
  });
});

// =============================================================================
// damerauLevenshteinDistance (internal) — used by
// M3LUnknownParameterDetector.detectWithSuggestions above; imported directly
// per the internal-helper test convention (see polling.test.ts's
// M3LPollFailureError (internal) describe block).
// =============================================================================
describe("damerauLevenshteinDistance (internal)", () => {
  test("identical strings have distance 0", () => {
    expect(damerauLevenshteinDistance("region", "region")).toBe(0);
  });

  test("a single substitution has distance 1", () => {
    expect(damerauLevenshteinDistance("cat", "cot")).toBe(1);
  });

  test("a single insertion has distance 1", () => {
    expect(damerauLevenshteinDistance("cat", "cats")).toBe(1);
  });

  test("a single deletion has distance 1", () => {
    expect(damerauLevenshteinDistance("cats", "cat")).toBe(1);
  });

  test("an adjacent transposition has distance 1 — the OSA-variant behavior that distinguishes this from plain Levenshtein (which would score it 2)", () => {
    expect(damerauLevenshteinDistance("region", "regoin")).toBe(1);
  });

  test("completely different short strings return some non-zero distance (not over-asserted)", () => {
    expect(damerauLevenshteinDistance("abc", "xyz")).toBeGreaterThan(0);
  });

  test("empty-string edges", () => {
    expect(damerauLevenshteinDistance("", "abc")).toBe(3);
    expect(damerauLevenshteinDistance("abc", "")).toBe(3);
    expect(damerauLevenshteinDistance("", "")).toBe(0);
  });

  test("is case-sensitive — no implicit lower-casing", () => {
    expect(damerauLevenshteinDistance("Region", "region")).toBe(1);
  });
});

// =============================================================================
// M3LSecretsSpecifier
// =============================================================================
describe("M3LSecretsSpecifier", () => {
  test("isSecret() is true for a name marked via markSecret()", () => {
    const specifier = new M3LSecretsSpecifier();
    specifier.markSecret("apiKey");
    expect(specifier.isSecret("apiKey")).toBe(true);
  });

  test("isSecret() is false for a name never marked", () => {
    const specifier = new M3LSecretsSpecifier();
    expect(specifier.isSecret("region")).toBe(false);
  });

  test("constructor-seeded secret names are recognized without an explicit markSecret() call", () => {
    const specifier = new M3LSecretsSpecifier(["apiKey", "dbPassword"]);
    expect(specifier.isSecret("apiKey")).toBe(true);
    expect(specifier.isSecret("dbPassword")).toBe(true);
    expect(specifier.isSecret("region")).toBe(false);
  });

  test("secretNames exposes the marked names as a ReadonlySet", () => {
    const specifier = new M3LSecretsSpecifier(["apiKey"]);
    specifier.markSecret("dbPassword");
    expect(specifier.secretNames.has("apiKey")).toBe(true);
    expect(specifier.secretNames.has("dbPassword")).toBe(true);
    expect(specifier.secretNames.has("region")).toBe(false);
  });

  test("classifies only — it does not redact or transform values", () => {
    // No redaction API exists on the class; markSecret/isSecret is the whole
    // surface. This test documents the contract by exercising only that
    // surface and asserting no observable value mutation occurs.
    const specifier = new M3LSecretsSpecifier();
    specifier.markSecret("apiKey");
    const config = new M3LConfig();
    config.set("apiKey", "super-secret-value");
    expect(config.get("apiKey")).toBe("super-secret-value");
  });

  test("secretNames returns a snapshot: a later markSecret() does not retroactively mutate a previously read reference", () => {
    const specifier = new M3LSecretsSpecifier();
    const snapshot = specifier.secretNames;
    specifier.markSecret("api");
    expect(snapshot.has("api")).toBe(false);
  });

  test("mutating the returned secretNames set does not corrupt internal state", () => {
    const specifier = new M3LSecretsSpecifier();
    (specifier.secretNames as Set<string>).add("evil");
    expect(specifier.isSecret("evil")).toBe(false);
  });
});

// =============================================================================
// Error classes
// =============================================================================
describe("M3LConfigCoercionError", () => {
  test("is an instance of M3LError", () => {
    const error = new M3LConfigCoercionError("bad int");
    expect(error).toBeInstanceOf(M3LError);
  });

  test("code is the narrow literal ERR_CONFIG_COERCION", () => {
    const error = new M3LConfigCoercionError("bad int");
    expect(error.code).toBe("ERR_CONFIG_COERCION");
  });

  test("toJSON() (inherited) includes name, message, and code", () => {
    const error = new M3LConfigCoercionError("bad int");
    const json = error.toJSON();
    expect(json.name).toBe("M3LConfigCoercionError");
    expect(json.message).toBe("bad int");
    expect(json.code).toBe("ERR_CONFIG_COERCION");
  });

  test("chains an underlying cause when provided", () => {
    const cause = new TypeError("root cause");
    const error = new M3LConfigCoercionError("bad int", { cause });
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options at all: code is set and context defaults to empty", () => {
    const error = new M3LConfigCoercionError("bad int");
    expect(error.code).toBe("ERR_CONFIG_COERCION");
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  test("constructs with only a context option (no cause)", () => {
    const error = new M3LConfigCoercionError("bad int", {
      context: { rawValue: "abc", type: "INT" },
    });
    expect(error.context).toEqual({ rawValue: "abc", type: "INT" });
    expect(error.cause).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_CONFIG_COERCION'", () => {
      expectTypeOf<
        M3LConfigCoercionError["code"]
      >().toEqualTypeOf<"ERR_CONFIG_COERCION">();
    });
  });
});

describe("M3LConfigParseError", () => {
  test("is an instance of M3LError", () => {
    const error = new M3LConfigParseError("bad json");
    expect(error).toBeInstanceOf(M3LError);
  });

  test("code is the narrow literal ERR_CONFIG_PARSE", () => {
    const error = new M3LConfigParseError("bad json");
    expect(error.code).toBe("ERR_CONFIG_PARSE");
  });

  test("toJSON() (inherited) includes name, message, and code", () => {
    const error = new M3LConfigParseError("bad json");
    const json = error.toJSON();
    expect(json.name).toBe("M3LConfigParseError");
    expect(json.message).toBe("bad json");
    expect(json.code).toBe("ERR_CONFIG_PARSE");
  });

  test("chains an underlying cause when provided", () => {
    const cause = new SyntaxError("Unexpected token");
    const error = new M3LConfigParseError("bad json", { cause });
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options at all: code is set and context defaults to empty", () => {
    const error = new M3LConfigParseError("bad json");
    expect(error.code).toBe("ERR_CONFIG_PARSE");
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  test("constructs with only a context option (no cause)", () => {
    const error = new M3LConfigParseError("bad json", {
      context: { filePath: "/fixtures/bad.json" },
    });
    expect(error.context).toEqual({ filePath: "/fixtures/bad.json" });
    expect(error.cause).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_CONFIG_PARSE'", () => {
      expectTypeOf<
        M3LConfigParseError["code"]
      >().toEqualTypeOf<"ERR_CONFIG_PARSE">();
    });
  });
});

describe("M3LUnsafeConfigKeyError", () => {
  test("is an instance of M3LError", () => {
    const error = new M3LUnsafeConfigKeyError("dangerous key");
    expect(error).toBeInstanceOf(M3LError);
  });

  test("code is the narrow literal ERR_CONFIG_UNSAFE_KEY", () => {
    const error = new M3LUnsafeConfigKeyError("dangerous key");
    expect(error.code).toBe("ERR_CONFIG_UNSAFE_KEY");
  });

  test("toJSON() (inherited) includes name, message, and code", () => {
    const error = new M3LUnsafeConfigKeyError("dangerous key");
    const json = error.toJSON();
    expect(json.name).toBe("M3LUnsafeConfigKeyError");
    expect(json.message).toBe("dangerous key");
    expect(json.code).toBe("ERR_CONFIG_UNSAFE_KEY");
  });

  test("chains an underlying cause when provided", () => {
    const cause = new Error("root cause");
    const error = new M3LUnsafeConfigKeyError("dangerous key", { cause });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options at all: code is set and context defaults to empty", () => {
    const error = new M3LUnsafeConfigKeyError("dangerous key");
    expect(error.code).toBe("ERR_CONFIG_UNSAFE_KEY");
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  test("constructs with only a context option (no cause)", () => {
    const error = new M3LUnsafeConfigKeyError("dangerous key", {
      context: { key: "__proto__" },
    });
    expect(error.context).toEqual({ key: "__proto__" });
    expect(error.cause).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_CONFIG_UNSAFE_KEY'", () => {
      expectTypeOf<
        M3LUnsafeConfigKeyError["code"]
      >().toEqualTypeOf<"ERR_CONFIG_UNSAFE_KEY">();
    });
  });
});

// =============================================================================
// Prototype-pollution — cross-provider guard (Record, JSON file, Lambda event)
// =============================================================================
describe("prototype-pollution guard across dangerous-key entry points", () => {
  beforeEach(() => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  test.each([
    [
      "in-memory Record",
      () =>
        new M3LInMemoryConfigProvider(
          JSON.parse('{"__proto__": {"polluted": true}}') as Record<
            string,
            unknown
          >,
        ),
    ],
    [
      "JSON config file",
      () => {
        vi.spyOn(fs, "readFileSync").mockReturnValue(
          '{"__proto__": {"polluted": true}}',
        );
        return new M3LJSONConfigProvider("/fixtures/dangerous.json");
      },
    ],
    [
      "Lambda event payload",
      () =>
        new M3LLambdaEventConfigProvider(
          JSON.parse('{"__proto__": {"polluted": true}}'),
        ),
    ],
  ] as const)(
    "%s: constructing throws M3LUnsafeConfigKeyError",
    (_label, build) => {
      expect(() => build()).toThrow(M3LUnsafeConfigKeyError);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    },
  );
});

// =============================================================================
// M3LConfigValidators — stock validators (constraint-only failure reasons)
// =============================================================================
describe("M3LConfigValidators", () => {
  describe("range(min, max)", () => {
    const inRange = M3LConfigValidators.range(1, 65535);

    test.each([
      [1, true],
      [65535, true],
    ] as const)(
      "accepts the inclusive boundary %j -> %j",
      (value, expected) => {
        expect(inRange(value)).toBe(expected);
      },
    );

    test.each([0, 70000])(
      "rejects %j with a string reason describing the bounds but not the value",
      (value) => {
        const result = inRange(value);
        expect(typeof result).toBe("string");
        const reason = result as string;
        expect(reason).toContain("1");
        expect(reason).toContain("65535");
        expect(reason).not.toContain(String(value));
      },
    );
  });

  describe("regex(pattern)", () => {
    const lettersOnly = M3LConfigValidators.regex(/^[a-z]+$/);

    test("accepts a matching string", () => {
      expect(lettersOnly("hello")).toBe(true);
    });

    test("rejects a non-matching string with a reason containing the pattern but not the input", () => {
      const result = lettersOnly("HELLO123");
      expect(typeof result).toBe("string");
      const reason = result as string;
      expect(reason).toContain("^[a-z]+$");
      expect(reason).not.toContain("HELLO123");
    });
  });

  describe("oneOf(allowed)", () => {
    const environment = M3LConfigValidators.oneOf(["dev", "prod"] as const);

    test("accepts a member of the allowed set", () => {
      expect(environment("dev")).toBe(true);
    });

    test("rejects a non-member with a reason listing the allowed set but not the rejected value", () => {
      // The validator's declared input type is the allowed union; a runtime
      // caller (e.g. a value coerced from an untyped provider) can still pass
      // a value outside it, which is exactly the case under test.
      const result = environment("staging" as "dev" | "prod");
      expect(typeof result).toBe("string");
      const reason = result as string;
      expect(reason).toContain("dev");
      expect(reason).toContain("prod");
      expect(reason).not.toContain("staging");
    });
  });

  describe("nonEmpty", () => {
    // nonEmpty is a validator VALUE (not a factory) — called directly.
    test("passes (returns true) for a non-empty string", () => {
      expect(M3LConfigValidators.nonEmpty("hello")).toBe(true);
    });

    test("passes (returns true) for a non-empty array", () => {
      expect(M3LConfigValidators.nonEmpty(["a", "b"])).toBe(true);
    });

    // nonEmpty can only fail when value.length === 0, so the received value
    // itself never carries redactable content — unlike range/regex/oneOf,
    // there is nothing to assert "the reason does not contain the value"
    // against (String("") === String([]) === "", which every string
    // trivially contains). The reason still must name the constraint.
    test("rejects an empty string with a reason naming the 'empty' constraint", () => {
      const result = M3LConfigValidators.nonEmpty("");
      expect(typeof result).toBe("string");
      expect(result as string).toContain("empty");
    });

    test("rejects an empty array with a reason naming the 'empty' constraint", () => {
      const result = M3LConfigValidators.nonEmpty([]);
      expect(typeof result).toBe("string");
      expect(result as string).toContain("empty");
    });
  });

  describe("minLength(min)", () => {
    // The factory is invoked inside each test body (not at describe-body
    // top level, unlike range()/regex() above) so that its current absence
    // fails only these individual tests rather than aborting collection of
    // the whole file.
    test.each([
      ["abc", true],
      ["abcd", true],
    ] as const)("accepts %j (length >= min) -> %j", (value, expected) => {
      const atLeastThree = M3LConfigValidators.minLength(3);
      expect(atLeastThree(value)).toBe(expected);
    });

    test("accepts an array whose length meets the minimum", () => {
      const atLeastThree = M3LConfigValidators.minLength(3);
      expect(atLeastThree(["a", "b", "c"])).toBe(true);
    });

    test.each(["a", "ab"])(
      "rejects %j (too short) with a reason naming the bound but not the value",
      (value) => {
        const atLeastThree = M3LConfigValidators.minLength(3);
        const result = atLeastThree(value);
        expect(typeof result).toBe("string");
        const reason = result as string;
        expect(reason).toContain("3");
        expect(reason).not.toContain(String(value));
      },
    );

    // "" stringifies to the empty string, which every string trivially
    // contains — excluded from the "not contain the value" assertion above
    // for the same reason as nonEmpty's empty-value case.
    test("rejects an empty string with a reason naming the bound", () => {
      const atLeastThree = M3LConfigValidators.minLength(3);
      const result = atLeastThree("");
      expect(typeof result).toBe("string");
      expect(result as string).toContain("3");
    });

    test("rejects a too-short array with a reason naming the bound but not the value", () => {
      const atLeastThree = M3LConfigValidators.minLength(3);
      const result = atLeastThree(["a", "b"]);
      expect(typeof result).toBe("string");
      const reason = result as string;
      expect(reason).toContain("3");
      expect(reason).not.toContain("a,b");
    });
  });

  describe("type-level contract", () => {
    test("M3LConfigValidator<T> is (value: T) => true | string", () => {
      expectTypeOf<M3LConfigValidator<number>>().toEqualTypeOf<
        (value: number) => true | string
      >();
    });

    test("range returns M3LConfigValidator<number>", () => {
      expectTypeOf(M3LConfigValidators.range).returns.toEqualTypeOf<
        M3LConfigValidator<number>
      >();
    });

    test("regex returns M3LConfigValidator<string>", () => {
      expectTypeOf(M3LConfigValidators.regex).returns.toEqualTypeOf<
        M3LConfigValidator<string>
      >();
    });

    test("oneOf infers T from the allowed array: oneOf(['a','b'] as const) is M3LConfigValidator<'a'|'b'>", () => {
      const allowed = ["a", "b"] as const;
      expectTypeOf(M3LConfigValidators.oneOf(allowed)).toEqualTypeOf<
        M3LConfigValidator<"a" | "b">
      >();
    });

    test("a validator typed for the wrong parameter shape is a compile error on an INT parameter", () => {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        // no defaultValue: the constructor eagerly validates a supplied
        // defaultValue, and this test only asserts the compile-time mismatch
        // of `validate`, not a runtime validation outcome.
        // @ts-expect-error -- regex() is M3LConfigValidator<string>, not assignable to an INT parameter's number-typed validate
        validate: M3LConfigValidators.regex(/x/),
      });
    });

    test("nonEmpty is M3LConfigValidator<{ readonly length: number }>, not a factory", () => {
      expectTypeOf(M3LConfigValidators.nonEmpty).toEqualTypeOf<
        M3LConfigValidator<{ readonly length: number }>
      >();
    });

    test("minLength returns M3LConfigValidator<{ readonly length: number }>", () => {
      expectTypeOf(M3LConfigValidators.minLength).returns.toEqualTypeOf<
        M3LConfigValidator<{ readonly length: number }>
      >();
    });

    test("nonEmpty compiles as `validate` on a STRING parameter (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "name",
            type: M3LConfigParameterType.STRING,
            defaultValue: "Ada",
            validate: M3LConfigValidators.nonEmpty,
          }),
      ).not.toThrow();
    });

    test("nonEmpty compiles as `validate` on a STRING_ARRAY parameter (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "tags",
            type: M3LConfigParameterType.STRING_ARRAY,
            defaultValue: ["a"],
            validate: M3LConfigValidators.nonEmpty,
          }),
      ).not.toThrow();
    });

    test("minLength(1) compiles as `validate` on a STRING parameter (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "name",
            type: M3LConfigParameterType.STRING,
            defaultValue: "Ada",
            validate: M3LConfigValidators.minLength(1),
          }),
      ).not.toThrow();
    });

    test("minLength(1) compiles as `validate` on a STRING_ARRAY parameter (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "tags",
            type: M3LConfigParameterType.STRING_ARRAY,
            defaultValue: ["a"],
            validate: M3LConfigValidators.minLength(1),
          }),
      ).not.toThrow();
    });

    test("nonEmpty on an INT parameter is a compile error (number has no length)", () => {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 3000,
        // @ts-expect-error -- nonEmpty is M3LConfigValidator<{ readonly length: number }>; number has no `length`, not assignable to an INT parameter's validate
        validate: M3LConfigValidators.nonEmpty,
      });
    });

    test("minLength(1) on an INT parameter is a compile error (number has no length)", () => {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 3000,
        // @ts-expect-error -- minLength(1) is M3LConfigValidator<{ readonly length: number }>; number has no `length`, not assignable to an INT parameter's validate
        validate: M3LConfigValidators.minLength(1),
      });
    });

    test("a range() validator (M3LConfigValidator<number>) compiles on an INT parameter", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "port",
            type: M3LConfigParameterType.INT,
            defaultValue: 3000,
            validate: M3LConfigValidators.range(1, 65535),
          }),
      ).not.toThrow();
    });

    test("a boolean-returning function is NOT assignable to M3LConfigValidator<number> (return must be true | string)", () => {
      const booleanValidator = (value: number): boolean => value > 0;
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 3000,
        // @ts-expect-error -- a boolean-returning predicate is not M3LConfigValidator<number>; return must be `true | string`
        validate: booleanValidator,
      });
    });
  });
});

// =============================================================================
// M3LConfigParameter `validate` option — the three validation points
// =============================================================================
describe("M3LConfigParameter schema-time validation", () => {
  test("throws M3LConfigValidationError eagerly in the constructor for an out-of-range defaultValue", () => {
    expect(
      () =>
        new M3LConfigParameter({
          name: "port",
          type: M3LConfigParameterType.INT,
          defaultValue: 70000,
          validate: M3LConfigValidators.range(1, 65535),
        }),
    ).toThrow(M3LConfigValidationError);
  });

  test("does NOT throw at construction for a defaultValue that passes its validator", () => {
    expect(
      () =>
        new M3LConfigParameter({
          name: "port",
          type: M3LConfigParameterType.INT,
          defaultValue: 3000,
          validate: M3LConfigValidators.range(1, 65535),
        }),
    ).not.toThrow();
  });

  test("rejects with M3LConfigValidationError when a coerced provider value fails validation", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "70000" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      validate: M3LConfigValidators.range(1, 65535),
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigValidationError,
    );
  });

  test("resolves normally when a coerced provider value passes validation", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "3000" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      validate: M3LConfigValidators.range(1, 65535),
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(3000);
  });

  test("rejects with M3LConfigValidationError when the asyncFallback result fails validation", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      asyncFallback: () => Promise.resolve(70000),
      validate: M3LConfigValidators.range(1, 65535),
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigValidationError,
    );
  });

  test("resolves normally when the asyncFallback result passes validation", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
      asyncFallback: () => Promise.resolve(3000),
      validate: M3LConfigValidators.range(1, 65535),
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(3000);
  });

  test("regression guard: a parameter with no validate resolves exactly as before (unchanged)", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ port: "70000" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "port",
      type: M3LConfigParameterType.INT,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(70000);
  });
});

// =============================================================================
// M3LConfigParameter `required` option — F1 (fail-fast on a missing value)
// =============================================================================
describe("M3LConfigParameter `required` option", () => {
  test("rejects with M3LConfigMissingError when required and no provider, defaultValue, or asyncFallback supplies a value", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    await expect(parameter.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigMissingError,
    );
  });

  test("resolves normally to the coerced value when required and a provider supplies a value", async () => {
    const reader = new M3LConfigReader([
      new M3LInMemoryConfigProvider({ apiKey: "secret-value" }),
    ]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe("secret-value");
  });

  test("resolves to defaultValue when required is true and a defaultValue is declared (the guard never fires)", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: true,
      defaultValue: "fallback-value",
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBe(
      "fallback-value",
    );
  });

  test("regression guard: required left unset with nothing supplying a value still resolves to undefined", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBeUndefined();
  });

  test("regression guard: explicit required: false with nothing supplying a value resolves to undefined", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: false,
    });

    await expect(parameter.getValueAsync(reader)).resolves.toBeUndefined();
  });

  describe("type-level contract", () => {
    test("required is an optional boolean constructor option (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "apiKey",
            type: M3LConfigParameterType.STRING,
            required: true,
          }),
      ).not.toThrow();
      expect(
        () =>
          new M3LConfigParameter({
            name: "apiKey",
            type: M3LConfigParameterType.STRING,
          }),
      ).not.toThrow();
    });
  });
});

// =============================================================================
// M3LConfigParameter `secret` option — purely declarative marker
// (docs/reference/core/config.md "Secret parameters"; RED until implemented)
// =============================================================================
describe("M3LConfigParameter `secret` option", () => {
  test("isSecret() returns true when `secret: true` is declared", () => {
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      secret: true,
    });

    expect(parameter.isSecret()).toBe(true);
  });

  test("isSecret() returns false by default when `secret` is omitted", () => {
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
    });

    expect(parameter.isSecret()).toBe(false);
  });

  test("isSecret() returns false when `secret: false` is declared explicitly", () => {
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      secret: false,
    });

    expect(parameter.isSecret()).toBe(false);
  });

  test("resolution/coercion/required behavior is identical for a secret parameter and its non-secret twin (secret is never consulted by resolution)", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);

    const secretWithDefault = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      defaultValue: "shh",
      secret: true,
    });
    const plainWithDefault = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      defaultValue: "shh",
    });

    await expect(secretWithDefault.getValueAsync(reader)).resolves.toBe("shh");
    await expect(plainWithDefault.getValueAsync(reader)).resolves.toBe("shh");

    const secretRequired = new M3LConfigParameter({
      name: "missing",
      type: M3LConfigParameterType.STRING,
      required: true,
      secret: true,
    });
    const plainRequired = new M3LConfigParameter({
      name: "missing",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    await expect(secretRequired.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigMissingError,
    );
    await expect(plainRequired.getValueAsync(reader)).rejects.toBeInstanceOf(
      M3LConfigMissingError,
    );
  });

  describe("type-level contract", () => {
    test("secret is an optional boolean constructor option (positive control)", () => {
      expect(
        () =>
          new M3LConfigParameter({
            name: "apiKey",
            type: M3LConfigParameterType.STRING,
            secret: true,
          }),
      ).not.toThrow();
      expect(
        () =>
          new M3LConfigParameter({
            name: "apiKey",
            type: M3LConfigParameterType.STRING,
          }),
      ).not.toThrow();
    });

    test("isSecret() returns boolean", () => {
      const parameter = new M3LConfigParameter({
        name: "apiKey",
        type: M3LConfigParameterType.STRING,
        secret: true,
      });

      expectTypeOf(parameter.isSecret()).toEqualTypeOf<boolean>();
    });

    test("declaring `secret: undefined` is rejected under exactOptionalPropertyTypes (declare-or-omit, matching `required`'s style)", () => {
      // @ts-expect-error -- secret is declared `secret?: boolean` (no `| undefined`), so an explicit `undefined` is rejected under exactOptionalPropertyTypes, mirroring `required?: boolean`
      new M3LConfigParameter({
        name: "apiKey",
        type: M3LConfigParameterType.STRING,
        secret: undefined,
      });
    });
  });
});

// =============================================================================
// M3LConfigValidationError
// =============================================================================
describe("M3LConfigValidationError", () => {
  test("is an instance of M3LError with code ERR_CONFIG_VALIDATION", () => {
    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 70000,
        validate: M3LConfigValidators.range(1, 65535),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    expect((thrown as M3LConfigValidationError).code).toBe(
      "ERR_CONFIG_VALIDATION",
    );
  });

  test("context carries { parameter, reason, valueType } matching the failed validation", () => {
    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 70000,
        validate: M3LConfigValidators.range(1, 65535),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    const validationError = thrown as M3LConfigValidationError;
    expect(validationError.context["parameter"]).toBe("port");
    expect(typeof validationError.context["reason"]).toBe("string");
    expect(validationError.context["reason"] as string).toContain("65535");
    expect(validationError.context["valueType"]).toBe("number");
  });

  test("a custom validator's failure reason surfaces via context.reason", () => {
    const validate: M3LConfigValidator<number> = (value) =>
      value % 2 === 0 ? true : "must be an even number";

    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "evenPort",
        type: M3LConfigParameterType.INT,
        defaultValue: 3001,
        validate,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    const validationError = thrown as M3LConfigValidationError;
    expect(validationError.context["reason"]).toBe("must be an even number");
  });

  test("chains an underlying cause when provided", () => {
    const cause = new Error("root");
    const error = new M3LConfigValidationError("bad value", { cause });

    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LConfigValidationError);
    expect(error.code).toBe("ERR_CONFIG_VALIDATION");
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options at all: code is set and context defaults to empty", () => {
    const error = new M3LConfigValidationError("bad value");

    expect(error.code).toBe("ERR_CONFIG_VALIDATION");
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_CONFIG_VALIDATION'", () => {
      expectTypeOf<
        M3LConfigValidationError["code"]
      >().toEqualTypeOf<"ERR_CONFIG_VALIDATION">();
    });
  });
});

// =============================================================================
// M3LConfigMissingError
// =============================================================================
describe("M3LConfigMissingError", () => {
  test("is an instance of M3LError with code ERR_CONFIG_MISSING", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "apiKey",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    let thrown: unknown;
    try {
      await parameter.getValueAsync(reader);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(M3LConfigMissingError);
    expect((thrown as M3LConfigMissingError).code).toBe("ERR_CONFIG_MISSING");
  });

  // There is no resolved value at all when a required parameter is missing,
  // so context has nothing to redact beyond naming the parameter — asserting
  // the exact shape doubles as both the contract check and the redaction
  // check (no stray `value` key can sneak in).
  test("context carries exactly { parameter } — no value to leak", async () => {
    const reader = new M3LConfigReader([new M3LInMemoryConfigProvider({})]);
    const parameter = new M3LConfigParameter({
      name: "dbPassword",
      type: M3LConfigParameterType.STRING,
      required: true,
    });

    let thrown: unknown;
    try {
      await parameter.getValueAsync(reader);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigMissingError);
    const missingError = thrown as M3LConfigMissingError;
    expect(missingError.context).toEqual({ parameter: "dbPassword" });
  });

  test("chains an underlying cause when provided", () => {
    const cause = new Error("root");
    const error = new M3LConfigMissingError("missing value", { cause });

    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LConfigMissingError);
    expect(error.code).toBe("ERR_CONFIG_MISSING");
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options at all: code is set and context defaults to empty", () => {
    const error = new M3LConfigMissingError("missing value");

    expect(error.code).toBe("ERR_CONFIG_MISSING");
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_CONFIG_MISSING'", () => {
      expectTypeOf<
        M3LConfigMissingError["code"]
      >().toEqualTypeOf<"ERR_CONFIG_MISSING">();
    });
  });
});

// =============================================================================
// Security — the resolved value never leaks through a validation failure
// =============================================================================
describe("M3LConfigValidationError redaction safety", () => {
  test("a non-echoing custom validator's failure never leaks the sentinel value in message or serialized context", () => {
    const SENTINEL = "SENTINEL_LEAK_9137";
    // A well-behaved custom validator: the reason is a constant string that
    // never embeds the received value.
    const validate: M3LConfigValidator<string> = () =>
      "must satisfy the application-defined constraint";

    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "apiToken",
        type: M3LConfigParameterType.STRING,
        defaultValue: SENTINEL,
        validate,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    const validationError = thrown as M3LConfigValidationError;
    expect(validationError.message).not.toContain(SENTINEL);
    expect(JSON.stringify(validationError.context)).not.toContain(SENTINEL);
    expect(validationError.context).not.toHaveProperty("value");
  });

  test("a secret parameter's value never appears in the thrown validation error", () => {
    const specifier = new M3LSecretsSpecifier(["dbPassword"]);
    expect(specifier.isSecret("dbPassword")).toBe(true);

    const SECRET_VALUE = "SENTINEL_SECRET_4471";
    const validate: M3LConfigValidator<string> = () =>
      "must satisfy the application-defined constraint";

    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "dbPassword",
        type: M3LConfigParameterType.STRING,
        defaultValue: SECRET_VALUE,
        validate,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    const validationError = thrown as M3LConfigValidationError;
    expect(validationError.message).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(validationError.context)).not.toContain(SECRET_VALUE);
  });

  test("context carries only parameter, reason, and valueType — no value or valueLength key", () => {
    let thrown: unknown;
    try {
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 70000,
        validate: M3LConfigValidators.range(1, 65535),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConfigValidationError);
    const validationError = thrown as M3LConfigValidationError;
    expect(validationError.context).not.toHaveProperty("value");
    expect(validationError.context).not.toHaveProperty("valueLength");
    expect(Object.keys(validationError.context).sort()).toEqual(
      ["parameter", "reason", "valueType"].sort(),
    );
  });
});

// =============================================================================
// M3LConfigHelpFormatter (PR4 — additive, RED until implemented)
// =============================================================================
describe("M3LConfigHelpFormatter", () => {
  test("a required STRING param with an alias and a description renders header + description, no default line", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "name",
        type: M3LConfigParameterType.STRING,
        aliases: ["alias"],
        description: "A human name.",
        required: true,
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);
    const lines = output.split("\n");

    expect(lines[0]).toBe("--name, --alias <STRING> (required)");
    expect(lines[1]).toBe("    A human name.");
    expect(output).not.toContain("default:");
  });

  test("a param with a defaultValue but no description renders a default: line, no description line", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
        defaultValue: 3000,
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);

    expect(output).toContain("default: 3000");
    expect(output.split("\n")).toHaveLength(2);
  });

  test("a param with neither description nor default renders only the header line", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "port",
        type: M3LConfigParameterType.INT,
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);

    expect(output.split("\n")).toHaveLength(1);
    expect(output).toBe("--port <INT>");
  });

  test("a STRING_ARRAY param's default array renders comma-joined", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "tags",
        type: M3LConfigParameterType.STRING_ARRAY,
        defaultValue: ["a", "b", "c"],
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);

    expect(output).toContain("default: a, b, c");
  });

  test("multiple parameters are separated by a blank line and appear in schema order", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "first",
        type: M3LConfigParameterType.STRING,
      }),
      new M3LConfigParameter({
        name: "second",
        type: M3LConfigParameterType.STRING,
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);

    expect(output).toBe("--first <STRING>\n\n--second <STRING>");
  });

  test("no aliases means no trailing comma in the header", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "solo",
        type: M3LConfigParameterType.STRING,
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);

    expect(output).toBe("--solo <STRING>");
    expect(output).not.toContain(",");
  });

  test("an empty schema formats to an empty string", () => {
    const schema = new M3LConfigSchema([]);
    const formatter = new M3LConfigHelpFormatter();

    expect(formatter.format(schema)).toBe("");
  });

  test("a secret parameter renders name/type/description normally but masks its default: line as `default: ********`", () => {
    const schema = new M3LConfigSchema([
      new M3LConfigParameter({
        name: "apiKey",
        type: M3LConfigParameterType.STRING,
        required: true,
        secret: true,
        description: "API key for the target service",
        defaultValue: "shh-default",
      }),
    ]);
    const formatter = new M3LConfigHelpFormatter();

    const output = formatter.format(schema);
    const lines = output.split("\n");

    expect(lines[0]).toBe("--apiKey <STRING> (required)");
    expect(lines[1]).toBe("    API key for the target service");
    expect(output).not.toContain("shh-default");
    expect(lines[2]).toBe("    default: ********");
  });

  test("type-level: format() returns string", () => {
    expectTypeOf(
      new M3LConfigHelpFormatter().format,
    ).returns.toEqualTypeOf<string>();
  });
});
