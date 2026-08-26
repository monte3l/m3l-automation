/**
 * `core/cli-contract` — the typed seam a script exports so a host (the `m3l`
 * CLI today, an agent runtime later) can invoke it in-process instead of
 * spawning `dist/main.js` and reading an exit code off a dead child
 * (ADR-0054).
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * `M3LExitCode`, `M3L_EXIT_CODES`, and `mapErrorToExitCode` stay singly owned
 * by `core/diagnostics`, `M3LConfigParameter` by `core/config`, and
 * `M3LLogger` by `core/logging` — re-exporting any of them here would collide
 * in `src/core/index.ts`'s star exports (TS2308, and a silently dropped
 * export under ES module semantics).
 *
 * @packageDocumentation
 */

export * from "./types.js";
export * from "./output.js";
export * from "./exit-codes.js";
