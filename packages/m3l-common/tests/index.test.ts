import { expect, test } from "vitest";

import * as m3l from "../src/index.js";

test("public barrel exposes the Core and AWS namespaces", () => {
  expect(m3l).toHaveProperty("Core");
  expect(m3l).toHaveProperty("AWS");
});

test("the Core and AWS namespaces are objects", () => {
  expect(typeof m3l.Core).toBe("object");
  expect(typeof m3l.AWS).toBe("object");
});

/**
 * Reads a value off a namespace object by string key, without a static
 * property-access type dependency (`namespace.<Symbol>`). This matters
 * because some cases below assert a symbol from a submodule that is only
 * partway wired into its barrel (see the diagnostics cases): a static
 * `m3l.Core.M3LRunReporter` access would fail the whole file at `tsc` time
 * with "property does not exist" the moment that symbol is absent, instead
 * of failing the one targeted assertion below for the right reason (a red
 * runtime test, not a broken test file).
 */
function readNamespaceMember(namespace: object, key: string): unknown {
  return (namespace as Record<string, unknown>)[key];
}

/**
 * One load-bearing, representative symbol per Core submodule barrel wired
 * into `src/core/index.ts`. Each case asserts that symbol is genuinely
 * reachable through the public `m3l.Core` namespace — not merely that
 * `m3l.Core` is an object (the previous, proxy-only assertion in this file).
 *
 * This is the regression guard for a barrel `export *` line being silently
 * dropped: every other test in the suite imports straight from `src/**`, so
 * none of them can observe that the *namespace* re-export is broken. Only a
 * test that goes through `../src/index.js` can.
 */
const CORE_REACHABILITY_CASES: ReadonlyArray<
  readonly [
    submodule: string,
    symbol: string,
    expectedType: "function" | "object",
  ]
> = [
  ["analysis", "M3LThresholdEvaluator", "function"],
  ["config", "M3LConfig", "function"],
  ["diagnostics", "mapErrorToExitCode", "function"],
  ["diagnostics", "M3L_EXIT_CODES", "object"],
  ["diagnostics", "formatErrorChain", "function"],
  ["diagnostics", "serializeErrorChain", "function"],
  ["diagnostics", "M3LBreadcrumbTrail", "function"],
  ["diagnostics", "collectDiagnostics", "function"],
  ["diagnostics", "M3LRunReporter", "function"],
  ["diagnostics", "isM3LErrorOrigin", "function"],
  ["diagnostics", "scrubUrlsInText", "function"],
  ["environment", "M3LExecutionEnvironment", "function"],
  ["errors", "M3LError", "function"],
  ["errors", "M3L_ERROR_CATALOG", "object"],
  ["errors", "classifyErrorCode", "function"],
  ["errors", "isM3LErrorCode", "function"],
  ["events", "M3LEventEmitter", "function"],
  ["exporters", "M3LJSONListExporter", "function"],
  ["files", "M3LFileCopier", "function"],
  ["importers", "M3LFileListImporter", "function"],
  ["json", "M3LJSONFieldExtractor", "function"],
  ["logging", "M3LLogger", "function"],
  ["messaging", "M3LMessenger", "function"],
  ["network", "M3LHttpClient", "function"],
  ["polling", "M3LPoller", "function"],
  ["prompt", "M3LPrompt", "function"],
  ["script", "M3LScript", "function"],
  ["security", "isDangerousKey", "function"],
  ["storage", "M3LFtsIndex", "function"],
  ["text", "M3LTextExtractorRegistry", "function"],
  ["utils", "M3LConcurrencyPool", "function"],
];

test.each(CORE_REACHABILITY_CASES)(
  "Core.%s is reachable through the public namespace as a %s (submodule core/%s)",
  (submodule, symbol, expectedType) => {
    const value = readNamespaceMember(m3l.Core, symbol);
    expect(value).toBeDefined();
    expect(typeof value).toBe(expectedType);
  },
);

/**
 * One load-bearing, representative symbol per AWS submodule barrel wired
 * into `src/aws/index.ts`. Same rationale as {@link CORE_REACHABILITY_CASES}.
 */
const AWS_REACHABILITY_CASES: ReadonlyArray<
  readonly [
    submodule: string,
    symbol: string,
    expectedType: "function" | "object",
  ]
> = [
  ["models", "parseAWSRegion", "function"],
  ["credentials", "M3LAWSCredentialsManager", "function"],
  ["clients", "AWSClientProvider", "function"],
  ["dynamodb", "getItem", "function"],
  ["cloudwatch-logs-insights", "M3LLogsInsightsClient", "function"],
  ["sqs", "M3LSQSOperations", "function"],
  ["signing", "M3LRequestSigner", "function"],
  ["s3", "getObject", "function"],
  ["athena", "M3LAthenaClient", "function"],
  ["eventbridge", "M3LEventBridgeOperations", "function"],
  ["lambda", "M3LLambdaOperations", "function"],
];

test.each(AWS_REACHABILITY_CASES)(
  "AWS.%s is reachable through the public namespace as a %s (submodule aws/%s)",
  (submodule, symbol, expectedType) => {
    const value = readNamespaceMember(m3l.AWS, symbol);
    expect(value).toBeDefined();
    expect(typeof value).toBe(expectedType);
  },
);

test("Core namespace exposes at least as many keys as there are wired submodule barrels", () => {
  // Mirrors the number of `export * from "./<module>/index.js"` lines in
  // src/core/index.ts (20, per ADR-0035 phase 1 — bump this alongside a new
  // submodule barrel). The per-submodule cases above are the primary defense
  // against one dropped export line; this is a coarse secondary canary that
  // catches a wholesale collapse of the barrel's export list.
  const CORE_WIRED_SUBMODULE_COUNT = 20;
  expect(Object.keys(m3l.Core).length).toBeGreaterThanOrEqual(
    CORE_WIRED_SUBMODULE_COUNT,
  );
});

test("AWS namespace exposes at least as many keys as there are wired submodule barrels", () => {
  // Mirrors src/aws/index.ts's 11 `export *` lines.
  const AWS_WIRED_SUBMODULE_COUNT = 11;
  expect(Object.keys(m3l.AWS).length).toBeGreaterThanOrEqual(
    AWS_WIRED_SUBMODULE_COUNT,
  );
});
