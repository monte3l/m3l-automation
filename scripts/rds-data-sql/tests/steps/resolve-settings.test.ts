import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  resolveRdsDataSqlSettings,
  type RdsDataSqlSettings,
} from "../../src/steps/resolve-settings.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `resolve-settings` row +
 * the "Configuration schema" table's identifier-pattern rule
 * (`^[A-Za-z_][A-Za-z0-9_]{0,62}$`, applying to `schema`/`table`/`columns`/
 * `migrations.table`). `cluster.arn`/`secret.arn` are documented as "passed
 * as `resourceArn`"/"passed as `secretArn`" to every `aws/rds-data` call, so
 * this file asserts `RdsDataSqlSettings` carries those exact field names
 * alongside `operation`/`database`/`schema`. `config.ts`'s declared schema
 * already enforces presence/non-emptiness of required parameters and each
 * identifier's own pattern at config-load time; this step defensively
 * re-validates identifiers (per the contract) since these tests build the
 * `M3LConfig` directly, bypassing `M3LConfigParameter` resolution — the same
 * pattern `scripts/athena-query/tests/steps/resolve-settings.test.ts` uses.
 */

const SETTINGS_CODE = "ERR_RDS_DATA_SQL_SETTINGS";

/** Builds a raw `M3LConfig` store directly, one `.set(name, value)` per key. */
function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

const VALID_QUERY_VALUES: Record<string, unknown> = {
  operation: "query",
  "cluster.arn": "arn:aws:rds:us-east-1:123456789012:cluster:my-cluster",
  "secret.arn":
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
  database: "mydb",
  schema: "public",
  sql: "SELECT 1",
};

/** Extracts the coded `Core.M3LError` thrown by `fn`, or fails the test. */
function captureThrown(fn: () => unknown): unknown {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

describe("resolveRdsDataSqlSettings", () => {
  it("narrows a valid 'query' config into a typed RdsDataSqlSettings", () => {
    const settings = resolveRdsDataSqlSettings(buildConfig(VALID_QUERY_VALUES));

    expect(settings.operation).toBe("query");
    expect(settings.resourceArn).toBe(
      "arn:aws:rds:us-east-1:123456789012:cluster:my-cluster",
    );
    expect(settings.secretArn).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
    );
    expect(settings.database).toBe("mydb");
    expect(settings.schema).toBe("public");
  });

  it("leaves 'schema' undefined when unset", () => {
    const { schema: _unused, ...withoutSchema } = VALID_QUERY_VALUES;
    const settings = resolveRdsDataSqlSettings(buildConfig(withoutSchema));

    expect(settings.schema).toBeUndefined();
  });

  it("throws Core.M3LError coded ERR_RDS_DATA_SQL_SETTINGS when 'database' resolves to a non-string value", () => {
    const config = buildConfig({ ...VALID_QUERY_VALUES, database: 123 });

    expect(() => resolveRdsDataSqlSettings(config)).toThrowError(Core.M3LError);
    const thrown = captureThrown(() => resolveRdsDataSqlSettings(config));
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(SETTINGS_CODE);
  });

  it("throws ERR_RDS_DATA_SQL_SETTINGS when 'cluster.arn' resolves to a non-string value", () => {
    const config = buildConfig({
      ...VALID_QUERY_VALUES,
      "cluster.arn": ["not", "a", "string"],
    });

    const thrown = captureThrown(() => resolveRdsDataSqlSettings(config));
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(SETTINGS_CODE);
  });

  describe("identifier-pattern rejection (^[A-Za-z_][A-Za-z0-9_]{0,62}$)", () => {
    it("rejects an invalid 'schema' value", () => {
      const config = buildConfig({
        ...VALID_QUERY_VALUES,
        schema: "bad-schema",
      });

      const thrown = captureThrown(() => resolveRdsDataSqlSettings(config));
      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(SETTINGS_CODE);
    });

    it("rejects an invalid 'table' value (operation: load)", () => {
      const config = buildConfig({
        operation: "load",
        "cluster.arn": VALID_QUERY_VALUES["cluster.arn"],
        "secret.arn": VALID_QUERY_VALUES["secret.arn"],
        database: "mydb",
        table: "1bad-table",
        "input.file": "in.jsonl",
      });

      const thrown = captureThrown(() => resolveRdsDataSqlSettings(config));
      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(SETTINGS_CODE);
    });

    it("rejects an invalid entry in 'columns' (operation: load)", () => {
      const config = buildConfig({
        operation: "load",
        "cluster.arn": VALID_QUERY_VALUES["cluster.arn"],
        "secret.arn": VALID_QUERY_VALUES["secret.arn"],
        database: "mydb",
        table: "widgets",
        "input.file": "in.jsonl",
        columns: ["good_name", "bad-name"],
      });

      const thrown = captureThrown(() => resolveRdsDataSqlSettings(config));
      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(SETTINGS_CODE);
    });

    it("rejects an invalid 'migrations.table' value (operation: migrate)", () => {
      const config = buildConfig({
        operation: "migrate",
        "cluster.arn": VALID_QUERY_VALUES["cluster.arn"],
        "secret.arn": VALID_QUERY_VALUES["secret.arn"],
        database: "mydb",
        "migrations.dir": "migrations/",
        "migrations.table": "bad table",
      });

      const thrown = captureThrown(() => resolveRdsDataSqlSettings(config));
      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(SETTINGS_CODE);
    });

    it("accepts a valid identifier (63 chars, the pattern's inclusive max)", () => {
      const maxLengthName = "a".repeat(63);
      const config = buildConfig({
        ...VALID_QUERY_VALUES,
        schema: maxLengthName,
      });

      expect(resolveRdsDataSqlSettings(config).schema).toBe(maxLengthName);
    });
  });

  it("has the documented RdsDataSqlSettings shape (type contract)", () => {
    expectTypeOf<RdsDataSqlSettings>().toExtend<{
      operation: "query" | "load" | "execute" | "migrate";
      resourceArn: string;
      secretArn: string;
      database: string;
      schema?: string;
    }>();
  });
});
