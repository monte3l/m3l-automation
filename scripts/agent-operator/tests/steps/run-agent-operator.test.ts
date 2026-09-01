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

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { openDailyInvocationCounter } from "../../src/steps/daily-counter.js";
import {
  budgetPolicyDeclaration,
  decisionLogPolicyDeclaration,
  fullPolicyDeclaration,
  realAgentPolicyDeclaration,
} from "../support/policyFixtures.js";

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

import { createAgentCliSurface } from "../../src/lib/cli-surface.js";

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
 * A fake `AgentCliSurface` recording which methods were invoked. `inspect`
 * and `dryRun` throw if ever called — `explain-policy` never needs a script
 * name, so a call into either proves a wiring bug.
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
  };
  return { surface, calls };
}

const DEFAULT_ENTRYPOINT = "/fake/repo/packages/m3l-cli/bin/m3l.mjs";

let inputDir: string;
let dataDir: string;

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "agent-operator-run-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "agent-operator-run-data-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(createAgentCliSurface).mockReset();
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

/** The cross-run daily invocation counter file, under the stubbed data root. */
function counterPath(): string {
  return path.join(dataDir, "agent-state", "daily-invocations.checkpoint.json");
}

/** `true` when `health-check` left a counter file behind. */
async function counterExists(): Promise<boolean> {
  try {
    await readFile(counterPath(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The counter file's decoded payload — the day's persisted absolute total. */
async function readCounterPayload(): Promise<Record<string, unknown>> {
  const envelope = asRecord(JSON.parse(await readFile(counterPath(), "utf8")));
  return asRecord(envelope["payload"]);
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
    });

    await runAgentOperator({
      config,
      logger,
      paths: makePaths(),
      signal: controller.signal,
      reportRecovery,
    });

    // The CLI seam was genuinely exercised on the real explainPolicy code
    // path — not skipped, not mocked away.
    expect(calls.filter((call) => call === "list")).toHaveLength(1);
    expect(calls.filter((call) => call === "doctor")).toHaveLength(1);
    expect(calls).not.toContain("inspect");
    expect(calls).not.toContain("dryRun");

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
        signal: controller.signal,
      }),
    );

    // This offline slice absorbs no per-action failure — reportRecovery is
    // threaded onto the seam for a later slice but unused today.
    expect(reportRecovery).not.toHaveBeenCalled();
  });
});

/** Narrows a parsed JSON value to a record without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Asserts `value` is a record and returns it, for JSONL field reads. */
function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

/**
 * Reads every decision-log line the real `Core.M3LAgentDecisionLog` wrote into
 * `directory`. Returns `[]` when the directory does not exist — which is the
 * assertion the abort-ordering test below needs.
 */
async function readDecisionLogEntries(
  directory: string,
): Promise<readonly Record<string, unknown>[]> {
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const name of [...names].sort()) {
    const text = await readFile(path.join(directory, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      entries.push(asRecord(JSON.parse(line) as unknown));
    }
  }
  return entries;
}

/**
 * The ordered list of milestone `step` values the run logged — the ONE shared
 * call list the health-check wiring tests read, so the phase order is asserted
 * rather than inferred from end state. Each milestone is a log event carrying
 * `data.step`; extra steps are allowed, order is not.
 */
function stepTrail(events: readonly Core.M3LLogEvent[]): readonly string[] {
  const trail: string[] = [];
  for (const event of events) {
    const step = event.data?.["step"];
    if (typeof step === "string") trail.push(step);
  }
  return trail;
}

