/**
 * `core/script` — the `M3LScriptOptions.host` seam (U7 PR1).
 *
 * ADR-0072 slice split: `script.test.ts` is already ~7,000 lines, so the host
 * seam gets its own file rather than piling onto it. Everything here concerns
 * ONE option — `host` — and the two behaviours it changes simultaneously.
 *
 * `host` is what a program running this script **in-process** (the `m3l` CLI's
 * hybrid executor) supplies instead of spawning `dist/main.js`. Supplying it
 * — even as `{}` — changes two things at once, which is the part most likely
 * to surprise a reader:
 *
 *  1. **Parameter binding.** `host.parameterValues`, when present, REPLACES
 *     precedence level 1 (the command-line provider) rather than layering
 *     above it. The host's own `process.argv` must not leak into a hosted
 *     run's configuration — and the substitute provider reports the source
 *     label `"cli"`, not `"in-memory"`, so a hosted run's `run-report.json`
 *     is indistinguishable from a spawned one's (ADR-0054's parity clause).
 *  2. **Signal ownership.** A hosted script installs NO `SIGINT`/`SIGTERM`/
 *     `SIGQUIT` listeners of its own — the host owns process signals — and
 *     bridges `host.signal` into its own controller instead, preserving the
 *     ADR-0049 abort-before-cleanup ordering.
 *
 * Process-global hygiene: this file deliberately does NOT blanket-spy
 * `process.on` the way `script.test.ts` does, because the registration count
 * IS the assertion here. Every listener a construction adds is removed in the
 * test's own `finally`, so nothing leaks into another file sharing the worker.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import {
  M3LConfigCoercionError,
  M3LConfigParameter,
  M3LConfigParameterType,
  M3LUnsafeConfigKeyError,
} from "../src/core/config/index.js";
import {
  M3LCredentialSource,
  M3LDeploymentMode,
  M3LExecutionEnvironment,
  M3LExecutionEnvironmentType,
} from "../src/core/environment/index.js";
import type { M3LExecutionEnvironmentInfo } from "../src/core/environment/index.js";
import { M3LLogger } from "../src/core/logging/index.js";
import { M3LScript } from "../src/core/script/index.js";
import type {
  M3LScriptMetadata,
  M3LScriptOptions,
} from "../src/core/script/index.js";

// ---------------------------------------------------------------------------
// Shared fixtures — mirroring `script.test.ts`'s own environment stubs so the
// two files agree on what "a non-AWS run" means.
// ---------------------------------------------------------------------------

const metadata: M3LScriptMetadata = { name: "host-script", version: "1.0.0" };

/** The signals `registerShutdownSignals` installs outside AWS-managed runs. */
const HANDLED_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const;

type HandledSignal = (typeof HANDLED_SIGNALS)[number];

function makeEnvironmentInfo(
  overrides: Partial<M3LExecutionEnvironmentInfo> = {},
): M3LExecutionEnvironmentInfo {
  const base = {
    environmentType: M3LExecutionEnvironmentType.CI,
    isInteractive: false,
    isAWSManaged: false,
    canPromptUser: false,
    canOpenBrowser: false,
    requiresAwsProfile: false,
    credentialSource: M3LCredentialSource.ENVIRONMENT,
    detectionDetails: {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      isCiEnvironment: true,
      hasLambdaTaskRoot: false,
      hasEcsMetadataUri: false,
      hasCodeBuildBuildId: false,
      workspaceMarkerPath: undefined,
    },
    deploymentMode: M3LDeploymentMode.STANDALONE,
    monorepoRoot: undefined,
  } satisfies M3LExecutionEnvironmentInfo;
  return { ...base, ...overrides } as M3LExecutionEnvironmentInfo;
}

/** Forces `M3LExecutionEnvironment.detect`/`detectFresh` to a non-AWS info. */
function stubNonAwsEnvironment(): void {
  const info = makeEnvironmentInfo();
  vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(info);
  vi.spyOn(M3LExecutionEnvironment, "detectFresh").mockReturnValue(info);
}

/** Forces an AWS-managed (Lambda) environment info. */
function stubAwsLambdaEnvironment(): void {
  const info = makeEnvironmentInfo({
    environmentType: M3LExecutionEnvironmentType.AWS_LAMBDA,
    isAWSManaged: true,
    credentialSource: M3LCredentialSource.WEB_IDENTITY,
  });
  vi.spyOn(M3LExecutionEnvironment, "detect").mockReturnValue(info);
  vi.spyOn(M3LExecutionEnvironment, "detectFresh").mockReturnValue(info);
}

