#!/usr/bin/env node
// Process entry for the m3l console server. Kept outside src/ so every
// TypeScript module stays import-inert (fully exercisable under the per-file
// coverage gate); this wrapper is the only place that traps a process signal
// or writes to stderr.
//
// It is deliberately outside the `no-console` zone that covers src/: a boot
// failure happens before `createConsoleRuntime` has resolved a logger, and a
// drain failure happens after that logger's sinks may already be closed. In
// both windows stderr is the only channel left, so this file prints directly
// rather than pretending a logger exists.
const { startConsole } = await import("../dist/main.js");

let console_;
try {
  console_ = await startConsole();
} catch (error) {
  // No logger exists yet — config resolution or the bind itself failed.
  process.stderr.write(
    `m3l-console-server: failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

if (console_ !== undefined) {
  // `closed`, never `shutdown()` — the latter TRIGGERS the drain, so awaiting
  // it here would tear the server down the instant it finished booting. This
  // resolves only once a trapped SIGINT/SIGTERM has driven the drain through.
  const outcome = await console_.closed;
  // A drain that abandoned in-flight work is not a clean exit: report it in
  // the exit code so a supervisor (compose, systemd) can tell the difference
  // between "shut down as asked" and "gave up on N requests".
  process.exitCode = outcome.graceful ? 0 : 1;
}