describe("runAgentOperator — health-check runs the audit spine", () => {
  // Was: "'health-check' is declared but not implemented" (it threw
  // ERR_AGENT_OPERATOR_CONFIG). This slice replaces that fail-fast with the
  // real audit spine — load policy, build the ledger, run the decision-log
  // preflight — and reports the MODEL LOOP as the part still pending, exiting
  // cleanly rather than throwing.
  it("loads the policy, runs the preflight, and reports the model loop as pending instead of throwing", async () => {
    const policyFileName = "health-check-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger, handler } = createLogger();

    await expect(
      runAgentOperator({
        config: buildConfig({
          command: "health-check",
          policyFile: policyFileName,
          agentName: "audit-spine-test",
          decisionLogDir: logDirectory,
        }),
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      }),
    ).resolves.toBeUndefined();

    const trail = stepTrail(handler.events);
    expect(trail).toContain("policy-loaded");
    expect(trail).toContain("preflight-complete");
    expect(trail).toContain("model-loop-pending");
    expect(trail.indexOf("policy-loaded")).toBeLessThan(
      trail.indexOf("preflight-complete"),
    );
    expect(trail.indexOf("preflight-complete")).toBeLessThan(
      trail.indexOf("model-loop-pending"),
    );

    // The model-driven workload is what is still pending — not the operation.
    const text = flattenLoggedText(handler.events);
    expect(text).toMatch(/pending/i);
    // No CLI process is spawned for health-check in this slice.
    expect(createAgentCliSurface).not.toHaveBeenCalled();
  });

  it("writes both the bootstrap and the concluding decision-log entry through the real writer", async () => {
    const policyFileName = "health-check-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger } = createLogger();

    await runAgentOperator({
      config: buildConfig({
        command: "health-check",
        policyFile: policyFileName,
        agentName: "audit-spine-test",
        decisionLogDir: logDirectory,
      }),
      logger,
      paths: makePaths(),
      signal: new AbortController().signal,
      reportRecovery: vi.fn(),
    });

    const entries = await readDecisionLogEntries(logDirectory);
    // Was "exactly one entry": only the BOOTSTRAP decision reached the log, so
    // the durable audit trail carried the verdict the run started from and
    // never the one it concluded on. Both are recorded now — and "exactly",
    // the original intent, is preserved as an exact length of two, so a
    // duplicated or dropped write still fails.
    expect(entries).toHaveLength(2);
    const entry = asRecord(entries[0]);
    // The bootstrap decision is recorded truthfully: the first evaluation of
    // the run genuinely cannot observe the log, so it escalates on the
    // `.unobservable` rule. A seeded `decisionLogAvailable` would show up here
    // as an `auto-approved` entry.
    expect(entry["verdict"]).toBe("escalate");
    expect(entry["rule"]).toBe("decision-log-unavailable.unobservable");
    // The identity comes from the configured `agentName`, not a hardcoded one.
    expect(asRecord(entry["identity"])["name"]).toBe("audit-spine-test");

    // The concluding entry: this budget-free fixture policy grants
    // `health-check` as a read-only operation, so once the log has been
    // observed the re-evaluated verdict is genuinely auto-approved — which is
    // why this run resolves rather than surfacing an escalation.
    const conclusion = asRecord(entries[1]);
    expect(conclusion["verdict"]).toBe("auto-approved");
    expect(conclusion["rule"]).not.toBe("decision-log-unavailable");
    expect(conclusion["rule"]).not.toBe(
      "decision-log-unavailable.unobservable",
    );
    expect(asRecord(conclusion["identity"])["name"]).toBe("audit-spine-test");
  });

  it("aborts before any decision-log write when the policy cannot be loaded", async () => {
    // Ordering, proven by failure injection: the policy load precedes the
    // preflight, so an unloadable policy leaves no audit artefact behind.
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger, handler } = createLogger();

    let thrown: unknown;
    try {
      await runAgentOperator({
        config: buildConfig({
          command: "health-check",
          policyFile: "no-such-policy.json",
          decisionLogDir: logDirectory,
        }),
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_POLICY",
    );
    expect(await readDecisionLogEntries(logDirectory)).toEqual([]);
    expect(stepTrail(handler.events)).not.toContain("preflight-complete");
    expect(stepTrail(handler.events)).not.toContain("model-loop-pending");
  });
});

describe("runAgentOperator — health-check seeds the daily invocation counter", () => {
  /** A `health-check` config wired at this test's temp policy + log locations. */
  function healthCheckConfig(
    policyFileName: string,
    logDirectory: string,
  ): Core.M3LConfig {
    return buildConfig({
      command: "health-check",
      policyFile: policyFileName,
      agentName: "daily-counter-test",
      decisionLogDir: logDirectory,
    });
  }

  // THE headline test of this slice. Against a policy declaring
  // `invocationsPerRun` + `invocationsPerDay` + `tokensPerRun`, the evaluator
  // reports the FIRST unsatisfied ceiling in its own fixed order
  // (`invocationsPerRun -> invocationsPerDay -> tokensPerRun -> costPerRun ->
  // loopIterations`). Before this slice that was
  // `budget.invocations-per-day.unobservable`; the counter moves it exactly
  // one slot, to `budget.tokens-per-run.unobservable`, which is what the
  // metering invoker closes in the next slice.
  //
  // This is deliberately a sharper assertion than "the run passes": moving
  // `counter.seed()` below the preflight — or deleting the seeding entirely —
  // flips the reported rule straight back to the per-day one.
  it("moves the escalation off budget.invocations-per-day.unobservable and onto the next declared ceiling", async () => {
    const policyFileName = "per-day-policy.json";
    await writePolicyFixture(
      policyFileName,
      budgetPolicyDeclaration({
        invocationsPerRun: 60,
        invocationsPerDay: 400,
        tokensPerRun: 200_000,
      }),
    );
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger } = createLogger();

    let thrown: unknown;
    try {
      await runAgentOperator({
        config: healthCheckConfig(policyFileName, logDirectory),
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_ESCALATED");
    expect(asError.context?.["rule"]).toBe(
      "budget.tokens-per-run.unobservable",
    );
    expect(asError.context?.["rule"]).not.toBe(
      "budget.invocations-per-day.unobservable",
    );
  });

  it("logs the daily-counter step before the preflight, never after it", async () => {
    // Ordering, stated as a trail rather than inferred from end state:
    // `runDecisionLogPreflight` snapshots the ledger TWICE, so a baseline
    // seeded after it would leave both phases escalating on the per-day rule.
    const policyFileName = "health-check-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger, handler } = createLogger();

    await runAgentOperator({
      config: healthCheckConfig(policyFileName, logDirectory),
      logger,
      paths: makePaths(),
      signal: new AbortController().signal,
      reportRecovery: vi.fn(),
    });

    const trail = stepTrail(handler.events);
    expect(trail).toContain("daily-counter-loaded");
    expect(trail.indexOf("policy-loaded")).toBeLessThan(
      trail.indexOf("daily-counter-loaded"),
    );
    expect(trail.indexOf("daily-counter-loaded")).toBeLessThan(
      trail.indexOf("preflight-complete"),
    );
  });

  it("carries a persisted prior-day total into the evaluation, so a spent budget escalates as EXHAUSTED rather than unobservable", async () => {
    // Proves the file is genuinely read — not merely created. At the
    // reject-AT bound (`observed >= ceiling`) the rule must be the exhausted
    // one; a counter that silently restarted at 0 would auto-approve here.
    const policyFileName = "per-day-only-policy.json";
    await writePolicyFixture(
      policyFileName,
      budgetPolicyDeclaration({ invocationsPerDay: 400 }),
    );
    const logDirectory = path.join(inputDir, "agent-log");
    const paths = makePaths();
    const planted = await openDailyInvocationCounter({
      paths,
      now: Date.now(),
    });
    await planted.record(400);

    let thrown: unknown;
    try {
      await runAgentOperator({
        config: healthCheckConfig(policyFileName, logDirectory),
        logger: createLogger().logger,
        paths,
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as M3LAgentOperatorCliError).context?.["rule"]).toBe(
      "budget.invocations-per-day",
    );
  });

  it("records the run's consumption only after the conclusion is auto-approved", async () => {
    const policyFileName = "health-check-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const logDirectory = path.join(inputDir, "agent-log");

    await runAgentOperator({
      config: healthCheckConfig(policyFileName, logDirectory),
      logger: createLogger().logger,
      paths: makePaths(),
      signal: new AbortController().signal,
      reportRecovery: vi.fn(),
    });

    // Zero, honestly: no model invocation can occur in this slice. The write
    // is kept anyway — it creates the state directory, exercises the atomic
    // write in production, and materialises the rollover onto today.
    expect(await readCounterPayload()).toMatchObject({ invocations: 0 });
  });

  it("records no consumption when the policy declined the concluding verdict", async () => {
    const policyFileName = "declining-policy.json";
    await writePolicyFixture(
      policyFileName,
      budgetPolicyDeclaration({ tokensPerRun: 200_000 }),
    );
    const logDirectory = path.join(inputDir, "agent-log");

    await expect(
      runAgentOperator({
        config: healthCheckConfig(policyFileName, logDirectory),
        logger: createLogger().logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "ERR_AGENT_OPERATOR_ESCALATED" });

    // Both decision-log entries ARE durable — the audit trail records the
    // refusal — but no consumption is claimed for a run that never ran.
    expect(await readDecisionLogEntries(logDirectory)).toHaveLength(2);
    expect(await counterExists()).toBe(false);
  });

  it("writes no counter file when the policy cannot be loaded", async () => {
    // The counter is the second artefact under the rule the audit log
    // already pins: an unloadable policy must leave nothing behind.
    await expect(
      runAgentOperator({
        config: healthCheckConfig(
          "no-such-policy.json",
          path.join(inputDir, "agent-log"),
        ),
        logger: createLogger().logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "ERR_AGENT_OPERATOR_POLICY" });

    expect(await counterExists()).toBe(false);
  });

  it("samples now once, at the top, and threads that one instant into the counter write", async () => {
    // A run straddling UTC midnight must not roll the counter under one
    // instant and be judged under another. "Called once" is the wrong
    // assertion — the library's own decision log reads the clock too — so
    // the VALUE is pinned instead: a monotonically advancing clock makes a
    // re-sample at the write site produce a different `countedAt`, while a
    // single hoisted sample threads the FIRST reading all the way through.
    const policyFileName = "health-check-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const paths = makePaths();
    const first = Date.UTC(2026, 8, 1, 12, 0, 0);
    let tick = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => first + tick++ * 1000);

    await runAgentOperator({
      config: healthCheckConfig(
        policyFileName,
        path.join(inputDir, "agent-log"),
      ),
      logger: createLogger().logger,
      paths,
      signal: new AbortController().signal,
      reportRecovery: vi.fn(),
    });

    // More than one reading happened (so the pin below is not vacuous), and
    // the counter still carries the FIRST one.
    expect(nowSpy.mock.calls.length).toBeGreaterThan(1);
    expect(await readCounterPayload()).toMatchObject({ countedAt: first });
    nowSpy.mockRestore();
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
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(createAgentCliSurface).not.toHaveBeenCalled();
  });
});

/**
 * Narrows a JSONL field to a `readonly string[]` without a cast, so a shape
 * drift in the recorded entry fails loudly here instead of silently widening
 * the assertions below.
 */
function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  const items: unknown[] = value;
  const strings: string[] = [];
  for (const item of items) {
    if (typeof item !== "string")
      throw new Error("expected an array of strings");
    strings.push(item);
  }
  return strings;
}

describe("runAgentOperator — health-check's default decision-log directory", () => {
  it("resolves with decisionLogDir absent, writing to the library's default directory", async () => {
    // `decisionLogDir` is declared bare-optional with NO `defaultValue`
    // (src/config.ts), so an ABSENT value is the normal deployment case — yet
    // every other health-check test in this file sets it, leaving the default
    // branch of `buildDecisionRecorder`'s
    // `directory === undefined ? new Core.M3LAgentDecisionLog() : new
    // Core.M3LAgentDecisionLog({ directory })` completely unexercised. That
    // ternary is load-bearing: the library reads `directory` presence with
    // `Object.hasOwn`, so an options bag carrying the key with `undefined`
    // throws `ERR_INVALID_ARGUMENT` — an error outside this script's
    // seven-code family — on every real run.
    //
    // This case passes against today's implementation: it is a mutation lock,
    // not a proof of new behaviour. Collapse the ternary (or make the
    // directory required) and it is the only test in the package that fails.
    //
    // The library default resolves to `new Core.M3LPaths().getDataDir()`
    // joined with `"agent-log"`, i.e. this checkout's gitignored
    // `data/agent-log/`. `makePaths()` stubs `M3L_DATA_DIR` at this test's own
    // temp data dir purely for HERMETICITY — so the run writes neither the
    // decision log nor the daily counter into the repo. It is not a way of
    // configuring the script: `decisionLogDir` itself stays genuinely absent,
    // which is the thing under test, and the assertion below asserts that
    // absence rather than assuming it.
    const policyFileName = "default-log-dir-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const { logger, handler } = createLogger();
    const config = buildConfig({
      command: "health-check",
      policyFile: policyFileName,
      agentName: "audit-spine-test",
    });

    // The precondition, asserted through the same accessor the step uses.
    expect(
      new Core.M3LConfigAccessor({
        config,
        code: "ERR_AGENT_OPERATOR_CONFIG",
      }).optionalString("decisionLogDir"),
    ).toBeUndefined();

    await expect(
      runAgentOperator({
        config,
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      }),
    ).resolves.toBeUndefined();

    // The entries landed under the LIBRARY's default location — `getDataDir()`
    // + "agent-log" — not under a path this script invented.
    const entries = await readDecisionLogEntries(
      path.join(dataDir, "agent-log"),
    );
    expect(entries.length).toBeGreaterThan(0);
    const entry = asRecord(entries[0]);
    expect(entry["verdict"]).toBe("escalate");
    expect(asRecord(entry["identity"])["name"]).toBe("audit-spine-test");
    expect(stepTrail(handler.events)).toContain("model-loop-pending");
  });
});

/** Sentinels planted in config so the escalation error can be proven not to echo them. */
const SENSITIVE_AGENT_NAME = "zzagentnamezz";
const SENSITIVE_MODEL_ID = "zzmodelidzz";

describe("runAgentOperator — health-check surfaces a non-auto-approved conclusion", () => {
  it("rejects instead of exiting 0 when the run concluded on an escalation", async () => {
    // The committed `data/input/agent-policy.json` declares all five budgets
    // and this slice meters none of them, so the CONCLUDING decision escalates
    // on a `budget.*.unobservable` rule. Today `runHealthCheck` never inspects
    // that verdict, so this run resolves — exit 0 — on a run the policy
    // escalated, while the log carries a verdict that is not the one the run
    // ended on.
    //
    // The gate must be `Core.isAgentActionAutoApproved(decision)`. NOT
    // `verdict !== "allow"`: the closed verdict set is
    // `auto-approved | escalate | denied`, so that literal is dead code that
    // never fires. NOT `verdict !== "denied"` either: that lets every
    // escalation through, which is exactly this defect.
    const policyFileName = "committed-agent-policy.json";
    await writePolicyFixture(
      policyFileName,
      await realAgentPolicyDeclaration(),
    );
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger, handler } = createLogger();

    let thrown: unknown;
    try {
      await runAgentOperator({
        config: buildConfig({
          command: "health-check",
          policyFile: policyFileName,
          agentName: SENSITIVE_AGENT_NAME,
          modelId: SENSITIVE_MODEL_ID,
          decisionLogDir: logDirectory,
        }),
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const asError = thrown as M3LAgentOperatorCliError;
    // `ERR_AGENT_OPERATOR_ESCALATED` — its own member of this script's closed
    // code family. Not `ERR_AGENT_OPERATOR_POLICY`: that code means the policy
    // file is missing, unreadable, malformed or structurally invalid, and this
    // is the opposite — the policy working correctly and declining to
    // auto-approve. Not `ERR_AGENT_OPERATOR_DECISION_LOG` either: the log was
    // perfectly writable here. Conflating any two of the three destroys the
    // discriminant at the only place a catch site reads it.
    expect(asError.code).toBe("ERR_AGENT_OPERATOR_ESCALATED");

    // The surfaced text carries the library-authored verdict, never a config
    // value read back out — an agent name, a model id, a filesystem path, or a
    // policy file name.
    const surfaced = `${asError.message} ${JSON.stringify(asError.context)}`;
    expect(surfaced).not.toContain(SENSITIVE_AGENT_NAME);
    expect(surfaced).not.toContain(SENSITIVE_MODEL_ID);
    expect(surfaced).not.toContain(logDirectory);
    expect(surfaced).not.toContain(policyFileName);

    // The audit trail is complete BEFORE the escalation surfaces: the
    // concluding verdict is durable, not lost to the throw.
    const entries = await readDecisionLogEntries(logDirectory);
    expect(entries).toHaveLength(2);
    const conclusion = asRecord(entries[1]);
    expect(conclusion["verdict"]).toBe("escalate");
    expect(String(conclusion["rule"])).toMatch(/^budget\..+\.unobservable$/);

    // …and the run never reported itself successful.
    expect(stepTrail(handler.events)).not.toContain("model-loop-pending");
  });

  it("still resolves when the concluding decision IS auto-approved", async () => {
    // The other arm, so the gate above cannot be satisfied by rejecting
    // unconditionally: with the budget-free fixture policy the conclusion is
    // genuinely `auto-approved` and the run must still exit cleanly.
    const policyFileName = "auto-approved-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const { logger, handler } = createLogger();

    await expect(
      runAgentOperator({
        config: buildConfig({
          command: "health-check",
          policyFile: policyFileName,
          agentName: "audit-spine-test",
          decisionLogDir: path.join(inputDir, "agent-log"),
        }),
        logger,
        paths: makePaths(),
        signal: new AbortController().signal,
        reportRecovery: vi.fn(),
      }),
    ).resolves.toBeUndefined();

    expect(stepTrail(handler.events)).toContain("model-loop-pending");
  });
});

/**
 * The parameters a `health-check` run actually resolves out of config:
 * `command` (the dispatcher), then `policyFile`, `decisionLogDir`,
 * `agentName` and `modelId` (the audit spine). Declared `as const` so the
 * shape-key fixture below cannot drift from the list it is derived from.
 */
const HEALTH_CHECK_PARAMETER_NAMES = [
  "command",
  "policyFile",
  "decisionLogDir",
  "agentName",
  "modelId",
] as const;

describe("runAgentOperator — health-check's declared parameterNames", () => {
  it("declares every parameter the run resolves, so the shape key matches a fuller declaration of the same action", async () => {
    // `healthCheckAction()` declares `parameterNames: ["command"]`, but the run
    // resolves `policyFile`, `decisionLogDir`, `agentName` and `modelId` too.
    // `parameterNames` feeds the audit record AND the shape key
    // (`Core.agentActionShapeKey` hashes `{ script, operation, kind,
    // parameterNames }`), so the understated list both under-reports the entry
    // and produces a key that will not match a later, fuller declaration of
    // the same action — silently defeating dry-run-first shape matching.
    const policyFileName = "parameter-names-policy.json";
    await writePolicyFixture(policyFileName, decisionLogPolicyDeclaration());
    const logDirectory = path.join(inputDir, "agent-log");
    const { logger } = createLogger();

    await runAgentOperator({
      config: buildConfig({
        command: "health-check",
        policyFile: policyFileName,
        agentName: "audit-spine-test",
        decisionLogDir: logDirectory,
      }),
      logger,
      paths: makePaths(),
      signal: new AbortController().signal,
      reportRecovery: vi.fn(),
    });

    const entries = await readDecisionLogEntries(logDirectory);
    const entry = asRecord(entries[0]);
    const recorded = asStringArray(entry["parameterNames"]);

    expect(recorded).toEqual(
      expect.arrayContaining([...HEALTH_CHECK_PARAMETER_NAMES]),
    );

    // The shape key for that declared set, computed through the library's own
    // door — stable, and demonstrably NOT the understated `["command"]`-only
    // key the action declares today.
    const declaredKey = Core.agentActionShapeKey({
      script: "agent-operator",
      operation: "health-check",
      kind: "read-only",
      parameterNames: [...HEALTH_CHECK_PARAMETER_NAMES],
    });
    const understatedKey = Core.agentActionShapeKey({
      script: "agent-operator",
      operation: "health-check",
      kind: "read-only",
      parameterNames: ["command"],
    });
    expect(declaredKey).not.toBe(understatedKey);
    expect(entry["shapeKey"]).toBe(declaredKey);
    // One action, one shape key: both entries of the run carry the same one.
    expect(asRecord(entries[1])["shapeKey"]).toBe(declaredKey);
  });
});
