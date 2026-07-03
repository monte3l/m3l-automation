/**
 * `core/network` — an event-emitting HTTP client (`M3LHttpClient`) wrapping
 * `undici`'s `fetch`, with automatic JSON parsing, per-request timeouts,
 * typed failure normalization, and optional proxy routing.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./M3LHttpClient.js";
export * from "./M3LHttpClientError.js";