/** A silent logger, so nothing in this file writes to the real console. */
function silentLogger(): M3LLogger {
  return new M3LLogger([]);
}

// ---------------------------------------------------------------------------
// argv / env stubbing — mirrors `script.test.ts`'s `stubArgv` + `vi.stubEnv`
// convention exactly rather than inventing a second style.
// ---------------------------------------------------------------------------

const originalArgv = process.argv;

/** Replaces `process.argv.slice(2)` (what the command-line provider reads). */
function stubArgv(...args: string[]): void {
  process.argv = [
    originalArgv[0] ?? "node",
    originalArgv[1] ?? "script",
    ...args,
  ];
}

beforeEach(() => {
  stubNonAwsEnvironment();
  stubArgv();
  // The env tier (level 4) sits below both level-1 candidates; clearing it
  // keeps a developer machine's ambient `REGION`/`TABLE` out of the way.
  vi.stubEnv("HOSTPARAM", undefined);
  vi.stubEnv("OTHERPARAM", undefined);
  vi.stubEnv("HOSTFLAG", undefined);
  vi.stubEnv("HOSTCOUNT", undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Signal-listener accounting
// ---------------------------------------------------------------------------

/**
 * Runs `build`, returning how many listeners it added per handled signal, and
 * removing every one of them again before returning. Real listeners are used
 * (not a `process.on` spy) because the registration count is the assertion;
 * the removal is what keeps this file from leaking process-global state into
 * another test file sharing the same worker.
 */
function countAddedSignalListeners<T>(build: () => T): {
  readonly result: T;
  readonly added: Record<HandledSignal, number>;
} {
  const before = new Map<HandledSignal, readonly unknown[]>(
    HANDLED_SIGNALS.map((signal) => [signal, [...process.listeners(signal)]]),
  );
  let result: T;
  const added: Record<HandledSignal, number> = {
    SIGTERM: 0,
    SIGINT: 0,
    SIGQUIT: 0,
  };
  try {
    result = build();
  } finally {
    for (const signal of HANDLED_SIGNALS) {
      const previous = new Set(before.get(signal) ?? []);
      for (const listener of process.listeners(signal)) {
        if (!previous.has(listener)) {
          added[signal] += 1;
          process.removeListener(signal, listener as NodeJS.SignalsListener);
        }
      }
    }
  }
  return { result, added };
}

// ---------------------------------------------------------------------------
// host.parameterValues — precedence level 1, replaced not layered
// ---------------------------------------------------------------------------

describe("M3LScriptOptions.host.parameterValues — parameter binding", () => {
  const hostParam = new M3LConfigParameter({
    name: "hostParam",
    type: M3LConfigParameterType.STRING,
  });

  test("a host-bound value wins over a conflicting process.argv flag", async () => {
    // Both level-1 candidates are genuinely present in this test's own setup:
    // argv carries a conflicting value, so the losing branch could fire. That
    // is what makes this a precedence assertion rather than a tautology.
    stubArgv("--hostParam=fromArgv");

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam] },
      host: { parameterValues: { hostParam: "fromHost" } },
    });

    const config = await script.getConfiguration();
    expect(config.get("hostParam")).toBe("fromHost");
  });

  // The parity fix: a hosted run's config must look, from `run-report.json`'s
  // perspective, exactly like a `"cli"`-sourced spawn run — never
  // `"in-memory"`, which would make a hosted run trivially distinguishable
  // from a spawned one in the very artifact ADR-0054's parity clause is about.
  test("sourceOf reports 'cli', not 'in-memory', for a host-bound value", async () => {
    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam] },
      host: { parameterValues: { hostParam: "fromHost" } },
    });

    const config = await script.getConfiguration();
    expect(config.sourceOf("hostParam")).toBe("cli");
    expect(config.sourceOf("hostParam")).not.toBe("in-memory");
  });

  // "Replace, never layer above": the command-line provider must be GONE from
  // the chain when the host bound values, not merely outranked. A parameter
  // the host did not bind must therefore NOT pick up the host process's argv.
  test("an unbound parameter does not fall back to the host process's argv", async () => {
    stubArgv("--otherParam=leakedFromHostArgv");
    const otherParam = new M3LConfigParameter({
      name: "otherParam",
      type: M3LConfigParameterType.STRING,
      defaultValue: "fromDefault",
    });

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam, otherParam] },
      host: { parameterValues: { hostParam: "fromHost" } },
    });

    const config = await script.getConfiguration();
    expect(config.get("otherParam")).toBe("fromDefault");
  });

  test("the rest of the precedence chain below level 1 still applies", async () => {
    vi.stubEnv("OTHERPARAM", "fromEnv");
    const otherParam = new M3LConfigParameter({
      name: "otherParam",
      type: M3LConfigParameterType.STRING,
      defaultValue: "fromDefault",
    });

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam, otherParam] },
      host: { parameterValues: { hostParam: "fromHost" } },
    });

    const config = await script.getConfiguration();
    expect(config.get("otherParam")).toBe("fromEnv");
    expect(config.sourceOf("otherParam")).toBe("environment-variable");
  });

  // Regression lock on every existing call site: with `host` omitted, the real
  // command-line provider is still level 1 and still reads `process.argv`.
  test("with host omitted entirely, process.argv is still read (regression lock)", async () => {
    stubArgv("--hostParam=fromArgv");

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam] },
    });

    const config = await script.getConfiguration();
    expect(config.get("hostParam")).toBe("fromArgv");
    expect(config.sourceOf("hostParam")).toBe("cli");
  });

  // `host: {}` changes signal ownership (below) but binds nothing, so the
  // real command-line provider must stay in place.
  test("host: {} with no parameterValues still reads process.argv", async () => {
    stubArgv("--hostParam=fromArgv");

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam] },
      host: {},
    });

    const config = await script.getConfiguration();
    expect(config.get("hostParam")).toBe("fromArgv");
  });

  test("an empty parameterValues record binds nothing but still replaces level 1", async () => {
    stubArgv("--hostParam=fromArgv");

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam] },
      host: { parameterValues: {} },
    });

    const config = await script.getConfiguration();
    expect(config.get("hostParam")).toBeUndefined();
  });

  // `host.parameterValues` is caller data crossing a trust boundary — a host
  // may have built it from a CLI, an HTTP body or an agent's tool call — so it
  // gets the SAME prototype-pollution guard every other config source gets
  // (`M3LInMemoryConfigProvider`, `M3LPresetConfigProvider`,
  // `M3LLambdaEventConfigProvider`, the JSON/YAML file providers). This is the
  // drift guard on "the host seam is not a hole in that guard": the substitute
  // provider is built inside stage 3, so the error surfaces as a REJECTION of
  // `getConfiguration()` rather than a throw at construction.
  //
  // `JSON.parse` rather than an object literal, matching `config.test.ts`: a
  // literal `{ __proto__: ... }` sets the prototype instead of creating an own
  // key, so it would never reach the guard at all.
  test("a __proto__ key in parameterValues is rejected like every other source", async () => {
    const dangerousValues = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    ) as Readonly<Record<string, unknown>>;

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [hostParam] },
      host: { parameterValues: dangerousValues },
    });

    await expect(script.getConfiguration()).rejects.toThrow(
      M3LUnsafeConfigKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // Parity of the RAW value space, not just of the source label: the provider
  // the host replaces yields `string | boolean` (a bare `--flag` parses to a
  // real `true`), so a host binding a real boolean must land on the same
  // coerced value as the argv form it stands in for. Both arms are exercised
  // in one test precisely so a divergence is visible rather than inferred.
  test("a host-bound boolean coerces exactly as a bare --flag does", async () => {
    const flagParam = new M3LConfigParameter({
      name: "hostFlag",
      type: M3LConfigParameterType.BOOL,
    });

    stubArgv("--hostFlag");
    const spawned = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [flagParam] },
    });
    const spawnedConfig = await spawned.getConfiguration();

    stubArgv();
    const hosted = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [flagParam] },
      host: { parameterValues: { hostFlag: true } },
    });
    const hostedConfig = await hosted.getConfiguration();

    expect(hostedConfig.get("hostFlag")).toBe(true);
    expect(hostedConfig.get("hostFlag")).toBe(spawnedConfig.get("hostFlag"));
    expect(hostedConfig.sourceOf("hostFlag")).toBe(
      spawnedConfig.sourceOf("hostFlag"),
    );
  });

  // The other half of the same parity question, and the one that constrains a
  // host: BOOL is the ONLY non-string passthrough the coercer accepts (plus
  // Buffer/Uint8Array for BUFFER). INT/DOUBLE coerce FROM a string, because
  // the argv provider can never hand them anything else — so a host binding a
  // raw `5` is a documented coercion failure, not a silently accepted value.
  // Characterization of today's contract: a host must stringify numerics.
  test("a host-bound raw number for an INT parameter is a coercion failure", async () => {
    const countParam = new M3LConfigParameter({
      name: "hostCount",
      type: M3LConfigParameterType.INT,
    });

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [countParam] },
      host: { parameterValues: { hostCount: 5 } },
    });

    await expect(script.getConfiguration()).rejects.toThrow(
      M3LConfigCoercionError,
    );
  });

  test("a host-bound numeric STRING coerces to the same INT the argv form gives", async () => {
    const countParam = new M3LConfigParameter({
      name: "hostCount",
      type: M3LConfigParameterType.INT,
    });

    stubArgv("--hostCount=5");
    const spawned = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [countParam] },
    });
    const spawnedConfig = await spawned.getConfiguration();

    stubArgv();
    const hosted = new M3LScript({
      metadata,
      logger: silentLogger(),
      config: { params: [countParam] },
      host: { parameterValues: { hostCount: "5" } },
    });
    const hostedConfig = await hosted.getConfiguration();

    expect(hostedConfig.get("hostCount")).toBe(5);
    expect(hostedConfig.get("hostCount")).toBe(spawnedConfig.get("hostCount"));
  });
});

