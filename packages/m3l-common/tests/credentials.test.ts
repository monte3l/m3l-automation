/**
 * Tests for aws/credentials submodule.
 *
 * Contract source: docs/reference/aws/credentials.md plus the hub-locked
 * decisions for this change set: `type`/`profile` are folded into
 * `M3LAWSCredentialsError.context` (not top-level fields); a declined
 * interactive confirm THROWS (unrecovered); `analyzeError` is synchronous;
 * `ensureValidCredentialsMultiple` validates in parallel then logs in
 * sequentially and fails fast on the first unrecoverable profile.
 *
 * Exports under test (from `../src/aws/credentials/index.js`):
 *   M3LAWSCredentialsManager, M3LAWSCredentialsError (2 symbols). Model types
 *   (`M3LAWSCredentialsErrorType`, `M3LAWSLoginResult`, etc.) come from
 *   `../src/aws/models/index.js` and are NOT re-exported here.
 *
 * Mocking strategy: `@aws-sdk/client-sts`, `@aws-sdk/credential-providers`,
 * and `node:child_process` are mocked with top-level `vi.mock` + a
 * `vi.hoisted` bag of mutable spies (this repo's convention for a
 * collaborator every test needs pre-wired before any import runs). A single
 * static import loads `M3LAWSCredentialsManager`/`M3LAWSCredentialsError`
 * alongside `M3LError`, so everything shares ONE module graph. This
 * deliberately avoids a per-test `vi.doMock` + `vi.resetModules()` + dynamic
 * re-import strategy, which runs into two hazards here:
 *   1. `instanceof` across module graphs: a dynamically re-imported
 *      `M3LAWSCredentialsError` does not share a prototype chain with a
 *      statically-imported `M3LError` from a different graph.
 *   2. `ensureValidCredentialsMultiple` validates profiles CONCURRENTLY, each
 *      doing a first-time `await import("@aws-sdk/client-sts")` internally.
 *      `vi.doMock` only reliably intercepts a specifier once its first
 *      resolution has settled; a raced concurrent first-time import can slip
 *      past the mock and load the real SDK package.
 * A single static import + top-level `vi.mock` (hoisted above every import)
 * sidesteps both: the mock is registered before the module graph is even
 * built, so every dynamic `import()` inside the implementation — concurrent
 * or not — resolves to the same mocked module instance.
 *
 * The "SDK-load-failure" scenarios (C7) genuinely need the dynamic
 * `import()` to REJECT — which the top-level "present" mocks here cannot
 * simulate — so those live in the sibling
 * `tests/credentials-missing-peer.test.ts`, which uses `vi.doMock` +
 * `vi.resetModules()` + a dynamic re-import (safe there because each of its
 * tests only ever triggers one dynamic import, never concurrent ones).
 */

import { EventEmitter } from "node:events";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factories
// below (those factories cannot close over ordinary file-scope variables).
const h = vi.hoisted(() => ({
  stsSend: vi.fn(),
  fromSSO: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = h.stsSend;
    constructor(config?: unknown) {
      void config;
    }
  },
  GetCallerIdentityCommand: class {
    constructor(input?: unknown) {
      void input;
    }
  },
}));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromSSO: h.fromSSO,
}));

vi.mock("node:child_process", () => ({
  spawn: h.spawn,
}));

import { M3LError } from "../src/core/errors/index.js";
import { M3LPrompt } from "../src/core/prompt/index.js";
import type { M3LPromptAdapter } from "../src/core/prompt/index.js";
import {
  M3LAWSCredentialsError,
  M3LAWSCredentialsManager,
} from "../src/aws/credentials/index.js";
import { M3LAWSCredentialsErrorType } from "../src/aws/models/index.js";
import type { M3LAWSLoginResult } from "../src/aws/models/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal adapter satisfying M3LPromptAdapter; only `confirm` is exercised. */
function makePromptAdapter(
  confirmImpl: () => Promise<boolean>,
): M3LPromptAdapter {
  return {
    input: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: vi.fn(confirmImpl),
    select: vi.fn(),
    checkbox: vi.fn(),
    search: vi.fn(),
  };
}

