/**
 * `aws/codepipeline/client` — {@link M3LCodePipelineOperations}, a typed
 * wrapper over a raw `CodePipelineClient` so callers never import
 * `@aws-sdk/client-codepipeline` command classes directly. Scoped to pipeline
 * listing/description, the pipeline declaration model, execution control, and
 * stage transitions — CodePipeline ships no package-level waiter, so this
 * module has no `waitUntil*` method (see
 * `docs/reference/aws/codepipeline.md`).
 *
 * SCAFFOLD STATUS: every method below is a signature-only placeholder that
 * rejects with `M3LCodePipelineOperationError("... not yet implemented")`.
 * `implementing-submodules` turns these GREEN against the settled contract in
 * `docs/reference/aws/codepipeline.md`.
 *
 * @packageDocumentation
 */

import type { CodePipelineClient } from "@aws-sdk/client-codepipeline";

import { M3LCodePipelineOperationError } from "./error.js";
import type {
  M3LCodePipelineCreatePipelineInput,
  M3LCodePipelineDeclaration,
  M3LCodePipelineDefinition,
  M3LCodePipelineDisableStageTransitionInput,
  M3LCodePipelineEnableStageTransitionInput,
  M3LCodePipelineExecution,
  M3LCodePipelineListExecutionsResult,
  M3LCodePipelineListPipelinesResult,
  M3LCodePipelineStartExecutionResult,
  M3LCodePipelineState,
  M3LCodePipelineStopExecutionInput,
  M3LCodePipelineStopExecutionResult,
} from "./types.js";

/**
 * Options for {@link M3LCodePipelineOperations.listPipelines}.
 */
export interface M3LCodePipelineListPipelinesOptions {
  readonly nextToken?: string;
  readonly maxResults?: number;
}

/**
 * Options for {@link M3LCodePipelineOperations.listPipelineExecutions}.
 */
export interface M3LCodePipelineListExecutionsOptions {
  readonly nextToken?: string;
  readonly maxResults?: number;
}

/**
 * Options for {@link M3LCodePipelineOperations.getPipeline}.
 */
export interface M3LCodePipelineGetPipelineOptions {
  readonly version?: number;
}

/**
 * Options for {@link M3LCodePipelineOperations.startPipelineExecution}.
 */
export interface M3LCodePipelineStartExecutionOptions {
  readonly clientRequestToken?: string;
}

/**
 * Typed wrapper over a raw `CodePipelineClient`. Constructed once from a
 * provider-vended client (e.g. `script.aws.clients.codePipeline`) and reused
 * across calls; holds no state of its own beyond the client reference.
 *
 * @example
 * ```ts
 * import { M3LCodePipelineOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const codePipeline = new M3LCodePipelineOperations(script.aws.clients.codePipeline);
 * const { pipelines } = await codePipeline.listPipelines();
 * ```
 */
export class M3LCodePipelineOperations {
  readonly #client: CodePipelineClient;

  /**
   * Creates a new `M3LCodePipelineOperations` over the given raw client.
   *
   * @param client - The raw `CodePipelineClient` to wrap (e.g.
   *   `script.aws.clients.codePipeline`).
   */
  constructor(client: CodePipelineClient) {
    this.#client = client;
  }

