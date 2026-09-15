/**
 * Tests for `src/cli/process.ts` — the bounded-subprocess port (V10c, file
 * 2 of the contract). Deliberately narrower than
 * `scripts/agent-operator/src/lib/cli-process.ts` (no process-group
 * teardown, no SIGKILL escalation, no exit reaper) — those arrive in a
 * later slice, so tests here only pin what THIS module's contract actually
 * promises.
 *
 * Every test drives the injected `spawn` seam (`SpawnLike`) with a fake
 * child built from `node:events` `EventEmitter`s. No real child process is
 * ever spawned — a real spawn would be slow, and the timeout/abort/kill
 * paths would otherwise signal the Vitest worker itself.
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type {
  CliRunDisposition,
  CliRunResult,
  CliSpawnOptions,
  RunCliProcessOptions,
  SpawnLike,
} from "../src/cli/process.js";
import { runCliProcess } from "../src/cli/process.js";

/**
 * The structural shape `process.ts`'s module-private `CliChildProcess`
 * needs: an event source for `"error"`/`"close"`, `stdout`/`stderr`
 * sub-emitters for `"data"`, and a `kill` spy. Built on `EventEmitter`
 * rather than a hand-rolled plain object so `.emit(...)` in each test reads
 * naturally — the fake is still never a real `ChildProcess`.
 */
interface FakeChildProcess extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
}

function createFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
  });
  return child;
}

/** One recorded invocation of the fake `spawn` seam. */
interface RecordedSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CliSpawnOptions;
}

function createFakeSpawn(child: FakeChildProcess): {
  readonly spawn: SpawnLike;
  readonly calls: RecordedSpawnCall[];
} {
  const calls: RecordedSpawnCall[] = [];
  const spawn = vi.fn<SpawnLike>(
    (command: string, args: readonly string[], options: CliSpawnOptions) => {
      calls.push({ command, args, options });
      return child;
    },
  );
  return { spawn, calls };
}

const baseOptions = {
  nodeExecPath: "/usr/bin/node",
  entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
  args: ["list", "--json"],
  cwd: "/repo/packages/m3l-cli/bin",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
} satisfies Omit<RunCliProcessOptions, "signal" | "spawn">;

afterEach(() => {
  // The only mocked collaborators in this file are per-test vi.fn()/vi.spyOn
  // instances created fresh inside each test (createFakeChild /
  // createFakeSpawn, and the one `removeEventListener` spy below) — there is
  // no top-level vi.mock(...) factory whose call history could leak across
  // tests, so restoreAllMocks + useRealTimers is sufficient teardown here.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runCliProcess — spawn invocation shape", () => {
  test("spawns nodeExecPath with argv exactly [entrypoint, ...args]", async () => {
    const child = createFakeChild();
    const { spawn, calls } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", 0, null);
    await resultPromise;

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.command).toBe(baseOptions.nodeExecPath);
    expect(call?.args).toEqual([baseOptions.entrypoint, ...baseOptions.args]);
  });

  test("never uses a shell, and forwards cwd", async () => {
    const child = createFakeChild();
    const { spawn, calls } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", 0, null);
    await resultPromise;

    const options = calls[0]?.options;
    expect(options).toBeDefined();
    // `CliSpawnOptions` types `shell` as the literal `false` and has no
    // `timeout` field at all — `defaultSpawn` cannot pass spawn's own
    // `timeout` option (which would race this module's own timer and
    // double-kill) because the type makes it inexpressible, not merely
    // untested. Pin that at the type level rather than re-deriving it with
    // a runtime `not.toHaveProperty`, which chai falls back to an `in`
    // check for and would pass vacuously via the prototype chain.
    expectTypeOf<CliSpawnOptions>().toEqualTypeOf<{
      readonly cwd: string;
      readonly shell: false;
    }>();
    expect(options?.shell).toBe(false);
    expect(options?.cwd).toBe(baseOptions.cwd);
  });
});