/** Builds a real M3LPrompt whose `confirm()` resolves to the given boolean. */
function makePrompt(confirmResult: boolean): M3LPrompt {
  return new M3LPrompt({
    adapter: makePromptAdapter(() => Promise.resolve(confirmResult)),
  });
}

/**
 * A fake `ChildProcess` — just enough of the `EventEmitter` surface for
 * `spawn()`. `kill()` immediately emits `"exit"` with a null exit code and a
 * `"SIGTERM"` signal, mirroring how a real killed child eventually reports
 * its exit.
 */
class FakeChildProcess extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

/**
 * Configures `h.spawn` to return a fresh `FakeChildProcess` per call and
 * schedule its `"exit"` event via `queueMicrotask` — deferred so the
 * implementation's `child.on("exit", ...)` listener is always attached
 * first, regardless of how many awaits precede the `spawn()` call.
 */
function configureSpawn(exitCode: number | null, signal: string | null): void {
  h.spawn.mockImplementation(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.emit("exit", exitCode, signal);
    });
    return child;
  });
}

/**
 * Configures `h.spawn` to return a fresh `FakeChildProcess` whose `"error"`
 * event fires (via `queueMicrotask`, deferred past listener attachment)
 * instead of `"exit"` — simulating the `aws` executable itself failing to
 * spawn (e.g. `ENOENT` when it is not installed or not on `PATH`).
 */
function configureSpawnError(cause: Error): void {
  h.spawn.mockImplementation(() => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.emit("error", cause);
    });
    return child;
  });
}

/** Representative error messages mapped to the documented classification. */
const CLASSIFICATION_CASES = [
  [
    "Token has expired and refresh failed",
    M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
    true,
  ],
  [
    "The SSO session associated with this profile is invalid",
    M3LAWSCredentialsErrorType.SSO_SESSION_INVALID,
    true,
  ],
  [
    "Profile my-prof not found",
    M3LAWSCredentialsErrorType.PROFILE_NOT_FOUND,
    false,
  ],
  [
    "Could not load credentials from any providers",
    M3LAWSCredentialsErrorType.CREDENTIALS_PROVIDER_FAILED,
    true,
  ],
  ["something unexpected", M3LAWSCredentialsErrorType.UNKNOWN, false],
] as const;

