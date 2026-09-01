/**
 * Tests for src/commands/dynamic-argv.ts's `translateArgv` — the ADR-0085
 * seam that splits a parsed invocation into the public `--name[=value]` child
 * argv and the secret-only environment overlay.
 *
 * The load-bearing assertion in this file is the negative one: a
 * `secret: true` parameter's value must appear **nowhere** in the argv array,
 * because argv is level 1 of `M3LScriptConfigLoader`'s provider chain and the
 * environment is level 4 — leaving the token in place would resolve the
 * secret from argv anyway and make the whole hardening inert while every
 * "the value reached the environment" assertion still passed. Deleting the
 * secret branch in `translateArgv` must turn these red.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  buildParameterValues,
  translateArgv,
} from "../src/commands/dynamic-argv.js";
import type { M3LCliTranslatedInvocation } from "../src/commands/dynamic-argv.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";

const SECRET = "SUPER-SECRET-VALUE-9000";

function makeDescriptor(
  overrides: Partial<M3LCliParameterDescriptor> &
    Pick<M3LCliParameterDescriptor, "name">,
): M3LCliParameterDescriptor {
  return {
    aliases: [],
    type: "STRING",
    required: false,
    defaultValue: undefined,
    description: "",
    secret: false,
    operations: [],
    ...overrides,
  };
}

describe("translateArgv — a secret never reaches argv", () => {
  test("a present secret parameter contributes NOTHING to argv", () => {
    const { argv } = translateArgv(
      [makeDescriptor({ name: "licenseCode", secret: true })],
      { licenseCode: SECRET },
    );

    // Asserted against the whole array, not `.includes("--licenseCode")`:
    // what matters is that the value is absent from every token, since the
    // tokens are what become /proc/<pid>/cmdline.
    expect(argv).toEqual([]);
    expect(JSON.stringify(argv)).not.toContain(SECRET);
  });

  test("the same value DOES appear in secretEnv under the derived name", () => {
    const { secretEnv } = translateArgv(
      [makeDescriptor({ name: "licenseCode", secret: true })],
      { licenseCode: SECRET },
    );

    expect(secretEnv).toEqual({ LICENSECODE: SECRET });
  });

  test.each([
    ["api.token", "API_TOKEN"],
    ["api-token", "API_TOKEN"],
    ["a.b-c", "A_B_C"],
    ["ALREADY_UPPER", "ALREADY_UPPER"],
  ])(
    "derives the environment name for a %j parameter as %j",
    (name, envName) => {
      const { argv, secretEnv } = translateArgv(
        [makeDescriptor({ name, secret: true })],
        { [name]: SECRET },
      );

      expect(secretEnv).toEqual({ [envName]: SECRET });
      expect(argv).toEqual([]);
    },
  );

  test("an alias hit keys the env entry off the CANONICAL name, never the alias", () => {
    const { secretEnv } = translateArgv(
      [makeDescriptor({ name: "api-token", aliases: ["t"], secret: true })],
      { t: SECRET },
    );

    expect(secretEnv).toEqual({ API_TOKEN: SECRET });
  });

  test("an absent secret parameter produces no env entry at all", () => {
    const { argv, secretEnv } = translateArgv(
      [makeDescriptor({ name: "licenseCode", secret: true })],
      {},
    );

    expect(argv).toEqual([]);
    expect(secretEnv).toEqual({});
  });
});

describe("translateArgv — a non-secret still reaches argv", () => {
  test("a non-secret parameter goes to argv and contributes nothing to secretEnv", () => {
    const { argv, secretEnv } = translateArgv(
      [makeDescriptor({ name: "region" })],
      { region: "us-east-1" },
    );

    expect(argv).toEqual(["--region=us-east-1"]);
    expect(secretEnv).toEqual({});
  });

  test("mixed descriptors split cleanly, preserving declaration order in argv", () => {
    const { argv, secretEnv } = translateArgv(
      [
        makeDescriptor({ name: "region" }),
        makeDescriptor({ name: "licenseCode", secret: true }),
        makeDescriptor({ name: "verbose", type: "BOOL" }),
      ],
      { region: "us-east-1", licenseCode: SECRET, verbose: true },
    );

    // The secret sits BETWEEN two non-secrets: its `continue` must not
    // disturb the ordering of what remains.
    expect(argv).toEqual(["--region=us-east-1", "--verbose"]);
    expect(secretEnv).toEqual({ LICENSECODE: SECRET });
  });
});

describe("translateArgv — per-type secret rendering", () => {
  test("a STRING_ARRAY secret is comma-joined, matching coerceConfigValue's splitCsv contract", () => {
    const { argv, secretEnv } = translateArgv(
      [makeDescriptor({ name: "tokens", type: "STRING_ARRAY", secret: true })],
      { tokens: ["a", "b"] },
    );

    expect(argv).toEqual([]);
    expect(secretEnv).toEqual({ TOKENS: "a,b" });
  });

  test("an INT secret is stringified", () => {
    const { secretEnv } = translateArgv(
      [makeDescriptor({ name: "port", type: "INT", secret: true })],
      { port: "8080" },
    );

    expect(secretEnv).toEqual({ PORT: "8080" });
  });

  test("a BOOL secret is a contradiction and is routed to argv as a bare flag, never to env", () => {
    const { argv, secretEnv } = translateArgv(
      [makeDescriptor({ name: "verbose", type: "BOOL", secret: true })],
      { verbose: true },
    );

    expect(argv).toEqual(["--verbose"]);
    expect(secretEnv).toEqual({});
  });

  test("a false BOOL secret is omitted from both halves, exactly as a non-secret false flag is", () => {
    const { argv, secretEnv } = translateArgv(
      [makeDescriptor({ name: "verbose", type: "BOOL", secret: true })],
      { verbose: false },
    );

    expect(argv).toEqual([]);
    expect(secretEnv).toEqual({});
  });
});

describe("translateArgv — env-name collision guard", () => {
  test("rejects two parameters deriving the same env name when one is secret", () => {
    expect(() =>
      translateArgv(
        [
          makeDescriptor({ name: "api.token", secret: true }),
          makeDescriptor({ name: "api-token" }),
        ],
        { "api.token": SECRET },
      ),
    ).toThrowError(/both derive the environment variable 'API_TOKEN'/);
  });

  test("the collision error is ERR_CLI_CONFIG_IMPORT — an invalid declared config, not user input", () => {
    try {
      translateArgv(
        [
          makeDescriptor({ name: "api.token" }),
          makeDescriptor({ name: "api-token", secret: true }),
        ],
        {},
      );
      expect.unreachable("expected a collision error");
    } catch (error) {
      expect(error).toBeInstanceOf(M3LCliError);
      expect((error as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
    }
  });

  test("two colliding NON-secret parameters are left alone — pre-existing behaviour, unchanged", () => {
    const { argv } = translateArgv(
      [
        makeDescriptor({ name: "api.token" }),
        makeDescriptor({ name: "api-token" }),
      ],
      { "api.token": "x", "api-token": "y" },
    );

    expect(argv).toEqual(["--api.token=x", "--api-token=y"]);
  });

  test("distinct env names do not collide", () => {
    expect(() =>
      translateArgv(
        [
          makeDescriptor({ name: "api.token", secret: true }),
          makeDescriptor({ name: "api.secret", secret: true }),
        ],
        { "api.token": SECRET, "api.secret": "other" },
      ),
    ).not.toThrow();
  });
});

describe("buildParameterValues — the in-process path is deliberately unchanged", () => {
  test("a secret still appears in the typed record, because there is no argv to leak it into", () => {
    // Regression lock (ADR-0085 §in-process): withholding the value here to
    // "match" the spawn path would break every in-process run of a
    // secret-bearing script by starving `execute` of a required parameter.
    // There is no child process, no argv, and no serialization on this path.
    const values = buildParameterValues(
      [makeDescriptor({ name: "licenseCode", secret: true })],
      { licenseCode: SECRET },
    );

    expect(values).toEqual({ licenseCode: SECRET });
  });
});

describe("translateArgv — type contract", () => {
  test("returns the M3LCliTranslatedInvocation pair", () => {
    expectTypeOf(
      translateArgv([], {}),
    ).toEqualTypeOf<M3LCliTranslatedInvocation>();
    expectTypeOf<M3LCliTranslatedInvocation>().toEqualTypeOf<{
      readonly argv: readonly string[];
      readonly secretEnv: Readonly<Record<string, string>>;
    }>();
  });
});
