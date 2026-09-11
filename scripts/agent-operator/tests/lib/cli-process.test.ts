/**
 * Tests for `src/lib/cli-process.ts` — the process-plumbing layer. Exercises
 * every `CliRunDisposition` via the `spawn` injection seam `runCliProcess`
 * accepts (never a real child process, and no `vi.mock("node:child_process")`
 * — the seam is preferred per the PR 1 contract when it covers the case, and
 * it covers every case here).
 */
import { EventEmitter, getEventListeners } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runCliProcess } from "../../src/lib/cli-process.js";
import type {
  CliRunResult,
  ProcessKillLike,
  SpawnLike,
} from "../../src/lib/cli-process.js";

/**
 * The subset of a real `ChildProcess` this fake needs to satisfy the
 * `spawn` injection seam: an `EventEmitter` (for `error`/`close`/`exit`)
 * plus `stdout`/`stderr` sub-emitters (for `data`) and a `kill` spy. This
 * shape is structurally assignable to `cli-process.ts`'s exported
 * `CliChildProcess` (an `EventEmitter`'s general `on(event, listener)`
 * satisfies that interface's narrower `"error"`/`"close"` overloads), which
 * is what lets `createFakeSpawn` return it from a properly `SpawnLike`-typed
 * `vi.fn`.
 */
interface FakeChildProcess extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
  /**
   * Mirrors `ChildProcess.pid`'s own OPTIONAL declaration, so a child built
   * with no argument has no `pid` own property at all — which is the exact
   * shape the group-teardown pid guard has to refuse.
   */
  readonly pid?: number | undefined;
}

function createFakeChild(pid?: number): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
    // Conditional so `createFakeChild()` leaves `pid` genuinely ABSENT
    // rather than present-but-`undefined`.
    ...(pid === undefined ? {} : { pid }),
  });
  return child;
}

/** One recorded invocation of the fake `spawn` function. */
interface RecordedSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

function createFakeSpawn(child: FakeChildProcess): {
  readonly spawn: SpawnLike;
  readonly calls: RecordedSpawnCall[];
} {
  const calls: RecordedSpawnCall[] = [];
  const spawn = vi.fn<SpawnLike>((command, args, options) => {
    calls.push({ command, args, options });
    return child;
  });
  return { spawn, calls };
}

const baseOptions = {
  nodeExecPath: "/usr/bin/node",
  entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
  args: ["list", "--json"],
  cwd: "/repo",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runCliProcess — exit dispositions", () => {
  test.each([[0], [1], [17]])(
    "resolves 'exited' with the child's exit code (%i)",
    async (exitCode) => {
      const child = createFakeChild();
      const { spawn } = createFakeSpawn(child);
      const resultPromise = runCliProcess({ ...baseOptions, spawn });

      child.emit("close", exitCode, null);

      const result = await resultPromise;
      expect(result.disposition).toBe("exited");
      expect(result.exitCode).toBe(exitCode);
    },
  );

  test("resolves 'signalled' when the child exits via a signal (code null, signal set)", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", null, "SIGKILL");

    const result = await resultPromise;
    expect(result.disposition).toBe("signalled");
    expect(result.exitCode).toBeNull();
  });
});