describe("runCliProcess — 'exited' and 'signalled'", () => {
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

  test("resolves 'signalled' when the child exits via a signal it was not killed by", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("close", null, "SIGKILL");

    const result = await resultPromise;
    expect(result.disposition).toBe("signalled");
    expect(result.exitCode).toBeNull();
    // Nobody on our side called kill() in this scenario.
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("runCliProcess — 'spawn-failed' (a value, never a throw)", () => {
  test("an ENOENT spawn error resolves failureCode 'ENOENT' and leaks no absolute path anywhere in the result", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    // A real Node ENOENT spawn error embeds the resolved absolute path —
    // here a deliberately host-identifying fake path, distinct from any
    // path this test file itself uses, so a leak cannot be missed.
    const leakedPath = "/home/someone/secret/path/node";
    const enoentMessage = `spawn ${leakedPath} ENOENT`;
    const error = Object.assign(new Error(enoentMessage), { code: "ENOENT" });
    child.emit("error", error);

    const result = await resultPromise;
    expect(result.disposition).toBe("spawn-failed");
    expect(result.failureCode).toBe("ENOENT");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/home/someone");
    expect(serialized).not.toContain(enoentMessage);
    expect(result.stdout).not.toContain("/home/someone");
    expect(result.stderr).not.toContain("/home/someone");
  });

  test.each([
    ["lowercase code", "enoent"],
    ["numeric code", 42],
    ["code over 32 chars", "E".repeat(33)],
    ["code with a disallowed character", "ERR-BAD"],
    ["missing code entirely", undefined],
  ])(
    "a non-conforming error.code (%s) leaves failureCode undefined",
    async (_label, code) => {
      const child = createFakeChild();
      const { spawn } = createFakeSpawn(child);
      const resultPromise = runCliProcess({ ...baseOptions, spawn });

      const error =
        code === undefined
          ? new Error("boom")
          : Object.assign(new Error("boom"), { code });
      child.emit("error", error);

      const result = await resultPromise;
      expect(result.disposition).toBe("spawn-failed");
      expect(result.failureCode).toBeUndefined();
    },
  );

  test("a well-formed uppercase code (e.g. 'EACCES') is propagated as failureCode", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("error", Object.assign(new Error("boom"), { code: "EACCES" }));

    const result = await resultPromise;
    expect(result.failureCode).toBe("EACCES");
  });

  test("settles once from the first event: an 'error' followed by a 'close' is not overwritten", async () => {
    // NOTE on what actually guarantees this: `attachChildLifecycle`'s
    // detach function removes the "close" listener on the very first
    // settle, so by the time this test's `close` fires below, `onClose`
    // has already been detached and never runs at all. This scenario is
    // therefore proven by listener detachment, not by the `settled` flag
    // inside `settle()` — deleting that flag would not flip this test red.
    // The one scenario where the flag itself is load-bearing is covered by
    // the "close followed by a still-attached 'error'" test below, because
    // the child's own "error" listener is deliberately never detached.
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.disposition).toBe("spawn-failed");
  });

  test("cleanup runs only once even when a still-attached listener reaches settle() a second time: a 'close' followed by the child's own 'error' does not double-detach", async () => {
    // `attachChildLifecycle` deliberately never detaches the child's own
    // "error" listener (a delayed OS-level error must not crash this
    // long-lived server) — unlike "close"/"data", it is still attached
    // after the first settle, so the `error` emitted below genuinely
    // re-enters `settle()` a second time. That makes this the one place in
    // this suite where `if (settled) return` is actually load-bearing: a
    // resolved Promise's value is already idempotent regardless of that
    // guard (so asserting `result.disposition` alone here would pass even
    // with the guard deleted — see the previous test's comment), but a
    // second, un-guarded call to `settle()` would re-run `cleanup()`, which
    // calls `removeEventListener("abort", ...)` a second time. Spying on
    // that call count is what actually falsifies a deleted guard.
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
    expect(result.disposition).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));
    await Promise.resolve();

    // The resolved value staying "exited" here is NOT proof of the guard —
    // `resolve()` is idempotent on its own. The call count is the proof.
    expect(result.disposition).toBe("exited");
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  test("a synchronous throw from spawnFn itself resolves 'spawn-failed' and leaks no absolute path anywhere in the result", async () => {
    // Node's real `spawn` throws SYNCHRONOUSLY (ERR_INVALID_ARG_VALUE) for a
    // NUL-bearing/empty argv entry, with the offending value embedded in the
    // message — this must never escape `runCliProcess`'s never-throws
    // contract, and the message must never reach the result.
    const leakedPath = "/home/someone/secret/path/m3l.mjs\x00";
    const throwingSpawn: SpawnLike = vi.fn(() => {
      throw Object.assign(
        new TypeError(
          `The argument 'args[0]' must be a string without null bytes. Received '${leakedPath}'`,
        ),
        { code: "ERR_INVALID_ARG_VALUE" },
      );
    });

    const result = await runCliProcess({
      ...baseOptions,
      spawn: throwingSpawn,
    });

    expect(result.disposition).toBe("spawn-failed");
    expect(result.failureCode).toBe("ERR_INVALID_ARG_VALUE");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/home/someone");
    expect(serialized).not.toContain("secret");
  });
});

