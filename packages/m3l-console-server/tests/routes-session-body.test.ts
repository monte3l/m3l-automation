/**
 * Tests for `src/http/routes/session-body.ts` — the three body-field
 * validators `http/routes/sessions.ts` and `http/routes/session-bindings.ts`
 * both import.
 *
 * The module became exported surface when X7d split it out as an import leaf,
 * but until now it was exercised only TRANSITIVELY through the two route
 * suites. That left one branch of its contract unpinned: `label` defaults to
 * `field`, and every binding-entry call site passes an explicit label, so the
 * route suites only ever drive the default for `readBindings`' own top-level
 * fields. This file pins both arms directly.
 *
 * Driving the functions rather than a route is the point — a label-defaulting
 * regression would surface here as a wrong message, where through a route it
 * would surface only in whichever route happened to rely on the default.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  readRequiredBoolean,
  readRequiredNonEmptyString,
  rejectBody,
} from "../src/http/routes/session-body.js";

/** Captures a thrown value without losing its type. */
function captureThrown(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("rejectBody", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST naming the field in both message and context", () => {
    const thrown = captureThrown(() => {
      rejectBody("reference", "is required");
    });

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect((thrown as M3LConsoleError).message).toBe(
      "invalid session request: 'reference' is required",
    );
    expect((thrown as M3LConsoleError).context).toMatchObject({
      field: "reference",
    });
  });

  // INVARIANT: the message names the FIELD, never the caller's value. These
  // read untrusted request bodies, and a message echoing one back would put
  // caller text in a response. Mutation-tested: interpolating the value into
  // the message fails here.
  test("never echoes a value, only the field name and the reason", () => {
    const thrown = captureThrown(() => {
      readRequiredNonEmptyString({ token: 42 }, "token");
    });

    expect((thrown as M3LConsoleError).message).not.toContain("42");
  });
});

describe("readRequiredNonEmptyString", () => {
  test("returns the value when present and non-empty", () => {
    expect(
      readRequiredNonEmptyString({ operation: "sqs-etl" }, "operation"),
    ).toBe("sqs-etl");
  });

  test.each([
    ["absent", {}, "is required"],
    ["not a string", { operation: 7 }, "must be a string"],
    ["empty", { operation: "" }, "must not be empty"],
  ])("rejects %s with its own reason", (_label, body, reason) => {
    const thrown = captureThrown(() =>
      readRequiredNonEmptyString(body, "operation"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toContain(reason);
  });

  // THE UNPINNED BRANCH. `label` defaults to `field`; every binding-entry
  // caller passes an explicit label, so the route suites only ever exercise
  // the default for top-level fields. Both arms are asserted here.
  test("defaults the reported label to the field name", () => {
    const thrown = captureThrown(() =>
      readRequiredNonEmptyString({}, "operation"),
    );

    expect((thrown as M3LConsoleError).message).toContain("'operation'");
    expect((thrown as M3LConsoleError).context).toMatchObject({
      field: "operation",
    });
  });

  test("reports an explicit label instead of the field name when given one", () => {
    const thrown = captureThrown(() =>
      readRequiredNonEmptyString({}, "reference", "bindings[0].reference"),
    );

    // The KEY looked up stays `reference`; only what the message names changes.
    expect((thrown as M3LConsoleError).message).toContain(
      "'bindings[0].reference'",
    );
    expect((thrown as M3LConsoleError).context).toMatchObject({
      field: "bindings[0].reference",
    });
  });

  // A key whose value is `undefined` is PRESENT — `Object.hasOwn`, not a
  // truthiness check — so it must fail as "must be a string", not "is
  // required". Mutation-tested: swapping `Object.hasOwn` for `in` keeps this
  // green, but swapping it for a `!== undefined` check flips the message.
  test("treats an explicitly-undefined key as present but wrongly typed", () => {
    const thrown = captureThrown(() =>
      readRequiredNonEmptyString({ operation: undefined }, "operation"),
    );

    expect((thrown as M3LConsoleError).message).toContain("must be a string");
  });
});

describe("readRequiredBoolean", () => {
  test.each([true, false])("returns %s verbatim", (value) => {
    expect(readRequiredBoolean({ dryRun: value }, "dryRun")).toBe(value);
  });

  // `false` is a legitimate value, not an absent one. Mutation-tested:
  // replacing the `Object.hasOwn`/`isBoolean` pair with a truthiness check
  // makes `{ dryRun: false }` fail as "is required".
  test("accepts false rather than treating it as missing", () => {
    expect(readRequiredBoolean({ dryRun: false }, "dryRun")).toBe(false);
  });

  test.each([
    ["absent", {}, "is required"],
    ["not a boolean", { dryRun: "yes" }, "must be a boolean"],
  ])("rejects %s with its own reason", (_label, body, reason) => {
    const thrown = captureThrown(() => readRequiredBoolean(body, "dryRun"));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).message).toContain(reason);
  });

  test("defaults the reported label to the field name", () => {
    const thrown = captureThrown(() => readRequiredBoolean({}, "dryRun"));

    expect((thrown as M3LConsoleError).message).toContain("'dryRun'");
  });

  test("reports an explicit label instead of the field name when given one", () => {
    const thrown = captureThrown(() =>
      readRequiredBoolean({}, "multiSelect", "bindings[2].multiSelect"),
    );

    expect((thrown as M3LConsoleError).message).toContain(
      "'bindings[2].multiSelect'",
    );
  });
});
