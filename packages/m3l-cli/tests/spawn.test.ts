/**
 * Tests for src/run/spawn.ts — spawns a script's compiled `dist/main.js` via
 * an injectable `spawnImpl`, resolving the child's exit code (or the
 * signal-derived `128 + signal number` when the child died from a signal),
 * and rejecting `ERR_CLI_SPAWN_FAILED` on a spawn `error` event or
 * `ERR_CLI_SCRIPT_NOT_BUILT` when `dist/main.js` is missing (m3l-cli 8c
 * addendum).
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
// Bare identifier imports (not `fsPromises.<method>` member calls) for the
// real-filesystem setup/teardown of the "real spawnImpl" describe block below
// — the repo's `no-restricted-syntax` guard bans mutating `fs`/`fsPromises`
// *member-expression* calls in tests, but a bare identifier call is exempt,
// matching packages/m3l-common/tests/checkpoint.test.ts's precedent.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern, and this package's own
// discover.test.ts / load-config.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { spawnScript } from "../src/run/spawn.js";
import type { M3LCliSpawnOptions, M3LCliSpawnStdio } from "../src/run/spawn.js";
import { M3LCliError } from "../src/cli/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A minimal fake `ChildProcess`: an EventEmitter emitting `close`/`error`. */
function createFakeChild(): EventEmitter {
  return new EventEmitter();
}

/**
 * A fake child whose `stdout` exposes a spy `pipe` — used to assert
 * `spawnScript` pipes the child's stdout into the caller's redirect target
 * when `redirectStdoutToStderr` is set.
 */
function createFakeChildWithStdoutPipe(): EventEmitter & {
  stdout: {
    pipe: ReturnType<
      typeof vi.fn<(destination: { write(chunk: unknown): unknown }) => unknown>
    >;
  };
} {
  const child = createFakeChild() as EventEmitter & {
    stdout: {
      pipe: ReturnType<
        typeof vi.fn<
          (destination: { write(chunk: unknown): unknown }) => unknown
        >
      >;
    };
  };
  child.stdout = {
    pipe: vi.fn<(destination: { write(chunk: unknown): unknown }) => unknown>(),
  };
  return child;
}

const scriptDirectory = join("/workspace", "scripts", "foo");

describe("spawnScript — happy path (exit-code pass-through)", () => {
  test("resolves with the child's numeric exit code from the close event", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", 7, null);

    await expect(resultPromise).resolves.toBe(7);
  });

  test("resolves with 0 when the child exits cleanly", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", 0, null);

    await expect(resultPromise).resolves.toBe(0);
  });

  test("never resolves before the child's close/error event fires", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    let resolved = false;
    const resultPromise: Promise<number> = spawnScript(scriptDirectory, [], {
      spawnImpl,
    }).then((code: number) => {
      resolved = true;
      return code;
    });

    // Let any pending microtasks drain without ever emitting close/error.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    fakeChild.emit("close", 0, null);
    await resultPromise;
    expect(resolved).toBe(true);
  });
});

describe("spawnScript — argv/cwd/stdio", () => {
  test("spawns process.execPath with the documented argv, scriptDirectory as cwd, and inherited stdio", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, ["--limit", "5"], {
      spawnImpl,
    });
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["--env-file-if-exists=.env", "dist/main.js", "--limit", "5"],
      { cwd: scriptDirectory, stdio: "inherit" },
    );
  });

  test("passes an empty passthrough array through unchanged", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["--env-file-if-exists=.env", "dist/main.js"],
      { cwd: scriptDirectory, stdio: "inherit" },
    );
  });
});

describe("spawnScript — signal death", () => {
  test("resolves 143 (128 + SIGTERM's 15) when the child dies from SIGTERM", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", null, "SIGTERM");

    const expectedCode = 128 + os.constants.signals.SIGTERM;
    await expect(resultPromise).resolves.toBe(expectedCode);
  });

  test("resolves 1 as a fallback for an unrecognized signal name", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", null, "SIGDOESNOTEXIST");

    await expect(resultPromise).resolves.toBe(1);
  });
});

