import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  M3LAgentOperatorCliError,
  type M3LAgentOperatorErrorCode,
} from "../../src/lib/errors.js";

/**
 * Contract: PR 1 spec `src/lib/errors.ts`. One class,
 * `M3LAgentOperatorCliError extends Core.M3LError`, taking `(message, code,
 * options?)` and calling `super(message, { code, ...options })`. Every
 * script-local failure pins its own `code` from the nine-member
 * `M3LAgentOperatorErrorCode` union rather than a dedicated subclass per code.
 */

const ALL_CODES: readonly M3LAgentOperatorErrorCode[] = [
  "ERR_AGENT_OPERATOR_CONFIG",
  "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT",
  "ERR_AGENT_OPERATOR_CLI_SPAWN",
  "ERR_AGENT_OPERATOR_CLI_OUTPUT",
  "ERR_AGENT_OPERATOR_SCRIPT_NAME",
  "ERR_AGENT_OPERATOR_POLICY",
  "ERR_AGENT_OPERATOR_DECISION_LOG",
  "ERR_AGENT_OPERATOR_ESCALATED",
  "ERR_AGENT_OPERATOR_BUDGET_STATE",
] as const;

describe("M3LAgentOperatorCliError", () => {
  it("is an instance of Core.M3LError", () => {
    const error = new M3LAgentOperatorCliError(
      "bad config",
      "ERR_AGENT_OPERATOR_CONFIG",
    );

    expect(error).toBeInstanceOf(Core.M3LError);
    expect(error).toBeInstanceOf(Error);
  });

  it.each(ALL_CODES.map((code) => [code] as const))(
    "pins the passed code %s onto .code",
    (code) => {
      const error = new M3LAgentOperatorCliError("message text", code);
      expect(error.code).toBe(code);
    },
  );

  it("preserves a cause when supplied via options", () => {
    const originalCause = new Error("root cause");
    const error = new M3LAgentOperatorCliError(
      "wrapping failure",
      "ERR_AGENT_OPERATOR_POLICY",
      { cause: originalCause },
    );

    expect(error.cause).toBe(originalCause);
  });

  it("has no cause when options is omitted", () => {
    const error = new M3LAgentOperatorCliError(
      "no cause here",
      "ERR_AGENT_OPERATOR_CLI_SPAWN",
    );

    expect(error.cause).toBeUndefined();
  });

  it("threads context through to the base M3LError", () => {
    const error = new M3LAgentOperatorCliError(
      "context carried",
      "ERR_AGENT_OPERATOR_CLI_OUTPUT",
      { context: { reason: "not-json" } },
    );

    expect(error.context).toEqual({ reason: "not-json" });
  });

  it("preserves the message verbatim", () => {
    const error = new M3LAgentOperatorCliError(
      "exact message text",
      "ERR_AGENT_OPERATOR_SCRIPT_NAME",
    );

    expect(error.message).toBe("exact message text");
  });

  it("is catchable and narrowable via instanceof at a call site", () => {
    let thrown: unknown;
    try {
      throw new M3LAgentOperatorCliError(
        "entrypoint missing",
        "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect(thrown).toBeInstanceOf(Core.M3LError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.code).toBe("ERR_AGENT_OPERATOR_CLI_ENTRYPOINT");
  });

  it("types the error code union to exactly the nine documented codes", () => {
    // `toEqualTypeOf` is bidirectional and exact on purpose: a tenth member
    // added to the union — or one of these nine removed — fails this pin.
    expectTypeOf<M3LAgentOperatorErrorCode>().toEqualTypeOf<
      | "ERR_AGENT_OPERATOR_CONFIG"
      | "ERR_AGENT_OPERATOR_CLI_ENTRYPOINT"
      | "ERR_AGENT_OPERATOR_CLI_SPAWN"
      | "ERR_AGENT_OPERATOR_CLI_OUTPUT"
      | "ERR_AGENT_OPERATOR_SCRIPT_NAME"
      | "ERR_AGENT_OPERATOR_POLICY"
      | "ERR_AGENT_OPERATOR_DECISION_LOG"
      | "ERR_AGENT_OPERATOR_ESCALATED"
      | "ERR_AGENT_OPERATOR_BUDGET_STATE"
    >();
  });

  it("constructor's first parameter is a string message", () => {
    type FirstParam = ConstructorParameters<typeof M3LAgentOperatorCliError>[0];
    expectTypeOf<FirstParam>().toEqualTypeOf<string>();
  });

  it("constructor's second parameter is the M3LAgentOperatorErrorCode union", () => {
    type SecondParam = ConstructorParameters<
      typeof M3LAgentOperatorCliError
    >[1];
    expectTypeOf<SecondParam>().toEqualTypeOf<M3LAgentOperatorErrorCode>();
  });
});

/**
 * The exit code every `ERR_AGENT_OPERATOR_*` failure must actually produce,
 * per code. Verified against the real `Core.mapErrorToExitCode`, never
 * described.
 *
 * Before the origin table existed, EVERY code here produced `1`
 * (`UNCLASSIFIED`): `mapErrorToExitCode` resolves from a structural `origin`
 * field first and a `core/errors/catalog.ts` lookup by `code` second, and
 * this family set no `origin` and appears in no catalog (grep:
 * `ERR_AGENT_OPERATOR` has zero hits there). Both lookups missed, so a
 * scheduler could not tell a bad policy file from an unreachable `m3l` CLI.
 * Deleting the table's default reverts every row below to `1`.
 */
const EXIT_CODE_BY_CODE: ReadonlyArray<
  readonly [code: M3LAgentOperatorErrorCode, exit: number]
> = [
  // The operator's own input is wrong, or their policy declined the run.
  ["ERR_AGENT_OPERATOR_CONFIG", 2],
  ["ERR_AGENT_OPERATOR_CLI_ENTRYPOINT", 2],
  ["ERR_AGENT_OPERATOR_SCRIPT_NAME", 2],
  ["ERR_AGENT_OPERATOR_POLICY", 2],
  // The policy worked exactly as written and declined — a caller fault, not
  // an external one.
  ["ERR_AGENT_OPERATOR_ESCALATED", 2],
  // Something outside this process failed: a spawned child, the decision-log
  // directory, the cross-run counter file.
  ["ERR_AGENT_OPERATOR_CLI_SPAWN", 3],
  ["ERR_AGENT_OPERATOR_CLI_OUTPUT", 3],
  ["ERR_AGENT_OPERATOR_DECISION_LOG", 3],
  ["ERR_AGENT_OPERATOR_BUDGET_STATE", 3],
];

describe("M3LAgentOperatorCliError — fault origin drives the exit code", () => {
  it.each(EXIT_CODE_BY_CODE)("%s exits %i", (code, exit) => {
    const error = new M3LAgentOperatorCliError("message text", code);

    expect(Core.mapErrorToExitCode(error)).toBe(exit);
  });

  it("covers every declared code, so a tenth cannot be added without a mapping", () => {
    // The table above is a hand-written list; this pins it against the union
    // the class actually accepts. `ALL_CODES` is itself type-checked as
    // `readonly M3LAgentOperatorErrorCode[]`, and the bidirectional
    // `expectTypeOf` above pins that union to exactly nine members.
    expect(EXIT_CODE_BY_CODE.map(([code]) => code).sort()).toEqual(
      [...ALL_CODES].sort(),
    );
  });

  it("never maps to LIBRARY (4): this script cannot assert a defect in m3l-common", () => {
    for (const [code] of EXIT_CODE_BY_CODE) {
      expect(
        Core.mapErrorToExitCode(new M3LAgentOperatorCliError("m", code)),
      ).not.toBe(4);
    }
  });

  it("lets an explicit options.origin win over the table's default", () => {
    // The table only supplies a default; a call site with better information
    // must still be able to override it.
    const error = new M3LAgentOperatorCliError(
      "message text",
      "ERR_AGENT_OPERATOR_CONFIG",
      { origin: "external" },
    );

    expect(error.origin).toBe("external");
    expect(Core.mapErrorToExitCode(error)).toBe(3);
  });

  it("no longer collapses every failure onto UNCLASSIFIED", () => {
    // The regression this table exists to prevent, stated as a set: the nine
    // codes must produce more than one distinct exit code.
    const codes = new Set(
      EXIT_CODE_BY_CODE.map(([code]) =>
        Core.mapErrorToExitCode(new M3LAgentOperatorCliError("m", code)),
      ),
    );

    expect(codes.size).toBeGreaterThan(1);
    expect(codes.has(1)).toBe(false);
  });
});
