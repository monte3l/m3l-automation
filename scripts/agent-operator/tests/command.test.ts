import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

/**
 * `Core.runScript` and `Core.M3LScript` are mocked at the package level (the
 * fleet's established `vi.mock("@m3l-automation/m3l-common", ...)` factory
 * pattern) so `execute`'s WIRING can be asserted without running the
 * nine-stage pipeline: a real run resolves configuration and provisions AWS
 * even under `--dry-run`, so it would need real inputs and credentials and
 * would write a run report into the data tree.
 *
 * What that buys is coverage of the one path a composition regression would
 * land on — Core.captureRunFailures -> Core.runScript -> Core.deriveCommandOutcome — including
 * the metadata narrowing, which a previous revision got wrong.
 */
const runMocks = vi.hoisted(() => ({
  /** Captures the `M3LScriptOptions` bag `execute` builds. */
  scriptOptions: [] as unknown[],
  /** Captures `Core.runScript`'s `mainFn` and options per call. */
  runScriptCalls: [] as { mainFn: unknown; options: unknown }[],
  /** Set by a test to make the mocked run report absorbed recoveries. */
  recoveryTotal: 0,
}));

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    Core: {
      ...actual.Core,
      // `new Core.M3LScript(...)` — must be an ordinary function expression,
      // since an arrow cannot be invoked with `new`.
      M3LScript: vi.fn().mockImplementation(function mockedScript(options) {
        runMocks.scriptOptions.push(options);
        return {
          get recovery() {
            return Array.from({ length: runMocks.recoveryTotal }, () => ({
              item: "x",
              error: [],
              recordedAt: "2026-01-01T00:00:00.000Z",
            }));
          },
          get recoveryTotal() {
            return runMocks.recoveryTotal;
          },
        };
      }),
      // Records its arguments and never throws (matching `runScript`'s
      // documented contract), but deliberately does NOT invoke `mainFn`.
      //
      // Scope choice, not an oversight: `mainFn` reaches into the real
      // `M3LScript` instance (`getConfiguration`, `logger`, and per-script
      // extras like `aws`/`prompt`/`reportRecovery`), so invoking it would
      // force this template to stub a different surface for every script in
      // the fleet. What is under test here is `execute`'s COMPOSITION — the
      // options it builds, the dryRun it forwards, the outcome it derives —
      // while `runMain`'s body is covered by each script's own `steps/` tests.
      // The tests below assert that a callable was handed over, and drive the
      // failure paths through the composed `onError` directly.
      runScript: vi
        .fn()
        .mockImplementation((_script, mainFn: unknown, options: unknown) => {
          runMocks.runScriptCalls.push({ mainFn, options });
          return Promise.resolve();
        }),
    },
  };
});

import { Core } from "@m3l-automation/m3l-common";

import { commandModule } from "../src/command.js";
import { configParameters } from "../src/config.js";
import { hooks } from "../src/hooks.js";

/**
 * This package's own manifest, read at runtime rather than imported: the
 * shared tsconfig does not enable `resolveJsonModule`, and turning it on for
 * one assertion would widen the compiler surface for every script. Resolved
 * from this file's own URL, so it does not depend on the runner's working
 * directory.
 *
 * Read for real rather than mocked, deliberately: this file IS the artifact
 * under comparison. Mocking it would assert a fixture the test itself wrote
 * against the descriptor, which detects no drift at all — the opposite of the
 * point. The read is of a committed file inside this package, so it is neither
 * a network nor a mutating dependency.
 */
interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

const manifest: PackageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

/**
 * Contract: `docs/reference/core/cli-contract.md` (ADR-0054) plus
 * `docs/reference/scripts/agent-operator.md`.
 *
 * This file is the anti-drift guard for the command-module seam: `command.ts`
 * and `main.ts` are two independent composition sites until the CLI's
 * in-process host unifies them, so the properties that must hold across both
 * are asserted here.
 *
 * Deliberately NOT tested: a live `commandModule.execute(...)` call. Even a
 * dry run runs pipeline stages 1-5 — config resolution, plus AWS provisioning
 * where `aws.profile` is declared — so it would need real inputs (and
 * credentials) and would write a run report into the data tree. The
 * composition is asserted mechanically instead, by `pnpm
 * check:script-scaffold`, whose optional-but-verified tier requires an adopted
 * `src/command.ts` to compose `Core.runScript` and to source its schema from
 * `./config.js`.
 */
