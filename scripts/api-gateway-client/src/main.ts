import { Core } from "@m3l-automation/m3l-common";

import { configParameters } from "./config.js";
import { getCorrelationId, hooks } from "./hooks.js";
import { runApiGatewayClient } from "./steps/run-api-gateway-client.js";

// Composition root ONLY (ADR-0022): construct the script, wire config/hooks,
// and run the step. Any conditional, loop, or I/O beyond wiring belongs in a
// steps/ module — reviewers reject business logic here.
//
// `run`'s main function takes no arguments; reach the library through the
// script instance (`script.logger`, `await script.getConfiguration()`,
// `script.aws`, `script.paths`, `script.prompt`) and inject what each step
// needs as parameters. The per-run correlation id is captured by
// `hooks.onBeforeRun` (mainFn itself receives no `ctx`) and read back via
// `getCorrelationId()`. The `auth: iam` + unprovisioned-`script.aws` guard
// lives in `resolve-auth-headers.ts` (its single source of truth, covered by
// `tests/resolve-auth-headers.test.ts`) — not duplicated here.
const script = new Core.M3LScript({
  metadata: { name: "api-gateway-client", version: "0.0.0" },
  config: { params: configParameters },
  hooks,
});

// A --dry-run switch validates environment, configuration, and AWS
// credentials (pipeline stages 1-5) without executing the run — the one
// argv read the composition root is permitted.
const dryRun = process.argv.includes("--dry-run");

await Core.runScript(
  script,
  async () => {
    const config = await script.getConfiguration();

    const baseUrl = config.get("baseUrl");
    const httpClient = new Core.M3LHttpClient({
      ...(typeof baseUrl === "string" && { baseUrl }),
      defaultHeaders: {},
    });

    await runApiGatewayClient({
      config,
      paths: script.paths,
      logger: script.logger,
      correlationId: getCorrelationId(),
      httpClient,
      signer: script.aws?.clients.requestSigner,
      prompt: script.prompt,
    });
  },
  { dryRun },
);