describe("runCliProcess — 'stream-failed' (a broken output stream)", () => {
  test("an 'error' on stdout kills the child, resolves 'stream-failed', and leaks no absolute path", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    const leakedPath = "/home/someone/secret/named-pipe";
    const error = Object.assign(new Error(`EPIPE ${leakedPath}`), {
      code: "EPIPE",
    });
    child.stdout.emit("error", error);

    const result = await resultPromise;
    expect(result.disposition).toBe("stream-failed");
    expect(result.failureCode).toBe("EPIPE");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/home/someone");
  });

  test("an 'error' on stderr also resolves 'stream-failed'", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.stderr.emit(
      "error",
      Object.assign(new Error("boom"), { code: "EIO" }),
    );

    const result = await resultPromise;
    expect(result.disposition).toBe("stream-failed");
    expect(result.failureCode).toBe("EIO");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("a non-conforming code on a stream error leaves failureCode undefined", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    child.stdout.emit("error", new Error("boom without a code"));

    const result = await resultPromise;
    expect(result.disposition).toBe("stream-failed");
    expect(result.failureCode).toBeUndefined();
  });

  test("does not crash the process: an unhandled stream 'error' would otherwise be a Node uncaught exception", async () => {
    // EventEmitter throws synchronously if an "error" event has no
    // listener. This assertion is really about attachOutputCapture having
    // registered a listener at all — if it hadn't, `child.stdout.emit`
    // itself would throw here and fail this test.
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    expect(() => {
      child.stdout.emit("error", new Error("boom"));
    }).not.toThrow();

    await resultPromise;
  });
});

describe("runCliProcess — stdio decoding", () => {
  test("reassembles a multi-byte UTF-8 character split across two chunks without a replacement character", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({ ...baseOptions, spawn });

    // "€" is the 3-byte UTF-8 sequence 0xE2 0x82 0xAC, split mid-sequence.
    const euro = Buffer.from("€", "utf8");
    expect(euro.length).toBe(3);
    child.stdout.emit("data", euro.subarray(0, 1));
    child.stdout.emit("data", euro.subarray(1, 3));
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.stdout).toContain("€");
    expect(result.stdout).not.toContain("�");
  });
});

