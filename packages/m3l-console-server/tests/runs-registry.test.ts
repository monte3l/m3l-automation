/**
 * Tests for src/runs/registry.ts — `M3LRunRegistry` (m3l-console-server X4
 * slice 6 round 1). This port carries no implementation of its own: it is
 * the narrow surface `runs/orchestrator.ts` depends on, declared separately
 * from `M3LConsoleRunsRepository` so `runs/` never gets `countByStatus`,
 * `close()`, or `transaction()` by accident. There is therefore no runtime
 * behavior to exercise here — the whole contract is type-level, and a
 * type-only test file is correct for it (see `.claude/rules/tests.md`).
 * `M3LConsoleRunsRepository`'s conformance to `M3LRunRegistry` is the
 * compiler-checked proof the module's own TSDoc promises; this file is that
 * proof made explicit and enforced.
 */
import { describe, expectTypeOf, test } from "vitest";

import type { M3LRunRegistry } from "../src/runs/registry.js";
import type {
  M3LConsoleRunsRepository,
  M3LRunFinish,
  M3LRunInsert,
  M3LRunListQuery,
  M3LRunRecord,
} from "../src/store/runs-repository.js";

describe("M3LRunRegistry — conformance", () => {
  test("M3LConsoleRunsRepository structurally satisfies the narrow registry port", () => {
    expectTypeOf<M3LConsoleRunsRepository>().toExtend<M3LRunRegistry>();
  });
});

describe("M3LRunRegistry — declared shape", () => {
  test("declares exactly the narrow surface the orchestrator depends on, not the wider repository", () => {
    expectTypeOf<M3LRunRegistry>().toEqualTypeOf<{
      insertQueued(input: M3LRunInsert): void;
      claimForStart(id: string, startedAtMs: number): boolean;
      finish(id: string, result: M3LRunFinish): boolean;
      get(id: string): M3LRunRecord | undefined;
      list(query: M3LRunListQuery): readonly M3LRunRecord[];
      countRunningForScript(script: string): number;
      reconcileOrphaned(endedAtMs: number): number;
      abandonQueued(id: string, endedAtMs: number): boolean;
    }>();
  });
});
