/**
 * Tests for `steps/run-agent-operator` — the top-level dispatcher that wires
 * `config` -> `loadAgentPolicy` -> `resolveAgentOperatorRuntime` ->
 * `createAgentCliSurface` -> `explainPolicy` (PR 1, ADR-0055).
 *
 * Backfill (GREEN): `runAgentOperator` already exists and is exercised here
 * through its REAL collaborators (`loadAgentPolicy`,
 * `resolveAgentOperatorRuntime`) against a real `Core.M3LPaths` pointed at a
 * temp input dir (the same `M3L_INPUT_DIR` pattern `load-policy.test.ts`
 * already established in this package). `runAgentOperator` builds
 * `createAgentCliSurface` internally — it is not an injected `deps` field —
 * so that one collaborator seam (`../../src/lib/cli-surface.js`, a relative
 * module import, never the library barrel) is mocked so no real `m3l` CLI
 * process is ever spawned. Every other collaborator runs for real, which is
 * the whole point: a wrong argument order, a dropped `paths`, or a surface
 * built from stale/default settings is invisible to any test that mocks more
 * than this one seam.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import type {
  AgentOperatorDoctorCheck,
  AgentOperatorListRow,
} from "../../src/lib/cli-envelopes.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  projectDoctorReport,
  projectListRow,
  type AgentOperatorProjectedDoctorReport,
  type AgentOperatorProjectedListRow,
} from "../../src/lib/model-safety.js";
import { runAgentOperator } from "../../src/steps/run-agent-operator.js";
import { fullPolicyDeclaration } from "../support/policyFixtures.js";

/**
 * Builds a real, nominally-branded {@link AgentOperatorProjectedDoctorReport}
 * by running the actual `projectDoctorReport` projector over raw check
 * fixtures — the brand on `AgentOperatorProjectedDoctorCheck` can only be
 * minted inside `model-safety.ts`, so this fake surface must go through the
 * real projector rather than hand-writing an object literal (which would
 * need a disallowed cast).
 */
function buildDoctorReport(
  checks: readonly AgentOperatorDoctorCheck[],
): AgentOperatorProjectedDoctorReport {
  return projectDoctorReport(checks);
}

/**
 * Builds the fake surface's `list()` rows through the REAL `projectListRow`
 * for the same reason {@link buildDoctorReport} exists: every
 * `AgentOperatorProjected*` type is nominally branded, so only the module's
 * own projector may mint one — a hand-written object literal would need a
 * disallowed cast.
 */
function buildListRows(): readonly AgentOperatorProjectedListRow[] {
  const rows: readonly AgentOperatorListRow[] = [
    {
      name: "agent-operator",
      description: "…",
      parameterCount: 20,
      loadError: null,
    },
  ];
  return rows.map((row) => projectListRow(row));
}

vi.mock("../../src/lib/cli-surface.js", () => ({
  createAgentCliSurface: vi.fn(),
}));

// The health-check ARM is mocked, not the workload: this file tests the
// dispatcher, and `run-health-check.test.ts` tests what the arm reaches.
vi.mock("../../src/steps/run-health-check.js", () => ({
  runHealthCheck: vi.fn(() => Promise.resolve()),
}));

import { createAgentCliSurface } from "../../src/lib/cli-surface.js";
import { runHealthCheck } from "../../src/steps/run-health-check.js";

/** Records every event handed to it, for assertion without pinning exact prose. */
class RecordingLoggerHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];
  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}

/** Flattens every recorded event's message + structured data into one searchable string. */
function flattenLoggedText(events: readonly Core.M3LLogEvent[]): string {
  return events
    .map((event) => `${event.message} ${JSON.stringify(event.data ?? {})}`)
    .join("\n");
}

