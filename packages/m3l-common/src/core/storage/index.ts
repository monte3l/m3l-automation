/**
 * `core/storage` — an embedded, synchronous full-text search index backed by
 * SQLite's FTS5 extension.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./M3LFtsIndex.js";
export * from "./M3LFtsIndexError.js";
export * from "./types.js";
