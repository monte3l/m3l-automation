import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { writePipeline } from "../src/steps/write-pipeline.js";
import { createFakeCodePipelineOperations } from "./support/codePipelineFakes.js";

/**
 * Contract: `scripts/codepipeline-ops/src/steps/write-pipeline.ts` — handles
 * `create-pipeline`/`update-pipeline`/`delete-pipeline`. `create`/`update`
 * take an already-JSON-parsed `declaration` record and guard-check
 * `name`/`roleArn`/a non-empty `stages` array present (throwing
 * `ERR_CODEPIPELINE_OPS_INPUT`), then cast to `AWS.M3LCodePipelineDeclaration`
 * and call `operations.createPipeline({declaration})`/
 * `operations.updatePipeline(declaration)`. `delete-pipeline` guard-checks
 * `pipeline` from config (`ERR_CODEPIPELINE_OPS_CONFIG`), awaits
 * `operations.deletePipeline(pipeline)`, and returns `undefined`. This step
 * never touches `destructive-gate`/`prompt` itself — `run-codepipeline-ops`
 * gates before dispatching here.
 */

const DECLARATION: AWS.M3LCodePipelineDeclaration = {
  name: "my-pipeline",
  roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
  stages: [{ name: "Source", actions: [] }],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("writePipeline — create-pipeline", () => {
  test("calls operations.createPipeline with the parsed declaration wrapped in { declaration }", async () => {
    const createPipeline = vi.fn().mockResolvedValue(DECLARATION);
    const operations = createFakeCodePipelineOperations({ createPipeline });
    const declaration = {
      name: "my-pipeline",
      roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
      stages: [{ name: "Source", actions: [] }],
    };

    const returned = await writePipeline({
      operations,
      operation: "create-pipeline",
      declaration,
      pipeline: undefined,
    });

    expect(createPipeline).toHaveBeenCalledWith({ declaration });
    expect(returned).toEqual(DECLARATION);
  });

  test("throws ERR_CODEPIPELINE_OPS_INPUT when declaration is undefined, never calling createPipeline", async () => {
    const createPipeline = vi.fn();
    const operations = createFakeCodePipelineOperations({ createPipeline });

    let thrown: unknown;
    try {
      await writePipeline({
        operations,
        operation: "create-pipeline",
        declaration: undefined,
        pipeline: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_INPUT");
    expect(createPipeline).not.toHaveBeenCalled();
  });

  test.each(["name", "roleArn", "stages"] as const)(
    "throws ERR_CODEPIPELINE_OPS_INPUT when the parsed declaration is missing '%s', never calling createPipeline",
    async (missing) => {
      const createPipeline = vi.fn();
      const operations = createFakeCodePipelineOperations({ createPipeline });
      const declaration: Record<string, unknown> = {
        name: "my-pipeline",
        roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
        stages: [{ name: "Source", actions: [] }],
      };
      delete declaration[missing];

      await expect(
        writePipeline({
          operations,
          operation: "create-pipeline",
          declaration,
          pipeline: undefined,
        }),
      ).rejects.toMatchObject({ code: "ERR_CODEPIPELINE_OPS_INPUT" });
      expect(createPipeline).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_CODEPIPELINE_OPS_INPUT when 'stages' is an empty array", async () => {
    const createPipeline = vi.fn();
    const operations = createFakeCodePipelineOperations({ createPipeline });
    const declaration = {
      name: "my-pipeline",
      roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
      stages: [],
    };

    await expect(
      writePipeline({
        operations,
        operation: "create-pipeline",
        declaration,
        pipeline: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CODEPIPELINE_OPS_INPUT" });
    expect(createPipeline).not.toHaveBeenCalled();
  });
});

describe("writePipeline — update-pipeline", () => {
  test("calls operations.updatePipeline with the parsed declaration directly (not wrapped)", async () => {
    const updatePipeline = vi.fn().mockResolvedValue(DECLARATION);
    const operations = createFakeCodePipelineOperations({ updatePipeline });
    const declaration = {
      name: "my-pipeline",
      roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
      stages: [{ name: "Source", actions: [] }],
    };

    const returned = await writePipeline({
      operations,
      operation: "update-pipeline",
      declaration,
      pipeline: undefined,
    });

    expect(updatePipeline).toHaveBeenCalledWith(
      expect.objectContaining(declaration),
    );
    expect(returned).toEqual(DECLARATION);
  });

  test("throws ERR_CODEPIPELINE_OPS_INPUT when declaration is undefined, never calling updatePipeline", async () => {
    const updatePipeline = vi.fn();
    const operations = createFakeCodePipelineOperations({ updatePipeline });

    await expect(
      writePipeline({
        operations,
        operation: "update-pipeline",
        declaration: undefined,
        pipeline: undefined,
      }),
    ).rejects.toMatchObject({ code: "ERR_CODEPIPELINE_OPS_INPUT" });
    expect(updatePipeline).not.toHaveBeenCalled();
  });

  test.each(["name", "roleArn", "stages"] as const)(
    "throws ERR_CODEPIPELINE_OPS_INPUT when the parsed declaration is missing '%s', never calling updatePipeline",
    async (missing) => {
      const updatePipeline = vi.fn();
      const operations = createFakeCodePipelineOperations({ updatePipeline });
      const declaration: Record<string, unknown> = {
        name: "my-pipeline",
        roleArn: "arn:aws:iam::123456789012:role/codepipeline-role",
        stages: [{ name: "Source", actions: [] }],
      };
      delete declaration[missing];

      await expect(
        writePipeline({
          operations,
          operation: "update-pipeline",
          declaration,
          pipeline: undefined,
        }),
      ).rejects.toMatchObject({ code: "ERR_CODEPIPELINE_OPS_INPUT" });
      expect(updatePipeline).not.toHaveBeenCalled();
    },
  );
});

describe("writePipeline — delete-pipeline", () => {
  test("calls operations.deletePipeline(pipeline) from config, ignoring declaration, resolving undefined", async () => {
    const deletePipeline = vi.fn().mockResolvedValue(undefined);
    const operations = createFakeCodePipelineOperations({ deletePipeline });

    const returned = await writePipeline({
      operations,
      operation: "delete-pipeline",
      declaration: undefined,
      pipeline: "my-pipeline",
    });

    expect(deletePipeline).toHaveBeenCalledWith("my-pipeline");
    expect(returned).toBeUndefined();
  });

  test("throws ERR_CODEPIPELINE_OPS_CONFIG when pipeline is undefined, never calling deletePipeline", async () => {
    const deletePipeline = vi.fn();
    const operations = createFakeCodePipelineOperations({ deletePipeline });

    let thrown: unknown;
    try {
      await writePipeline({
        operations,
        operation: "delete-pipeline",
        declaration: undefined,
        pipeline: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CODEPIPELINE_OPS_CONFIG");
    expect(deletePipeline).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("writePipeline's deps shape is exactly operations/operation/declaration/pipeline", () => {
    expectTypeOf<Parameters<typeof writePipeline>[0]>().toEqualTypeOf<{
      readonly operations: AWS.M3LCodePipelineOperations;
      readonly operation:
        "create-pipeline" | "update-pipeline" | "delete-pipeline";
      readonly declaration: Record<string, unknown> | undefined;
      readonly pipeline: string | undefined;
    }>();
  });

  test("writePipeline resolves M3LCodePipelineDeclaration | undefined", () => {
    expectTypeOf(writePipeline).returns.resolves.toEqualTypeOf<
      AWS.M3LCodePipelineDeclaration | undefined
    >();
  });
});
