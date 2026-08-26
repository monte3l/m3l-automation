import { describe, test, expect } from "vitest";
import { createPageCursorGuard } from "../src/internal/aws/pagination.js";
import { M3LNoProgressError } from "../src/internal/polling/errors.js";

/**
 * TDD seam for A5b (issue #506): bound the three unbounded pagination
 * generators (`aws/dynamodb`'s `queryItems`/`scanSegment`, `aws/s3`'s
 * `listObjects`) against a repeated continuation token/`LastEvaluatedKey`.
 *
 * `createPageCursorGuard` is a NOT-YET-IMPLEMENTED internal helper —
 * `internal/aws/pagination.ts` does not exist yet, so every test in this
 * file is RED (module-not-found) until `implementing-submodules` lands it.
 * `internal/` modules are still directly testable via relative import even
 * though they are not exposed through the public barrel — see
 * `tests/polling.test.ts`'s direct imports from `internal/polling/*` for the
 * sibling pattern this composes with (`internal/polling/progress.ts`'s
 * `ProgressTracker`).
 */
describe("internal/aws/pagination", () => {
  test("a first defined cursor establishes a baseline and does not throw", () => {
    const guard = createPageCursorGuard();

    expect(() => {
      guard.check("token-1");
    }).not.toThrow();
  });

  test("a cursor that changes on every call never throws, across many calls", () => {
    const guard = createPageCursorGuard();

    expect(() => {
      guard.check("token-1");
      guard.check("token-2");
      guard.check("token-3");
      guard.check("token-4");
      guard.check("token-5");
      guard.check("token-6");
    }).not.toThrow();
  });

  test("the same string cursor twice in a row throws M3LNoProgressError with code ERR_NO_PROGRESS", () => {
    const guard = createPageCursorGuard();
    guard.check("stuck-token");

    let thrown: unknown;
    try {
      guard.check("stuck-token");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LNoProgressError);
    expect((thrown as M3LNoProgressError).code).toBe("ERR_NO_PROGRESS");
  });

  test("the same object cursor (identical key/value pairs, same insertion order) twice in a row throws", () => {
    const guard = createPageCursorGuard();
    guard.check({ userId: "42", seq: 1 });

    expect(() => {
      guard.check({ userId: "42", seq: 1 });
    }).toThrow(M3LNoProgressError);
  });

  test("the same object cursor with different key insertion order still throws (normalization)", () => {
    const guard = createPageCursorGuard();
    guard.check({ a: 1, b: 2 });

    expect(() => {
      guard.check({ b: 2, a: 1 });
    }).toThrow(M3LNoProgressError);
  });

  test("a different object cursor (a changed value) does not throw", () => {
    const guard = createPageCursorGuard();
    guard.check({ userId: "42", seq: 1 });

    expect(() => {
      guard.check({ userId: "42", seq: 2 });
    }).not.toThrow();
  });

  test("a defined-then-undefined sequence (loop ending normally) never throws, regardless of history", () => {
    const guard = createPageCursorGuard();
    guard.check("token-1");
    guard.check("token-2");

    expect(() => {
      guard.check(undefined);
    }).not.toThrow();
  });

  test("an undefined cursor on the very first call never throws", () => {
    const guard = createPageCursorGuard();

    expect(() => {
      guard.check(undefined);
    }).not.toThrow();
  });

  test("an object cursor holding a bigint value does not throw a serialization error, and repeat-detection still fires when the bigint is held constant", () => {
    const guard = createPageCursorGuard();
    guard.check({ shardId: 7n, seq: "a" });

    let thrown: unknown;
    try {
      guard.check({ shardId: 7n, seq: "a" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LNoProgressError);
  });

  test("an object cursor holding a bigint value that changes across calls does not throw", () => {
    const guard = createPageCursorGuard();
    guard.check({ shardId: 7n, seq: "a" });

    expect(() => {
      guard.check({ shardId: 8n, seq: "a" });
    }).not.toThrow();
  });

  test("an object cursor holding a Uint8Array value does not throw, and repeat-detection fires when it is held constant", () => {
    const guard = createPageCursorGuard();
    const binaryKey = { partition: new Uint8Array([1, 2, 3]) };
    guard.check(binaryKey);

    let thrown: unknown;
    try {
      guard.check({ partition: new Uint8Array([1, 2, 3]) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LNoProgressError);
  });

  test("an object cursor holding a Uint8Array value that changes across calls does not throw", () => {
    const guard = createPageCursorGuard();
    guard.check({ partition: new Uint8Array([1, 2, 3]) });

    expect(() => {
      guard.check({ partition: new Uint8Array([4, 5, 6]) });
    }).not.toThrow();
  });

  test("the thrown M3LNoProgressError's context carries numeric attempts and stalledAttempts fields", () => {
    const guard = createPageCursorGuard();
    guard.check("token-1");
    guard.check("token-2");

    let thrown: unknown;
    try {
      guard.check("token-2");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LNoProgressError);
    const context = (thrown as M3LNoProgressError).context;
    expect(typeof context["attempts"]).toBe("number");
    expect(typeof context["stalledAttempts"]).toBe("number");
    expect(context["stalledAttempts"]).toBe(1);
  });

  test("a fresh guard instance tracks state independently from another instance", () => {
    const guardA = createPageCursorGuard();
    const guardB = createPageCursorGuard();
    guardA.check("shared-token");

    expect(() => {
      guardB.check("shared-token");
    }).not.toThrow();
  });
});