describe("runCliProcess — 'output-truncated' (per-stream byte cap)", () => {
  test("breaches the cap on stdout: kills the child, resolves 'output-truncated', and keeps bytes accumulated before the breach", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    // First chunk stays under the cap; the second chunk tips it over. This
    // proves the pre-breach bytes are genuinely kept, not merely that some
    // output happens to be non-empty.
    child.stdout.emit("data", Buffer.from("hi", "utf8"));
    child.stdout.emit("data", Buffer.from("é".repeat(6), "utf8"));

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(result.stdout).toContain("hi");
    // The confirmed defect (re-review of `createStreamAccumulator`):
    // `bytes > maxBytes` was checked only AFTER `text += decoder.write(chunk)`
    // had already appended the WHOLE breaching chunk, so all six "é"
    // characters (12 bytes) were retained even though only 8 more bytes fit
    // under the 10-byte cap. The fixed contract bounds retention to the
    // cap: "hi" (2 bytes) leaves exactly 8 bytes of remaining budget, which
    // is exactly 4 complete "é" characters (2 bytes each) — a clean cut, no
    // partial multi-byte sequence — so the retained text is deterministic.
    expect(result.stdout).toBe(`hi${"é".repeat(4)}`);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(maxOutputBytes);
    expect(result.stdout).not.toContain("é".repeat(6));
    // This module has no escalation ladder (SIGKILL arrives with slice
    // V10e's core/process promotion) — SIGTERM is the signal that lets the
    // child flush and clean up, so every kill path pins it explicitly.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("a single chunk far larger than the cap is bounded to the cap, not retained in full", async () => {
    // The confirmed defect, isolated to a SINGLE breaching chunk (no
    // pre-breach bytes at all): the real bug report drove `runCliProcess`
    // with `maxOutputBytes: 10` and one 50 MB "data" chunk, and the settled
    // `result.stdout` came back as the full 52,428,800 bytes. Here the
    // buffer is scaled down to 1 MiB against a 16-byte cap — still a
    // ~65,536x (order of 10^4.8) overshoot of the cap, enough to prove the
    // cap bounds the BREACHING chunk itself rather than merely cross-chunk
    // growth after a breach, while staying cheap in wall-clock/memory here.
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 16;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    // A single ASCII byte repeated so every input byte maps 1:1 to one
    // decoded character — no multi-byte decoding ambiguity muddies the
    // byte-count assertion below. Allocated once, never copied.
    const hugeChunk = Buffer.alloc(1_048_576, "a");
    child.stdout.emit("data", hugeChunk);

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(result.stdout).toBe("a".repeat(maxOutputBytes));
    expect(result.stdout.length).toBe(maxOutputBytes);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test("a chunk that breaches the cap mid-multibyte-character flushes the cut sequence as U+FFFD (StringDecoder.end()'s own contract)", async () => {
    // "é" is the 2-byte UTF-8 sequence 0xC3 0xA9. Three of them is 6 bytes;
    // slicing the ingest at a 5-byte cap lands ON the lead byte of the
    // third character (0xC3), with its continuation byte (0xA9) excluded
    // from the retained budget. `StringDecoder` buffers that lone lead byte
    // internally rather than emitting it, and `decoder.end()` — already
    // called from `finalize()` for every disposition — flushes an
    // unterminated sequence as exactly one U+FFFD replacement character.
    // That is Node's own documented `StringDecoder` contract, not a choice
    // this module makes, so pinning the EXACT resulting string here (rather
    // than asserting a length or a "does not contain �" negative) is
    // what tells the implementer the one deterministic answer to build
    // toward instead of leaving "truncate mid-character" underspecified.
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 5;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    const three = Buffer.from("é".repeat(3), "utf8");
    expect(three.length).toBe(6);
    child.stdout.emit("data", three);

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(result.stdout).toBe(`${"é".repeat(2)}�`);
  });

  test("breaches the cap on stderr too (counted per stream, independent of stdout)", async () => {
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
    // Same SIGTERM-only rationale as the stdout-breach case above.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("a chunk fed after the breach settles does not grow the resolved output or re-issue kill", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    child.stdout.emit("data", Buffer.from("hi", "utf8"));
    child.stdout.emit("data", Buffer.from("é".repeat(6), "utf8"));
    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(child.kill).toHaveBeenCalledTimes(1);

    // A child that ignores SIGTERM keeps firing "data" — cleanup on settle
    // must have detached the listener entirely, so none of this reaches the
    // accumulator or re-triggers a kill.
    child.stdout.emit("data", Buffer.from("x".repeat(64), "utf8"));
    child.stdout.emit("data", Buffer.from("y".repeat(64), "utf8"));

    expect(result.stdout).toBe((await resultPromise).stdout);
    expect(result.stdout).not.toContain("x");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test("an 'output-truncated' settle is not overwritten by a 'close' that arrives later", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const maxOutputBytes = 10;
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      maxOutputBytes,
    });

    child.stdout.emit("data", Buffer.from("é".repeat(6), "utf8"));
    // The killed child eventually reports a clean exit. In practice this is
    // guaranteed by listener detachment, not the `settled` flag itself: the
    // breach's own `settle()` call already detaches the "close" listener as
    // part of cleanup, so by the time `close` is emitted below there is no
    // `onClose` left to run at all. (The flag's own load-bearing case — a
    // second event via a listener that is deliberately never detached — is
    // covered by the spawn-failed group's "close followed by a
    // still-attached 'error'" test.)
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.disposition).toBe("output-truncated");
    expect(result.exitCode).toBeNull();
  });
});