describe("agent-operator command module descriptor", () => {
  it("names itself with the script's own kebab-case name", () => {
    // The name is the CLI's dispatch key (ADR-0042 `m3l <script>`), so it must
    // match the package directory exactly. Derived from package.json's scoped
    // name rather than a hardcoded literal: a long script name substituted
    // directly here would push the assertion past prettier's line width,
    // which `check-template-format.mjs` cannot reformat away (ADR-0053 U9).
    expect(commandModule.name).toBe(
      manifest.name.replace("@m3l-automation/", ""),
    );
  });

  // Asserted against package.json rather than a bare "0.0.0" literal, so the
  // manifest is the single source of truth and a bumped package version that
  // never reached the descriptor is caught. `main.ts` holds a third copy that
  // no test can reach without parsing it — a residual drift the CLI's
  // in-process host retires when it unifies the two composition roots.
  it("carries the same version as package.json", () => {
    expect(commandModule.version).toBe(manifest.version);
  });

  // A wiring check, not a drift guard between two hand-written copies:
  // `scriptDescription()` (command.ts) reads `description` from this same
  // package.json at runtime, so both sides of this assertion ultimately come
  // from the one field a host renders in help output. What this proves is
  // that the read-and-wire-through actually works, not that two independent
  // authors' copies stay in sync.
  it("carries the same one-line description as package.json", () => {
    expect(commandModule.description).toBe(manifest.description);
  });

  it("agrees with the package manifest on the script's name", () => {
    expect(manifest.name).toBe(`@m3l-automation/${commandModule.name}`);
  });

  it("exposes execute as a function of two arguments", () => {
    // `typeof`, not `expect(fn).toBeTypeOf(...)`: passing the method as a
    // value trips `@typescript-eslint/unbound-method`, and the point here is
    // the shape, not a callable reference.
    expect(typeof commandModule.execute).toBe("function");
    expect(commandModule.execute.length).toBe(2);
  });

  // Identity, not deep equality: a second parameter literal inside command.ts
  // would be a second source of truth for the schema and could drift from
  // config.ts silently, giving the in-process and spawn paths different
  // configuration contracts.
  it("reuses config.ts's declared schema by identity", () => {
    expect(commandModule.configParameters).toBe(configParameters);
  });

  // This assignment is the whole reason `M3LCommandModule` keeps `name` and
  // `version` flat rather than nested under an `identity` object: the
  // descriptor IS an `M3LScriptMetadata`, so `execute` passes it straight into
  // `new M3LScript({ metadata })` with no adapter and no second literal.
  it("is structurally an M3LScriptMetadata", () => {
    const metadata: Core.M3LScriptMetadata = commandModule;
    expect(metadata.name).toBe(commandModule.name);
    expect(metadata.version).toBe(commandModule.version);
  });
});

describe("agent-operator outcome-to-exit-code parity", () => {
  /**
   * The parity property: for every outcome Core.deriveCommandOutcome can produce, the mapped
   * exit code equals the one `Core.runScript` already assigned to
   * `process.exitCode` on the spawn path. A disagreement means a scheduler
   * sees two different results for the same run depending on how it was
   * invoked — the exact thing ADR-0054's parity clause forbids.
   */
  it("maps a clean run and a dry run to SUCCESS, as runScript leaves it", () => {
    expect(Core.mapCommandOutcomeToExitCode({ status: "success" })).toBe(
      Core.M3L_EXIT_CODES.SUCCESS,
    );
    expect(Core.mapCommandOutcomeToExitCode({ status: "dry-run" })).toBe(
      Core.M3L_EXIT_CODES.SUCCESS,
    );
  });

  it("maps an absorbed-recovery run to PARTIAL, as runScript sets it", () => {
    expect(
      Core.mapCommandOutcomeToExitCode({ status: "partial", recovered: 3 }),
    ).toBe(Core.M3L_EXIT_CODES.PARTIAL);
  });

  it("maps a failure through the same classifier runScript uses", () => {
    const error = new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(Core.mapCommandOutcomeToExitCode({ status: "failure", error })).toBe(
      Core.mapErrorToExitCode(error),
    );
  });

  it("maps an interrupted run to INTERRUPTED, as runScript sets it", () => {
    expect(Core.mapCommandOutcomeToExitCode({ status: "interrupted" })).toBe(
      Core.M3L_EXIT_CODES.INTERRUPTED,
    );
  });

  // Why the `interrupted` arm is load-bearing rather than decorative:
  // `mapErrorToExitCode` is TYPED never to return INTERRUPTED, so routing an
  // abort through the failure arm would map it to 1-4 while runScript set 5.
  it("cannot express an abort as a failure without disagreeing with runScript", () => {
    const abort = new Core.M3LOperationAbortedError("cancelled");
    expect(
      Core.mapCommandOutcomeToExitCode({ status: "failure", error: abort }),
    ).not.toBe(Core.M3L_EXIT_CODES.INTERRUPTED);
  });
});

