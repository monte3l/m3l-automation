/**
 * Tests for `src/sessions/flow-export.ts` — `buildSessionFlowExport` (X13
 * session-flow-export domain module, issue #561, PR 4/6).
 *
 * RED: `../src/sessions/flow-export.ts` does not exist yet, and
 * `M3LSessionScriptCatalogPort` does not exist yet in `../src/sessions/ports.js`
 * — every import below is expected to fail to resolve until the implementer
 * lands both. Do not edit `ports.ts` from this file's own reasoning — that is
 * the implementer's job.
 *
 * Fakes only: a Map-backed in-memory `M3LConsoleSessionsRepository`
 * (mirroring `sessions-composition.test.ts`'s own idiom) and a
 * `M3LSessionScriptCatalogPort` fake that resolves declared parameter facts
 * per script name. Never mocks the function under test — real fixture data,
 * real function.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { buildSessionFlowExport } from "../src/sessions/flow-export.js";
import type {
  M3LSessionFlowExportRequest,
  M3LSessionFlowExportResult,
  M3LSessionFlowExportStepProvenance,
  SessionFlowExportDependencies,
} from "../src/sessions/flow-export.js";
import type {
  M3LSessionScriptCatalogPort,
  M3LSessionScriptParameterFact,
} from "../src/sessions/ports.js";
import { isConsoleError } from "../src/errors/console-error.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepRecord,
} from "../src/store/sessions-repository-types.js";
import type { M3LRunTerminalStatus } from "../src/store/run-status.js";

// ---------------------------------------------------------------------------
// YAML round-trip helper (mirrors sessions-flow-yaml.test.ts's own pattern)
// ---------------------------------------------------------------------------

/** Temp roots created by this file, removed in `afterEach`. */
const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/**
 * Writes `yaml` to a real temp file inside a per-test mkdtemp sandbox, then
 * parses it back through `Core.M3LYAMLConfigProvider` — the exact reader
 * `packages/m3l-cli/src/flow/load.ts` uses in production.
 */
