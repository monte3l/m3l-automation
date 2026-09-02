/**
 * Tests for src/run/execute.ts — `executeScript` is the single shared
 * execution tail both `m3l run <script>` and the dynamic `m3l <script>`
 * dispatch through (ADR-0063, #539, "V2 slice 2"): spawn the script, and —
 * only when `--json` was requested — locate its run report and emit exactly
 * one JSON envelope on stdout. It depends on three sibling modules
 * (`run/spawn.js`, `run/report-lookup.js`, `run/envelope.js`), every one of
 * which is mocked here — this file never calls a real implementation.
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

vi.mock("../src/run/spawn.js", () => ({ spawnScript: vi.fn() }));
vi.mock("../src/run/report-lookup.js", () => ({ locateRunReport: vi.fn() }));
vi.mock("../src/run/envelope.js", () => ({
  buildRunEnvelope: vi.fn(),
  formatRunEnvelope: vi.fn(),
}));

import { executeScript } from "../src/run/execute.js";
import type {
  M3LCliExecuteContext,
  M3LCliExecuteOptions,
} from "../src/run/execute.js";
import { spawnScript } from "../src/run/spawn.js";
import { locateRunReport } from "../src/run/report-lookup.js";
import { buildRunEnvelope, formatRunEnvelope } from "../src/run/envelope.js";
import type {
  M3LCliRunEnvelope,
  M3LCliRunReportLookup,
  M3LCliRunReportUnavailableReason,
} from "../src/run/envelope.js";
import type { M3LCliOutput } from "../src/cli/output.js";

const spawnScriptMock = vi.mocked(spawnScript);
const locateRunReportMock = vi.mocked(locateRunReport);
const buildRunEnvelopeMock = vi.mocked(buildRunEnvelope);
const formatRunEnvelopeMock = vi.mocked(formatRunEnvelope);

afterEach(() => {
  spawnScriptMock.mockReset();
  locateRunReportMock.mockReset();
  buildRunEnvelopeMock.mockReset();
  formatRunEnvelopeMock.mockReset();
});

/**
 * A fake {@link M3LCliOutput}; every method is a bare `vi.fn()` spy.
 *
 * Accepts per-method overrides so a test can hold onto a named local (e.g.
 * `const infoSpy = vi.fn();`) and assert against that plain identifier
 * instead of the `context.output.info` member expression — referencing a
 * method off an object trips `@typescript-eslint/unbound-method` even when
 * the callee is a vitest mock (see `dynamic.test.ts`'s `infoSpy` convention).
 */
function createOutput(overrides: Partial<M3LCliOutput> = {}): M3LCliOutput {
  return {
    colorEnabled: false,
    info: vi.fn(),
    error: vi.fn(),
    heading: vi.fn(),
    ...overrides,
  };
}

function buildContext(
  overrides: Partial<M3LCliExecuteContext> = {},
): M3LCliExecuteContext {
  return {
    output: createOutput(),
    jsonOutput: false,
    outputDirPath: "/data/output",
    env: {},
    envFile: { kind: "auto" },
    ...overrides,
  };
}

const SCRIPT_NAME = "export-users";
const SCRIPT_DIRECTORY = "/workspace/scripts/export-users";
const ARGV = ["--limit", "5"] as const;

const STARTED_AT = new Date("2026-08-20T10:00:00.000Z");
const FINISHED_AT = new Date("2026-08-20T10:00:05.000Z");

const FOUND_LOOKUP: M3LCliRunReportLookup = {
  status: "found",
  reportPath:
    "/data/output/export-users/2026-08-20T10-00-00-000Z/run-report.json",
  summary: {
    outcome: "success",
    timelineCount: 4,
    timelineSourceCount: 1,
    recoveryTotal: null,
  },
};

const SAMPLE_ENVELOPE = {
  kind: "m3l.run.result",
  schemaVersion: 1,
} as unknown as M3LCliRunEnvelope;

