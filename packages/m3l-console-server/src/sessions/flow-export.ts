/**
 * `sessions/flow-export` — `buildSessionFlowExport`, the X13 pure domain
 * module composing a session's recorded steps into an exportable flow
 * document (issue #561, PR 4/6).
 *
 * Built entirely on the `sessions` zone's own allowance (`sessions`,
 * `errors`, `store` — `bin/check-eslint-zones.mjs`'s `CONSOLE_SERVER_LAYERS`):
 * `store/sessions-repository-types.ts` for the session/step/binding/decision
 * shapes, `sessions/ports.ts`'s declared-not-imported
 * `M3LSessionScriptCatalogPort` mirror of `runs/descriptors.ts`'s `describe` so
 * this module never imports `runs/` directly, and `sessions/flow-yaml.ts`
 * for rendering the composed document.
 *
 * This module is wired to nothing yet — no route, no `service.ts` call site
 * — that lands in a later PR (X13 slice 5). It only reads the store; it
 * never writes a step, a binding, or a decision.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionStepRecord,
} from "../store/sessions-repository-types.js";
import type { M3LRunTerminalStatus } from "../store/run-status.js";

import type { M3LFlowYamlDocument, M3LFlowYamlStep } from "./flow-yaml.js";
import { renderFlowYaml } from "./flow-yaml.js";
import type { M3LSessionScriptCatalogPort } from "./ports.js";

/** The dependencies {@link buildSessionFlowExport} reads from. */
export interface SessionFlowExportDependencies {
  /** The sessions repository — read-only from this module's perspective. */
  readonly sessionsRepository: M3LConsoleSessionsRepository;
  /** The script catalog used to screen parameter keys for secrecy. */
  readonly scripts: M3LSessionScriptCatalogPort;
}

/**
 * One caller-supplied request to export a session's steps as a flow.
 *
 * @example
 * ```ts
 * const request: M3LSessionFlowExportRequest = { name: "dlq-reconcile" };
 * ```
 */
export interface M3LSessionFlowExportRequest {
  /** The requested flow name; must match `/^[a-z0-9-]+$/`. */
  readonly name: string;
  /** An optional flow description, carried through to the rendered document. */
  readonly description?: string;
}

/**
 * Provenance for one exported step: how a rendered flow step traces back to
 * the session step it was composed from.
 *
 * @example
 * ```ts
 * const provenance: M3LSessionFlowExportStepProvenance = {
 *   stepId: "step-record-1",
 *   ordinal: 1,
 *   flowStepId: "step-1",
 *   script: "sqs-etl",
 *   outcome: "success",
 *   parameterReferences: { queueName: "step-1.output.Queues[0]" },
 * };
 * ```
 */
export interface M3LSessionFlowExportStepProvenance {
  /** The session step's own id. */
  readonly stepId: string;
  /** The session step's ordinal. */
  readonly ordinal: number;
  /** This step's id within the rendered flow document (`"step-<ordinal>"`). */
  readonly flowStepId: string;
  /** The operation/script this step invokes. */
  readonly script: string;
  /** This step's recorded outcome, or `null` when it never reached one. */
  readonly outcome: M3LRunTerminalStatus | null;
  /**
   * For each of this step's parameter keys, the matching binding's
   * `reference` (a best-effort join against
   * {@link M3LConsoleSessionsRepository.listBindingsForSession}), or `null`
   * when no binding matches that key.
   */
  readonly parameterReferences: Readonly<Record<string, string | null>>;
}

/** The result of a successful {@link buildSessionFlowExport} call. */
export interface M3LSessionFlowExportResult {
  /** The requested flow name, echoed back. */
  readonly name: string;
  /** The rendered flow document's YAML text. */
  readonly yaml: string;
  /** Per-step export provenance, in ordinal order. */
  readonly steps: readonly M3LSessionFlowExportStepProvenance[];
  /** The number of the session's recorded decisions that were dropped (never rendered). */
  readonly decisionsDropped: number;
}

/** The flow-name grammar every {@link M3LSessionFlowExportRequest.name} must match. */
const FLOW_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Narrows `parameters` (typed `unknown` at rest — round-tripped through
 * JSON) to a plain string-valued record, throwing when any own value is not
 * a string.
 */
function narrowStringParameters(
  parameters: unknown,
  stepId: string,
): Record<string, string> {
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID",
      `step "${stepId}" has non-object parameters and cannot be exported`,
    );
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== "string") {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID",
        `step "${stepId}" parameter "${key}" is not a string and cannot be exported`,
      );
    }
    result[key] = value;
  }
  return result;
}

/**
 * Throws {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET"` when any of `parameterKeys`
 * matches a descriptor's `name` or any of its `aliases` where `secret` is
 * `true`. Deliberately checks aliases too — stricter than
 * `packages/m3l-cli/src/flow/validate-guards.ts`'s `screenSecretParameters`,
 * which only checks canonical names.
 */