beforeEach(() => {
  h.stsSend.mockReset();
  h.fromSSO.mockReset().mockReturnValue({
    accessKeyId: "AKIA_FAKE",
    secretAccessKey: "fake",
  });
  h.spawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// Construction
// =============================================================================
describe("M3LAWSCredentialsManager construction", () => {
  test("constructs with no options — defaults apply, no throw", () => {
    expect(() => new M3LAWSCredentialsManager()).not.toThrow();
  });

  test("constructs with a full options bag — no throw", () => {
    expect(
      () =>
        new M3LAWSCredentialsManager({
          profile: "default",
          region: "eu-south-1",
          loginTimeoutMs: 5000,
          maxRetries: 2,
          interactive: false,
          prompt: makePrompt(true),
        }),
    ).not.toThrow();
  });
});

// =============================================================================
// ensureValidCredentials
// =============================================================================
describe("ensureValidCredentials", () => {
  test("already-valid profile resolves to undefined (no login runs)", async () => {
    h.stsSend.mockResolvedValue({ Account: "123456789012" });

    const manager = new M3LAWSCredentialsManager({ profile: "default" });

    await expect(manager.ensureValidCredentials()).resolves.toBeUndefined();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("recoverable failure runs SSO login and resolves to a successful M3LAWSLoginResult", async () => {
    h.stsSend.mockRejectedValue(
      new Error("The SSO session associated with this profile is invalid"),
    );
    configureSpawn(0, null);

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: false,
    });

    const result = await manager.ensureValidCredentials();
    expect(result).toMatchObject({
      profile: "my-profile",
      outcome: "success",
      exitCode: 0,
    });
    expect((result as M3LAWSLoginResult).durationMs).toBeGreaterThanOrEqual(0);
    expect(h.spawn).toHaveBeenCalledWith(
      "aws",
      ["sso", "login", "--profile=my-profile"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  test("unrecoverable failure throws M3LAWSCredentialsError naming the profile in context", async () => {
    h.stsSend.mockRejectedValue(new Error("Profile my-profile not found"));

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: false,
    });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentials();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    expect((thrown as M3LAWSCredentialsError).context.profile).toBe(
      "my-profile",
    );
  });

  test("declined interactive confirm throws M3LAWSCredentialsError (unrecovered, no login)", async () => {
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: true,
      prompt: makePrompt(false),
    });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentials();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ensureValidCredentialsMultiple
// =============================================================================
describe("ensureValidCredentialsMultiple", () => {
  test("all-valid profiles resolve to an empty array (no logins run)", async () => {
    h.stsSend.mockResolvedValue({ Account: "123456789012" });

    const manager = new M3LAWSCredentialsManager({ interactive: false });

    await expect(
      manager.ensureValidCredentialsMultiple(["profile-a", "profile-b"]),
    ).resolves.toEqual([]);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("all-invalid (recoverable) profiles each produce one login-result entry", async () => {
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );
    configureSpawn(0, null);

    const manager = new M3LAWSCredentialsManager({ interactive: false });

    const results = await manager.ensureValidCredentialsMultiple([
      "profile-a",
      "profile-b",
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((entry) => entry.outcome === "success")).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  test("phase-1 validation runs in parallel — all STS calls start before any resolves", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    h.stsSend.mockImplementation(async () => {
      concurrentCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await Promise.resolve();
      concurrentCalls -= 1;
      return { Account: "123456789012" };
    });

    const manager = new M3LAWSCredentialsManager({ interactive: false });

    await manager.ensureValidCredentialsMultiple([
      "profile-a",
      "profile-b",
      "profile-c",
    ]);

    // If validation ran sequentially, maxConcurrent would never exceed 1.
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  test("phase-3 SSO login runs sequentially — login N+1 only starts after login N settles", async () => {
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );

    // No auto-emit here: this test drives each child's exit explicitly to
    // prove strict ordering (spawn N+1 must not happen before child N exits).
    const children: FakeChildProcess[] = [];
    h.spawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      children.push(child);
      return child;
    });

    const manager = new M3LAWSCredentialsManager({ interactive: false });

    const pending = manager.ensureValidCredentialsMultiple([
      "profile-a",
      "profile-b",
    ]);

    // Only the first login should have spawned so far.
    await vi.waitFor(() => {
      expect(h.spawn).toHaveBeenCalledTimes(1);
    });

    const first = children[0];
    expect(first).toBeDefined();
    first?.emit("exit", 0, null);

    // Now the second login should start, not before.
    await vi.waitFor(() => {
      expect(h.spawn).toHaveBeenCalledTimes(2);
    });
    const second = children[1];
    second?.emit("exit", 0, null);

    await pending;
  });

  test("fail-fast: first unrecoverable profile throws M3LAWSCredentialsError naming that profile", async () => {
    h.stsSend.mockRejectedValue(new Error("Profile my-profile not found"));

    const manager = new M3LAWSCredentialsManager({ interactive: false });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentialsMultiple(["profile-a", "profile-b"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    expect((thrown as M3LAWSCredentialsError).context.profile).toBeDefined();
  });

  test("duplicate profile names each carry their OWN settlement — regression for indexOf mis-attribution", async () => {
    // Both entries share the name "dup". `mockRejectedValueOnce` is consumed
    // in call order: the FIRST validation call (for the first "dup") rejects
    // recoverably, the SECOND validation call (for the second "dup") rejects
    // unrecoverably. Phase-1 validates in parallel via `profiles.map(...)`,
    // but each `.map()` callback still invokes `h.stsSend` once per element
    // in array order, so call #1 belongs to `profiles[0]` and call #2 to
    // `profiles[1]` regardless of settlement timing.
    //
    // Under the OLD `profiles.indexOf(profile)` re-lookup in phase 3, BOTH
    // "dup" entries would resolve to `profiles.indexOf("dup")` === 0 — i.e.
    // both would see the FIRST (recoverable) settlement, and the manager
    // would never throw PROFILE_NOT_FOUND. The fix carries each entry's own
    // settlement through phase 2, so the second occurrence is correctly
    // attributed to the unrecoverable failure.
    h.stsSend
      .mockRejectedValueOnce(new Error("Token has expired and refresh failed"))
      .mockRejectedValueOnce(new Error("Profile dup not found"));
    configureSpawn(0, null);

    const manager = new M3LAWSCredentialsManager({ interactive: false });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentialsMultiple(["dup", "dup"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    expect((thrown as M3LAWSCredentialsError).context.type).toBe(
      "PROFILE_NOT_FOUND",
    );
  });
});

// =============================================================================
// retryWithRelogin
// =============================================================================
describe("retryWithRelogin", () => {
  test("operation resolves on first try — returns the value, no login runs", async () => {
    const manager = new M3LAWSCredentialsManager({ interactive: false });

    const operation = vi.fn().mockResolvedValue("ok");
    await expect(manager.retryWithRelogin(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("recoverable rejection then success — logs in once and retries, returning the value", async () => {
    configureSpawn(0, null);
    const manager = new M3LAWSCredentialsManager({
      interactive: true,
      prompt: makePrompt(true),
    });

    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Token has expired and refresh failed"))
      .mockResolvedValueOnce("recovered");

    await expect(
      manager.retryWithRelogin(operation, "my-profile"),
    ).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  test("operation is invoked at most maxRetries + 1 times (default maxRetries=1 => at most 2 calls)", async () => {
    configureSpawn(0, null);
    const manager = new M3LAWSCredentialsManager({
      interactive: true,
      prompt: makePrompt(true),
    });

    const operation = vi
      .fn()
      .mockRejectedValue(new Error("Token has expired and refresh failed"));

    let thrown: unknown;
    try {
      await manager.retryWithRelogin(operation);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    expect(operation.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("unrecoverable first error throws immediately — no login attempted", async () => {
    const manager = new M3LAWSCredentialsManager({ interactive: false });

    const operation = vi
      .fn()
      .mockRejectedValue(new Error("Profile my-profile not found"));

    let thrown: unknown;
    try {
      await manager.retryWithRelogin(operation, "my-profile");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  test("retries exhausted (all recoverable, all fail) — throws M3LAWSCredentialsError", async () => {
    configureSpawn(0, null);
    const manager = new M3LAWSCredentialsManager({
      interactive: false,
      maxRetries: 1,
    });

    const operation = vi
      .fn()
      .mockRejectedValue(new Error("Token has expired and refresh failed"));

    let thrown: unknown;
    try {
      await manager.retryWithRelogin(operation, "my-profile");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
  });
});

// =============================================================================
// SSO login behavioral seams: argv, stdio, success, timeout
// =============================================================================
describe("SSO login process seam", () => {
  test("spawns `aws sso login --profile=<name>` with stdio inherit", async () => {
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );
    configureSpawn(0, null);

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: false,
    });

    await manager.ensureValidCredentials();

    expect(h.spawn).toHaveBeenCalledWith(
      "aws",
      ["sso", "login", "--profile=my-profile"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  test("a REAL timeout (our timer fires) is killed and resolves outcome:'timedOut', exitCode:null", async () => {
    vi.useFakeTimers();
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );

    // No auto-emit: the child only exits when its `kill()` (invoked by the
    // implementation's timeout) fires — see FakeChildProcess.kill().
    const child = new FakeChildProcess();
    h.spawn.mockImplementation(() => child);

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: false,
      loginTimeoutMs: 1000,
    });

    const pending = manager.ensureValidCredentials();
    await vi.advanceTimersByTimeAsync(1000);

    const result = await pending;
    expect(result).toMatchObject({
      outcome: "timedOut",
      exitCode: null,
    });
    expect(child.killed).toBe(true);
  });

  test("an EXTERNAL signal-kill (not our timeout) resolves outcome:'failed', exitCode:null — regression for the timedOutByUs flag", async () => {
    // Simulates a user Ctrl-C or the parent process forwarding a signal via
    // `stdio: "inherit"` — the child exits with a null code and a signal,
    // exactly like our own timeout-driven kill, but OUR timer never fires.
    // Under the old exitCode/signal heuristic this was indistinguishable
    // from a real timeout and wrongly reported `timedOut: true`.
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );
    const child = new FakeChildProcess();
    h.spawn.mockImplementation(() => child);

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: false,
      loginTimeoutMs: 60_000,
    });

    const pending = manager.ensureValidCredentials();
    await vi.waitFor(() => {
      expect(h.spawn).toHaveBeenCalled();
    });
    child.emit("exit", null, "SIGINT");

    const result = await pending;
    expect(result).toMatchObject({
      outcome: "failed",
      exitCode: null,
    });
  });

  test("a spawn failure (aws CLI missing) rejects with M3LAWSCredentialsError naming the profile, cause chained (non-interactive)", async () => {
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );
    const spawnError = Object.assign(new Error("spawn aws ENOENT"), {
      code: "ENOENT",
    });
    configureSpawnError(spawnError);

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: false,
    });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentials();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    const err = thrown as M3LAWSCredentialsError;
    expect(err.message).toContain("my-profile");
    expect(err.message.toLowerCase()).toContain("aws");
    expect(err.cause).toBe(spawnError);
  });

  test("a spawn failure (aws CLI missing) rejects with M3LAWSCredentialsError (interactive path, confirm accepted)", async () => {
    h.stsSend.mockRejectedValue(
      new Error("Token has expired and refresh failed"),
    );
    const spawnError = Object.assign(new Error("spawn aws ENOENT"), {
      code: "ENOENT",
    });
    configureSpawnError(spawnError);

    const manager = new M3LAWSCredentialsManager({
      profile: "my-profile",
      interactive: true,
      prompt: makePrompt(true),
    });

    let thrown: unknown;
    try {
      await manager.ensureValidCredentials();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LAWSCredentialsError);
    const err = thrown as M3LAWSCredentialsError;
    expect(err.message).toContain("my-profile");
    expect(err.cause).toBe(spawnError);
  });
});

// =============================================================================
// analyzeError — synchronous classification
// =============================================================================
describe("analyzeError", () => {
  test.each(CLASSIFICATION_CASES)(
    "message %j classifies as type=%s recoverable=%s",
    (message, expectedType, expectedRecoverable) => {
      const manager = new M3LAWSCredentialsManager();

      const analysis = manager.analyzeError(new Error(message));
      expect(analysis.type).toBe(expectedType);
      expect(analysis.recoverable).toBe(expectedRecoverable);
    },
  );

  test("is synchronous — does not return a Promise", () => {
    const manager = new M3LAWSCredentialsManager();

    const result = manager.analyzeError(new Error("something unexpected"));
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.type).toBeDefined();
  });

  test("preserves the original error verbatim as `cause`", () => {
    const manager = new M3LAWSCredentialsManager();

    const original = new Error("Profile ghost not found");
    const analysis = manager.analyzeError(original);
    expect(analysis.cause).toBe(original);
  });

  test("accepts a non-Error thrown value without throwing itself", () => {
    const manager = new M3LAWSCredentialsManager();

    const nonError = "boom";
    expect(() => manager.analyzeError(nonError)).not.toThrow();
    const analysis = manager.analyzeError(nonError);
    expect(analysis.type).toBe(M3LAWSCredentialsErrorType.UNKNOWN);
    expect(analysis.recoverable).toBe(false);
    expect(analysis.cause).toBe(nonError);
  });
});

// =============================================================================
// M3LAWSCredentialsError — shape and identity
// =============================================================================
describe("M3LAWSCredentialsError", () => {
  test("is an instance of both M3LError and Error", () => {
    const error = new M3LAWSCredentialsError("bad credentials");
    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(Error);
  });

  test("name is the literal class name", () => {
    const error = new M3LAWSCredentialsError("bad credentials");
    expect(error.name).toBe("M3LAWSCredentialsError");
  });

  test("code is the literal ERR_AWS_CREDENTIALS", () => {
    const error = new M3LAWSCredentialsError("bad credentials");
    expect(error.code).toBe("ERR_AWS_CREDENTIALS");
  });

  test("folds `type` and `profile` into `context`, not top-level fields", () => {
    const error = new M3LAWSCredentialsError("bad credentials", {
      type: M3LAWSCredentialsErrorType.SSO_SESSION_EXPIRED,
      profile: "my-profile",
    });
    expect(error.context.type).toBe("SSO_SESSION_EXPIRED");
    expect(error.context.profile).toBe("my-profile");
    expect(
      (error as unknown as Record<string, unknown>)["type"],
    ).toBeUndefined();
    expect(
      (error as unknown as Record<string, unknown>)["profile"],
    ).toBeUndefined();
  });

  test("chains the underlying cause", () => {
    const cause = new Error("STS unreachable");
    const error = new M3LAWSCredentialsError("bad credentials", { cause });
    expect(error.cause).toBe(cause);
  });

  test("constructs with no options at all — code set, context empty, cause undefined", () => {
    const error = new M3LAWSCredentialsError("bad credentials");
    expect(error.code).toBe("ERR_AWS_CREDENTIALS");
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  describe("type-level contract", () => {
    test("code narrows to the literal 'ERR_AWS_CREDENTIALS'", () => {
      expectTypeOf<
        M3LAWSCredentialsError["code"]
      >().toEqualTypeOf<"ERR_AWS_CREDENTIALS">();
    });
  });
});

// =============================================================================
// Type-level contracts for manager method signatures
// =============================================================================
describe("M3LAWSCredentialsManager — type-level contract", () => {
  test("ensureValidCredentials returns Promise<M3LAWSLoginResult | undefined>", () => {
    expectTypeOf<
      M3LAWSCredentialsManager["ensureValidCredentials"]
    >().returns.resolves.toEqualTypeOf<M3LAWSLoginResult | undefined>();
  });

  test("ensureValidCredentialsMultiple returns Promise<readonly M3LAWSLoginResult[]>", () => {
    expectTypeOf<
      M3LAWSCredentialsManager["ensureValidCredentialsMultiple"]
    >().returns.resolves.toEqualTypeOf<readonly M3LAWSLoginResult[]>();
  });

  test("retryWithRelogin<T> is generic and returns Promise<T>", () => {
    expectTypeOf<M3LAWSCredentialsManager["retryWithRelogin"]>()
      .parameter(0)
      .toEqualTypeOf<() => Promise<unknown>>();
  });

  test("analyzeError is synchronous, returning M3LAWSCredentialsErrorAnalysis (not a Promise)", () => {
    expectTypeOf<
      M3LAWSCredentialsManager["analyzeError"]
    >().returns.not.toEqualTypeOf<Promise<unknown>>();
  });
});
