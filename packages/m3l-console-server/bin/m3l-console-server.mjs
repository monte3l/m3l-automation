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
const subcommand = process.argv[2];

if (subcommand === "cleanup") {
  // Operator-triggered retention sweep (ADR-0070 slice 5c). Orchestration
  // lives entirely in `src/cleanup.ts`; this branch only prints the outcome
  // or the failure message, matching the wrapper's existing failure convention.
  const { runCleanup } = await import("../dist/cleanup.js");
  try {
    const outcome = await runCleanup();
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(
      `m3l-console-server cleanup: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
} else if (subcommand !== undefined) {
  // An unknown subcommand must not silently start the long-running server —
  // a typo like `clenaup` would otherwise start a live process rather than
  // reporting the mistake immediately.
  process.stderr.write(
    `m3l-console-server: unknown subcommand '${subcommand}'; expected 'cleanup'\n`,
  );
  process.exitCode = 1;
} else {
  // No subcommand: start the server, exactly as before.
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
    try {
      // `closed`, never `shutdown()` — the latter TRIGGERS the drain, so
      // awaiting it here would tear the server down the instant it finished
      // booting. This resolves only once a trapped signal has driven the drain
      // through.
      const outcome = await console_.closed;
      // A drain that abandoned in-flight work is not a clean exit: report it in
      // the exit code so a supervisor (compose, systemd) can tell the difference
      // between "shut down as asked" and "gave up on N requests".
      process.exitCode = outcome.graceful ? 0 : 1;
    } catch (error) {
      // `closed` rejects when the shutdown sequence itself fails. Without this
      // catch that is an uncaught rejection at top level: the process dies with
      // a raw stack trace, losing both the stderr line and the exit code this
      // wrapper exists to produce — and a supervisor sees an abnormal
      // termination rather than a reported failure.
      process.stderr.write(
        `m3l-console-server: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
