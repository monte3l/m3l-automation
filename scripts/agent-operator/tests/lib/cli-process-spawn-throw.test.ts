/**
 * Tests for `src/lib/cli-process.ts`'s **synchronous** spawn-failure arm —
 * the one path `cli-process.test.ts` does not reach.
 *
 * `runCliProcess`'s TSDoc states that "a spawn failure, a timeout, an abort,
 * and a byte-cap breach are each a `CliRunDisposition`, never a throw". The
 * asynchronous arm (`child.emit("error", …)`) already honours that. The
 * synchronous arm does not: `child_process.spawn` throws **inline** — never
 * emitting an `error` event — for an invalid argument such as a NUL byte in
 * a path (`ERR_INVALID_ARG_VALUE`), and `cliEntrypoint` reaches that call
 * unvalidated from operator config. The `spawn(...)` call sits outside both
 * the returned promise and any `try`, so today the throw escapes
 * `runCliProcess` as a rejection.
 *
 * Uses the exported `SpawnLike` injection seam (the same seam
 * `cli-process.test.ts` uses) rather than `vi.mock("node:child_process")` —
 * a fake spawner that throws is an exact stand-in for the real synchronous
 * failure, with no real process involved.
 */
import { describe, expect, test, vi } from "vitest";

import { runCliProcess } from "../../src/lib/cli-process.js";
import type { SpawnLike } from "../../src/lib/cli-process.js";

const baseOptions = {
  nodeExecPath: "/usr/bin/node",
  entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
  args: ["list", "--json"],
  cwd: "/repo",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
};

/**
 * The message shape Node uses for a synchronous `ERR_INVALID_ARG_VALUE`
 * spawn failure: it echoes the offending argument, i.e. the resolved
 * absolute entrypoint path. That text must never reach the caller.
 */
const SYNC_SPAWN_MESSAGE =
  "The argument 'file' must be a string without null bytes. Received '/repo/packages/m3l-cli/bin/m3l.mjs'";

/** A `SpawnLike` that throws synchronously instead of returning a child. */
function throwingSpawn(thrown: unknown): SpawnLike {
  return vi.fn<SpawnLike>(() => {
    throw thrown;
  });
}

/** A synchronous `ERR_INVALID_ARG_VALUE`, as Node's `spawn` throws it. */
function syncSpawnError(code: string = "ERR_INVALID_ARG_VALUE"): Error {
  return Object.assign(new Error(SYNC_SPAWN_MESSAGE), { code });
}

describe("runCliProcess — a synchronous spawn throw is a value, not a rejection", () => {
  test("resolves 'spawn-failed' when spawn throws ERR_INVALID_ARG_VALUE inline", async () => {
    const result = await runCliProcess({
      ...baseOptions,
      spawn: throwingSpawn(syncSpawnError()),
    });

    expect(result.disposition).toBe("spawn-failed");
    expect(result.failureCode).toBe("ERR_INVALID_ARG_VALUE");
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("does not reject — the returned promise settles as fulfilled", async () => {
    const settled = await Promise.allSettled([
      runCliProcess({
        ...baseOptions,
        spawn: throwingSpawn(syncSpawnError()),
      }),
    ]);

    expect(settled[0]?.status).toBe("fulfilled");
  });

  test("leaks no part of the thrown error's message — including the entrypoint path", async () => {
    const result = await runCliProcess({
      ...baseOptions,
      spawn: throwingSpawn(syncSpawnError()),
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SYNC_SPAWN_MESSAGE);
    expect(serialized).not.toContain("/repo/packages/m3l-cli/bin/m3l.mjs");
    expect(serialized).not.toContain("null bytes");
  });

  test.each([
    ["a lowercase code", "enoent"],
    ["a code starting with a digit", "1BAD"],
    ["a code containing a hyphen", "ERR-INVALID"],
    [
      "a code longer than 32 characters",
      "ERR_INVALID_ARG_VALUE_WITH_A_VERY_LONG_TAIL",
    ],
  ])(
    "drops %s from failureCode — the /^[A-Z][A-Z0-9_]{0,31}$/ filter still applies on the synchronous arm",
    async (_label, code) => {
      const result = await runCliProcess({
        ...baseOptions,
        spawn: throwingSpawn(syncSpawnError(code)),
      });

      expect(result.disposition).toBe("spawn-failed");
      expect(result.failureCode).toBeUndefined();
    },
  );

  test("resolves 'spawn-failed' with no failureCode when spawn throws a non-Error value", async () => {
    const result = await runCliProcess({
      ...baseOptions,
      spawn: throwingSpawn("boom"),
    });

    expect(result.disposition).toBe("spawn-failed");
    expect(result.failureCode).toBeUndefined();
  });
});
