/**
 * `core/storage` — durable local storage primitives: an embedded, synchronous
 * full-text search index backed by SQLite's FTS5 extension, and an
 * append-only segmented JSONL stream for audit trails.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./M3LAppendOnlyStream.js";
export * from "./M3LAppendOnlyStreamError.js";
export * from "./M3LFtsIndex.js";
export * from "./M3LFtsIndexError.js";
export * from "./types.js";