describe("spawnScript — missing dist/main.js", () => {
  test("rejects M3LCliError ERR_CLI_SCRIPT_NOT_BUILT naming 'pnpm build', never invoking spawnImpl", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const spawnImpl = vi.fn(() => createFakeChild());

    let thrown: unknown;
    try {
      await spawnScript(scriptDirectory, [], { spawnImpl });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SCRIPT_NOT_BUILT");
    expect((thrown as M3LCliError).message).toContain("pnpm build");
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("spawnScript — spawn error event", () => {
  test("rejects M3LCliError ERR_CLI_SPAWN_FAILED with the original error chained as cause", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const spawnError = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
    });

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("error", spawnError);

    let thrown: unknown;
    try {
      await resultPromise;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SPAWN_FAILED");
    expect((thrown as M3LCliError).cause).toBe(spawnError);
  });
});

describe("spawnScript — settle-once guard", () => {
  test("emits error then close — rejects once with ERR_CLI_SPAWN_FAILED, and the close listener is removed before settling (no double-settle)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const spawnError = new Error("spawn ENOENT");

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("error", spawnError);

    let thrown: unknown;
    try {
      await resultPromise;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SPAWN_FAILED");
    // The sibling `close` listener was removed by the settle-once guard —
    // asserting 0 remaining listeners proves the removal itself, not just
    // that a later emit happens to be harmless.
    expect(fakeChild.listenerCount("close")).toBe(0);

    // A close event arriving after the promise already rejected is a
    // no-op: it must not throw and must not change the settled outcome.
    expect(() => fakeChild.emit("close", 0, null)).not.toThrow();
    await expect(resultPromise).rejects.toBeInstanceOf(M3LCliError);
  });

  test("emits close then error — resolves once with the code, and the error listener is removed before settling (no double-settle)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    // A permanent guard listener keeps Node's EventEmitter from treating a
    // later no-remaining-listener 'error' emit as an uncaught exception
    // (Node's own special-cased default behavior for the 'error' event) —
    // unrelated to spawnScript's settle-once guard, which this test targets.
    fakeChild.on("error", () => {});
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", 3, null);

    await expect(resultPromise).resolves.toBe(3);
    // Only the permanent guard listener remains — spawnScript's own `error`
    // listener was removed by the settle-once guard once `close` fired.
    expect(fakeChild.listenerCount("error")).toBe(1);

    // An error event arriving after the promise already resolved is a
    // no-op: the settled outcome must be unaffected.
    fakeChild.emit("error", new Error("late error"));
    await expect(resultPromise).resolves.toBe(3);
  });
});

describe("spawnScript — spawnImpl throws synchronously", () => {
  test("rejects ERR_CLI_SPAWN_FAILED with the thrown value chained as cause", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const syncError = new Error("boom: sync spawn failure");
    const spawnImpl = vi.fn(() => {
      throw syncError;
    });

    let thrown: unknown;
    try {
      await spawnScript(scriptDirectory, [], { spawnImpl });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_SPAWN_FAILED");
    expect((thrown as M3LCliError).cause).toBe(syncError);
  });
});

describe("M3LCliSpawnOptions contract", () => {
  test("spawnImpl is optional — an empty options object satisfies the type", () => {
    // Compiles only if `spawnImpl` is optional on M3LCliSpawnOptions.
    const options: M3LCliSpawnOptions = {};

    expect(options.spawnImpl).toBeUndefined();
  });

  test("a vi.fn returning the fake-child (EventEmitter) shape is assignable to spawnImpl", () => {
    // Compiles only if M3LCliSpawnOptions's `spawnImpl` accepts an
    // EventEmitter-returning implementation — the narrower,
    // EventEmitter-compatible shape `spawnScript` actually consumes, not
    // `typeof spawn`'s full overload set (which a mocked EventEmitter
    // return value cannot satisfy).
    const spawnImpl = vi.fn(() => createFakeChild());
    const options: M3LCliSpawnOptions = { spawnImpl };

    expect(options.spawnImpl).toBe(spawnImpl);
  });
});

describe("M3LCliSpawnOptions contract — redirectStdoutToStderr / stderrStream (RED: fields do not exist yet)", () => {
  test("redirectStdoutToStderr is optional — an options object with only spawnImpl still satisfies the type", () => {
    // Compiles only once `redirectStdoutToStderr` is declared optional on
    // M3LCliSpawnOptions; until then this is a plain, already-valid object.
    const spawnImpl = vi.fn(() => createFakeChild());
    const options: M3LCliSpawnOptions = { spawnImpl };

    expect(options.redirectStdoutToStderr).toBeUndefined();
  });

  test("redirectStdoutToStderr alone satisfies the type — proving it did not become required alongside spawnImpl", () => {
    // RED: `redirectStdoutToStderr` is not yet declared on
    // M3LCliSpawnOptions, so this object literal fails typecheck (excess
    // property) until the field is added — the sanctioned RED-phase type
    // error for a not-yet-existing member.
    const options: M3LCliSpawnOptions = { redirectStdoutToStderr: true };

    expect(options.redirectStdoutToStderr).toBe(true);
  });

  test("stderrStream alone satisfies the type", () => {
    // RED: same as above, for the `stderrStream` field.
    const stderrStream = { write: vi.fn() };
    const options: M3LCliSpawnOptions = { stderrStream };

    expect(options.stderrStream).toBe(stderrStream);
  });
});

describe("M3LCliSpawnStdio type contract (RED: type does not exist yet)", () => {
  test("accepts the literal 'inherit' string", () => {
    expectTypeOf<"inherit">().toMatchTypeOf<M3LCliSpawnStdio>();
  });

  test("accepts the three-element ['inherit', 'pipe', 'inherit'] tuple", () => {
    expectTypeOf<
      readonly ["inherit", "pipe", "inherit"]
    >().toMatchTypeOf<M3LCliSpawnStdio>();
  });
});

describe("spawnScript — redirectStdoutToStderr (stdout redirected to the parent's stderr)", () => {
  test('regression guard: redirectStdoutToStderr omitted still calls spawnImpl with stdio: "inherit"', async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["--env-file-if-exists=.env", "dist/main.js"],
      { cwd: scriptDirectory, stdio: "inherit" },
    );
  });

  test('regression guard: redirectStdoutToStderr explicitly false still calls spawnImpl with stdio: "inherit"', async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const options: M3LCliSpawnOptions = {
      spawnImpl,
      redirectStdoutToStderr: false,
    };

    const resultPromise = spawnScript(scriptDirectory, [], options);
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["--env-file-if-exists=.env", "dist/main.js"],
      { cwd: scriptDirectory, stdio: "inherit" },
    );
  });

  test('redirectStdoutToStderr: true calls spawnImpl with stdio ["inherit", "pipe", "inherit"]', async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChildWithStdoutPipe();
    const spawnImpl = vi.fn(() => fakeChild);
    const options: M3LCliSpawnOptions = {
      spawnImpl,
      redirectStdoutToStderr: true,
    };

    const resultPromise = spawnScript(scriptDirectory, [], options);
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ["--env-file-if-exists=.env", "dist/main.js"],
      { cwd: scriptDirectory, stdio: ["inherit", "pipe", "inherit"] },
    );
  });

  test("redirectStdoutToStderr: true pipes the child's stdout into the caller-supplied stderrStream exactly once", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChildWithStdoutPipe();
    const spawnImpl = vi.fn(() => fakeChild);
    const stderrStream = { write: vi.fn() };
    const options: M3LCliSpawnOptions = {
      spawnImpl,
      redirectStdoutToStderr: true,
      stderrStream,
    };

    const resultPromise = spawnScript(scriptDirectory, [], options);
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(fakeChild.stdout.pipe).toHaveBeenCalledTimes(1);
    expect(fakeChild.stdout.pipe).toHaveBeenCalledWith(stderrStream);
  });

  test("redirectStdoutToStderr: true with stderrStream omitted pipes the child's stdout into process.stderr", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChildWithStdoutPipe();
    const spawnImpl = vi.fn(() => fakeChild);
    const options: M3LCliSpawnOptions = {
      spawnImpl,
      redirectStdoutToStderr: true,
    };

    const resultPromise = spawnScript(scriptDirectory, [], options);
    fakeChild.emit("close", 0, null);
    await resultPromise;

    expect(fakeChild.stdout.pipe).toHaveBeenCalledTimes(1);
    expect(fakeChild.stdout.pipe).toHaveBeenCalledWith(process.stderr);
  });

  test("redirectStdoutToStderr: true with the fake child's stdout as null does not throw, and still resolves with the exit code", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild() as EventEmitter & { stdout: null };
    fakeChild.stdout = null;
    const spawnImpl = vi.fn(() => fakeChild);
    const options: M3LCliSpawnOptions = {
      spawnImpl,
      redirectStdoutToStderr: true,
    };

    const resultPromise = spawnScript(scriptDirectory, [], options);
    fakeChild.emit("close", 5, null);

    await expect(resultPromise).resolves.toBe(5);
  });

  test("redirectStdoutToStderr: true with the fake child's stdout field omitted entirely does not throw, and still resolves with the exit code", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);
    const options: M3LCliSpawnOptions = {
      spawnImpl,
      redirectStdoutToStderr: true,
    };

    const resultPromise = spawnScript(scriptDirectory, [], options);
    fakeChild.emit("close", 5, null);

    await expect(resultPromise).resolves.toBe(5);
  });
});