const SAMPLE_FORMATTED = '{"kind":"m3l.run.result"}';

/**
 * Builds a `now` seam that returns each of `dates` in order on successive
 * calls, and throws if invoked more times than `dates` provided — this
 * turns an over-eager or under-eager call count into a loud failure rather
 * than a silently reused stale `Date`.
 */
function scriptedNow(...dates: readonly Date[]): () => Date {
  const queue = [...dates];
  return (): Date => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("scriptedNow: called more times than dates provided");
    }
    return next;
  };
}

const UNAVAILABLE_REASONS = [
  "output-directory-missing",
  "output-directory-unreadable",
  "no-matching-report",
  "report-unreadable",
  "report-malformed",
] as const satisfies readonly M3LCliRunReportUnavailableReason[];

describe("executeScript — non-JSON mode", () => {
  test("spawns via spawnScript without redirecting stdout to stderr", async () => {
    spawnScriptMock.mockResolvedValue(0);
    const context = buildContext({ jsonOutput: false });

    const exitCode = await executeScript(
      context,
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    expect(exitCode).toBe(0);
    expect(spawnScriptMock).toHaveBeenCalledWith(
      SCRIPT_DIRECTORY,
      ARGV,
      expect.not.objectContaining({ redirectStdoutToStderr: true }),
    );
  });

  test("propagates spawnScript's resolved exit code verbatim", async () => {
    spawnScriptMock.mockResolvedValue(9);

    const exitCode = await executeScript(
      buildContext({ jsonOutput: false }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    expect(exitCode).toBe(9);
  });

  test("never calls locateRunReport or the envelope pipeline", async () => {
    spawnScriptMock.mockResolvedValue(0);

    await executeScript(
      buildContext({ jsonOutput: false }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    expect(locateRunReportMock).not.toHaveBeenCalled();
    expect(buildRunEnvelopeMock).not.toHaveBeenCalled();
    expect(formatRunEnvelopeMock).not.toHaveBeenCalled();
  });

  test("never calls context.output.info", async () => {
    spawnScriptMock.mockResolvedValue(0);
    const infoSpy = vi.fn();
    const context = buildContext({
      jsonOutput: false,
      output: createOutput({ info: infoSpy }),
    });

    await executeScript(context, SCRIPT_NAME, SCRIPT_DIRECTORY, ARGV);

    expect(infoSpy).not.toHaveBeenCalled();
  });

  test("passes through an injected spawnImpl and stderrStream to spawnScript", async () => {
    spawnScriptMock.mockResolvedValue(0);
    const spawnImpl: NonNullable<M3LCliExecuteOptions["spawnImpl"]> = vi.fn();
    const stderrStream: NonNullable<M3LCliExecuteOptions["stderrStream"]> = {
      write: vi.fn(),
    };

    await executeScript(
      buildContext({ jsonOutput: false }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { spawnImpl, stderrStream },
    );

    expect(spawnScriptMock).toHaveBeenCalledWith(
      SCRIPT_DIRECTORY,
      ARGV,
      expect.objectContaining({ spawnImpl, stderrStream }),
    );
  });
});

describe("executeScript — JSON mode", () => {
  test("spawns via spawnScript with redirectStdoutToStderr: true", async () => {
    spawnScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

    await executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { now: scriptedNow(STARTED_AT, FINISHED_AT) },
    );

    expect(spawnScriptMock).toHaveBeenCalledWith(
      SCRIPT_DIRECTORY,
      ARGV,
      expect.objectContaining({ redirectStdoutToStderr: true }),
    );
  });

  test("passes through an injected spawnImpl and stderrStream alongside redirectStdoutToStderr: true", async () => {
    spawnScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);
    const spawnImpl: NonNullable<M3LCliExecuteOptions["spawnImpl"]> = vi.fn();
    const stderrStream: NonNullable<M3LCliExecuteOptions["stderrStream"]> = {
      write: vi.fn(),
    };

    await executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      {
        spawnImpl,
        stderrStream,
        now: scriptedNow(STARTED_AT, FINISHED_AT),
      },
    );

    expect(spawnScriptMock).toHaveBeenCalledWith(
      SCRIPT_DIRECTORY,
      ARGV,
      expect.objectContaining({
        redirectStdoutToStderr: true,
        spawnImpl,
        stderrStream,
      }),
    );
  });

  test("captures now() strictly before spawning and again only after spawnScript resolves", async () => {
    const now = vi.fn(scriptedNow(STARTED_AT, FINISHED_AT));
    let nowCallCountDuringSpawn = -1;
    spawnScriptMock.mockImplementation(() => {
      nowCallCountDuringSpawn = now.mock.calls.length;
      return Promise.resolve(0);
    });
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

    await executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { now },
    );

    // Exactly one now() call had already happened by the time spawnScript
    // ran (the startedAt capture) — proving the ordering, not just the
    // final values, since an implementation that called now() twice only
    // after spawn (or not before it at all) would report 0 here instead.
    expect(nowCallCountDuringSpawn).toBe(1);
    expect(now).toHaveBeenCalledTimes(2);
  });

  test("calls locateRunReport with the outputDirPath, scriptName, and the two scripted now() values as startedAt/finishedAt", async () => {
    spawnScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);
    const context = buildContext({
      jsonOutput: true,
      outputDirPath: "/data/output",
    });

    await executeScript(context, SCRIPT_NAME, SCRIPT_DIRECTORY, ARGV, {
      now: scriptedNow(STARTED_AT, FINISHED_AT),
    });

    expect(locateRunReportMock).toHaveBeenCalledExactlyOnceWith({
      outputDirPath: "/data/output",
      scriptName: SCRIPT_NAME,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
    });
    expect(STARTED_AT.getTime()).toBeLessThan(FINISHED_AT.getTime());
  });

  test("calls buildRunEnvelope with scriptName, timing, spawnScript's exit code, and locateRunReport's result", async () => {
    spawnScriptMock.mockResolvedValue(3);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

    await executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { now: scriptedNow(STARTED_AT, FINISHED_AT) },
    );

    expect(buildRunEnvelopeMock).toHaveBeenCalledExactlyOnceWith({
      scriptName: SCRIPT_NAME,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      exitCode: 3,
      lookup: FOUND_LOOKUP,
    });
  });

  test("formats buildRunEnvelope's result and writes it via context.output.info exactly once", async () => {
    spawnScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);
    const infoSpy = vi.fn();
    const context = buildContext({
      jsonOutput: true,
      output: createOutput({ info: infoSpy }),
    });

    await executeScript(context, SCRIPT_NAME, SCRIPT_DIRECTORY, ARGV, {
      now: scriptedNow(STARTED_AT, FINISHED_AT),
    });

    expect(formatRunEnvelopeMock).toHaveBeenCalledExactlyOnceWith(
      SAMPLE_ENVELOPE,
    );
    expect(infoSpy).toHaveBeenCalledExactlyOnceWith(SAMPLE_FORMATTED);
  });

  test("returns spawnScript's exit code unaffected by the envelope pipeline", async () => {
    spawnScriptMock.mockResolvedValue(42);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

    const exitCode = await executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { now: scriptedNow(STARTED_AT, FINISHED_AT) },
    );

    expect(exitCode).toBe(42);
  });
});

