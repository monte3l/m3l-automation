import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Contract: docs/reference/scripts/api-gateway-client.md
 * `run-api-gateway-client` row. Thin dispatcher — reads `command` (already
 * oneOf-validated by the declared schema) and dynamic-imports the matching
 * step, forwarding the deps object unchanged. `run-sqs-etl.ts`'s dispatch
 * test is the direct model for this file: dynamic import (not a top-level
 * static import) so this file can `vi.mock` each step before dispatch
 * resolves it. This file asserts ONLY the dispatch — never a step's
 * internal logic (that is each step's own test file's job).
 */

const singleRequestMock = vi.fn();
const batchRequestMock = vi.fn();

vi.mock("../src/steps/single-request.js", () => ({
  singleRequest: singleRequestMock,
}));
vi.mock("../src/steps/batch-request.js", () => ({
  batchRequest: batchRequestMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import { runApiGatewayClient } from "../src/steps/run-api-gateway-client.js";
import { buildConfig, createFakeHttpClient } from "./support/httpFakes.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("runApiGatewayClient dispatch", () => {
  test.each([
    ["request", singleRequestMock],
    ["batch", batchRequestMock],
  ] as const)(
    "dispatches command '%s' to its matching step, passing deps through unchanged",
    async (command, mock) => {
      const config = buildConfig({ command });
      const paths = new Core.M3LPaths();
      const logger = new Core.M3LLogger([]);
      const httpClient = createFakeHttpClient();
      const prompt = new Core.M3LPrompt();

      await runApiGatewayClient({
        config,
        paths,
        logger,
        correlationId: "run-1",
        httpClient,
        signer: undefined,
        prompt,
      });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          paths,
          logger,
          correlationId: "run-1",
          httpClient,
          signer: undefined,
          prompt,
        }),
      );

      for (const other of [singleRequestMock, batchRequestMock]) {
        if (other !== mock) expect(other).not.toHaveBeenCalled();
      }
    },
  );

  test("defensively rejects an unrecognized 'command' value with a typed M3LError", async () => {
    const config = buildConfig({ command: "unknown-command" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);
    const httpClient = createFakeHttpClient();
    const prompt = new Core.M3LPrompt();

    let thrown: unknown;
    try {
      await runApiGatewayClient({
        config,
        paths,
        logger,
        correlationId: "run-2",
        httpClient,
        signer: undefined,
        prompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_API_GATEWAY_CLIENT_CONFIG",
    );
  });
});