function parseRenderedYaml(yaml: string): {
  readonly name: unknown;
  readonly description: unknown;
  readonly steps: unknown;
} {
  const root = mkdtempSync(join(tmpdir(), "m3l-flow-export-"));
  createdRoots.push(root);
  const filePath = join(root, "flow.yaml");
  writeFileSync(filePath, yaml, "utf8");
  const provider = new Core.M3LYAMLConfigProvider(filePath);
  return {
    name: provider.getRawValue("name"),
    description: provider.getRawValue("description"),
    steps: provider.getRawValue("steps"),
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** One open session record, id `"session-1"` unless overridden. */
function sessionRecord(id = "session-1"): M3LSessionRecord {
  return {
    id,
    operator: "ada",
    correlationId: "corr-1",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    status: "open",
  };
}

/** One session step record, with sane not-under-test defaults. */
function stepRecord(fields: {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly operation: string;
  readonly parameters: unknown;
  readonly outcome?: M3LRunTerminalStatus | undefined;
}): M3LSessionStepRecord {
  return {
    id: fields.id,
    sessionId: fields.sessionId,
    ordinal: fields.ordinal,
    operation: fields.operation,
    parameters: fields.parameters,
    runId: undefined,
    status: fields.outcome ?? "running",
    resultRef: undefined,
    queuedAtMs: 1_000,
    startedAtMs: 1_000,
    endedAtMs: fields.outcome === undefined ? undefined : 1_500,
    outcome: fields.outcome,
    failureMessage: undefined,
  };
}

/** One session binding record. */
function bindingRecord(fields: {
  readonly id: string;
  readonly sessionId: string;
  readonly reference: string;
  readonly parameterName: string | undefined;
}): M3LSessionBindingRecord {
  return {
    id: fields.id,
    sessionId: fields.sessionId,
    reference: fields.reference,
    expectedType: "string",
    multiSelect: false,
    createdAtMs: 1_000,
    parameterName: fields.parameterName,
  };
}

/** One session decision record ("pending" — content is irrelevant to the export). */
function decisionRecord(
  id: string,
  sessionId: string,
): M3LSessionDecisionRecord {
  return {
    id,
    sessionId,
    stepId: "step-record-1",
    prompt: "Proceed with the dump?",
    options: undefined,
    createdAtMs: 1_000,
    status: "pending",
  };
}

/** Throws for any repository method this fake was not asked to support. */
function notImplemented(name: string): never {
  throw new Error(`fake repository: '${name}' is not implemented`);
}

interface FakeRepositoryOptions {
  readonly session?: M3LSessionRecord;
  readonly steps?: readonly M3LSessionStepRecord[];
  readonly bindings?: readonly M3LSessionBindingRecord[];
  readonly decisions?: readonly M3LSessionDecisionRecord[];
}

interface FakeRepositoryHandle {
  readonly repository: M3LConsoleSessionsRepository;
  /** Number of times `listStepsForSession` was called — proves ordering of validation vs. lookup. */
  listStepsForSessionCallCount: number;
}

/** A minimal, Map-free fake repository: only the three read methods this module needs are backed by fixture data; every other method throws if reached. */
function createFakeRepository(
  options: FakeRepositoryOptions = {},
): FakeRepositoryHandle {
  const handle: FakeRepositoryHandle = {
    listStepsForSessionCallCount: 0,
    repository: {
      insertSession: () => notImplemented("insertSession"),
      getSession: (id: string) =>
        options.session?.id === id ? options.session : undefined,
      listSessions: () => notImplemented("listSessions"),
      closeSession: () => notImplemented("closeSession"),
      reopenSession: () => notImplemented("reopenSession"),
      insertStep: () => notImplemented("insertStep"),
      claimStepForStart: () => notImplemented("claimStepForStart"),
      finishStep: () => notImplemented("finishStep"),
      getStep: () => notImplemented("getStep"),
      getStepByOrdinal: () => notImplemented("getStepByOrdinal"),
      listStepsForSession: (sessionId: string) => {
        handle.listStepsForSessionCallCount += 1;
        return options.session?.id === sessionId ? (options.steps ?? []) : [];
      },
      attachStepRun: () => notImplemented("attachStepRun"),
      getStepByRunId: () => notImplemented("getStepByRunId"),
      insertBinding: () => notImplemented("insertBinding"),
      listBindingsForSession: (sessionId: string) =>
        options.session?.id === sessionId ? (options.bindings ?? []) : [],
      insertDecision: () => notImplemented("insertDecision"),
      answerDecision: () => notImplemented("answerDecision"),
      getDecision: () => notImplemented("getDecision"),
      listDecisionsForSession: (sessionId: string) =>
        options.session?.id === sessionId ? (options.decisions ?? []) : [],
      countOpenSessions: () => notImplemented("countOpenSessions"),
    },
  };
  return handle;
}

interface FakeScriptDescriptor {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly secret: boolean;
}

/** A fake `M3LSessionScriptCatalogPort` resolving declared parameters per script name. */
function createFakeScriptCatalog(
  parametersByScript: ReadonlyMap<string, readonly FakeScriptDescriptor[]>,
): M3LSessionScriptCatalogPort {
  return {
    describe: (name: string) => {
      const parameters = parametersByScript.get(name);
      if (parameters === undefined) {
        return Promise.reject(
          new Error(`fake script catalog has no entry for '${name}'`),
        );
      }
      return Promise.resolve({ parameters });
    },
  };
}

/** No script declares any secret parameter — the common non-secret catalog. */
function nonSecretCatalog(): M3LSessionScriptCatalogPort {
  // Typed against the real `describe()` parameter-fact shape (mirrors
  // `runs/descriptors.ts`'s per-parameter descriptor field for field) rather
  // than the local `FakeScriptDescriptor` alias, so this fixture is checked
  // against the actual port contract.
  const sqsEtlParameters: readonly M3LSessionScriptParameterFact[] = [
    { name: "command", aliases: [], secret: false },
    { name: "queueName", aliases: ["q"], secret: false },
  ];
  return createFakeScriptCatalog(new Map([["sqs-etl", sqsEtlParameters]]));
}

/** Builds the dependency bag from a repository handle and a script catalog. */
function deps(
  handle: FakeRepositoryHandle,
  scripts: M3LSessionScriptCatalogPort = nonSecretCatalog(),
): SessionFlowExportDependencies {
  return { sessionsRepository: handle.repository, scripts };
}

const VALID_REQUEST: M3LSessionFlowExportRequest = { name: "dlq-reconcile" };

/** Captures whatever `run` rejects with, as a single `unknown` value. */
async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("buildSessionFlowExport — happy path", () => {
  test("two successful steps compose a two-step flow document that round-trips through Core.M3LYAMLConfigProvider — and every step is onSuccess: continue / onFailure: stop", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { command: "list-queues" },
        outcome: "success",
      }),
      stepRecord({
        id: "step-record-2",
        sessionId: session.id,
        ordinal: 2,
        operation: "sqs-etl",
        parameters: { command: "dump", queueName: "my-dlq" },
        outcome: "success",
      }),
    ];
    const handle = createFakeRepository({ session, steps });

    const result: M3LSessionFlowExportResult = await buildSessionFlowExport(
      deps(handle),
      session.id,
      VALID_REQUEST,
    );

    expect(result.name).toBe("dlq-reconcile");
    expect(result.decisionsDropped).toBe(0);

    // Round-trip the rendered YAML through the production reader — same
    // pattern as sessions-flow-yaml.test.ts.
    const parsed = parseRenderedYaml(result.yaml);
    expect(parsed).toMatchObject({
      name: "dlq-reconcile",
      steps: [
        {
          id: "step-1",
          script: "sqs-etl",
          parameters: { command: "list-queues" },
          onSuccess: "continue",
          onFailure: "stop",
        },
        {
          id: "step-2",
          script: "sqs-etl",
          parameters: { command: "dump", queueName: "my-dlq" },
          onSuccess: "continue",
          onFailure: "stop",
        },
      ],
    });

    expect(result.steps).toHaveLength(2);
    const firstStepProvenance: M3LSessionFlowExportStepProvenance | undefined =
      result.steps[0];
    expect(firstStepProvenance).toMatchObject({
      stepId: "step-record-1",
      ordinal: 1,
      flowStepId: "step-1",
      script: "sqs-etl",
      outcome: "success",
    });
    expect(result.steps[1]).toMatchObject({
      stepId: "step-record-2",
      ordinal: 2,
      flowStepId: "step-2",
      script: "sqs-etl",
      outcome: "success",
    });
  });

  test("description carries through when supplied on the request", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { command: "list-queues" },
        outcome: "success",
      }),
    ];
    const handle = createFakeRepository({ session, steps });

    const result = await buildSessionFlowExport(deps(handle), session.id, {
      name: "with-description",
      description: "Exported from a workbench session.",
    });

    const parsed = parseRenderedYaml(result.yaml);
    expect(parsed).toMatchObject({
      description: "Exported from a workbench session.",
    });
  });
});

