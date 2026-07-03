/**
 * Direct unit tests for the internal `M3LAWSProvisioningError` class.
 *
 * The class is private to `core/script` (never re-exported through a public
 * barrel); consumers narrow on `instanceof M3LError` and
 * `code === "ERR_AWS_PROVISIONING"` — see
 * `tests/script-aws-provisioning-failure.test.ts` for that integration path.
 *
 * This file closes a branch-coverage gap: the constructor's conditional
 * `cause` spread (`...(options.cause !== undefined ? { cause: options.cause }
 * : {})`) is only exercised on the WITH-cause arm via the wrapped-failure
 * test above. These tests construct the class directly to cover BOTH arms —
 * no mocking needed, so a plain top-level import (not a `vi.doMock` +
 * `vi.resetModules()` dance) is sufficient.
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import { M3LAWSProvisioningError } from "../src/internal/script/M3LAWSProvisioningError.js";
import { M3LError } from "../src/core/errors/index.js";

describe("M3LAWSProvisioningError", () => {
  test("constructed without options has no cause and the expected code/message", () => {
    const error = new M3LAWSProvisioningError("boom");

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_AWS_PROVISIONING");
    expect(error.message).toBe("boom");
    expect(error.cause).toBeUndefined();
  });

  test("constructed with a cause chains it verbatim, alongside the expected code", () => {
    const sentinel = new Error("original failure");

    const error = new M3LAWSProvisioningError("boom", { cause: sentinel });

    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_AWS_PROVISIONING");
    expect(error.cause).toBe(sentinel);
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_AWS_PROVISIONING'", () => {
      expectTypeOf<
        M3LAWSProvisioningError["code"]
      >().toEqualTypeOf<"ERR_AWS_PROVISIONING">();
    });
  });
});