describe("executeScript — read-tolerance across every M3LCliRunReportUnavailableReason", () => {
  test.each(UNAVAILABLE_REASONS)(
    "still writes exactly one envelope and resolves the correct exit code when reason=%s",
    async (reason) => {
      spawnScriptMock.mockResolvedValue(5);
      locateRunReportMock.mockReturnValue({ status: "unavailable", reason });
      buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
      formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);
      const infoSpy = vi.fn();
      const context = buildContext({
        jsonOutput: true,
        output: createOutput({ info: infoSpy }),
      });

      const exitCode = await executeScript(
        context,
        SCRIPT_NAME,
        SCRIPT_DIRECTORY,
        ARGV,
        { now: scriptedNow(STARTED_AT, FINISHED_AT) },
      );

      expect(exitCode).toBe(5);
      expect(buildRunEnvelopeMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ lookup: { status: "unavailable", reason } }),
      );
      expect(infoSpy).toHaveBeenCalledExactlyOnceWith(SAMPLE_FORMATTED);
    },
  );
});

describe("executeScript — defense in depth against downstream envelope failures", () => {
  test("still resolves with spawnScript's exit code when locateRunReport throws", async () => {
    spawnScriptMock.mockResolvedValue(2);
    locateRunReportMock.mockImplementation(() => {
      throw new Error("defect in locateRunReport");
    });

    const exitCode = await executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { now: scriptedNow(STARTED_AT, FINISHED_AT) },
    );

    expect(exitCode).toBe(2);
  });

  test("still resolves with spawnScript's exit code when context.output.info throws", async () => {
    spawnScriptMock.mockResolvedValue(6);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);
    const infoSpy = vi.fn(() => {
      throw new Error("stdout write failed");
    });
    const context = buildContext({
      jsonOutput: true,
      output: createOutput({ info: infoSpy }),
    });

    const exitCode = await executeScript(
      context,
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { now: scriptedNow(STARTED_AT, FINISHED_AT) },
    );

    expect(exitCode).toBe(6);
  });
});

