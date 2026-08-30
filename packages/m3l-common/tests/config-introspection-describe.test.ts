/**
 * Tests for `core/config`'s `describeConfigParameters` (X10a — promoted from
 * `packages/m3l-cli/src/discovery/load-config.ts`'s `describeParameters`).
 * RED until implemented.
 *
 * Contract source: docs/reference/core/config.md, "Script introspection"
 * section. This is a PROMOTION, not new behaviour — coverage is ported from
 * `packages/m3l-cli/tests/load-config.test.ts`'s `describeParameters` and
 * "describeParameters — operations (U8)" blocks, onto the new Core symbol
 * names (`describeConfigParameters`, `M3LConfigParameterDescriptor`,
 * `M3LConfigOperationDescriptor`, `M3LConfigParameterLike`). The CLI test
 * file is untouched and remains the CLI-adapter regression net.
 *
 * New exports under test (from `packages/m3l-common/src/core/config`):
 *   describeConfigParameters, M3LConfigParameterDescriptor,
 *   M3LConfigOperationDescriptor, M3LConfigParameterLike,
 *   M3LConfigParameterValue.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  describeConfigParameters,
  M3LConfigParameter,
  M3LConfigParameterType,
} from "../src/core/config/index.js";
import type {
  M3LConfigOperationDescriptor,
  M3LConfigParameterDescriptor,
  M3LConfigParameterLike,
} from "../src/core/config/index.js";

/**
 * Builds a well-formed {@link M3LConfigParameterLike} fixture, with any
 * getter overridden to a deliberately misbehaving return value. `overrides`
 * is typed `Record<string, unknown>` (rather than `Partial<...>`) so a
 * caller can model a foreign, out-of-process config module (a script
 * compiled against a different `dist/`) whose getters return a shape
 * `M3LConfigParameterLike`'s compile-time signature would otherwise
 * reject — a shape {@link describeConfigParameters} must still validate
 * defensively at runtime.
 */
function buildParameterLikeFixture(
  overrides: Record<string, unknown> = {},
): M3LConfigParameterLike {
  return {
    getName: () => "paramName",
    getAliases: () => [],
    getType: () => "STRING",
    isRequired: () => false,
    getDefaultValue: () => undefined,
    getDescription: () => undefined,
    ...overrides,
  };
}

