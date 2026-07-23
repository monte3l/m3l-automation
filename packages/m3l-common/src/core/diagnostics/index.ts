/**
 * `core/diagnostics` — process exit-code mapping, error-chain
 * formatting/serialization, breadcrumbs, best-effort log/metric collection,
 * and the end-of-run report (ADR-0035).
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./exit-codes.js";
export * from "./format-error.js";
export * from "./breadcrumbs.js";
export * from "./collect.js";
export * from "./run-report.js";
