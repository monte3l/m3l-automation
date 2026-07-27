/**
 * Tests for aws/codepipeline submodule.
 *
 * Contract source: docs/reference/aws/codepipeline.md.
 *
 * Exports under test (from `../src/aws/codepipeline/index.js`, following
 * the package's `../src/aws/index.js` barrel):
 *   M3LCodePipelineOperations, M3LCodePipelineOperationError, and the
 *   M3LCodePipeline* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-codepipeline` is mocked with a
 * top-level `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/cloudformation.test.ts`), with a `.send()` spy dispatching by
 * command class. Unlike cloudformation/ecs, CodePipeline ships **no**
 * package-level `waitUntil*` waiter functions, so there are no waiter spies
 * here — see `docs/reference/aws/codepipeline.md`'s "Watching an execution"
 * section.
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LCodePipelineOperations`'s
 * methods currently reject with
 * `M3LCodePipelineOperationError("... not yet implemented")` (see
 * src/aws/codepipeline/client.ts). `implementing-submodules` turns them
 * GREEN; `test-author` expands this seed into the full happy/failure-path
 * suite against the settled contract.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies + a fake constructible client class referenced by
// the hoisted `vi.mock` factory below (mirrors tests/cloudformation.test.ts).
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class CodePipelineClient {
    send = send;
    destroy = destroy;
  }
  class ListPipelinesCommand {
    constructor(readonly input: unknown) {}
  }
  class GetPipelineCommand {
    constructor(readonly input: unknown) {}
  }
  class GetPipelineStateCommand {
    constructor(readonly input: unknown) {}
  }

  return {
    send,
    destroy,
    CodePipelineClient,
    ListPipelinesCommand,
    GetPipelineCommand,
    GetPipelineStateCommand,
  };
});

vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: h.CodePipelineClient,
  ListPipelinesCommand: h.ListPipelinesCommand,
  GetPipelineCommand: h.GetPipelineCommand,
  GetPipelineStateCommand: h.GetPipelineStateCommand,
}));

import type { CodePipelineClient } from "@aws-sdk/client-codepipeline";

import {
  M3LCodePipelineOperationError,
  M3LCodePipelineOperations,
  type M3LCodePipelineDeclaration,
} from "../src/aws/codepipeline/index.js";

/** Casts the hoisted fake `CodePipelineClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): CodePipelineClient {
  return new h.CodePipelineClient() as unknown as CodePipelineClient;
}

describe("M3LCodePipelineOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  test("listPipelines resolves the mapped page (RED until GREEN)", async () => {
    h.send.mockResolvedValueOnce({
      pipelines: [{ name: "demo-pipeline", version: 3 }],
      nextToken: "page-2",
    });

    const operations = new M3LCodePipelineOperations(fakeClient());

    await expect(operations.listPipelines()).resolves.toStrictEqual({
      pipelines: [{ name: "demo-pipeline", version: 3 }],
      nextToken: "page-2",
    });
  });

  test("getPipeline resolves undefined on PipelineNotFoundException (RED until GREEN)", async () => {
    const notFound = Object.assign(new Error("Pipeline not found"), {
      name: "PipelineNotFoundException",
    });
    h.send.mockRejectedValueOnce(notFound);

    const operations = new M3LCodePipelineOperations(fakeClient());

    await expect(
      operations.getPipeline("missing-pipeline"),
    ).resolves.toBeUndefined();
  });

  test("listPipelines rejects with M3LCodePipelineOperationError on an unmatched SDK failure", async () => {
    const operations = new M3LCodePipelineOperations(fakeClient());

    // The scaffold stub always rejects regardless of the mock — this
    // assertion is the "RED by design" contract check itself.
    await expect(operations.listPipelines()).rejects.toBeInstanceOf(
      M3LCodePipelineOperationError,
    );
  });

  test("M3LCodePipelineDeclaration shape matches the documented contract", () => {
    expectTypeOf<M3LCodePipelineDeclaration>().toMatchTypeOf<{
      readonly name: string;
      readonly roleArn: string;
      readonly stages: readonly unknown[];
    }>();
  });
});