  /**
   * Lists pipelines, one `nextToken` page per call (no auto-pagination).
   *
   * @param options - Optional `nextToken` and `maxResults`.
   * @returns The page of pipeline summaries plus an optional `nextToken`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  listPipelines(
    options?: M3LCodePipelineListPipelinesOptions,
  ): Promise<M3LCodePipelineListPipelinesResult> {
    // Referenced so `#client` isn't flagged unused before GREEN wires it in.
    void this.#client;
    void options;
    return Promise.reject(
      new M3LCodePipelineOperationError(
        "M3LCodePipelineOperations.listPipelines: not yet implemented",
      ),
    );
  }

  /**
   * Gets a pipeline's declaration (and metadata).
   *
   * @param name - The pipeline name.
   * @param options - Optional `version` to retrieve a specific pipeline version.
   * @returns The pipeline definition, or `undefined` when CodePipeline cannot
   *   resolve the given `name` (`PipelineNotFoundException`).
   * @throws {@link M3LCodePipelineOperationError} on any other rejected
   *   `.send()` call.
   */
  getPipeline(
    name: string,
    options?: M3LCodePipelineGetPipelineOptions,
  ): Promise<M3LCodePipelineDefinition | undefined> {
    void options;
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipeline: not yet implemented (name=${name})`,
      ),
    );
  }

  /**
   * Gets a pipeline's current stage/action state.
   *
   * @param name - The pipeline name.
   * @returns The pipeline state, or `undefined` when CodePipeline cannot
   *   resolve the given `name` (`PipelineNotFoundException`).
   * @throws {@link M3LCodePipelineOperationError} on any other rejected
   *   `.send()` call.
   */
  getPipelineState(name: string): Promise<M3LCodePipelineState | undefined> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipelineState: not yet implemented (name=${name})`,
      ),
    );
  }

  /**
   * Lists a pipeline's executions, one `nextToken` page per call (no
   * auto-pagination).
   *
   * @param pipelineName - The pipeline whose executions to list.
   * @param options - Optional `nextToken` and `maxResults`.
   * @returns The page of execution summaries plus an optional `nextToken`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  listPipelineExecutions(
    pipelineName: string,
    options?: M3LCodePipelineListExecutionsOptions,
  ): Promise<M3LCodePipelineListExecutionsResult> {
    void options;
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.listPipelineExecutions: not yet implemented (pipelineName=${pipelineName})`,
      ),
    );
  }

  /**
   * Gets a single pipeline execution's detail.
   *
   * @param pipelineName - The pipeline the execution belongs to.
   * @param pipelineExecutionId - The execution to describe.
   * @returns The execution detail, or `undefined` when CodePipeline cannot
   *   resolve the pipeline (`PipelineNotFoundException`) or the execution
   *   (`PipelineExecutionNotFoundException`) — the latter lets a `watch` poll
   *   loop tolerate the eventual-consistency window right after a trigger.
   * @throws {@link M3LCodePipelineOperationError} on any other rejected
   *   `.send()` call.
   */
  getPipelineExecution(
    pipelineName: string,
    pipelineExecutionId: string,
  ): Promise<M3LCodePipelineExecution | undefined> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.getPipelineExecution: not yet implemented (pipelineName=${pipelineName}, pipelineExecutionId=${pipelineExecutionId})`,
      ),
    );
  }

  /**
   * Creates a new pipeline.
   *
   * @param input - The pipeline creation input.
   * @returns The created pipeline's declaration, as returned by CodePipeline.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  createPipeline(
    input: M3LCodePipelineCreatePipelineInput,
  ): Promise<M3LCodePipelineDeclaration> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.createPipeline: not yet implemented (name=${input.declaration.name})`,
      ),
    );
  }

  /**
   * Updates an existing pipeline. **Takes a caller-authored complete
   * declaration** — this wrapper ships no get-mutate-put convenience method,
   * since {@link M3LCodePipelineDeclaration} is not a faithful round-trip of
   * {@link getPipeline} (see the spec page).
   *
   * @param declaration - The complete pipeline declaration to apply.
   * @returns The updated pipeline's declaration, as returned by CodePipeline.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  updatePipeline(
    declaration: M3LCodePipelineDeclaration,
  ): Promise<M3LCodePipelineDeclaration> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.updatePipeline: not yet implemented (name=${declaration.name})`,
      ),
    );
  }

  /**
   * Deletes a pipeline. **Destructive** — this wrapper performs no
   * confirmation gate of its own (see the spec page).
   *
   * @param name - The pipeline name to delete.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call. Deleting an already-absent pipeline is a CodePipeline no-op
   *   success, not an error.
   */
  deletePipeline(name: string): Promise<void> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.deletePipeline: not yet implemented (name=${name})`,
      ),
    );
  }

  /**
   * Starts a pipeline execution. **Not idempotent without
   * `options.clientRequestToken`** — supply it to dedupe retried triggers.
   *
   * @param name - The pipeline name to trigger.
   * @param options - Optional `clientRequestToken`.
   * @returns The started execution's `pipelineExecutionId`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call, including `ConcurrentPipelineExecutionsLimitExceededException`/
   *   `ConflictException` (neither classified as data — see the spec page).
   */
  startPipelineExecution(
    name: string,
    options?: M3LCodePipelineStartExecutionOptions,
  ): Promise<M3LCodePipelineStartExecutionResult> {
    void options;
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.startPipelineExecution: not yet implemented (name=${name})`,
      ),
    );
  }

  /**
   * Stops a pipeline execution. Unlike {@link deletePipeline}, re-stopping or
   * stopping an already-terminal execution **errors**
   * (`DuplicatedStopRequestException`/`PipelineExecutionNotStoppableException`
   * — neither classified as data, see the spec page).
   *
   * @param input - The pipeline/execution to stop, plus optional
   *   `abandon`/`reason`.
   * @returns The stopped execution's `pipelineExecutionId`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()` call.
   */
  stopPipelineExecution(
    input: M3LCodePipelineStopExecutionInput,
  ): Promise<M3LCodePipelineStopExecutionResult> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.stopPipelineExecution: not yet implemented (pipelineName=${input.pipelineName}, pipelineExecutionId=${input.pipelineExecutionId})`,
      ),
    );
  }

  /**
   * Enables a stage transition (inbound or outbound).
   *
   * @param input - The pipeline/stage/direction to enable.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call, including `StageNotFoundException` — deliberately **not**
   *   classified as data (a bad stage name is a caller error, see the spec
   *   page).
   */
  enableStageTransition(
    input: M3LCodePipelineEnableStageTransitionInput,
  ): Promise<void> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.enableStageTransition: not yet implemented (pipelineName=${input.pipelineName}, stageName=${input.stageName})`,
      ),
    );
  }

  /**
   * Disables a stage transition (inbound or outbound). Unlike
   * {@link enableStageTransition}, `input.reason` is **required**.
   *
   * @param input - The pipeline/stage/direction to disable, plus the
   *   required `reason`.
   * @throws {@link M3LCodePipelineOperationError} on a rejected `.send()`
   *   call, including `StageNotFoundException` — deliberately **not**
   *   classified as data (see the spec page).
   */
  disableStageTransition(
    input: M3LCodePipelineDisableStageTransitionInput,
  ): Promise<void> {
    return Promise.reject(
      new M3LCodePipelineOperationError(
        `M3LCodePipelineOperations.disableStageTransition: not yet implemented (pipelineName=${input.pipelineName}, stageName=${input.stageName})`,
      ),
    );
  }
}