describe("runCliProcess — spawn failure (a value, not a throw)", () => {
  test("an ENOENT spawn error resolves 'spawn-failed' with failureCode 'ENOENT', and the resolved message text is not leaked anywhere", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    // A real Node ENOENT spawn error embeds the resolved absolute path.
    const enoentMessage = "spawn /repo/packages/m3l-cli/bin/m3l.mjs ENOENT";
    const error = Object.assign(new Error(enoentMessage), { code: "ENOENT" });
    child.emit("error", error);

    const result = await resultPromise;
    expect(result.disposition).toBe("spawn-failed");
    expect(result.failureCode).toBe("ENOENT");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(enoentMessage);
    expect(serialized).not.toContain("/repo/packages/m3l-cli/bin/m3l.mjs");
  });

  test.each([["weird message"], [42]])(
    "a non-conforming error.code (%p) leaves failureCode undefined",
    async (code) => {
      const child = createFakeChild();
      const { spawn } = createFakeSpawn(child);
      const resultPromise = runCliProcess({ ...baseOptions, spawn });

      const error = Object.assign(new Error("boom"), { code });
      child.emit("error", error);

      const result = await resultPromise;
      expect(result.disposition).toBe("spawn-failed");
      expect(result.failureCode).toBeUndefined();
    },
  );

  test("an 'error' event followed by a 'close' event settles once, from the first event (the settled guard)", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));
    // Arrives after the promise has already settled — without a `settled`
    // guard this would overwrite the outcome to a clean exit.
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.disposition).toBe("spawn-failed");
    expect(result.exitCode).toBeNull();
  });

  test("a 'close' event followed by an 'error' event settles once, from the first event (the settled guard)", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", 0, null);
    child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));

    const result = await resultPromise;
    expect(result.disposition).toBe("exited");
    expect(result.exitCode).toBe(0);
  });
});

describe("runCliProcess — stdio collection", () => {
  test("listens on 'close', not 'exit': stdout data emitted between 'exit' and 'close' is still collected", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    // `exit` can fire before the stdio streams have flushed.
    child.emit("exit", 0, null);
    child.stdout.emit("data", Buffer.from("late-flushed-output", "utf8"));
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.stdout).toContain("late-flushed-output");
  });

  test("reassembles a UTF-8 sequence split across chunk boundaries without a replacement character", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    // A 4-byte UTF-8 sequence (an emoji), split mid-sequence across two chunks.
    const emoji = Buffer.from("\u{1F600}", "utf8");
    expect(emoji.length).toBe(4);
    child.stdout.emit("data", emoji.subarray(0, 2));
    child.stdout.emit("data", emoji.subarray(2, 4));
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.stdout).toContain("\u{1F600}");
    expect(result.stdout).not.toContain("�");
  });
});

describe("runCliProcess — output-truncated (byte cap)", () => {
  test("breaches the byte cap on a multi-byte payload whose character count is under the cap, killing the child with SIGTERM", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    // "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit — 6 of them is 12 bytes
    // (over the 10-byte cap) yet only 6 JS-string characters (under it). A
    // character-count implementation would never trip; a byte-count one must.
    const payload = Buffer.from("é".repeat(6), "utf8");
    expect(payload.length).toBeGreaterThan(maxOutputBytes);
    child.stdout.emit("data", payload);

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("breaches the byte cap on stderr too (counted per stream)", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    child.stderr.emit("data", Buffer.from("é".repeat(6), "utf8"));

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("runCliProcess — timeout", () => {
  test("resolves 'timed-out' when timeoutMs elapses before the child settles", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const result = await resultPromise;
    expect(result.disposition).toBe("timed-out");
  });

  test("does not time out when the child settles before timeoutMs elapses", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      timeoutMs: 5_000,
    });

    child.emit("close", 0, null);
    const result = await resultPromise;
    // Advancing past the timeout after settlement must not change the outcome.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(result.disposition).toBe("exited");
    expect(result.exitCode).toBe(0);
  });
});

describe("runCliProcess — abort", () => {
  test("resolves 'aborted' (never throws) when the AbortSignal fires mid-run", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      signal: controller.signal,
    });

    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      disposition: "aborted",
    });
  });

  test("removes the abort listener once the promise settles via a non-abort path", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      signal: controller.signal,
    });

    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // Aborting after settlement must be a pure no-op: no re-settlement, no
    // mutation of the already-returned result.
    controller.abort();
    await Promise.resolve();
    expect(result.disposition).toBe("exited");
  });
});

