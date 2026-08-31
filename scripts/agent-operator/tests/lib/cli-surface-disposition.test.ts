/**
 * Tests for `src/lib/cli-surface.ts`'s disposition-to-error mapping — the
 * one place `CliRunDisposition`'s discriminant is read.
 *
 * `resolveCliRunResult` currently folds `spawn-failed`, `timed-out`,
 * `signalled`, and `output-truncated` into a single arm that throws the same
 * fixed message with `context` populated only for `spawn-failed`. The other
 * three arrive at the operator as `context: {}` — an error the maintainer
 * cannot tell apart from a timeout, a kill, or a byte-cap breach, even
 * though `CliRunDisposition` is a closed union of six non-sensitive literals
 * with no disclosure risk.
 *
 * The invariant that must NOT regress while fixing this: the model-facing
 * `message` stays one of the three fixed strings — never a script name, raw
 * stdout, a filesystem path, or a spawn `error.message`.
 *
 * Injects `tests/support/cliFakes.ts`'s fake `runCliProcess` as
 * `deps.runProcess`, like `cli-surface.test.ts`; no real child process, no
 * `vi.mock`.
 */
import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { runCliProcess, CliRunResult } from "../../src/lib/cli-process.js";
import { createAgentCliSurface } from "../../src/lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  createFakeRunCliProcess,
  signalledResult,
  spawnFailedResult,
  timedOutResult,
  truncatedResult,
} from "../support/cliFakes.js";

/** The three fixed model-facing messages `cli-surface.ts` may ever raise. */
const FIXED_MESSAGES: readonly string[] = [
  "the script name did not pass this tool's allowed-name check",
  "the CLI process could not be run to completion",
  "the CLI exited with an unacceptable status or produced output that could not be parsed",
];

interface AgentCliSurfaceDeps {
  readonly entrypoint: string;
  readonly cwd: string;
  readonly nodeExecPath: string;
  readonly cliTimeoutMs: number;
  readonly dryRunTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly dryRunAllowlist: ReadonlySet<string>;
  readonly runProcess?: typeof runCliProcess;
}

function createDeps(runProcess: typeof runCliProcess): AgentCliSurfaceDeps {
  return {
    entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
    cwd: "/repo",
    nodeExecPath: "/usr/bin/node",
    cliTimeoutMs: 30_000,
    dryRunTimeoutMs: 120_000,
    maxOutputBytes: 1_048_576,
    dryRunAllowlist: new Set(["widget-export"]),
    runProcess,
  };
}

/** Runs `list()` against one scripted result and returns the thrown value. */
async function captureListRejection(result: CliRunResult): Promise<unknown> {
  const fake = createFakeRunCliProcess();
  fake.enqueueResult(result);
  const surface = createAgentCliSurface(createDeps(fake.runProcess));
  try {
    await surface.list();
  } catch (error) {
    return error;
  }
  throw new Error("expected list() to reject, but it resolved");
}

const NON_EXITED_DISPOSITIONS: [string, () => CliRunResult][] = [
  ["spawn-failed", () => spawnFailedResult()],
  ["timed-out", () => timedOutResult()],
  ["signalled", () => signalledResult()],
  ["output-truncated", () => truncatedResult()],
];

describe("cli-surface — the failed disposition survives into context", () => {
  it.each(NON_EXITED_DISPOSITIONS)(
    "reports context.disposition === '%s' rather than an indistinguishable spawn error",
    async (disposition, build) => {
      const thrown = await captureListRejection(build());

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const error = thrown as M3LAgentOperatorCliError;
      expect(error.code).toBe("ERR_AGENT_OPERATOR_CLI_SPAWN");
      expect(error.context["disposition"]).toBe(disposition);
    },
  );

  it.each(NON_EXITED_DISPOSITIONS)(
    "keeps the model-facing message fixed for '%s' — the discriminant goes in context, never the text",
    async (_disposition, build) => {
      const thrown = await captureListRejection(build());

      const error = thrown as M3LAgentOperatorCliError;
      expect(FIXED_MESSAGES).toContain(error.message);
      expect(error.message).toBe(
        "the CLI process could not be run to completion",
      );
    },
  );

  it("keeps the existing failureCode alongside the new disposition for spawn-failed", async () => {
    const thrown = await captureListRejection(
      spawnFailedResult({ failureCode: "ENOENT" }),
    );

    const error = thrown as M3LAgentOperatorCliError;
    expect(error.context).toMatchObject({
      disposition: "spawn-failed",
      failureCode: "ENOENT",
    });
  });

  it("still raises M3LOperationAbortedError for 'aborted' — that disposition is not folded into the spawn error", async () => {
    const fake = createFakeRunCliProcess();
    fake.enqueueResult({
      disposition: "aborted",
      exitCode: null,
      stdout: "",
      stderr: "",
      failureCode: undefined,
    });
    const surface = createAgentCliSurface(createDeps(fake.runProcess));

    let thrown: unknown;
    try {
      await surface.list();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
  });
});
