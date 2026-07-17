import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "../src/config.js";

/**
 * Contract: docs/reference/scripts/api-gateway-client.md "Configuration
 * schema" table + `src/config.ts`. 12 declared parameters: aws.profile,
 * command, auth, baseUrl, method, path, body, input, output, maxInFlight,
 * apiKey, yes. This file asserts the DECLARED shape only — names,
 * uniqueness, instance types, and each parameter's own validator/default —
 * never the library's own provider-resolution order.
 */

const EXPECTED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "command",
  "auth",
  "baseUrl",
  "method",
  "path",
  "body",
  "input",
  "output",
  "maxInFlight",
  "apiKey",
  "yes",
] as const;

const COMMANDS = ["request", "batch"] as const;
const AUTH_MODES = ["none", "api-key", "iam"] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/** Resolves `parameter` against a single in-memory raw value keyed by its canonical name. */
async function resolveWith(
  parameter: Core.M3LConfigParameter,
  raw: unknown,
): Promise<unknown> {
  const reader = new Core.M3LConfigReader([
    new Core.M3LInMemoryConfigProvider({ [parameter.getName()]: raw }),
  ]);
  return parameter.getValueAsync(reader);
}

/** Resolves `parameter` against a single in-memory raw value keyed by an alias. */
async function resolveWithKey(
  parameter: Core.M3LConfigParameter,
  key: string,
  raw: unknown,
): Promise<unknown> {
  const reader = new Core.M3LConfigReader([
    new Core.M3LInMemoryConfigProvider({ [key]: raw }),
  ]);
  return parameter.getValueAsync(reader);
}

/** Resolves `parameter` with no provider at all (falls through to its default). */
async function resolveDefault(
  parameter: Core.M3LConfigParameter,
): Promise<unknown> {
  const reader = new Core.M3LConfigReader([]);
  return parameter.getValueAsync(reader);
}

function paramNamed(name: string): Core.M3LConfigParameter {
  const found = configParameters.find(
    (parameter) => parameter.getName() === name,
  );
  if (found === undefined) {
    throw new Error(
      `test fixture error: no declared parameter named '${name}'`,
    );
  }
  return found;
}

describe("api-gateway-client config declaration", () => {
  it("declares at least one parameter", () => {
    expect(configParameters.length).toBeGreaterThan(0);
  });

  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  it("declares exactly the 12 documented parameters, in order", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(names).toEqual(EXPECTED_NAMES);
  });

  describe("'command' — required, oneOf(request, batch)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("command"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(COMMANDS)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("command"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("command"), "list"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'auth' — required, oneOf(none, api-key, iam)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("auth"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(AUTH_MODES)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("auth"), value)).resolves.toBe(value);
    });

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("auth"), "basic"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'baseUrl' — required, nonEmpty", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("baseUrl"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it("rejects an empty string and accepts a non-empty one", async () => {
      const parameter = paramNamed("baseUrl");
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(
        resolveWith(parameter, "https://api.example.test"),
      ).resolves.toBe("https://api.example.test");
    });
  });

  describe("'method' — required, oneOf(GET, POST, PUT, PATCH, DELETE, HEAD)", () => {
    it("rejects a MISSING value with M3LConfigMissingError", async () => {
      let thrown: unknown;
      try {
        await resolveDefault(paramNamed("method"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Core.M3LConfigMissingError);
    });

    it.each(METHODS)("accepts '%s'", async (value) => {
      await expect(resolveWith(paramNamed("method"), value)).resolves.toBe(
        value,
      );
    });

    it("rejects a value outside the declared set (never defaults to an implicit GET)", async () => {
      await expect(
        resolveWith(paramNamed("method"), "OPTIONS"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'path'/'input'/'output' — optional, nonEmpty when set", () => {
    it.each(["path", "input", "output"] as const)(
      "'%s' has no default (unset)",
      async (name) => {
        await expect(resolveDefault(paramNamed(name))).resolves.toBeUndefined();
      },
    );

    it.each(["path", "input", "output"] as const)(
      "'%s' rejects an empty string and accepts a non-empty one",
      async (name) => {
        const parameter = paramNamed(name);
        await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
          Core.M3LConfigValidationError,
        );
        await expect(resolveWith(parameter, "value")).resolves.toBe("value");
      },
    );
  });

  describe("'body' — optional, no validator", () => {
    it("has no default (unset)", async () => {
      await expect(resolveDefault(paramNamed("body"))).resolves.toBeUndefined();
    });

    it("accepts an arbitrary string body", async () => {
      await expect(
        resolveWith(paramNamed("body"), '{"name":"widget"}'),
      ).resolves.toBe('{"name":"widget"}');
    });
  });

  describe("'maxInFlight' — INT, range(1, 64), default 4", () => {
    it("defaults to 4", async () => {
      await expect(resolveDefault(paramNamed("maxInFlight"))).resolves.toBe(4);
    });

    it("accepts the boundary values 1 and 64", async () => {
      await expect(resolveWith(paramNamed("maxInFlight"), "1")).resolves.toBe(
        1,
      );
      await expect(resolveWith(paramNamed("maxInFlight"), "64")).resolves.toBe(
        64,
      );
    });

    it("rejects 0 and 65", async () => {
      await expect(
        resolveWith(paramNamed("maxInFlight"), "0"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
      await expect(
        resolveWith(paramNamed("maxInFlight"), "65"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("'apiKey' — optional, nonEmpty, alias 'api-gateway-api-key'", () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed("apiKey")),
      ).resolves.toBeUndefined();
    });

    it("rejects an empty string and accepts a non-empty one under its canonical name", async () => {
      const parameter = paramNamed("apiKey");
      await expect(resolveWith(parameter, "")).rejects.toBeInstanceOf(
        Core.M3LConfigValidationError,
      );
      await expect(resolveWith(parameter, "secret-value")).resolves.toBe(
        "secret-value",
      );
    });

    it("declares the 'api-gateway-api-key' alias", () => {
      expect(paramNamed("apiKey").getAliases()).toContain(
        "api-gateway-api-key",
      );
    });

    it("resolves a value supplied under the 'api-gateway-api-key' alias key", async () => {
      await expect(
        resolveWithKey(paramNamed("apiKey"), "api-gateway-api-key", "aliased"),
      ).resolves.toBe("aliased");
    });
  });

  describe("'yes' — BOOL, default false", () => {
    it("defaults to false", async () => {
      await expect(resolveDefault(paramNamed("yes"))).resolves.toBe(false);
    });

    it("accepts an explicit true", async () => {
      await expect(resolveWith(paramNamed("yes"), "true")).resolves.toBe(true);
    });
  });

  describe(`'${Core.AWS_PROFILE_PARAM_NAME}' — optional (guard-checked for auth: iam)`, () => {
    it("has no default (unset)", async () => {
      await expect(
        resolveDefault(paramNamed(Core.AWS_PROFILE_PARAM_NAME)),
      ).resolves.toBeUndefined();
    });

    it("accepts a non-empty profile name", async () => {
      await expect(
        resolveWith(paramNamed(Core.AWS_PROFILE_PARAM_NAME), "default"),
      ).resolves.toBe("default");
    });
  });
});
