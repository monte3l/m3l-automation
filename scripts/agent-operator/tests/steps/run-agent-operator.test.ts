/**
 * Tests for `steps/run-agent-operator` — the top-level dispatcher that wires
 * `config` -> `loadAgentPolicy` -> `resolveAgentOperatorRuntime` ->
 * `explainPolicy` (PR 1, ADR-0055).
 *
 * PR A scope: this dispatcher no longer builds an `AgentCliSurface` —
 * `createAgentCliSurface` and `../../src/lib/cli-surface.js` return in PR B,
 * the `m3l` CLI seam. `runAgentOperator` is exercised here through its REAL
 * collaborators (`loadAgentPolicy`, `resolveAgentOperatorRuntime`,
 * `explainPolicy`) against a real `Core.M3LPaths` pointed at a temp input dir
 * (the same `M3L_INPUT_DIR` pattern `load-policy.test.ts` already established
 * in this package) — nothing is mocked in this file, since there is no
 * process-spawning collaborator left to isolate. A wrong argument order, a
 * dropped `paths`, or a policy file threaded incorrectly is invisible to any
 * test that doesn't run the real wiring end to end.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { runAgentOperator } from "../../src/steps/run-agent-operator.js";
import { fullPolicyDeclaration } from "../support/policyFixtures.js";

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

let inputDir: string;

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "agent-operator-run-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(inputDir, { recursive: true, force: true });
});

/** A real `Core.M3LPaths`, pointed at this test's temp input dir. */
function makePaths(): Core.M3LPaths {
  vi.stubEnv("M3L_INPUT_DIR", inputDir);
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
  config.set("cliEntrypoint", "/fake/repo/packages/m3l-cli/bin/m3l.mjs");
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

describe("runAgentOperator — explain-policy wiring", () => {
  it("loads the policy, resolves the runtime, and renders through explainPolicy", async () => {
    // A non-default `policyFile` name: proves the config value is actually
    // read and threaded through, not a hardcoded "agent-policy.json".
    const policyFileName = "custom-agent-policy.json";
    await writePolicyFixture(policyFileName, fullPolicyDeclaration());

    const { logger, handler } = createLogger();
    const controller = new AbortController();
    const reportRecovery = vi.fn();
    const config = buildConfig({
      policyFile: policyFileName,
    });

    await runAgentOperator({
      config,
      logger,
      paths: makePaths(),
      signal: controller.signal,
      reportRecovery,
    });

    // The rendered text carries the loaded fixture's OWN content (from
    // fullPolicyDeclaration(), not a default/empty policy) — proving
    // load -> resolve -> render actually threaded the right file through.
    const text = flattenLoggedText(handler.events);
    expect(text).toContain("s3-objects");
    expect(text).toMatch(/1000/); // tokensPerRun

    // This offline slice absorbs no per-action failure — reportRecovery is
    // threaded onto the seam for a later slice but unused today.
    expect(reportRecovery).not.toHaveBeenCalled();
  });
});

describe("runAgentOperator — health-check", () => {
  it("throws ERR_AGENT_OPERATOR_CONFIG rather than silently succeeding or running a no-op", async () => {
    const { logger } = createLogger();
    const config = buildConfig({ command: "health-check" });

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
    // Consistent with the README/reference page: declared (so `list`/
    // `inspect` surface it) but not implemented until a follow-up slice.
    expect(asError.message).toMatch(/declared/);
    expect(asError.message).toMatch(/not implemented/);
    expect(asError.message).toMatch(/follow-up slice/);
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
  });
});