describe("runCliProcess — killing the child on settle (M3a)", () => {
  test("kills the child with SIGTERM when the timeout elapses (a timed-out child must not be left running)", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const result = await resultPromise;
    expect(result.disposition).toBe("timed-out");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // Optional pin (not one of the two named defects, but explicitly worth
  // covering per the review): a child that ignores the initial SIGTERM must
  // eventually be escalated to SIGKILL. Uses fake timers so the test never
  // actually waits; 60s past the timeout is a generous stand-in for "any
  // reasonable grace period" since no such option exists in the contract.
  test("escalates to SIGKILL when the child ignores the SIGTERM sent on timeout", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;
    expect(result.disposition).toBe("timed-out");
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    // The fake child never emits "close" — it ignores SIGTERM entirely.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("does not kill an already-exited child on the 'exited' disposition", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(result.disposition).toBe("exited");
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("does not kill an already-exited child on the 'signalled' disposition", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    // The child already died via its own signal (e.g. sent by something
    // else entirely) before we ever observed it — it needs no kill from us.
    child.emit("close", null, "SIGKILL");
    const result = await resultPromise;

    expect(result.disposition).toBe("signalled");
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("does not attempt to kill a child that never started, on 'spawn-failed'", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));
    const result = await resultPromise;

    expect(result.disposition).toBe("spawn-failed");
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("kills the child with SIGTERM when the AbortSignal fires (pinning the existing abort-path kill)", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      signal: controller.signal,
    });

    controller.abort();
    const result = await resultPromise;

    expect(result.disposition).toBe("aborted");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // Bonus finding surfaced while pinning M3a, not one of the two named
  // defects: today `attachStdio`'s `onBreach` calls `child.kill()`
  // unconditionally before settling, so two breaches arriving in the same
  // synchronous tick (one per stream) each call `kill` — an already-dead
  // (from our own first kill) child gets killed a second time. If the fix
  // routes every kill through a settled-aware guard (as the timeout/abort
  // fix above would need to, to satisfy the two tests just above), this
  // comes along for free; asserting it here catches a regression either way.
  test("does not kill the child a second time when stdout and stderr both breach the byte cap in the same tick", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    // Both streams breach the cap before either "data" handler yields back
    // to the event loop.
    child.stdout.emit("data", Buffer.from("é".repeat(6), "utf8"));
    child.stderr.emit("data", Buffer.from("é".repeat(6), "utf8"));

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("runCliProcess — stdio listener cleanup after settle (M3b)", () => {
  test("stops accumulating stdout/stderr and detaches the 'data' listeners once settled via output-truncated", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    child.stdout.emit("data", Buffer.from("é".repeat(6), "utf8"));

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");

    // Detachment mechanism: assert the fake stream's own "data" listener
    // count drops to zero, rather than spying on removeListener/off — this
    // holds regardless of which of the two equivalent EventEmitter APIs the
    // fix uses, and (unlike "the result is unchanged" alone) cannot pass
    // merely because the already-resolved promise captured its value before
    // any post-settle "data" event arrived.
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);

    const stdoutAtSettle = result.stdout;
    const stderrAtSettle = result.stderr;

    // More data after settlement must not reach the already-resolved result.
    child.stdout.emit("data", Buffer.from("more-stdout", "utf8"));
    child.stderr.emit("data", Buffer.from("more-stderr", "utf8"));

    expect(result.stdout).toBe(stdoutAtSettle);
    expect(result.stderr).toBe(stderrAtSettle);
  });

  test("stops accumulating stdout/stderr and detaches the 'data' listeners once settled via a normal exit", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.stdout.emit("data", Buffer.from("first-chunk", "utf8"));
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.disposition).toBe("exited");
    expect(result.stdout).toContain("first-chunk");

    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);

    const stdoutAtSettle = result.stdout;

    child.stdout.emit("data", Buffer.from("late-and-unwanted", "utf8"));
    expect(result.stdout).toBe(stdoutAtSettle);
  });
});