// ---------------------------------------------------------------------------
// Refusal paths
// ---------------------------------------------------------------------------

describe("buildSessionFlowExport — refusals", () => {
  test("an empty session (no steps) refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY", async () => {
    const session = sessionRecord();
    const handle = createFakeRepository({ session, steps: [] });

    const error = await captureFailure(() =>
      buildSessionFlowExport(deps(handle), session.id, VALID_REQUEST),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY");
    }
  });

  test("an unknown session id refuses with the existing ERR_CONSOLE_SESSION_NOT_FOUND", async () => {
    const handle = createFakeRepository({});

    const error = await captureFailure(() =>
      buildSessionFlowExport(deps(handle), "no-such-session", VALID_REQUEST),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_NOT_FOUND");
    }
  });

  test.each<[string, string]>([
    ["upper-case letters", "Has Upper"],
    ["a space", "has spaces"],
  ])(
    "an invalid requested name (%s) refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID and never looks up the session's steps",
    async (_label, invalidName) => {
      const session = sessionRecord();
      const steps = [
        stepRecord({
          id: "step-record-1",
          sessionId: session.id,
          ordinal: 1,
          operation: "sqs-etl",
          parameters: { command: "list-queues" },
          outcome: "success",
        }),
      ];
      const handle = createFakeRepository({ session, steps });

      const error = await captureFailure(() =>
        buildSessionFlowExport(deps(handle), session.id, {
          name: invalidName,
        }),
      );

      expect(isConsoleError(error)).toBe(true);
      if (isConsoleError(error)) {
        expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID");
      }

      // The name is validated BEFORE any session lookup work happens.
      expect(handle.listStepsForSessionCallCount).toBe(0);
    },
  );

  test("a step whose parameter name is declared secret refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { queueName: "my-dlq" },
        outcome: "success",
      }),
    ];
    const handle = createFakeRepository({ session, steps });
    const scripts = createFakeScriptCatalog(
      new Map([
        ["sqs-etl", [{ name: "queueName", aliases: ["q"], secret: true }]],
      ]),
    );

    const error = await captureFailure(() =>
      buildSessionFlowExport(deps(handle, scripts), session.id, VALID_REQUEST),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET");
    }
  });

  test("[alias case] a step whose parameter name is an ALIAS of a secret parameter also refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET — stricter than the CLI's screenSecretParameters, which only checks canonical names", async () => {
    const session = sessionRecord();
    // The session step uses the literal alias key "q", never the canonical
    // "queueName" — so a canonical-name-only screen (the CLI's own
    // `screenSecretParameters`) would let this through. This exporter must
    // not.
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { q: "my-dlq" },
        outcome: "success",
      }),
    ];
    const handle = createFakeRepository({ session, steps });
    const scripts = createFakeScriptCatalog(
      new Map([
        ["sqs-etl", [{ name: "queueName", aliases: ["q"], secret: true }]],
      ]),
    );

    const error = await captureFailure(() =>
      buildSessionFlowExport(deps(handle, scripts), session.id, VALID_REQUEST),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET");
    }
  });

  test("a non-string parameter value refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        // `parameters: unknown` at rest — simulate a row whose JSON-round-tripped
        // value is not a plain string-valued record.
        parameters: { command: "dump", retries: 3 },
        outcome: "success",
      }),
    ];
    const handle = createFakeRepository({ session, steps });

    const error = await captureFailure(() =>
      buildSessionFlowExport(deps(handle), session.id, VALID_REQUEST),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// Non-success outcomes are still included
// ---------------------------------------------------------------------------

describe("buildSessionFlowExport — every step is exported regardless of outcome", () => {
  test("a failed step and a never-finished step are both included, with their real outcome reflected in provenance", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { command: "dump" },
        outcome: "failure",
      }),
      stepRecord({
        id: "step-record-2",
        sessionId: session.id,
        ordinal: 2,
        operation: "sqs-etl",
        parameters: { command: "republish" },
        outcome: undefined,
      }),
    ];
    const handle = createFakeRepository({ session, steps });

    const result = await buildSessionFlowExport(
      deps(handle),
      session.id,
      VALID_REQUEST,
    );

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.outcome).toBe("failure");
    expect(result.steps[1]?.outcome).toBeNull();

    const parsed = parseRenderedYaml(result.yaml);
    expect(parsed.steps).toMatchObject([{ id: "step-1" }, { id: "step-2" }]);
  });
});

