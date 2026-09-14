#!/usr/bin/env node
// Process entry for the m3l runtime MCP server (ADR-0062). Kept outside src/
// so every TypeScript module stays import-inert (fully exercisable under the
// per-file coverage gate); this wrapper is the only place that traps a boot
// failure or writes to a stream directly.
//
// THE STDOUT RULE: under stdio transport, stdout IS the JSON-RPC framing
// channel. A single stray byte written outside the transport corrupts every
// message framed after it, so this file writes exclusively to stderr — and
// src/ is inside the `no-console` ESLint zone for the same reason. This is
// the same constraint bin/mcp-server.mjs (the dev-time server, ADR-0030 /
// ADR-0096) states in its own header; the two servers are deliberately
// distinct surfaces and must not be conflated.
//
// It is deliberately outside that zone itself: a boot failure happens before
// any logger or transport exists, so stderr is the only channel available.
// Loading the build output is its own failure class, caught separately from
// a server boot failure, because its error message cannot be printed at all.
// `dist/main.js` is absent on an unbuilt checkout, a partial install, or a
// corrupted package — all plausible for a freshly scaffolded entry point.
// Left outside a try, a rejecting top-level `await import()` is an unhandled
// rejection and Node's default handler dumps message AND stack, both carrying
// this machine's absolute paths. But catching it is not enough either:
// Node's own `ERR_MODULE_NOT_FOUND` message embeds the full resolved path and
// the importing file's path, so forwarding `error.message` here would leak
// exactly what the rule below forbids. Hence a fixed line that names the
// remedy and no filesystem detail. Deliberately does not distinguish
// "missing" from "unloadable" (a syntax error in the build output rejects
// here too): both are answered by rebuilding, and telling them apart would
// mean reading the message this branch exists to withhold.
let startM3LMcpServer;
try {
  ({ startM3LMcpServer } = await import("../dist/main.js"));
} catch {
  process.stderr.write(
    "m3l-mcp: failed to start: could not load the package's build output; run `pnpm build`\n",
  );
  process.exitCode = 1;
}

try {
  // Skipped when the import above already failed and set the exit code —
  // calling `undefined` would replace that clean line with a TypeError.
  if (startM3LMcpServer !== undefined) await startM3LMcpServer();
} catch (error) {
  // Module load, policy load, decision-log preflight, or the transport
  // connect failed. The server refuses to serve rather than serving
  // unaudited, so a boot failure is terminal — report it and exit non-zero
  // for the supervising MCP client.
  //
  // Only `error.message` is printed, never a chained `cause` or a stack: a
  // cause's own message may embed an absolute path or file content, and this
  // package's contract is that neither reaches a client's stderr log.
  //
  // `code` is the exception, and is safe: it is a closed enum of subsystem
  // tags (`M3LMcpErrorCode`), never caller data or a path, and it is the one
  // structured discriminator that tells an operator WHICH subsystem refused
  // — information the message alone does not reliably carry.
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? ` [${error.code}]`
      : "";
  process.stderr.write(
    `m3l-mcp: failed to start${code}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