describe("spawnScript — resolveExitCode fallback (code and signal both null)", () => {
  test("resolves the fallback exit code 1 when close fires with code=null and signal=null (neither a normal exit nor a recognized signal death)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeChild = createFakeChild();
    const spawnImpl = vi.fn(() => fakeChild);

    const resultPromise = spawnScript(scriptDirectory, [], { spawnImpl });
    fakeChild.emit("close", null, null);

    await expect(resultPromise).resolves.toBe(1);
  });
});

describe("spawnScript — real defaultSpawnImpl (no injected spawnImpl override)", () => {
  // No `spawnImpl` is supplied in this block, so `spawnScript` falls through
  // to the module-scope `defaultSpawnImpl`, which genuinely calls
  // `node:child_process`'s real `spawn` — exercising both arms of its
  // `stdio: spawnOptions.stdio === "inherit" ? "inherit" : [...spawnOptions.stdio]`
  // ternary, which no fake-spawnImpl test elsewhere in this file can reach.
  let scriptDirectoryReal: string;

  beforeAll(async () => {
    scriptDirectoryReal = await mkdtemp(
      join(os.tmpdir(), "m3l-cli-spawn-real-"),
    );
    await mkdir(join(scriptDirectoryReal, "dist"), { recursive: true });
    // A trivial CJS script (no package.json in this scratch directory, so
    // Node's default module type applies): exits with a known code so the
    // test can assert on it without any process output to synchronize on.
    await writeFile(
      join(scriptDirectoryReal, "dist", "main.js"),
      "process.exit(0);\n",
    );
  });

  afterAll(async () => {
    await rm(scriptDirectoryReal, { recursive: true, force: true });
  });

  test("spawns the real child process with no options and resolves with its exit code (covers the stdio === 'inherit' ternary arm)", async () => {
    await expect(spawnScript(scriptDirectoryReal, [])).resolves.toBe(0);
  }, 15000);

  test("spawns the real child process with redirectStdoutToStderr and resolves with its exit code (covers the tuple-stdio ternary arm)", async () => {
    await expect(
      spawnScript(scriptDirectoryReal, [], {
        redirectStdoutToStderr: true,
      }),
    ).resolves.toBe(0);
  }, 15000);
});