describe("agent-operator execute wiring", () => {
  /**
   * A host port bag with the fallback writer; `signal` defaults to none.
   *
   * Coverage for `Core.createCommandOutput` and `Core.deriveCommandOutcome`
   * themselves lives in the library's own `cli-contract-output.test.ts` and
   * `cli-contract-outcome.test.ts` — this helper exists only to build a
   * plausible `M3LCommandContext` for driving `execute`.
   */
  function contextFor(
    dryRun: boolean,
    signal?: AbortSignal,
  ): Core.M3LCommandContext {
    return {
      output: Core.createCommandOutput(),
      // A sink-less logger: nothing under test here asserts on emitted log
      // content, so a silent logger keeps the test output clean. `execute`
      // now forwards this straight into `M3LScript` — see the "forwards
      // context.logger" test below for that assertion.
      logger: new Core.M3LLogger([]),
      signal,
      dryRun,
    };
  }

  /**
   * Invokes the `onError` hook `execute` composed onto this script's own
   * hooks — the seam that lets `execute` observe a failure at all, since
   * `runScript` absorbs the error instead of re-throwing.
   */
  async function invokeCapturedOnError(error: unknown): Promise<void> {
    const { hooks } = runMocks.scriptOptions[0] as {
      readonly hooks: Core.M3LScriptLifecycleHooks;
    };
    await hooks.onError?.({} as unknown as Core.M3LScriptHookContext, error);
  }

  afterEach(() => {
    runMocks.scriptOptions.length = 0;
    runMocks.runScriptCalls.length = 0;
    runMocks.recoveryTotal = 0;
    vi.clearAllMocks();
  });

  it("hands runScript a callable main function", async () => {
    await commandModule.execute({}, contextFor(true));
    expect(typeof runMocks.runScriptCalls[0]?.mainFn).toBe("function");
  });

  // The regression guard for a defect a previous revision shipped: passing
  // `commandModule` itself as `metadata` typechecks, but `M3LRunReporter`
  // writes `input.script` into `run-report.json` verbatim and does NOT redact
  // it — so the whole descriptor, including every parameter's `defaultValue`,
  // would land in the report where the spawn path writes two fields.
  it("hands M3LScript only the descriptor's name and version", async () => {
    await commandModule.execute({}, contextFor(true));

    const options = runMocks.scriptOptions[0] as {
      readonly metadata: Record<string, unknown>;
    };
    expect(options.metadata).toEqual({
      name: commandModule.name,
      version: commandModule.version,
    });
  });

  // `execute` now forwards `context.logger` straight into `M3LScriptOptions`
  // (U7, ADR-0054): the port is built by `Core.createCommandLogger`, which
  // already resolves the log-level floor and derives secrets, so there is no
  // longer a reason for `execute` to build its own default logger instead.
  it("forwards context.logger to M3LScript", async () => {
    const logger = new Core.M3LLogger([]);
    await commandModule.execute(
      {},
      {
        output: Core.createCommandOutput(),
        logger,
        signal: undefined,
        dryRun: true,
      },
    );

    const options = runMocks.scriptOptions[0] as { readonly logger: unknown };
    expect(options.logger).toBe(logger);
  });

  // The conditional spread must omit the `host` KEY entirely when no signal
  // was supplied, not merely leave it `undefined` — matching this repo's
  // `exactOptionalPropertyTypes` conventions for forwarding an optional value
  // into a strict target.
  it("omits host entirely when context.signal is undefined", async () => {
    await commandModule.execute({}, contextFor(true));

    const options = runMocks.scriptOptions[0] as Record<string, unknown>;
    expect(Object.hasOwn(options, "host")).toBe(false);
  });

  // The bridge that lets a host's cooperative-cancellation signal (ADR-0049)
  // reach the script: `context.signal`, when present, must land on
  // `M3LScriptOptions.host.signal` by identity.
  it("bridges context.signal into host.signal when present", async () => {
    const controller = new AbortController();
    await commandModule.execute({}, contextFor(true, controller.signal));

    const options = runMocks.scriptOptions[0] as {
      readonly host: { readonly signal: AbortSignal };
    };
    expect(options.host).toEqual({ signal: controller.signal });
    expect(options.host.signal).toBe(controller.signal);
  });

  it("declares the same schema config.ts exports", async () => {
    await commandModule.execute({}, contextFor(true));

    const options = runMocks.scriptOptions[0] as {
      readonly config: { readonly params: unknown };
    };
    expect(options.config.params).toBe(configParameters);
  });

  // `hooks: capture.hooks` must SPREAD this script's declared hooks, not
  // replace them: `Core.captureRunFailures` adds an `onError` for the outcome, and a
  // composition that dropped the spread would silently stop running
  // `onBeforeRun` — which is what captures the correlation id — on the
  // in-process path only. Asserted by key set plus a same-reference check on
  // every hook the script actually declares.
  it("composes onError onto the script's own declared hooks", async () => {
    await commandModule.execute({}, contextFor(true));

    const options = runMocks.scriptOptions[0] as {
      readonly hooks: Record<string, unknown>;
    };
    for (const [name, declared] of Object.entries(
      hooks as Record<string, unknown>,
    )) {
      if (name === "onError") continue;
      expect(options.hooks[name]).toBe(declared);
    }
    expect(typeof options.hooks["onError"]).toBe("function");
  });

  // `context.dryRun` is the one port U6 forwards; the others are accepted and
  // deliberately unused. If this stops reaching `runScript`, `--dry-run` would
  // silently perform real work on the in-process path.
  it("forwards context.dryRun to runScript", async () => {
    await commandModule.execute({}, contextFor(true));
    expect(runMocks.runScriptCalls[0]?.options).toEqual({ dryRun: true });

    runMocks.runScriptCalls.length = 0;
    runMocks.scriptOptions.length = 0;
    await commandModule.execute({}, contextFor(false));
    expect(runMocks.runScriptCalls[0]?.options).toEqual({ dryRun: false });
  });

  it("resolves dry-run when the run absorbed nothing", async () => {
    await expect(commandModule.execute({}, contextFor(true))).resolves.toEqual({
      status: "dry-run",
    });
  });

  it("resolves partial from the script's own recovery count", async () => {
    runMocks.recoveryTotal = 7;
    await expect(commandModule.execute({}, contextFor(false))).resolves.toEqual(
      { status: "partial", recovered: 7 },
    );
  });

  // The composed `onError` is what lets `execute` see a failure at all:
  // `runScript` absorbs the error rather than re-throwing, and `mainFn` is
  // only stage 7 of nine, so a try/catch around it would miss a `config-load`
  // failure entirely and answer `success`.
  it("resolves failure from an error the composed onError captured", async () => {
    const boom = new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    vi.mocked(Core.runScript).mockImplementationOnce(
      async (_script, mainFn, options) => {
        runMocks.runScriptCalls.push({ mainFn, options });
        await invokeCapturedOnError(boom);
      },
    );

    await expect(commandModule.execute({}, contextFor(false))).resolves.toEqual(
      { status: "failure", error: boom },
    );
  });

  it("resolves interrupted when the captured error is a cooperative abort", async () => {
    const abort = new Core.M3LOperationAbortedError("cancelled");
    vi.mocked(Core.runScript).mockImplementationOnce(
      async (_script, mainFn, options) => {
        runMocks.runScriptCalls.push({ mainFn, options });
        await invokeCapturedOnError(abort);
      },
    );

    await expect(commandModule.execute({}, contextFor(false))).resolves.toEqual(
      { status: "interrupted" },
    );
  });
});