// ---------------------------------------------------------------------------
// host — shutdown-handler opt-out
// ---------------------------------------------------------------------------

describe("M3LScriptOptions.host — shutdown-handler opt-out", () => {
  // The discriminating baseline: without `host`, construction DOES install
  // listeners. Without this arm, the zero-delta assertions below would pass
  // identically against an implementation that never installed any.
  test("a non-hosted construction installs SIGTERM/SIGINT/SIGQUIT listeners", () => {
    const { added } = countAddedSignalListeners(
      () => new M3LScript({ metadata, logger: silentLogger() }),
    );

    expect(added).toEqual({ SIGTERM: 1, SIGINT: 1, SIGQUIT: 1 });
  });

  test("host: {} suppresses every shutdown listener — the host owns signals", () => {
    const { added } = countAddedSignalListeners(
      () => new M3LScript({ metadata, logger: silentLogger(), host: {} }),
    );

    expect(added).toEqual({ SIGTERM: 0, SIGINT: 0, SIGQUIT: 0 });
  });

  test("host carrying a signal also suppresses every shutdown listener", () => {
    const controller = new AbortController();
    const { added } = countAddedSignalListeners(
      () =>
        new M3LScript({
          metadata,
          logger: silentLogger(),
          host: { signal: controller.signal },
        }),
    );

    expect(added).toEqual({ SIGTERM: 0, SIGINT: 0, SIGQUIT: 0 });
  });

  test("host carrying only parameterValues also suppresses them", () => {
    const { added } = countAddedSignalListeners(
      () =>
        new M3LScript({
          metadata,
          logger: silentLogger(),
          host: { parameterValues: { hostParam: "fromHost" } },
        }),
    );

    expect(added).toEqual({ SIGTERM: 0, SIGINT: 0, SIGQUIT: 0 });
  });

  // The pre-existing AWS-managed gate is unchanged, and hosting does not
  // interact with it: an AWS-managed run installed no listeners before and
  // installs none now, hosted or not.
  test("AWS-managed installs none, with or without host", () => {
    stubAwsLambdaEnvironment();

    const bare = countAddedSignalListeners(
      () => new M3LScript({ metadata, logger: silentLogger() }),
    );
    const hosted = countAddedSignalListeners(
      () => new M3LScript({ metadata, logger: silentLogger(), host: {} }),
    );

    expect(bare.added).toEqual({ SIGTERM: 0, SIGINT: 0, SIGQUIT: 0 });
    expect(hosted.added).toEqual({ SIGTERM: 0, SIGINT: 0, SIGQUIT: 0 });
  });
});