async function screenSecretParameters(
  scripts: M3LSessionScriptCatalogPort,
  operation: string,
  parameterKeys: readonly string[],
  stepId: string,
): Promise<void> {
  const { parameters } = await scripts.describe(operation);
  const secretKeys = new Set<string>();
  for (const descriptor of parameters) {
    if (!descriptor.secret) continue;
    secretKeys.add(descriptor.name);
    for (const alias of descriptor.aliases) {
      secretKeys.add(alias);
    }
  }
  for (const key of parameterKeys) {
    if (secretKeys.has(key)) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET",
        `step "${stepId}" parameter "${key}" is declared secret and cannot be exported`,
      );
    }
  }
}

/** Builds one exported flow step and its provenance from one session step record. */
async function buildExportedStep(
  dependencies: SessionFlowExportDependencies,
  sessionId: string,
  step: M3LSessionStepRecord,
): Promise<{
  readonly flowStep: M3LFlowYamlStep;
  readonly provenance: M3LSessionFlowExportStepProvenance;
}> {
  const parameters = narrowStringParameters(step.parameters, step.id);
  const parameterKeys = Object.keys(parameters);

  await screenSecretParameters(
    dependencies.scripts,
    step.operation,
    parameterKeys,
    step.id,
  );

  const flowStepId = `step-${String(step.ordinal)}`;
  const flowStep: M3LFlowYamlStep = {
    id: flowStepId,
    script: step.operation,
    parameters,
    onSuccess: "continue",
    onFailure: "stop",
  };

  const bindings =
    dependencies.sessionsRepository.listBindingsForSession(sessionId);
  const parameterReferences: Record<string, string | null> = {};
  for (const key of parameterKeys) {
    const binding = bindings.find((b) => b.parameterName === key);
    parameterReferences[key] = binding?.reference ?? null;
  }

  const provenance: M3LSessionFlowExportStepProvenance = {
    stepId: step.id,
    ordinal: step.ordinal,
    flowStepId,
    script: step.operation,
    outcome: step.outcome ?? null,
    parameterReferences,
  };

  return { flowStep, provenance };
}

/**
 * Composes `sessionId`'s recorded steps into an exportable flow document.
 *
 * Validates `request.name` against `/^[a-z0-9-]+$/` before any repository
 * call. Every step is included regardless of its recorded `outcome` — the
 * rendered flow's `onSuccess: "continue"` / `onFailure: "stop"` pair on
 * every step lets the flow engine stop naturally when the step list runs
 * out. Decisions are counted but never rendered.
 *
 * @param dependencies - The repository and script catalog to read from.
 * @param sessionId - The session to export.
 * @param request - The caller's requested flow name/description.
 * @returns The rendered flow document plus per-step export provenance.
 * @throws {@link M3LConsoleError} with code
 *   `"ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID"` when `request.name` is
 *   malformed, or a step's parameters are not all strings.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
 *   when no session matches `sessionId`.
 * @throws {@link M3LConsoleError} with code
 *   `"ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY"` when the session has no steps.
 * @throws {@link M3LConsoleError} with code
 *   `"ERR_CONSOLE_SESSION_FLOW_EXPORT_SECRET"` when a step's parameter key
 *   (or an alias of one) is declared secret.
 *
 * @example
 * ```ts
 * import { buildSessionFlowExport } from "@m3l-automation/m3l-console-server/sessions/flow-export";
 *
 * const result = await buildSessionFlowExport(
 *   { sessionsRepository, scripts },
 *   "session-1",
 *   { name: "dlq-reconcile" },
 * );
 * ```
 */
export async function buildSessionFlowExport(
  dependencies: SessionFlowExportDependencies,
  sessionId: string,
  request: M3LSessionFlowExportRequest,
): Promise<M3LSessionFlowExportResult> {
  if (!FLOW_NAME_PATTERN.test(request.name)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID",
      `flow name "${request.name}" does not match /^[a-z0-9-]+$/`,
    );
  }

  const session = dependencies.sessionsRepository.getSession(sessionId);
  if (session === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      `no session found for id "${sessionId}"`,
    );
  }

  const sessionSteps =
    dependencies.sessionsRepository.listStepsForSession(sessionId);
  if (sessionSteps.length === 0) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY",
      `session "${sessionId}" has no steps to export`,
    );
  }

  const flowSteps: M3LFlowYamlStep[] = [];
  const provenanceSteps: M3LSessionFlowExportStepProvenance[] = [];
  for (const step of sessionSteps) {
    const { flowStep, provenance } = await buildExportedStep(
      dependencies,
      sessionId,
      step,
    );
    flowSteps.push(flowStep);
    provenanceSteps.push(provenance);
  }

  const document: M3LFlowYamlDocument = {
    name: request.name,
    steps: flowSteps,
    ...(request.description !== undefined && {
      description: request.description,
    }),
  };

  const yaml = renderFlowYaml(document, [
    `Generated by X13 session-flow-export from session "${sessionId}"`,
    `Exported at ${new Date().toISOString()}`,
  ]);

  const decisionsDropped =
    dependencies.sessionsRepository.listDecisionsForSession(sessionId).length;

  return {
    name: request.name,
    yaml,
    steps: provenanceSteps,
    decisionsDropped,
  };
}