function createLogger(): {
  readonly logger: Core.M3LLogger;
  readonly handler: RecordingLoggerHandler;
} {
  const handler = new RecordingLoggerHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

/**
 * A fake `AgentCliSurface` recording which methods were invoked. `inspect`,
 * `dryRun` and `run` throw if ever called — `explain-policy` never needs a
 * script name, so a call into any of them proves a wiring bug, and `run` is
 * the mutating method this offline, read-only command must never reach.
 */
function createFakeSurface(): {
  readonly surface: AgentCliSurface;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const surface: AgentCliSurface = {
    list() {
      calls.push("list");
      return Promise.resolve(buildListRows());
    },
    doctor() {
      calls.push("doctor");
      return Promise.resolve(
        buildDoctorReport([
          { name: "workspace-root", status: "ok", detail: "ok" },
        ]),
      );
    },
    inspect(): Promise<never> {
      calls.push("inspect");
      throw new Error("unexpected surface.inspect() call");
    },
    dryRun(): Promise<never> {
      calls.push("dryRun");
      throw new Error("unexpected surface.dryRun() call");
    },
    run(): Promise<never> {
      calls.push("run");
      throw new Error("unexpected surface.run() call");
    },
  };
  return { surface, calls };
}

const DEFAULT_ENTRYPOINT = "/fake/repo/packages/m3l-cli/bin/m3l.mjs";

/**
 * One declared `presetAllowlist` grant, in the `"<name>=<path>"` config form
 * `resolveAgentOperatorRuntime` parses. The path is workspace-relative and
 * inside `data/config/presets/`, as that parser requires.
 */
const PRESET_NAME = "nightly-report";
const PRESET_RELATIVE_PATH = "data/config/presets/nightly-report.yaml";

let inputDir: string;
let dataDir: string;

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "agent-operator-run-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "agent-operator-run-data-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(createAgentCliSurface).mockReset();
  vi.mocked(runHealthCheck).mockClear();
  await rm(inputDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * A real `Core.M3LPaths`, pointed at this test's temp input dir **and** temp
 * data dir. `M3L_DATA_DIR` is stubbed for the same reason `M3L_INPUT_DIR` is:
 * `health-check` now writes the cross-run daily invocation counter under
 * `getDataDir()/agent-state`, and a test must never write into the checkout.
 */
function makePaths(): Core.M3LPaths {
  vi.stubEnv("M3L_INPUT_DIR", inputDir);
  vi.stubEnv("M3L_DATA_DIR", dataDir);
  return new Core.M3LPaths();
}

async function writePolicyFixture(
  name: string,
  declaration: unknown,
): Promise<void> {
  await writeFile(
    path.join(inputDir, name),
    JSON.stringify(declaration),
    "utf8",
  );
}

/**
 * A resolved config carrying only the globally-required fields plus an
 * always-explicit `cliEntrypoint` — so `resolveAgentOperatorRuntime` never
 * has to call `paths.getProjectRoot()`, keeping these tests independent of
 * which deployment mode `M3LExecutionEnvironment` detects in this checkout.
 */
function buildConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Core.M3LConfig {
  const config = new Core.M3LConfig();
  config.set(Core.AWS_PROFILE_PARAM_NAME, "sandbox");
  config.set("command", "explain-policy");
  config.set("modelId", "anthropic.claude-3-5-sonnet-20241022-v2:0");
  config.set("cliEntrypoint", DEFAULT_ENTRYPOINT);
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

describe("runAgentOperator — explain-policy wiring", () => {
  it("loads the policy, resolves the runtime, builds the CLI surface from it, and renders through explainPolicy", async () => {
    // A non-default `policyFile` name: proves the config value is actually
    // read and threaded through, not a hardcoded "agent-policy.json".
    const policyFileName = "custom-agent-policy.json";
    await writePolicyFixture(policyFileName, fullPolicyDeclaration());

    const { surface, calls } = createFakeSurface();
    vi.mocked(createAgentCliSurface).mockReturnValue(surface);

    const { logger, handler } = createLogger();
    const controller = new AbortController();
    const reportRecovery = vi.fn();
    const config = buildConfig({
      policyFile: policyFileName,
      cliTimeoutMs: 12_345,
      dryRunTimeoutMs: 67_890,
      maxOutputBytes: 2_000_000,
      dryRunAllowlist: ["json-etl"],
      // A NON-EMPTY, recognisable preset grant. The pin below asserts this
      // exact entry arrives at the surface, so a wiring that hands over
      // `new Map()` (or drops the option) cannot satisfy it — which is the
      // bug class this fixture exists for.
      presetAllowlist: [`${PRESET_NAME}=${PRESET_RELATIVE_PATH}`],
    });

    await runAgentOperator({
      config,
      logger,
      paths: makePaths(),
      signal: controller.signal,
      reportRecovery,
      aws: undefined,
    });

    // The CLI seam was genuinely exercised on the real explainPolicy code
    // path — not skipped, not mocked away.
    expect(calls.filter((call) => call === "list")).toHaveLength(1);
    expect(calls.filter((call) => call === "doctor")).toHaveLength(1);
    expect(calls).not.toContain("inspect");
    expect(calls).not.toContain("dryRun");
    // `explain-policy` is read-only: the mutating method is never reached,
    // even with a preset grant declared in config.
    expect(calls).not.toContain("run");

    // The rendered text carries the loaded fixture's OWN content (from
    // fullPolicyDeclaration(), not a default/empty policy) — proving
    // load -> resolve -> render actually threaded the right file through.
    const text = flattenLoggedText(handler.events);
    expect(text).toContain("s3-objects");
    expect(text).toMatch(/1000/); // tokensPerRun

    // Wiring correctness: createAgentCliSurface received the settings
    // resolve-runtime derived from THIS config/paths — not defaults, and
    // not a value dropped in argument shuffling.
    expect(createAgentCliSurface).toHaveBeenCalledTimes(1);
    expect(createAgentCliSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        entrypoint: DEFAULT_ENTRYPOINT,
        cwd: path.dirname(DEFAULT_ENTRYPOINT),
        nodeExecPath: process.execPath,
        cliTimeoutMs: 12_345,
        dryRunTimeoutMs: 67_890,
        maxOutputBytes: 2_000_000,
        // `includeDryRunProbes` is unset (its default is off) in this
        // config, so the configured allowlist must NOT arm the `dry-run`
        // tool — the gate is the flag, and an allowlist alone is inert.
        // (Corrected from a previous pin of `new Set(["json-etl"])`, which
        // codified the ungated behaviour.)
        dryRunAllowlist: new Set(),
        // The parsed `presetAllowlist` must reach the surface, or the config
        // parameter is inert and every `run` call rejects on an empty
        // lookup. Pinned as the exact one-entry map the resolved runtime
        // carries — `expect.any(Map)` or an empty map would be satisfied by
        // a site that passed `new Map()`, which is precisely the defect.
        presetAllowlist: new Map([[PRESET_NAME, PRESET_RELATIVE_PATH]]),
        signal: controller.signal,
      }),
    );

    // This offline slice absorbs no per-action failure — reportRecovery is
    // threaded onto the seam for a later slice but unused today.
    expect(reportRecovery).not.toHaveBeenCalled();
  });
});

describe("runAgentOperator — command validation", () => {
  // `isKnownCommand` is the runtime guard that keeps the dispatch `switch`'s
  // `default: { const exhaustive: never = rawCommand; ... }` arm reachable
  // only if this guard were broken — TypeScript proves the arm unreachable
  // at compile time GIVEN the guard's type predicate, but the predicate
  // itself is a runtime check against `AGENT_OPERATOR_COMMANDS`. These two
  // cases prove the guard actually rejects what it claims to, which is what
  // makes that compile-time guarantee sound in the first place.
  it.each([
    ["a non-string value", 123],
    ["an empty string", ""],
    ["a string outside the declared operation set", "delete-everything"],
  ])(
    "throws an ERR_AGENT_OPERATOR_CONFIG-coded error for %s",
    async (_label, command) => {
      const { logger } = createLogger();
      const config = buildConfig({ command });

      let thrown: unknown;
      try {
        await runAgentOperator({
          config,
          logger,
          paths: makePaths(),
          signal: new AbortController().signal,
          reportRecovery: vi.fn(),
          aws: undefined,
        });
      } catch (error) {
        thrown = error;
      }

      // A non-string/empty value never reaches isKnownCommand — it fails
      // earlier in M3LConfigAccessor.requiredString, as a plain Core.M3LError
      // (not the M3LAgentOperatorCliError subclass) but the SAME pinned
      // code, since both accessors are constructed with
      // `code: "ERR_AGENT_OPERATOR_CONFIG"`.
      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe("ERR_AGENT_OPERATOR_CONFIG");
      expect(createAgentCliSurface).not.toHaveBeenCalled();
    },
  );

  it("throws M3LAgentOperatorCliError with a fixed message when isKnownCommand rejects a well-formed but undeclared operation string", async () => {
    const { logger } = createLogger();
    const config = buildConfig({ command: "delete-everything" });

    let thrown: unknown;
    try {
      await runAgentOperator({
        config,
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
        aws: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    expect(asError.message).toBe(
      "'command' must be one of the declared agent-operator operations",
    );
  });
});

describe("runAgentOperator — maxIterations vs. policy budget cross-check", () => {
  it("propagates resolve-runtime's ERR_AGENT_OPERATOR_CONFIG cross-check failure out of runAgentOperator, rather than swallowing it", async () => {
    const policyFileName = "budget-policy.json";
    await writePolicyFixture(policyFileName, {
      version: 1,
      scripts: [{ script: "agent-operator", allOperations: true }],
      budgets: { loopIterations: 2 },
    });

    const { surface } = createFakeSurface();
    vi.mocked(createAgentCliSurface).mockReturnValue(surface);
    const { logger } = createLogger();
    const config = buildConfig({
      policyFile: policyFileName,
      maxIterations: 10,
    });

    let thrown: unknown;
    try {
      await runAgentOperator({
        config,
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
        aws: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
    expect(asError.message).toMatch(/loopIterations/);
    // The failure happened before the CLI surface was ever built — proving
    // it propagated out of resolve-runtime rather than being absorbed and
    // the run continuing regardless.
    expect(createAgentCliSurface).not.toHaveBeenCalled();
  });
});

/**
 * Runs `explain-policy` with `overrides` merged into the base config and
 * returns the options object `createAgentCliSurface` was actually built
 * with — the observable seam for both the dry-run gate and the
 * workspace-root scrub below.
 */
async function captureSurfaceOptions(
  overrides: Readonly<Record<string, unknown>>,
  paths?: Core.M3LPaths,
): Promise<Parameters<typeof createAgentCliSurface>[0]> {
  const policyFileName = "gate-policy.json";
  await writePolicyFixture(policyFileName, fullPolicyDeclaration());
  const { surface } = createFakeSurface();
  vi.mocked(createAgentCliSurface).mockReturnValue(surface);
  const { logger } = createLogger();

  await runAgentOperator({
    config: buildConfig({ policyFile: policyFileName, ...overrides }),
    logger,
    paths: paths ?? makePaths(),
    signal: new AbortController().signal,
    reportRecovery: vi.fn(),
    aws: undefined,
  });

  const call = vi.mocked(createAgentCliSurface).mock.calls[0];
  if (call === undefined) {
    throw new Error("createAgentCliSurface was never called");
  }
  return call[0];
}

describe("runAgentOperator — includeDryRunProbes gates the dry-run allowlist", () => {
  // `includeDryRunProbes` is declared (config.ts), cross-validated
  // (configValidators), and resolved (resolve-runtime.ts) — and the
  // reference page documents it as "Enables the `dry-run` tool". The
  // dispatcher must therefore read it: an allowlist alone arms nothing.
  // Fail closed — absent or false means an EMPTY allowlist reaches the
  // surface, so a mis-set flag cannot silently enable a destructive probe.
  it.each([
    ["absent (schema default)", {}],
    ["explicitly false", { includeDryRunProbes: false }],
  ])(
    "passes an empty dryRunAllowlist when includeDryRunProbes is %s, even with an allowlist configured",
    async (_label, flagOverride) => {
      const options = await captureSurfaceOptions({
        dryRunAllowlist: ["json-etl"],
        ...flagOverride,
      });

      expect([...options.dryRunAllowlist]).toEqual([]);
    },
  );

  it("passes the configured allowlist through when includeDryRunProbes is true", async () => {
    const options = await captureSurfaceOptions({
      includeDryRunProbes: true,
      dryRunAllowlist: ["json-etl", "sqs-etl"],
    });

    expect([...options.dryRunAllowlist].sort()).toEqual([
      "json-etl",
      "sqs-etl",
    ]);
  });

  it("passes an empty dryRunAllowlist when includeDryRunProbes is true but no allowlist is configured", async () => {
    const options = await captureSurfaceOptions({
      includeDryRunProbes: true,
    });

    expect([...options.dryRunAllowlist]).toEqual([]);
  });
});

describe("runAgentOperator — workspace-root scrub degradation", () => {
  it("logs a warning when getProjectRoot fails and the absolute-path scrub is disabled", async () => {
    const policyFileName = "standalone-policy.json";
    await writePolicyFixture(policyFileName, fullPolicyDeclaration());
    const { surface } = createFakeSurface();
    vi.mocked(createAgentCliSurface).mockReturnValue(surface);
    const { logger, handler } = createLogger();
    const paths = makePaths();
    // STANDALONE mode: there is no monorepo root to scrub against.
    vi.spyOn(paths, "getProjectRoot").mockImplementation(() => {
      throw new Core.M3LPathResolutionError(
        "getProjectRoot() is only available in MONOREPO mode",
      );
    });

    await runAgentOperator({
      config: buildConfig({ policyFile: policyFileName }),
      logger,
      paths,
      signal: new AbortController().signal,
      reportRecovery: vi.fn(),
      aws: undefined,
    });

    // The run continues (degrade, never fail) with the scrub off …
    const call = vi.mocked(createAgentCliSurface).mock.calls[0];
    expect(call?.[0].workspaceRoot).toBeUndefined();

    // … but the degradation is recorded, not silent: in this mode absolute
    // host paths reach the model unmasked, and today nothing says so.
    const warnings = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(flattenLoggedText(warnings).toLowerCase()).toMatch(
      /workspace root|workspace-root/,
    );
  });

  it("propagates a non-M3LPathResolutionError out of getProjectRoot instead of absorbing it", async () => {
    // Regression lock: this arm already behaves correctly today (the `if
    // (!(cause instanceof Core.M3LPathResolutionError)) throw cause;`
    // rethrow), but it had no coverage — so a future `catch { return
    // undefined; }` simplification would have gone unnoticed.
    const policyFileName = "rethrow-policy.json";
    await writePolicyFixture(policyFileName, fullPolicyDeclaration());
    const { surface } = createFakeSurface();
    vi.mocked(createAgentCliSurface).mockReturnValue(surface);
    const { logger } = createLogger();
    const paths = makePaths();
    const failure = new Error("EIO: readlink failed");
    vi.spyOn(paths, "getProjectRoot").mockImplementation(() => {
      throw failure;
    });

    let thrown: unknown;
    try {
      await runAgentOperator({
        config: buildConfig({ policyFile: policyFileName }),
        logger,
        paths,
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
        aws: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(createAgentCliSurface).not.toHaveBeenCalled();
  });
});

describe("runAgentOperator — health-check delegates to the workload step", () => {
  // `health-check`'s behaviour moved to `steps/run-health-check` when the
  // model loop landed. What stays this dispatcher's job — and all this test
  // asserts — is that the arm reaches that step at all, with the SAME deps
  // object it was handed. `run-health-check.test.ts` owns the workload's own
  // behaviour; duplicating it here would just make two files fail for one
  // cause.
  it("calls runHealthCheck with the dispatcher's own deps, and never builds the explain-policy CLI surface itself", async () => {
    const { logger } = createLogger();
    const config = buildConfig({ command: "health-check" });
    const signal = new AbortController().signal;
    const reportRecovery = vi.fn();
    const paths = makePaths();

    await runAgentOperator({
      config,
      logger,
      paths,
      signal,
      reportRecovery,
      aws: undefined,
    });

    expect(runHealthCheck).toHaveBeenCalledTimes(1);
    expect(runHealthCheck).toHaveBeenCalledWith({
      config,
      logger,
      paths,
      signal,
      reportRecovery,
      aws: undefined,
    });
    // The dispatcher builds no CLI surface of its own for this arm — the
    // workload step owns that, and a surface built here would be a second,
    // unused one.
    expect(createAgentCliSurface).not.toHaveBeenCalled();
  });
});