// ---------------------------------------------------------------------------
// host.signal — bridging into the script's own controller
// ---------------------------------------------------------------------------

describe("M3LScriptOptions.host.signal — abort bridging", () => {
  test("an already-aborted host signal aborts the script's own signal synchronously", () => {
    const controller = new AbortController();
    controller.abort();

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      host: { signal: controller.signal },
    });

    // Synchronously, at construction — not after a turn of the event loop: a
    // script whose `signal` is still live for one tick could start a fresh
    // long-running wait it will never be told to stop.
    expect(script.signal.aborted).toBe(true);
  });

  test("an already-aborted host signal still runs onCleanup", async () => {
    const controller = new AbortController();
    controller.abort();
    const cleanups: string[] = [];

    new M3LScript({
      metadata,
      logger: silentLogger(),
      host: { signal: controller.signal },
      hooks: {
        onCleanup: () => {
          cleanups.push("cleanup");
        },
      },
    });

    // `runCleanup` is invoked as a floating promise, so the hook lands on a
    // later microtask turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanups).toEqual(["cleanup"]);
  });

  test("a host signal aborted AFTER construction flips the script's signal", async () => {
    const controller = new AbortController();

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      host: { signal: controller.signal },
    });
    expect(script.signal.aborted).toBe(false);

    controller.abort();
    await Promise.resolve();

    expect(script.signal.aborted).toBe(true);
  });

  test("a later abort runs onCleanup, with the abort already visible to the hook", async () => {
    const controller = new AbortController();
    const order: string[] = [];

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      host: { signal: controller.signal },
      hooks: {
        onCleanup: () => {
          // ADR-0049's abort-before-cleanup ordering: a cleanup hook reading
          // `signal.aborted` must already see `true`, so it does not start a
          // fresh long-running wait while the run is shutting down.
          order.push(
            script.signal.aborted
              ? "cleanup-after-abort"
              : "cleanup-before-abort",
          );
        },
      },
    });

    controller.abort();
    order.push("abort-returned");
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["abort-returned", "cleanup-after-abort"]);
  });

  // The reason-less `.abort()` matters: a script's own classification code
  // reads `.aborted`, never a reason, so bridging must not start attaching one
  // (`AbortSignal.reason` would become a new, undocumented observable).
  test("the bridged abort carries the default reason, not the host's", () => {
    const controller = new AbortController();
    controller.abort(new Error("host-specific reason"));

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      host: { signal: controller.signal },
    });

    expect(script.signal.aborted).toBe(true);
    expect(script.signal.reason).not.toBe(controller.signal.reason);
    expect(script.signal.reason).toBeInstanceOf(DOMException);
  });

  test("host with no signal leaves the script's own signal live", () => {
    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      host: {},
    });

    expect(script.signal.aborted).toBe(false);
  });

  test("host omitted leaves the script's own signal live (regression lock)", () => {
    const { result: script } = countAddedSignalListeners(
      () => new M3LScript({ metadata, logger: silentLogger() }),
    );

    expect(script.signal.aborted).toBe(false);
  });

  test("a hosted, AWS-managed run still bridges the host signal", () => {
    stubAwsLambdaEnvironment();
    const controller = new AbortController();
    controller.abort();

    const script = new M3LScript({
      metadata,
      logger: silentLogger(),
      host: { signal: controller.signal },
    });

    expect(script.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("M3LScriptOptions.host — type-level contract", () => {
  test("host is optional, and both of its members are optional", () => {
    const withoutHost: M3LScriptOptions = { metadata };
    const empty: M3LScriptOptions = { metadata, host: {} };
    const full: M3LScriptOptions = {
      metadata,
      host: {
        parameterValues: { hostParam: "fromHost" },
        signal: new AbortController().signal,
      },
    };

    expect(withoutHost.host).toBeUndefined();
    expect(empty.host).toEqual({});
    expect(full.host?.parameterValues).toEqual({ hostParam: "fromHost" });
  });

  test("parameterValues is a readonly record of unknown values", () => {
    expectTypeOf<
      NonNullable<M3LScriptOptions["host"]>["parameterValues"]
    >().toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
  });

  test("signal is an AbortSignal, matching M3LCommandContext['signal']", () => {
    expectTypeOf<
      NonNullable<M3LScriptOptions["host"]>["signal"]
    >().toEqualTypeOf<AbortSignal | undefined>();
  });

  test("an explicit `signal: undefined` does not compile — use a conditional spread", () => {
    const signal: AbortSignal | undefined = undefined;
    // @ts-expect-error -- `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` against an optional field; a caller forwarding a possibly-
    // absent `context.signal` must spread it conditionally.
    const options: M3LScriptOptions = { metadata, host: { signal } };
    expect(options.metadata.name).toBe("host-script");
  });

  // `M3LScriptHostOptions` is module-private, following the same precedent as
  // this file's existing unexported `M3LScriptConfigDeclaration` /
  // `M3LReadonlyConfig`: it is reachable through `M3LScriptOptions["host"]`,
  // never as a barrel export of its own.
  test("M3LScriptHostOptions is not surfaced on the core/script barrel", async () => {
    const barrel: Record<string, unknown> =
      await import("../src/core/script/index.js");
    expect(Object.keys(barrel)).not.toContain("M3LScriptHostOptions");
  });
});