describe("runCliProcess — timeout", () => {
  test("resolves 'timed-out' and kills the child when timeoutMs elapses before the child settles", async () => {
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
    // This module has no escalation ladder (SIGKILL arrives with slice
    // V10e's core/process promotion) — SIGTERM is the signal that lets the
    // child flush and clean up, so every kill path pins it explicitly.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("settles exactly once: a normal 'close' arriving AFTER the timeout kill must not overwrite 'timed-out'", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const resultPromise = runCliProcess({
      ...baseOptions,
      spawn,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    // The killed child finally reports a clean exit. As with the
    // output-truncated case above, this specific ordering is actually
    // guaranteed by listener detachment (the timeout's own `settle()` call
    // detaches "close" as part of cleanup, so `onClose` never runs here at
    // all) rather than by the `settled` flag — the flag's load-bearing case
    // is exercised by the spawn-failed group's "close followed by a
    // still-attached 'error'" test, where the second event's listener is
    // deliberately never detached.
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.disposition).toBe("timed-out");
    expect(result.exitCode).toBeNull();
  });

  test("does not time out, and leaves no pending timer, when the child settles before timeoutMs elapses", async () => {
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

    expect(result.disposition).toBe("exited");
    // A leaked timer would keep this long-lived stdio server's event loop
    // alive; the timeout timer must be cleared on early settle.
    expect(vi.getTimerCount()).toBe(0);

    // Advancing past the original deadline must not retroactively change
    // the already-resolved outcome.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.disposition).toBe("exited");
  });
});

describe("runCliProcess — abort", () => {
  test("an already-aborted signal resolves 'aborted' WITHOUT spawning at all", async () => {
    const child = createFakeChild();
    const { spawn } = createFakeSpawn(child);
    const controller = new AbortController();
    controller.abort();

    const result = await runCliProcess({
      ...baseOptions,
      spawn,
      signal: controller.signal,
    });

    expect(result.disposition).toBe("aborted");
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  test("aborting mid-run kills the child and resolves 'aborted'", async () => {
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
    // This module has no escalation ladder (SIGKILL arrives with slice
    // V10e's core/process promotion) — SIGTERM is the signal that lets the
    // child flush and clean up, so every kill path pins it explicitly.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
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

    // Aborting after settlement must be a pure no-op.
    controller.abort();
    await Promise.resolve();
    expect(result.disposition).toBe("exited");
  });
});

describe("CliRunDisposition / CliRunResult (type level)", () => {
  test("CliRunDisposition is exactly the seven documented dispositions", () => {
    expectTypeOf<CliRunDisposition>().toEqualTypeOf<
      | "exited"
      | "spawn-failed"
      | "timed-out"
      | "aborted"
      | "signalled"
      | "output-truncated"
      | "stream-failed"
    >();
  });

  test("CliRunResult has exactly the documented readonly fields", () => {
    expectTypeOf<CliRunResult>().toEqualTypeOf<{
      readonly disposition: CliRunDisposition;
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly failureCode: string | undefined;
    }>();
  });
});
