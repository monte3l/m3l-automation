import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  configParameters,
  configValidators,
  RDS_DATA_SQL_OPERATIONS,
} from "../src/config.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md "Configuration schema"
 * table + the three ordered `configValidators` failure strings it documents.
 *
 * This file asserts the DECLARED shape (names, uniqueness, `required`,
 * per-parameter validators) and the cross-parameter `configValidators` — it
 * does not exercise the library's own 8-level provider-resolution order
 * (that's the library's own test suite's job) and does not test any
 * `steps/` module (covered by their own test files).
 */

const REQUIRED_NAMES = [
  Core.AWS_PROFILE_PARAM_NAME,
  "operation",
  "cluster.arn",
  "secret.arn",
  "database",
] as const;

/** Resolves `parameter` against a single in-memory raw value, nothing else. */
async function resolveWith(
  parameter: Core.M3LConfigParameter,
  raw: unknown,
): Promise<unknown> {
  const reader = new Core.M3LConfigReader([
    new Core.M3LInMemoryConfigProvider({ [parameter.getName()]: raw }),
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

/** Builds a raw `M3LConfig` store directly, one `.set(name, value)` per key. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

/**
 * Runs every declared `configValidators` entry against `config`, in
 * declaration order, mirroring `Core.M3LConfigSchema.validate`'s fail-fast
 * iteration: returns the first non-`true` result, or `undefined` when every
 * validator passes.
 */
function firstFailure(config: Core.M3LConfig): string | undefined {
  for (const validator of configValidators) {
    const result = validator(config);
    if (result !== true) return result;
  }
  return undefined;
}

describe("rds-data-sql config declaration", () => {
  it("declares every parameter via M3LConfigParameter with a unique name", () => {
    const names = configParameters.map((parameter) => parameter.getName());
    expect(new Set(names).size).toBe(names.length);
    for (const parameter of configParameters) {
      expect(parameter).toBeInstanceOf(Core.M3LConfigParameter);
    }
  });

  it.each(REQUIRED_NAMES)("'%s' is declared required: true", (name) => {
    expect(paramNamed(name).isRequired()).toBe(true);
  });

  describe("'operation' — oneOf(query, load, execute, migrate)", () => {
    it.each(["query", "load", "execute", "migrate"] as const)(
      "accepts '%s'",
      async (value) => {
        await expect(resolveWith(paramNamed("operation"), value)).resolves.toBe(
          value,
        );
      },
    );

    it("rejects a value outside the declared set", async () => {
      await expect(
        resolveWith(paramNamed("operation"), "delete"),
      ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
    });
  });

  describe("documented defaults", () => {
    it("'batch.size' defaults to 100", async () => {
      await expect(resolveDefault(paramNamed("batch.size"))).resolves.toBe(100);
    });

    it("'page.size' defaults to 1000", async () => {
      await expect(resolveDefault(paramNamed("page.size"))).resolves.toBe(1000);
    });

    it("'input.format' defaults to 'jsonl'", async () => {
      await expect(resolveDefault(paramNamed("input.format"))).resolves.toBe(
        "jsonl",
      );
    });

    it("'output.format' defaults to 'json'", async () => {
      await expect(resolveDefault(paramNamed("output.format"))).resolves.toBe(
        "json",
      );
    });

    it("'migrations.table' defaults to 'schema_migrations'", async () => {
      await expect(
        resolveDefault(paramNamed("migrations.table")),
      ).resolves.toBe("schema_migrations");
    });

    it("'yes' defaults to false", async () => {
      await expect(resolveDefault(paramNamed("yes"))).resolves.toBe(false);
    });

    it("'yesSensitive' defaults to false", async () => {
      await expect(resolveDefault(paramNamed("yesSensitive"))).resolves.toBe(
        false,
      );
    });
  });
});

describe("configValidators export", () => {
  it("is exported as a readonly array of validator functions", () => {
    expect(Array.isArray(configValidators)).toBe(true);
    expect(configValidators.length).toBeGreaterThan(0);
    for (const validator of configValidators) {
      expect(typeof validator).toBe("function");
    }
  });
});

describe("configValidators (cross-parameter validation, fail-fast, in order)", () => {
  describe("1. 'query'/'execute' require exactly one of 'sql'/'sql.file'", () => {
    it.each(["query", "execute"] as const)(
      "fails when operation is '%s' and neither 'sql' nor 'sql.file' is set",
      (operation) => {
        const config = buildConfig({ operation });
        expect(firstFailure(config)).toBe(
          "'query'/'execute' require exactly one of 'sql' or 'sql.file' to be set",
        );
      },
    );

    it.each(["query", "execute"] as const)(
      "fails when operation is '%s' and BOTH 'sql' and 'sql.file' are set",
      (operation) => {
        const config = buildConfig({
          operation,
          sql: "SELECT 1",
          "sql.file": "query.sql",
        });
        expect(firstFailure(config)).toBe(
          "'query'/'execute' require exactly one of 'sql' or 'sql.file' to be set",
        );
      },
    );

    it("passes when operation is 'query' and only 'sql' is set", () => {
      const config = buildConfig({ operation: "query", sql: "SELECT 1" });
      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when operation is 'execute' and only 'sql.file' is set", () => {
      const config = buildConfig({
        operation: "execute",
        "sql.file": "execute.sql",
      });
      expect(firstFailure(config)).toBeUndefined();
    });

    it("does not fire for 'load'/'migrate' even when 'sql'/'sql.file' are unset", () => {
      const config = buildConfig({
        operation: "load",
        table: "widgets",
        "input.file": "in.jsonl",
      });
      expect(firstFailure(config)).toBeUndefined();
    });

    it("silently ignores a 'sql' value supplied for 'load' (not an error)", () => {
      const config = buildConfig({
        operation: "load",
        sql: "SELECT 1",
        table: "widgets",
        "input.file": "in.jsonl",
      });
      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("2. 'load' requires 'table' and 'input.file' (derived — ADR-0055, two independent validators)", () => {
    it("fails when operation is 'load' and 'table' is unset", () => {
      const config = buildConfig({
        operation: "load",
        "input.file": "in.jsonl",
      });
      expect(firstFailure(config)).toBe(
        "'table' is required for operation(s): load",
      );
    });

    it("fails when operation is 'load' and 'input.file' is unset", () => {
      const config = buildConfig({ operation: "load", table: "widgets" });
      expect(firstFailure(config)).toBe(
        "'input.file' is required for operation(s): load",
      );
    });

    it("fails when operation is 'load' and both are unset, fail-fast reporting 'table' first (it is derived first)", () => {
      const config = buildConfig({ operation: "load" });
      expect(firstFailure(config)).toBe(
        "'table' is required for operation(s): load",
      );
    });

    it("passes when operation is 'load' and both 'table' and 'input.file' are set", () => {
      const config = buildConfig({
        operation: "load",
        table: "widgets",
        "input.file": "in.jsonl",
      });
      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("3. 'migrate' requires 'migrations.dir' (derived — ADR-0055)", () => {
    it("fails when operation is 'migrate' and 'migrations.dir' is unset", () => {
      const config = buildConfig({ operation: "migrate" });
      expect(firstFailure(config)).toBe(
        "'migrations.dir' is required for operation(s): migrate",
      );
    });

    it("passes when operation is 'migrate' and 'migrations.dir' is set", () => {
      const config = buildConfig({
        operation: "migrate",
        "migrations.dir": "migrations/",
      });
      expect(firstFailure(config)).toBeUndefined();
    });
  });

  describe("4. 'yesSensitive' requires 'yes'", () => {
    it("fails when 'yesSensitive' is true and 'yes' is unset", () => {
      const config = buildConfig({
        operation: "query",
        sql: "SELECT 1",
        yesSensitive: true,
      });
      expect(firstFailure(config)).toBe(
        "'yesSensitive' requires 'yes' to be set",
      );
    });

    it("passes when both 'yesSensitive' and 'yes' are set", () => {
      const config = buildConfig({
        operation: "query",
        sql: "SELECT 1",
        yes: true,
        yesSensitive: true,
      });
      expect(firstFailure(config)).toBeUndefined();
    });

    it("passes when 'yesSensitive' is unset regardless of 'yes'", () => {
      const config = buildConfig({ operation: "query", sql: "SELECT 1" });
      expect(firstFailure(config)).toBeUndefined();
    });
  });

  it("passes every validator for 'query' with only 'sql' set (vacuous pass on the derived validators; XOR still applies)", () => {
    const config = buildConfig({ operation: "query", sql: "SELECT 1" });
    expect(firstFailure(config)).toBeUndefined();
  });
});

describe("RDS_DATA_SQL_OPERATIONS", () => {
  it("is exported and equals ['query', 'load', 'execute', 'migrate'] in order — the single source of truth steps/resolve-settings.ts imports instead of a duplicate copy", () => {
    expect(RDS_DATA_SQL_OPERATIONS).toEqual([
      "query",
      "load",
      "execute",
      "migrate",
    ]);
  });
});

/**
 * Hand-authored (not re-derived from `src/config.ts`) so a src typo in
 * `requiredParameters` is actually caught rather than trivially agreeing
 * with itself. `query`/`execute` are deliberately `[]` — their real
 * constraint is the `sql` XOR `sql.file` rule, which `requiredParameters`
 * cannot express and which stays a hand-written validator (see
 * `configValidators` above).
 */
const REQUIRED_PARAMETERS_BY_OPERATION: Readonly<
  Record<string, readonly string[]>
> = {
  query: [],
  load: ["table", "input.file"],
  execute: [],
  migrate: ["migrations.dir"],
};

describe("'operation' parameter's declared operations (ADR-0055 introspection)", () => {
  it("getOperations() round-trips names, in order, non-blank descriptions, and requiredParameters", () => {
    const operations = paramNamed("operation").getOperations();

    expect(operations).toBeDefined();
    const names = (operations ?? []).map((operation) => operation.name);
    expect(names).toEqual(RDS_DATA_SQL_OPERATIONS);

    for (const operation of operations ?? []) {
      expect(operation.description.trim().length).toBeGreaterThan(0);
      expect(operation.requiredParameters ?? []).toEqual(
        REQUIRED_PARAMETERS_BY_OPERATION[operation.name],
      );
    }
  });

  it("returns a frozen projection — never the same reference twice, but always structurally equal", () => {
    const first = paramNamed("operation").getOperations();
    const second = paramNamed("operation").getOperations();

    expect(first).toEqual(second);
  });

  it("every requiredParameters entry names a declared configParameters entry (subset check)", () => {
    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    const operations = paramNamed("operation").getOperations() ?? [];

    for (const operation of operations) {
      for (const entry of operation.requiredParameters ?? []) {
        expect(declaredNames.has(entry)).toBe(true);
      }
    }
  });
});
