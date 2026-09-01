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