describe("runCliProcess — pre-aborted signal (already-aborted before invocation)", () => {
  // Contract pinned (security-review defect): `attachAbort`
  // (src/lib/cli-process.ts:317-329) only calls
  // `signal.addEventListener("abort", onAbort)`. `addEventListener` never
  // fires retroactively for a signal that is *already* aborted at
  // registration time — that is documented `AbortSignal` behaviour, not a
  // bug in `EventTarget`. So today, passing an already-aborted signal into
  // `runCliProcess` still spawns a child and rides out the full `timeoutMs`
  // before resolving `"timed-out"`, instead of settling `"aborted"`
  // immediately. The fix must check `signal.aborted` up front — before
  // spawning anything — and settle `"aborted"` with no timer involved.
  test("settles 'aborted' immediately on an already-aborted signal, without ever reaching the timeout", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    controller.abort();

    let settled = false;
    let result: CliRunResult | undefined;
    void runCliProcess({
      ...baseOptions,
      spawn,
      timeoutMs: 5_000,
      signal: controller.signal,
    }).then((settledResult) => {
      settled = true;
      result = settledResult;
    });

    // Flush only queued microtasks / zero-delay timers — deliberately never
    // advance anywhere near `timeoutMs`. A correct fix needs no timer tick at
    // all to observe an already-aborted signal; the current bug needs the
    // full 5_000ms to elapse before this ever settles (as `"timed-out"`).
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(result?.disposition).toBe("aborted");
  });

  // Contract pinned: not spawning at all is strictly better than
  // spawning-then-killing — no process creation, no AWS-profile/env
  // inheritance into a doomed child, no kill-signal race. The follow-up
  // Bedrock tool-loop slice needs exactly this: its `AbortSignal` outlives a
  // single tool call, so every remaining loop iteration after an abort must
  // skip spawning entirely, not spawn-and-immediately-kill on each one.
  test("never invokes the injected spawn seam when the signal is already aborted", () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    controller.abort();

    void runCliProcess({ ...baseOptions, spawn, signal: controller.signal });

    expect(spawn).not.toHaveBeenCalled();
  });

  test("leaves no 'abort' listener registered on the signal once settled via the pre-aborted early-exit path", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    controller.abort();

    let settled = false;
    let result: CliRunResult | undefined;
    void runCliProcess({
      ...baseOptions,
      spawn,
      signal: controller.signal,
    }).then((settledResult) => {
      settled = true;
      result = settledResult;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(result?.disposition).toBe("aborted");
    // Holds regardless of which strategy the fix uses — skipping
    // `addEventListener` entirely (aborted state already known) or
    // adding-then-immediately-removing it: either way, zero "abort"
    // listeners must remain on the signal. A long-lived agent-loop
    // `AbortSignal` that outlives many `runCliProcess` calls must never
    // accumulate one per pre-aborted call.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("runCliProcess — spawn invocation shape", () => {
  test("spawns process.execPath-equivalent command with [entrypoint, ...args], shell: false, and stdio ['ignore','pipe','pipe']", async () => {
    const child = createFakeChild();
    const { spawn, calls } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", 0, null);
    await resultPromise;

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe(baseOptions.nodeExecPath);
    expect(call?.args).toEqual([baseOptions.entrypoint, ...baseOptions.args]);
    expect(call?.options).toMatchObject({
      cwd: baseOptions.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

// ---------------------------------------------------------------------------
// V13 — process-group teardown. `flowRun` is the one surface method that
// opts in, so these tests drive `runCliProcess` directly with
// `teardown: "group"`.
//
// EVERY group-mode test MUST inject `kill`. A `teardown: "group"` run that
// reaches the real `process.kill(-pid, …)` would signal the Vitest worker's
// own process group — that hazard is why the seam exists, so the group
// harness below always attaches it (and an injected `exitEmitter`, so the
// reaper never registers on the real `process`).
// ---------------------------------------------------------------------------

/** One recorded process-level kill: the raw pid argument, exactly as passed. */
interface RecordedKill {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
}

/**
 * A group-teardown harness: a fake child with `pid`, a recording `spawn`, a
 * recording (optionally throwing) `kill`, and a fake exit emitter. The
 * `options` bag it returns always carries the two seams, so no test can
 * forget one.
 */
function createGroupHarness(
  pid: number | undefined,
  killImpl?: (pid: number, signal: NodeJS.Signals) => void,
): {
  readonly child: FakeChildProcess;
  readonly spawnCalls: RecordedSpawnCall[];
  readonly killCalls: RecordedKill[];
  readonly emitter: EventEmitter;
  readonly options: Parameters<typeof runCliProcess>[0];
} {
  const child = createFakeChild(pid);
  const { spawn, calls } = createFakeSpawn(child);
  const killCalls: RecordedKill[] = [];
  const emitter = new EventEmitter();
  const kill = vi.fn<ProcessKillLike>((target, signal) => {
    killCalls.push({ pid: target, signal });
    killImpl?.(target, signal);
  });
  return {
    child,
    spawnCalls: calls,
    killCalls,
    emitter,
    options: {
      ...baseOptions,
      spawn,
      teardown: "group",
      kill,
      exitEmitter: emitter,
    },
  };
}

/** Builds an errno-bearing throw shaped like a real `process.kill` failure. */
function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("runCliProcess — group teardown: the spawn shape", () => {
  test("teardown: 'group' spawns detached, alongside the unchanged cwd/shell/stdio", async () => {
    const harness = createGroupHarness(4242);
    const resultPromise = runCliProcess(harness.options);

    harness.child.emit("close", 0, null);
    await resultPromise;

    const call = harness.spawnCalls[0];
    expect(call).toBeDefined();
    expect(call?.options).toMatchObject({
      cwd: baseOptions.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  });

  // `toMatchObject` cannot prove a key's ABSENCE, and `detached === false`
  // would pass against a spawn that explicitly opts out — a different fact.
  // The contract is that the six non-opted-in methods spawn byte-for-byte as
  // before, i.e. with no `detached` own property at all.
  test.each([
    ["omitted", {}],
    ["explicit 'child'", { teardown: "child" as const }],
  ])(
    "teardown %s leaves NO 'detached' key on the spawn options object",
    async (_label, teardownOption) => {
      const child = createFakeChild(4242);
      const { spawn, calls } = createFakeSpawn(child);
      const resultPromise = runCliProcess({
        ...baseOptions,
        spawn,
        ...teardownOption,
      });

      child.emit("close", 0, null);
      await resultPromise;

      const call = calls[0];
      expect(call).toBeDefined();
      expect(Object.hasOwn(call?.options ?? {}, "detached")).toBe(false);
    },
  );
});

describe("runCliProcess — group teardown: signalling the group", () => {
  test("a timed-out group run signals the NEGATED pid, escalating to SIGKILL, and never touches child.kill", async () => {
    vi.useFakeTimers();
    const harness = createGroupHarness(4242);
    const resultPromise = runCliProcess({
      ...harness.options,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.disposition).toBe("timed-out");
    expect(harness.killCalls).toEqual([{ pid: -4242, signal: "SIGTERM" }]);

    // The fake child ignores the SIGTERM entirely — exactly what `m3l`'s
    // survival scope does — so the grace period must escalate.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.killCalls).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    // The positive assertions above are only half the contract: a group kill
    // that ALSO signalled the direct child would double-signal `m3l`.
    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  test("a timed-out CHILD-scope run still uses child.kill and never the process-level kill", async () => {
    vi.useFakeTimers();
    const child = createFakeChild(4242);
    const { spawn } = createFakeSpawn(child);
    const kill = vi.fn<ProcessKillLike>();
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      kill,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.disposition).toBe("timed-out");
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(kill).not.toHaveBeenCalled();
  });

  test.each([
    ["aborted", "aborted"],
    ["output-truncated", "output-truncated"],
  ])(
    "the '%s' settle path shares the same group sender",
    async (_label, expected) => {
      const harness = createGroupHarness(4242);
      const controller = new AbortController();
      const resultPromise = runCliProcess({
        ...harness.options,
        maxOutputBytes: 4,
        signal: controller.signal,
      });

      if (expected === "aborted") {
        controller.abort();
      } else {
        harness.child.stdout.emit("data", Buffer.from("0123456789"));
      }
      const result = await resultPromise;

      expect(result.disposition).toBe(expected);
      expect(harness.killCalls).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    },
  );

  test("a 'close' inside the grace window cancels the escalation in group mode too", async () => {
    vi.useFakeTimers();
    const harness = createGroupHarness(4242);
    const resultPromise = runCliProcess({
      ...harness.options,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;
    expect(result.disposition).toBe("timed-out");
    expect(harness.killCalls).toHaveLength(1);

    // The group drained from the SIGTERM: a second signal would be aimed at
    // a pgid the OS may already have reused.
    harness.child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.killCalls).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  test.each<[string, "exited" | "signalled" | "spawn-failed"]>([
    ["exited", "exited"],
    ["signalled", "signalled"],
    ["spawn-failed", "spawn-failed"],
  ])(
    "never signals the group on the '%s' disposition — the group is already gone or never existed",
    async (_label, disposition) => {
      const harness = createGroupHarness(4242);
      const resultPromise = runCliProcess(harness.options);

      if (disposition === "exited") {
        harness.child.emit("close", 0, null);
      } else if (disposition === "signalled") {
        harness.child.emit("close", null, "SIGKILL");
      } else {
        harness.child.emit("error", errnoError("ENOENT", "spawn ENOENT"));
      }
      const result = await resultPromise;

      expect(result.disposition).toBe(disposition);
      expect(harness.killCalls).toEqual([]);
      expect(harness.child.kill).not.toHaveBeenCalled();
    },
  );
});

describe("runCliProcess — group teardown: the pid guard", () => {
  // `process.kill(-0, sig)` IS `process.kill(0, sig)` — "every process in the
  // caller's own group", i.e. agent-operator (or the Vitest worker) signalling
  // itself. `-NaN` and a fractional pid are a coin flip. Each row asserts the
  // fallback POSITIVELY as well, so "the process kill was never called" cannot
  // pass because nothing happened at all.
  test.each<[string, number | undefined]>([
    ["absent", undefined],
    ["0", 0],
    ["negative", -5],
    ["fractional", 3.7],
    ["NaN", Number.NaN],
  ])(
    "a %s pid falls back to child.kill and never reaches the process-level kill",
    async (_label, pid) => {
      vi.useFakeTimers();
      const harness = createGroupHarness(pid);
      const resultPromise = runCliProcess({
        ...harness.options,
        timeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result.disposition).toBe("timed-out");
      expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(harness.killCalls).toEqual([]);
    },
  );

  // The guard runs at TWO call sites — the settle-path signal and the exit
  // reaper's registration — so a guard added to only one of them still leaks
  // a `kill(-0, "SIGKILL")` at process exit.
  test.each<[string, number | undefined]>([
    ["absent", undefined],
    ["0", 0],
    ["negative", -5],
    ["fractional", 3.7],
    ["NaN", Number.NaN],
  ])(
    "a %s pid is never registered with the exit reaper either",
    async (_label, pid) => {
      const harness = createGroupHarness(pid);
      const resultPromise = runCliProcess(harness.options);

      harness.emitter.emit("exit");
      harness.child.emit("close", 0, null);
      await resultPromise;

      expect(harness.killCalls).toEqual([]);
    },
  );
});

describe("runCliProcess — group teardown: errno handling", () => {
  test("an ESRCH from the group kill is silent — the group draining before the signal is a benign race", async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const harness = createGroupHarness(4242, () => {
      throw errnoError("ESRCH", "kill ESRCH");
    });
    const resultPromise = runCliProcess({
      ...harness.options,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.disposition).toBe("timed-out");
    expect(stderr).not.toHaveBeenCalled();
  });

  test("an EPERM from the group kill is reported by errno code only — never the pid, the path, or the raw message", async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const rawMessage = `kill /repo/packages/m3l-cli/bin/m3l.mjs EPERM`;
    const harness = createGroupHarness(4242, () => {
      throw errnoError("EPERM", rawMessage);
    });
    const resultPromise = runCliProcess({
      ...harness.options,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    // The promise still resolves with its original disposition: a teardown
    // fault must never become a throw or a changed outcome.
    expect(result.disposition).toBe("timed-out");
    expect(stderr).toHaveBeenCalledTimes(1);
    const written = String(stderr.mock.calls[0]?.[0] ?? "");
    expect(written).toContain("EPERM");
    expect(written).toContain("SIGTERM");
    expect(written).not.toContain(rawMessage);
    expect(written).not.toContain(baseOptions.entrypoint);
    expect(written).not.toContain("4242");
  });

  test("a code-less throw from the group kill is still reported, as UNKNOWN", async () => {
    vi.useFakeTimers();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const harness = createGroupHarness(4242, () => {
      throw new Error("no code here");
    });
    const resultPromise = runCliProcess({
      ...harness.options,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.disposition).toBe("timed-out");
    expect(String(stderr.mock.calls[0]?.[0] ?? "")).toContain("UNKNOWN");
    expect(String(stderr.mock.calls[0]?.[0] ?? "")).not.toContain(
      "no code here",
    );
  });

  test("a throw on the ESCALATED kill, 5s after the promise resolved, never becomes an uncaught exception", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const harness = createGroupHarness(4242, () => {
      throw errnoError("EPERM", "kill EPERM");
    });
    const resultPromise = runCliProcess({
      ...harness.options,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await resultPromise;

    // If the SIGKILL send sat outside the try, this advance would throw out
    // of the timer callback and fail the run, not just this test. The paired
    // length assertion is what proves the escalation actually happened.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.killCalls).toHaveLength(2);
  });
});

describe("runCliProcess — group teardown: the exit reaper", () => {
  test("a live detached group at process 'exit' is group-SIGKILLed", async () => {
    const harness = createGroupHarness(4242);
    const resultPromise = runCliProcess(harness.options);

    // The operator is going away with the group still live — a double-Ctrl-C
    // (whose second signal is a JS `process.exit()`), an uncaught throw, or a
    // normal exit with a straggler.
    harness.emitter.emit("exit");

    expect(harness.killCalls).toEqual([{ pid: -4242, signal: "SIGKILL" }]);

    harness.child.emit("close", 0, null);
    await resultPromise;
  });

  // Sibling of the test above, and vacuous without it: "kills nothing" passes
  // trivially against a reaper that never fires at all.
  test("a group whose child already closed is NOT signalled at 'exit' — the pid is reusable by then", async () => {
    const harness = createGroupHarness(4242);
    const resultPromise = runCliProcess(harness.options);

    harness.child.emit("close", 0, null);
    await resultPromise;
    harness.emitter.emit("exit");

    expect(harness.killCalls).toEqual([]);
  });

  test("the 'exit' listener is registered once per emitter, not once per spawn", async () => {
    const emitter = new EventEmitter();
    for (const pid of [4242, 4243, 4244]) {
      const child = createFakeChild(pid);
      const { spawn } = createFakeSpawn(child);
      const resultPromise = runCliProcess({
        ...baseOptions,
        spawn,
        teardown: "group",
        kill: vi.fn<ProcessKillLike>(),
        exitEmitter: emitter,
      });
      child.emit("close", 0, null);
      await resultPromise;
    }

    expect(emitter.listenerCount("exit")).toBe(1);
  });

  test("a child-scope run registers no exit listener at all", async () => {
    const emitter = new EventEmitter();
    const child = createFakeChild(4242);
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      exitEmitter: emitter,
    });

    child.emit("close", 0, null);
    await resultPromise;

    expect(emitter.listenerCount("exit")).toBe(0);
  });
});
