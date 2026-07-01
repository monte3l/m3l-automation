/**
 * `core/json` — dot-notation field-path navigation and JSON/JSONL format
 * detection.
 *
 * Re-exports all public symbols from the implementation modules.
 * No logic lives here; this file is a barrel only.
 *
 * @packageDocumentation
 */

export * from "./fieldPath.js";
export * from "./M3LJSONFieldExtractor.js";
export * from "./M3LJSONFormatDetectionError.js";
export * from "./M3LJSONFormatDetector.js";
export * from "./types.js";
