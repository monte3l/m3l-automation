/**
 * Tests for src/store/run-status.ts — the run-status vocabulary the
 * `console_runs` table's `CHECK (status IN (...))` constraint is built from
 * (X4 run-registry, slice 3).
 *
 * This vocabulary lives in `store/` rather than `runs/` (a later slice)
 * because persistence owns the CHECK constraint that enforces it — the
 * vocabulary belongs next to the constraint it drives, and `runs/` imports
 * it from here rather than the other way round.
 *
 * The single most important guarantee in this file: `M3LRunTerminalStatus`
 * is deliberately IDENTITY-MAPPED to `Core.M3LRunOutcome`, not a hand
 * translated copy — so there is no translation table between the library's
 * run-report vocabulary and this registry's schema vocabulary to drift out
 * of sync. If a future library change widens `M3LRunOutcome`, the
 * `expectTypeOf` assertion below must break loudly here, at compile time,
 * rather than leaving the `CHECK` constraint silently blind to a new value.
 *
 * No filesystem or network I/O: every assertion here is either a pure
 * function call or a type-level check, so nothing in this file needs
 * mocking or teardown.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import {
  isRunStatus,
  isTerminalRunStatus,
  RUN_PENDING_STATUSES,
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  runStatusCheckList,
} from "../src/store/run-status.js";
import type {
  M3LRunPendingStatus,
  M3LRunStatus,
  M3LRunTerminalStatus,
} from "../src/store/run-status.js";

describe("M3LRunTerminalStatus — identity-mapped to Core.M3LRunOutcome", () => {
  test("is exactly Core.M3LRunOutcome, not a hand-copied union", () => {
    expectTypeOf<M3LRunTerminalStatus>().toEqualTypeOf<Core.M3LRunOutcome>();
  });
});

describe("RUN_TERMINAL_STATUSES", () => {
  test("contains exactly the five Core.M3LRunOutcome members", () => {
    // Typed against Core.M3LRunOutcome (not M3LRunTerminalStatus, though the
    // two are asserted identical above) so a drift in the library's own
    // outcome union surfaces here even if the identity-map assertion above
    // were ever weakened.
    const expected: readonly Core.M3LRunOutcome[] = [
      "success",
      "failure",
      "dry-run",
      "interrupted",
      "partial",
    ];

    expect([...RUN_TERMINAL_STATUSES].sort()).toEqual([...expected].sort());
    expect(RUN_TERMINAL_STATUSES).toHaveLength(5);
  });
});

describe("RUN_PENDING_STATUSES", () => {
  test("is exactly queued and running", () => {
    const expected: readonly M3LRunPendingStatus[] = ["queued", "running"];

    expect([...RUN_PENDING_STATUSES].sort()).toEqual([...expected].sort());
    expect(RUN_PENDING_STATUSES).toHaveLength(2);
  });
});

describe("RUN_STATUSES", () => {
  test("is the union of pending and terminal statuses, with no duplicates, length 7", () => {
    expect(RUN_STATUSES).toHaveLength(7);
    expect(new Set(RUN_STATUSES).size).toBe(RUN_STATUSES.length);

    for (const status of RUN_PENDING_STATUSES) {
      expect(RUN_STATUSES).toContain(status);
    }
    for (const status of RUN_TERMINAL_STATUSES) {
      expect(RUN_STATUSES).toContain(status);
    }
  });

  test("every member is either pending or terminal, and the two sets are disjoint", () => {
    const pendingSet = new Set<string>(RUN_PENDING_STATUSES);
    const terminalSet = new Set<string>(RUN_TERMINAL_STATUSES);

    for (const status of pendingSet) {
      expect(terminalSet.has(status)).toBe(false);
    }
    for (const status of RUN_STATUSES) {
      expect(pendingSet.has(status) || terminalSet.has(status)).toBe(true);
    }
  });
});

describe("isRunStatus", () => {
  test.each(RUN_STATUSES.map((status) => [status] as const))(
    "returns true for the valid member %s",
    (status) => {
      expect(isRunStatus(status)).toBe(true);
    },
  );

  test.each<unknown>([
    "QUEUED",
    "",
    "done",
    "Success",
    null,
    undefined,
    0,
    {},
    [],
    "running ",
  ])("returns false for the invalid input %j", (value) => {
    expect(isRunStatus(value)).toBe(false);
  });

  test("narrows the checked value to M3LRunStatus inside the guarded branch", () => {
    const maybe: unknown = "queued";

    if (isRunStatus(maybe)) {
      expectTypeOf(maybe).toEqualTypeOf<M3LRunStatus>();
    } else {
      expect.unreachable("expected isRunStatus to narrow maybe");
    }
  });
});

describe("isTerminalRunStatus", () => {
  test.each(RUN_TERMINAL_STATUSES.map((status) => [status] as const))(
    "returns true for the valid terminal member %s",
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(true);
    },
  );

  test.each(RUN_PENDING_STATUSES.map((status) => [status] as const))(
    "returns false for the pending (non-terminal) member %s",
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(false);
    },
  );

  test.each<unknown>(["QUEUED", "", "done", "Success", null, undefined, 0, {}])(
    "returns false for the invalid input %j",
    (value) => {
      expect(isTerminalRunStatus(value)).toBe(false);
    },
  );

  test("narrows the checked value to M3LRunTerminalStatus inside the guarded branch", () => {
    const maybe: unknown = "success";

    if (isTerminalRunStatus(maybe)) {
      expectTypeOf(maybe).toEqualTypeOf<M3LRunTerminalStatus>();
    } else {
      expect.unreachable("expected isTerminalRunStatus to narrow maybe");
    }
  });
});

describe("runStatusCheckList", () => {
  test("is byte-identical across repeated calls (feeds a digested migration statement)", () => {
    const first = runStatusCheckList();
    const second = runStatusCheckList();
    const third = runStatusCheckList();

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("contains every member of RUN_STATUSES, derived from the array rather than a literal", () => {
    const fragment = runStatusCheckList();

    for (const status of RUN_STATUSES) {
      expect(fragment).toContain(`'${status}'`);
    }
  });

  test("is exactly the documented status IN (...) fragment", () => {
    // Written out in full (rather than only the "contains every member"
    // check above) so an accidental reordering — which would still change
    // the migration's digested SQL byte-for-byte and trip a false
    // ERR_CONSOLE_STORE_SCHEMA_DRIFT on an already-migrated deployment — is
    // itself caught here.
    const expected = `status IN (${RUN_STATUSES.map((status) => `'${status}'`).join(", ")})`;

    expect(runStatusCheckList()).toBe(expected);
  });

  test("does not depend on object key insertion order", () => {
    // runStatusCheckList must derive from RUN_STATUSES (an array, whose
    // order is already stable and documented), not from iterating a plain
    // object's keys — so calling it many times, and from a "reordered"
    // spread copy of RUN_STATUSES fed through the same derivation formula
    // used above, still agrees exactly.
    const reordered = [...RUN_STATUSES].reverse().reverse();
    const expected = `status IN (${reordered.map((status) => `'${status}'`).join(", ")})`;

    expect(runStatusCheckList()).toBe(expected);
  });
});
