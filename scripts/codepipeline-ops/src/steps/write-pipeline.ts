import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The three mutating operations `writePipeline` dispatches. */
type WriteOperation = "create-pipeline" | "update-pipeline" | "delete-pipeline";

/**
 * The dependencies `writePipeline` needs, already resolved by
 * `run-codepipeline-ops` — `declaration` arrives as the already-JSON-parsed
 * record for `create-pipeline`/`update-pipeline` (`undefined` for
 * `delete-pipeline`, which reads `pipeline` from config instead). This step
 * takes no raw `Core.M3LConfig` and never touches `destructive-gate`/
 * `prompt` itself (`run-codepipeline-ops` gates before ever dispatching
 * here).
 */
interface WritePipelineDeps {
  readonly operations: AWS.M3LCodePipelineOperations;
  readonly operation: WriteOperation;
  readonly declaration: Record<string, unknown> | undefined;
  readonly pipeline: string | undefined;
}

/** Guard-checks `declaration` present, for `create-pipeline`/`update-pipeline`. */
function requireDeclarationRecord(
  declaration: Record<string, unknown> | undefined,
  operation: WriteOperation,
): Record<string, unknown> {
  if (declaration === undefined) {
    throw new Core.M3LError(
      `writePipeline: 'input' is required for '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_INPUT" },
    );
  }
  return declaration;
}

/** Guard-checks `value` present, for `delete-pipeline`'s `pipeline` config value. */
function requireString(
  value: string | undefined,
  name: string,
  operation: WriteOperation,
): string {
  if (value === undefined) {
    throw new Core.M3LError(
      `writePipeline: '${name}' is required for '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_CONFIG" },
    );
  }
  return value;
}

/** Reads a required, non-empty string field off an already-parsed declaration object. */
function readRequiredStringField(
  record: Record<string, unknown>,
  fieldName: string,
  operation: WriteOperation,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(
      `writePipeline: 'input.${fieldName}' must be a non-empty string for '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_INPUT" },
    );
  }
  return value;
}

/** Reads a required, non-empty array field off an already-parsed declaration object. */
function readRequiredArrayField(
  record: Record<string, unknown>,
  fieldName: string,
  operation: WriteOperation,
): readonly unknown[] {
  const value = record[fieldName];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Core.M3LError(
      `writePipeline: 'input.${fieldName}' must be a non-empty array for '${operation}'`,
      { code: "ERR_CODEPIPELINE_OPS_INPUT" },
    );
  }
  return value;
}

/**
 * Narrows an already-parsed declaration record into
 * `M3LCodePipelineDeclaration`, guard-checking `name`/`roleArn`/`stages`
 * present (the wrapper's own required fields) — every other field is trusted
 * as-is, matching `M3LCodePipelineOperations.createPipeline`/
 * `.updatePipeline`'s own no-pre-flight-validation stance on everything but
 * the six write-path enum fields it validates itself.
 *
 * The `input` file is expected to be a **complete** declaration — the
 * caller-authored `--cli-input-json` idiom the wrapper's own docs mandate,
 * never a mutated `getPipeline` result. `updatePipeline` replaces the whole
 * declaration; any field this parse doesn't require but the caller omits
 * (e.g. `artifactStore`, `variables`) is silently absent from the live
 * pipeline afterward — that lossy-replacement risk lives in the input file's
 * authoring, not in this parse.
 *
 * This is a KNOWN, INTENTIONAL trust boundary, not an oversight: only the
 * three top-level required fields are validated. A structurally malformed
 * nested element — e.g. `stages: [{}]` (a stage missing `name`/`actions`) —
 * passes this guard and reaches `AWS.M3LCodePipelineOperations.createPipeline`/
 * `.updatePipeline`, whose own `buildDeclaration` runs outside its `try`
 * block by design (so a validation failure there isn't mislabeled as an SDK
 * call failure) — meaning a malformed nested shape can surface as a raw,
 * unwrapped `TypeError` rather than a typed `M3LError`. The same shallow
 * "guard the top level, trust the rest as-is" stance is used by
 * `ecs-ops`'s `write-service.ts`; a caller-authored `input` file is treated
 * as a trusted config artifact at the script's own doorstep, not adversarial
 * external input.
 */
function asDeclaration(
  record: Record<string, unknown>,
  operation: WriteOperation,
): AWS.M3LCodePipelineDeclaration {
  readRequiredStringField(record, "name", operation);
  readRequiredStringField(record, "roleArn", operation);
  readRequiredArrayField(record, "stages", operation);
  return record as unknown as AWS.M3LCodePipelineDeclaration;
}

/**
 * Runs `codepipeline-ops`'s three mutating pipeline-declaration operations:
 * `create-pipeline` (`operations.createPipeline`), `update-pipeline`
 * (`operations.updatePipeline`), and `delete-pipeline`
 * (`operations.deletePipeline`). `run-codepipeline-ops` always routes
 * through `destructive-gate` before dispatching here — this step performs no
 * confirmation of its own.
 *
 * @param deps - The injected `AWS.M3LCodePipelineOperations`, which
 *   mutating operation to run, the already-parsed declaration record (for
 *   `create-pipeline`/`update-pipeline`), and the `pipeline` config value
 *   (for `delete-pipeline`).
 * @returns The `M3LCodePipelineDeclaration` (as returned by CodePipeline)
 *   for `create-pipeline`/`update-pipeline`; `undefined` for
 *   `delete-pipeline`.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_CONFIG"` when
 *   `delete-pipeline`'s `pipeline` config value is missing.
 * @throws {@link Core.M3LError} coded `"ERR_CODEPIPELINE_OPS_INPUT"` when
 *   `input` is missing for `create-pipeline`/`update-pipeline`, or the
 *   parsed declaration lacks `name`/`roleArn`/a non-empty `stages` array.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { writePipeline } from "./write-pipeline.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LCodePipelineOperations(script.aws.clients.codePipeline)`.
 * declare const operations: AWS.M3LCodePipelineOperations;
 *
 * await writePipeline({
 *   operations,
 *   operation: "delete-pipeline",
 *   declaration: undefined,
 *   pipeline: "my-pipeline",
 * });
 * ```
 */
export async function writePipeline(
  deps: WritePipelineDeps,
): Promise<AWS.M3LCodePipelineDeclaration | undefined> {
  switch (deps.operation) {
    case "create-pipeline": {
      const record = requireDeclarationRecord(deps.declaration, deps.operation);
      const declaration = asDeclaration(record, deps.operation);
      return deps.operations.createPipeline({ declaration });
    }
    case "update-pipeline": {
      const record = requireDeclarationRecord(deps.declaration, deps.operation);
      const declaration = asDeclaration(record, deps.operation);
      return deps.operations.updatePipeline(declaration);
    }
    case "delete-pipeline": {
      const pipeline = requireString(deps.pipeline, "pipeline", deps.operation);
      await deps.operations.deletePipeline(pipeline);
      return undefined;
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_CODEPIPELINE_OPS_CONFIG",
      });
    }
  }
}