/** Captures the thrown value from a synchronous call, or `undefined`. */
function captureThrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("describeConfigParameters", () => {
  test("maps every public getter through to the descriptor shape", () => {
    const parameter = new M3LConfigParameter({
      name: "PORT",
      type: M3LConfigParameterType.INT,
      aliases: ["SERVER_PORT"],
      defaultValue: 3000,
      required: true,
      description: "the listen port",
    });

    const descriptors = describeConfigParameters([parameter]);

    expect(descriptors).toEqual([
      {
        name: "PORT",
        aliases: ["SERVER_PORT"],
        type: "INT",
        required: true,
        defaultValue: "3000",
        description: "the listen port",
        secret: false,
        operations: [],
      },
    ]);
  });

  test("renders defaultValue as undefined and description as '' when neither was declared", () => {
    const parameter = new M3LConfigParameter({
      name: "TAGS",
      type: M3LConfigParameterType.STRING_ARRAY,
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.defaultValue).toBeUndefined();
    expect(descriptor?.description).toBe("");
    expect(descriptor?.aliases).toEqual([]);
    expect(descriptor?.required).toBe(false);
  });

  test("renders a BOOL/array defaultValue via String(...)", () => {
    const parameter = new M3LConfigParameter({
      name: "ENABLED",
      type: M3LConfigParameterType.BOOL,
      defaultValue: true,
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.defaultValue).toBe("true");
  });

  test("returns an empty array for an empty input", () => {
    expect(describeConfigParameters([])).toEqual([]);
  });

  test("maps a secret-flagged parameter's isSecret() through to descriptor.secret", () => {
    const parameter = new M3LConfigParameter({
      name: "API_KEY",
      type: M3LConfigParameterType.STRING,
      secret: true,
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.secret).toBe(true);
  });

  test("maps a non-secret parameter's isSecret() to descriptor.secret === false", () => {
    const parameter = new M3LConfigParameter({
      name: "REGION",
      type: M3LConfigParameterType.STRING,
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.secret).toBe(false);
  });

  test("masks a secret-flagged parameter's defaultValue as ******** in the descriptor, never the raw value", () => {
    const parameter = new M3LConfigParameter({
      name: "API_KEY",
      type: M3LConfigParameterType.STRING,
      defaultValue: "raw-secret-default-value",
      secret: true,
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.defaultValue).toBe("********");
    expect(descriptor?.defaultValue).not.toContain("raw-secret-default-value");
    expect(JSON.stringify(descriptor)).not.toContain(
      "raw-secret-default-value",
    );
  });

  test("leaves a non-secret parameter's defaultValue untouched", () => {
    const parameter = new M3LConfigParameter({
      name: "REGION",
      type: M3LConfigParameterType.STRING,
      defaultValue: "us-east-1",
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.defaultValue).toBe("us-east-1");
  });

  test("treats a duck-typed element missing isSecret() as non-secret, tolerating a stale pre-secret dist build", () => {
    const staleParameterLike: M3LConfigParameterLike = {
      getName: () => "LEGACY",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      // no isSecret() — simulates a config module compiled against a dist
      // predating secret-threading.
    };

    const [descriptor] = describeConfigParameters([staleParameterLike]);

    expect(descriptor?.secret).toBe(false);
  });
});

describe("describeConfigParameters — operations (ADR-0055 / U8)", () => {
  test("normalizes a real M3LConfigParameter's single declared operation onto descriptor.operations", () => {
    const parameter = new M3LConfigParameter({
      name: "command",
      type: M3LConfigParameterType.STRING,
      operations: [
        {
          name: "get",
          description: "Fetch one item.",
          requiredParameters: ["key"],
        },
      ],
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.operations).toEqual([
      {
        name: "get",
        description: "Fetch one item.",
        requiredParameters: ["key"],
      },
    ]);
  });

  test("preserves declaration order across multiple declared operations", () => {
    const parameter = new M3LConfigParameter({
      name: "command",
      type: M3LConfigParameterType.STRING,
      operations: [
        { name: "get", description: "Fetch one item." },
        { name: "put", description: "Write one item." },
        { name: "delete", description: "Remove one item." },
      ],
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(
      descriptor?.operations?.map(
        (operation: { readonly name: string }) => operation.name,
      ),
    ).toEqual(["get", "put", "delete"]);
  });

  test("normalizes an operation with no declared requiredParameters to an empty array, not undefined", () => {
    const parameter = new M3LConfigParameter({
      name: "command",
      type: M3LConfigParameterType.STRING,
      operations: [{ name: "get", description: "Fetch one item." }],
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.operations?.[0]?.requiredParameters).toEqual([]);
  });

  test("normalizes an operation's declared requiredParameters through unchanged", () => {
    const parameter = new M3LConfigParameter({
      name: "command",
      type: M3LConfigParameterType.STRING,
      operations: [
        {
          name: "put",
          description: "Write one item.",
          requiredParameters: ["key", "value"],
        },
      ],
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.operations?.[0]?.requiredParameters).toEqual([
      "key",
      "value",
    ]);
  });

  test("assigns an empty operations array to a real parameter that declares no operations", () => {
    const parameter = new M3LConfigParameter({
      name: "PORT",
      type: M3LConfigParameterType.INT,
    });

    const [descriptor] = describeConfigParameters([parameter]);

    expect(descriptor?.operations).toEqual([]);
  });

  test("assigns an empty operations array, never throwing, for a duck-typed element with no getOperations() method", () => {
    const staleParameterLike: M3LConfigParameterLike = {
      getName: () => "LEGACY",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      // no getOperations() — simulates a config module compiled against a
      // dist predating operation-threading.
    };

    const [descriptor] = describeConfigParameters([staleParameterLike]);

    expect(descriptor?.operations).toEqual([]);
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a non-array string", "get"],
    ["a non-array plain object", { name: "get" }],
    ["an array containing a non-object element", ["get"]],
    ["an array containing an object missing name and description", [{}]],
    [
      "an array containing an object with non-string name and description",
      [{ name: 1, description: 2 }],
    ],
    [
      "an array containing an object with a non-array requiredParameters",
      [{ name: "get", description: "d", requiredParameters: "key" }],
    ],
    [
      "an array containing an object whose requiredParameters array contains a non-string element",
      [{ name: "get", description: "d", requiredParameters: [1] }],
    ],
    ["an empty array", []],
  ])(
    "falls back to an empty operations array, never throwing, when getOperations() returns %s",
    (_label, malformedReturn) => {
      const duckTypedElement: M3LConfigParameterLike = {
        getName: () => "command",
        getAliases: () => [],
        getType: () => "STRING",
        isRequired: () => false,
        getDefaultValue: () => undefined,
        getDescription: () => undefined,
        getOperations: () => malformedReturn,
      };

      expect(() => describeConfigParameters([duckTypedElement])).not.toThrow();
      const [descriptor] = describeConfigParameters([duckTypedElement]);
      expect(descriptor?.operations).toEqual([]);
    },
  );

  test("all-or-nothing: when only ONE element of a multi-element getOperations() list is malformed, the whole list falls back to []", () => {
    const duckTypedElement: M3LConfigParameterLike = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      getOperations: () => [
        { name: "get", description: "Fetch one item." },
        { name: "put" }, // missing description — malformed
        { name: "scan", description: "Scan the whole table." },
      ],
    };

    const [descriptor] = describeConfigParameters([duckTypedElement]);

    expect(descriptor?.operations).toEqual([]);
  });

  test("reads a duck-typed element's getOperations() exactly once, reflecting only its first return value", () => {
    const getOperations = vi
      .fn()
      .mockReturnValueOnce([
        {
          name: "get",
          description: "Fetch one item.",
          requiredParameters: ["key"],
        },
      ])
      .mockReturnValueOnce([{ name: "put", description: "Write one item." }]);
    const duckTypedElement: M3LConfigParameterLike = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      getOperations,
    };

    const [descriptor] = describeConfigParameters([duckTypedElement]);

    expect(getOperations).toHaveBeenCalledTimes(1);
    expect(descriptor?.operations).toEqual([
      {
        name: "get",
        description: "Fetch one item.",
        requiredParameters: ["key"],
      },
    ]);
  });

  test("assigns an empty operations array, never throwing, when getOperations is a non-function property", () => {
    // Cast bypasses the getOperations type: this simulates a config module
    // exporting a plain property in place of the documented method, a shape
    // TypeScript itself would reject but a dynamically-imported, untrusted
    // script module can still produce at runtime.
    const duckTypedElement = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => "A malformed export.",
      getOperations: "not-a-function",
    } as unknown as M3LConfigParameterLike;

    expect(() => describeConfigParameters([duckTypedElement])).not.toThrow();
    const [descriptor] = describeConfigParameters([duckTypedElement]);

    expect(descriptor?.operations).toEqual([]);
    expect(descriptor?.name).toBe("command");
    expect(descriptor?.type).toBe("STRING");
    expect(descriptor?.required).toBe(false);
    expect(descriptor?.description).toBe("A malformed export.");
  });

  test("assigns an empty operations array, never throwing, when getOperations() throws", () => {
    const duckTypedElement: M3LConfigParameterLike = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => "A thrown getter.",
      getOperations: () => {
        throw new Error("boom");
      },
    };

    expect(() => describeConfigParameters([duckTypedElement])).not.toThrow();
    const [descriptor] = describeConfigParameters([duckTypedElement]);

    expect(descriptor?.operations).toEqual([]);
    expect(descriptor?.name).toBe("command");
    expect(descriptor?.type).toBe("STRING");
    expect(descriptor?.required).toBe(false);
    expect(descriptor?.description).toBe("A thrown getter.");
  });
});

describe("M3LConfigParameterDescriptor contract", () => {
  test("declares the documented readonly shape, including the secret flag and operations list", () => {
    expectTypeOf<M3LConfigParameterDescriptor>().toEqualTypeOf<{
      readonly name: string;
      readonly aliases: readonly string[];
      readonly type: string;
      readonly required: boolean;
      readonly defaultValue: string | undefined;
      readonly description: string;
      readonly secret: boolean;
      readonly operations: readonly M3LConfigOperationDescriptor[];
    }>();
  });
});

describe("M3LConfigOperationDescriptor contract", () => {
  test("declares the documented readonly shape: name, description, and an always-array requiredParameters", () => {
    expectTypeOf<M3LConfigOperationDescriptor>().toEqualTypeOf<{
      readonly name: string;
      readonly description: string;
      readonly requiredParameters: readonly string[];
    }>();
  });
});

describe("describeConfigParameters — required-getter validation (X10a change 2)", () => {
  test("throws ERR_CONFIG_MODULE_INVALID naming 'getName' when getName() returns a non-string", () => {
    const bad = buildParameterLikeFixture({ getName: () => 42 });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("getName");
  });

  test("throws ERR_CONFIG_MODULE_INVALID naming the parameter and 'getAliases' when getAliases() returns a non-array", () => {
    const bad = buildParameterLikeFixture({ getAliases: () => "not-an-array" });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("paramName");
    expect((thrown as M3LError).message).toContain("getAliases");
  });

  test("throws ERR_CONFIG_MODULE_INVALID naming the parameter and 'getAliases' when getAliases() returns an array with a non-string element", () => {
    const bad = buildParameterLikeFixture({ getAliases: () => ["ok", 42] });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("paramName");
    expect((thrown as M3LError).message).toContain("getAliases");
  });

  test("throws ERR_CONFIG_MODULE_INVALID naming the parameter and 'getType' when getType() returns a non-string", () => {
    const bad = buildParameterLikeFixture({ getType: () => 42 });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("paramName");
    expect((thrown as M3LError).message).toContain("getType");
  });

  test("throws ERR_CONFIG_MODULE_INVALID naming the parameter and 'isRequired' when isRequired() returns a non-boolean", () => {
    const bad = buildParameterLikeFixture({ isRequired: () => "yes" });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("paramName");
    expect((thrown as M3LError).message).toContain("isRequired");
  });

  test("throws ERR_CONFIG_MODULE_INVALID (never renders '[object Object]') when getDefaultValue() returns a value outside M3LConfigParameterValue", () => {
    const bad = buildParameterLikeFixture({ getDefaultValue: () => ({}) });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("paramName");
    expect((thrown as M3LError).message).toContain("getDefaultValue");
  });

  test("throws ERR_CONFIG_MODULE_INVALID naming the parameter and 'getDescription' when getDescription() returns a non-string, non-undefined value", () => {
    const bad = buildParameterLikeFixture({ getDescription: () => 42 });

    const thrown = captureThrown(() => describeConfigParameters([bad]));

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).message).toContain("paramName");
    expect((thrown as M3LError).message).toContain("getDescription");
  });

  test("does not throw and renders description as '' when getDescription() returns undefined (a documented legal value, not a failure)", () => {
    const good = buildParameterLikeFixture({ getDescription: () => undefined });

    expect(() => describeConfigParameters([good])).not.toThrow();
    const [descriptor] = describeConfigParameters([good]);
    expect(descriptor?.description).toBe("");
  });
});

describe("describeConfigParameters — isSecret fails closed (X10a change 3)", () => {
  const RAW_SECRET_DEFAULT = "raw-secret-default-value";

  /**
   * Builds a well-formed base fixture whose default value is a sensitive
   * string, with `isSecret` overridden to a deliberately misbehaving (or
   * well-behaved) value. The cast is the same deliberate foreign-module
   * modelling as {@link buildParameterLikeFixture} above.
   */
  function buildSecretFixture(isSecret: unknown): M3LConfigParameterLike {
    return {
      getName: () => "API_KEY",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => RAW_SECRET_DEFAULT,
      getDescription: () => undefined,
      isSecret,
    } as unknown as M3LConfigParameterLike;
  }

  test("treats isSecret that throws when called as secret: true, masking the default, and lets no throw escape", () => {
    const parameter = buildSecretFixture(() => {
      throw new Error("boom");
    });

    expect(() => describeConfigParameters([parameter])).not.toThrow();
    const [descriptor] = describeConfigParameters([parameter]);
    expect(descriptor?.secret).toBe(true);
    expect(descriptor?.defaultValue).toBe("********");
    expect(JSON.stringify(descriptor)).not.toContain(RAW_SECRET_DEFAULT);
  });

  test("treats isSecret present as a non-function property as secret: true, masking the default", () => {
    const parameter = buildSecretFixture("not-a-function");

    const [descriptor] = describeConfigParameters([parameter]);
    expect(descriptor?.secret).toBe(true);
    expect(descriptor?.defaultValue).toBe("********");
    expect(JSON.stringify(descriptor)).not.toContain(RAW_SECRET_DEFAULT);
  });

  test("treats isSecret returning a non-boolean as secret: true, masking the default", () => {
    const parameter = buildSecretFixture(() => "yes");

    const [descriptor] = describeConfigParameters([parameter]);
    expect(descriptor?.secret).toBe(true);
    expect(descriptor?.defaultValue).toBe("********");
    expect(JSON.stringify(descriptor)).not.toContain(RAW_SECRET_DEFAULT);
  });

  test("honors isSecret() => true unchanged: secret true, default masked", () => {
    const parameter = buildSecretFixture(() => true);

    const [descriptor] = describeConfigParameters([parameter]);
    expect(descriptor?.secret).toBe(true);
    expect(descriptor?.defaultValue).toBe("********");
  });

  test("honors isSecret() => false unchanged: secret false, default rendered normally", () => {
    const parameter = buildSecretFixture(() => false);

    const [descriptor] = describeConfigParameters([parameter]);
    expect(descriptor?.secret).toBe(false);
    expect(descriptor?.defaultValue).toBe(RAW_SECRET_DEFAULT);
  });
});