describe("executeScript — spawn failure propagation", () => {
  test("rejects with spawnScript's rejection unchanged and never touches the envelope pipeline", async () => {
    const spawnError = new Error("ERR_CLI_SCRIPT_NOT_BUILT");
    spawnScriptMock.mockRejectedValue(spawnError);
    const infoSpy = vi.fn();
    const context = buildContext({
      jsonOutput: true,
      output: createOutput({ info: infoSpy }),
    });

    await expect(
      executeScript(context, SCRIPT_NAME, SCRIPT_DIRECTORY, ARGV, {
        now: scriptedNow(STARTED_AT, FINISHED_AT),
      }),
    ).rejects.toBe(spawnError);

    expect(locateRunReportMock).not.toHaveBeenCalled();
    expect(buildRunEnvelopeMock).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test("rejects with spawnScript's rejection unchanged in non-JSON mode too", async () => {
    const spawnError = new Error("ERR_CLI_SPAWN_FAILED");
    spawnScriptMock.mockRejectedValue(spawnError);

    await expect(
      executeScript(
        buildContext({ jsonOutput: false }),
        SCRIPT_NAME,
        SCRIPT_DIRECTORY,
        ARGV,
      ),
    ).rejects.toBe(spawnError);
  });
});

describe("executeScript — scriptDirectory/argv passthrough", () => {
  test("passes scriptDirectory and argv through unchanged in non-JSON mode", async () => {
    spawnScriptMock.mockResolvedValue(0);
    const directory = "/workspace/scripts/other-script";
    const argv = ["--flag", "value", "extra"];

    await executeScript(
      buildContext({ jsonOutput: false }),
      "other-script",
      directory,
      argv,
    );

    expect(spawnScriptMock).toHaveBeenCalledWith(
      directory,
      argv,
      expect.anything(),
    );
  });

  test("passes scriptDirectory and argv through unchanged in JSON mode", async () => {
    spawnScriptMock.mockResolvedValue(0);
    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);
    const directory = "/workspace/scripts/other-script";
    const argv = ["--flag", "value", "extra"];

    await executeScript(
      buildContext({ jsonOutput: true }),
      "other-script",
      directory,
      argv,
      { now: scriptedNow(STARTED_AT, FINISHED_AT) },
    );

    expect(spawnScriptMock).toHaveBeenCalledWith(
      directory,
      argv,
      expect.anything(),
    );
  });
});

describe("executeScript — secret/env forwarding (ADR-0085)", () => {
  test("forwards context.env and context.envFile to spawnScript verbatim", async () => {
    spawnScriptMock.mockResolvedValue(0);
    const context = buildContext({
      jsonOutput: false,
      env: { AWS_PROFILE: "sandbox" },
      envFile: { kind: "disabled" },
    });

    await executeScript(context, SCRIPT_NAME, SCRIPT_DIRECTORY, ARGV);

    expect(spawnScriptMock).toHaveBeenCalledWith(
      SCRIPT_DIRECTORY,
      ARGV,
      expect.objectContaining({
        env: { AWS_PROFILE: "sandbox" },
        envFile: { kind: "disabled" },
      }),
    );
  });

  test("forwards options.secretEnv to spawnScript verbatim", async () => {
    spawnScriptMock.mockResolvedValue(0);

    await executeScript(
      buildContext({ jsonOutput: false }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
      { secretEnv: { API_TOKEN: "hunter2" } },
    );

    expect(spawnScriptMock).toHaveBeenCalledWith(
      SCRIPT_DIRECTORY,
      ARGV,
      expect.objectContaining({ secretEnv: { API_TOKEN: "hunter2" } }),
    );
  });

  test("omitting secretEnv forwards no secretEnv key at all (exactOptionalPropertyTypes discipline)", async () => {
    spawnScriptMock.mockResolvedValue(0);

    await executeScript(
      buildContext({ jsonOutput: false }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    const options = spawnScriptMock.mock.calls[0]?.[2] ?? {};
    expect(Object.hasOwn(options, "secretEnv")).toBe(false);
  });

  test("a forwarded secret never reaches the writer facade, in JSON mode or out", async () => {
    spawnScriptMock.mockResolvedValue(0);
    const lines: string[] = [];
    const context = buildContext({
      jsonOutput: true,
      output: {
        colorEnabled: false,
        info: (text: string) => lines.push(text),
        error: (text: string) => lines.push(text),
        heading: (text: string) => lines.push(text),
      },
    });

    await executeScript(context, SCRIPT_NAME, SCRIPT_DIRECTORY, ARGV, {
      secretEnv: { API_TOKEN: "hunter2" },
    });

    expect(lines.join("\n")).not.toContain("hunter2");
  });
});

describe("executeScript — redirectStdoutToStderr fallback (ADR-0085 flow composition)", () => {
  // `flow/step.ts` relies on this default rather than passing
  // `redirectStdoutToStderr` on every non-flow call: omitting the option must
  // still reproduce `m3l run --json`'s pre-existing behaviour exactly.
  test.each([
    [true, true],
    [false, false],
  ] as const)(
    "omitting redirectStdoutToStderr falls back to context.jsonOutput (%s -> %s)",
    async (jsonOutput, expected) => {
      spawnScriptMock.mockResolvedValue(0);
      locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
      buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
      formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

      await executeScript(
        buildContext({ jsonOutput }),
        SCRIPT_NAME,
        SCRIPT_DIRECTORY,
        ARGV,
        { now: scriptedNow(STARTED_AT, FINISHED_AT) },
      );

      expect(spawnScriptMock).toHaveBeenCalledWith(
        SCRIPT_DIRECTORY,
        ARGV,
        expect.objectContaining({ redirectStdoutToStderr: expected }),
      );
    },
  );
});

describe("executeScript — type contract", () => {
  test("returns a Promise<number> regardless of JSON mode", () => {
    expectTypeOf<typeof executeScript>().returns.toEqualTypeOf<
      Promise<number>
    >();
  });

  test("M3LCliExecuteOptions fields are all optional per-invocation inputs and injectable seams", () => {
    expectTypeOf<M3LCliExecuteOptions>().toEqualTypeOf<{
      readonly spawnImpl?: M3LCliExecuteOptions["spawnImpl"];
      readonly stderrStream?: M3LCliExecuteOptions["stderrStream"];
      readonly now?: () => Date;
      readonly secretEnv?: Readonly<Record<string, string>>;
      readonly redirectStdoutToStderr?: boolean;
    }>();
  });
});

// ---------------------------------------------------------------------------
// U11 — D11/D12: executeScript exit-code fidelity and envelope pipeline
//
// executeScript's contract: return exactly the exit code spawnScript resolves
// with, and — when --json was requested — run the full envelope pipeline
// (locateRunReport → buildRunEnvelope → formatRunEnvelope → output.info)
// regardless of how spawn ends.
//
// Parent survival after SIGINT is owned by main.ts's runCli, which installs
// a cancellation scope around every dispatch path. execute.ts itself does not
// create a scope (see execute.ts:194-197) and is not responsible for signal
// suppression. Coverage for the scope's lifecycle is in main-cancellation.test.ts.
//
// The assertions "code is 5, not 130" name 130 explicitly because that is the
// value that would appear if the parent were killed by Node's default SIGINT
// disposition (128 + os.constants.signals.SIGINT (2) = 130), pinning that
// executeScript never performs that conversion.
// ---------------------------------------------------------------------------

describe("executeScript — exit-code fidelity and envelope pipeline (U11 D11/D12)", () => {
  test("D11 — resolves with the child's own exit code (5), not 130 (128+SIGINT)", async () => {
    // executeScript returns exactly the code spawnScript resolves with.
    // 130 would appear if the parent were killed by Node's default SIGINT
    // disposition (128 + 2); parent survival is runCli's responsibility.
    let resolveSpawn!: (code: number) => void;
    const pendingSpawn = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });
    spawnScriptMock.mockReturnValue(pendingSpawn);

    const context = buildContext({ jsonOutput: false });
    const resultPromise = executeScript(
      context,
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    resolveSpawn(5);

    const code = await resultPromise;
    expect(code).toBe(5);
    expect(code).not.toBe(130); // not 128+SIGINT
  });

  test("D12 — --json envelope pipeline executes and reports exit code from the child", async () => {
    // Pins that when --json is requested, the full envelope pipeline
    // (locateRunReport → buildRunEnvelope → formatRunEnvelope → output.info)
    // runs and the exit code returned is still the child's own code.
    let resolveSpawn!: (code: number) => void;
    const pendingSpawn = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });
    spawnScriptMock.mockReturnValue(pendingSpawn);

    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

    const infoSpy = vi.fn();
    const context = buildContext({
      jsonOutput: true,
      output: createOutput({ info: infoSpy }),
    });
    const resultPromise = executeScript(
      context,
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    resolveSpawn(5);

    const code = await resultPromise;

    expect(locateRunReportMock).toHaveBeenCalledTimes(1);
    expect(buildRunEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(formatRunEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(SAMPLE_FORMATTED);
    expect(code).toBe(5);
  });

  test("D12 — exit code passed to buildRunEnvelope is the child's code (5), not 130", async () => {
    let resolveSpawn!: (code: number) => void;
    spawnScriptMock.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    locateRunReportMock.mockReturnValue(FOUND_LOOKUP);
    buildRunEnvelopeMock.mockReturnValue(SAMPLE_ENVELOPE);
    formatRunEnvelopeMock.mockReturnValue(SAMPLE_FORMATTED);

    const resultPromise = executeScript(
      buildContext({ jsonOutput: true }),
      SCRIPT_NAME,
      SCRIPT_DIRECTORY,
      ARGV,
    );

    resolveSpawn(5);
    await resultPromise;

    const envelopeArg = buildRunEnvelopeMock.mock.calls[0]?.[0];
    expect(envelopeArg).toMatchObject({ exitCode: 5 });
  });
});
