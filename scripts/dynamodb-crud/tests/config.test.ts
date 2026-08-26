import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import * as configModule from "../src/config.js";
import { configParameters } from "../src/config.js";

// The mandatory config-declaration smoke test (ADR-0022 §8). Importing the
// schema is itself an assertion: M3LConfigParameter validates a declared
// defaultValue eagerly in its constructor, so a default that violates its own
// validator fails this file at import time.
describe("dynamodb-crud config declaration", () => {
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
});

/**
 * ADR-0055 — the `operation` parameter's declared operation set. Order
 * follows `DYNAMO_OPERATION_DECLARATIONS` in `src/config.ts` (config
 * declaration order), which differs from the run-start guard table's order
 * in `steps/run-dynamodb-crud.ts`.
 */
const DYNAMO_OPERATIONS = [
  "get",
  "put",
  "update",
  "delete",
  "query",
  "scan",
  "batch-write",
  "batch-delete",
  "export",
  "import",
] as const;

/**
 * Hand-authored per the task spec, NOT re-derived from
 * `DYNAMO_OPERATION_DECLARATIONS` — the point of this table is to catch a
 * `src/config.ts` typo, not to restate whatever `src` currently says.
 */
const DYNAMO_OPERATION_REQUIRED_PARAMETERS: Readonly<
  Record<(typeof DYNAMO_OPERATIONS)[number], readonly string[]>
> = {
  get: ["key", "output"],
  put: ["item"],
  update: ["key", "item"],
  delete: ["key"],
  query: ["key", "output"],
  scan: ["output"],
  "batch-write": ["input"],
  "batch-delete": ["input"],
  export: ["output"],
  import: ["input"],
};

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

describe("'operation' declared operations (getOperations() round-trip, ADR-0055)", () => {
  it("declares an operations list on the 'operation' parameter", () => {
    const operations = paramNamed("operation").getOperations();
    expect(operations).toBeDefined();
  });

  it("declares operation names, in order, matching the config declaration order", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    expect(operations.map((operation) => operation.name)).toEqual(
      DYNAMO_OPERATIONS,
    );
  });

  it("gives every operation a non-blank description", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      expect(operation.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("declares the documented requiredParameters for every operation (frozen projection — toEqual, not toBe)", () => {
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      expect(operation.requiredParameters).toEqual(
        DYNAMO_OPERATION_REQUIRED_PARAMETERS[
          operation.name as (typeof DYNAMO_OPERATIONS)[number]
        ],
      );
    }
  });

  it("names only declared config parameters in every operation's requiredParameters (subset check)", () => {
    const declaredNames = new Set(
      configParameters.map((parameter) => parameter.getName()),
    );
    const operations = paramNamed("operation").getOperations() ?? [];
    for (const operation of operations) {
      for (const requiredName of operation.requiredParameters ?? []) {
        expect(declaredNames.has(requiredName)).toBe(true);
      }
    }
  });

  it("rejects a value outside the declared operation set with M3LConfigValidationError", async () => {
    await expect(
      resolveWith(paramNamed("operation"), "frobnicate"),
    ).rejects.toBeInstanceOf(Core.M3LConfigValidationError);
  });
});

/**
 * ADR-0055's opt-in clause: declaring `requiredParameters` on an operation
 * is metadata for CLI introspection ONLY — it does not, by itself, derive
 * any enforcement. `dynamodb-crud` never opted in
 * (`Core.deriveOperationValidators` is not spread into a `configValidators`
 * export — this script doesn't have one at all), so presence enforcement
 * for e.g. `key`/`output` on `get` stays exactly where it was before this
 * retrofit: the run-start guard in `steps/run-dynamodb-crud.ts`
 * (`applyOperationGuards`/`REQUIRED_FIELDS`). This test pins that intent —
 * it is not documenting an oversight, and should keep passing unchanged
 * even as `DYNAMO_OPERATION_DECLARATIONS` grows new operations/fields.
 */
describe("ADR-0055 opt-in clause — requiredParameters is declarative metadata only", () => {
  it("does not export a configValidators member", () => {
    expect(Object.hasOwn(configModule, "configValidators")).toBe(false);
  });
});
