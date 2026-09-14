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
const { startM3LMcpServer } = await import("../dist/main.js");

try {
  await startM3LMcpServer();
} catch (error) {
  // Policy load, decision-log preflight, or the transport connect failed.
  // The server refuses to serve rather than serving unaudited, so a boot
  // failure is terminal — report it and exit non-zero for the supervising
  // MCP client.
  //
  // Only `error.message` is printed, never a chained `cause` or a stack: a
  // cause's own message may embed an absolute path or file content, and this
  // package's contract is that neither reaches a client's stderr log.
  process.stderr.write(
    `m3l-mcp: failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