// ---------------------------------------------------------------------------
// Decisions dropped
// ---------------------------------------------------------------------------

describe("buildSessionFlowExport — decisions are dropped, counted only", () => {
  test("decisionsDropped reflects the session's decision count, and no decision text ever reaches the rendered yaml", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { command: "dump" },
        outcome: "success",
      }),
    ];
    const decisions = [
      decisionRecord("decision-1", session.id),
      decisionRecord("decision-2", session.id),
    ];
    const handle = createFakeRepository({ session, steps, decisions });

    const result = await buildSessionFlowExport(
      deps(handle),
      session.id,
      VALID_REQUEST,
    );

    expect(result.decisionsDropped).toBe(2);
    expect(result.yaml).not.toContain("Proceed with the dump?");
  });
});

// ---------------------------------------------------------------------------
// parameterReferences best-effort join
// ---------------------------------------------------------------------------

describe("buildSessionFlowExport — parameterReferences best-effort join", () => {
  test("a matching binding's reference is joined onto the step's provenance; an unmatched parameter maps to null", async () => {
    const session = sessionRecord();
    const steps = [
      stepRecord({
        id: "step-record-1",
        sessionId: session.id,
        ordinal: 1,
        operation: "sqs-etl",
        parameters: { command: "dump", queueName: "my-dlq" },
        outcome: "success",
      }),
    ];
    const bindings = [
      bindingRecord({
        id: "binding-1",
        sessionId: session.id,
        reference: "step-1.output.Queues[0]",
        parameterName: "queueName",
      }),
    ];
    const handle = createFakeRepository({ session, steps, bindings });

    const result = await buildSessionFlowExport(
      deps(handle),
      session.id,
      VALID_REQUEST,
    );

    expect(result.steps[0]?.parameterReferences["queueName"]).toBe(
      "step-1.output.Queues[0]",
    );
    expect(result.steps[0]?.parameterReferences["command"]).toBeNull();
  });
});
