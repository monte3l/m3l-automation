/**
 * `core/json/M3LJSONFieldExtractor` — field extraction over a fixed path.
 *
 * @packageDocumentation
 */

import { extractAll, navigateFieldPath } from "./fieldPath.js";

/**
 * Extracts field values from arbitrary records using a dot-notation field
 * path fixed at construction time — a single value via {@link extract}, or
 * every wildcard-expanded match via {@link extractAll}.
 *
 * A thin wrapper over the standalone {@link navigateFieldPath} and
 * {@link extractAll}: it inherits the same semantics, including array
 * indexing and object-key lookup for numeric segments, `*` wildcard
 * expansion (multi-value only), the prototype-pollution guard, and returning
 * `undefined` / `[]` (never throwing) when a segment is missing or the
 * record shape does not match.
 *
 * @example
 * ```typescript
 * import { M3LJSONFieldExtractor } from "@m3l-automation/m3l-common/core";
 * const extractor = new M3LJSONFieldExtractor("metadata.author");
 * extractor.extract({ metadata: { author: "Ada" } }); // "Ada"
 * extractor.extract({ metadata: {} }); // undefined
 * ```
 */
export class M3LJSONFieldExtractor {
  /** The dot-notation field path used for every {@link extract} call. */
  private readonly fieldPath: string;

  /**
   * Creates a field extractor bound to a single field path.
   *
   * @param fieldPath - A dot-notation field path, e.g. `"metadata.author"`.
   */
  constructor(fieldPath: string) {
    this.fieldPath = fieldPath;
  }

  /**
   * Extracts the configured field path's value from `record`.
   *
   * @param record - The value to extract from. Typed `unknown` because
   *   callers pass arbitrary parsed data (e.g. JSON records).
   * @returns The extracted value, or `undefined` when the field path cannot
   *   be resolved against `record`.
   *
   * @example
   * ```typescript
   * import { M3LJSONFieldExtractor } from "@m3l-automation/m3l-common/core";
   * const extractor = new M3LJSONFieldExtractor("items.0");
   * extractor.extract({ items: ["x"] }); // "x" — a digit segment indexes into the array
   * ```
   */
  extract(record: unknown): unknown {
    return navigateFieldPath(record, this.fieldPath);
  }

  /**
   * Extracts every value matching the configured field path from `record`,
   * expanding `*` wildcards, in document order.
   *
   * @param record - The value to extract from. Typed `unknown` because
   *   callers pass arbitrary parsed data (e.g. JSON records).
   * @returns Every matching value, in document order. Empty when nothing
   *   matches.
   *
   * @example
   * ```typescript
   * import { M3LJSONFieldExtractor } from "@m3l-automation/m3l-common/core";
   * const extractor = new M3LJSONFieldExtractor("items.*.id");
   * extractor.extractAll({ items: [{ id: 1 }, { id: 2 }] }); // [1, 2]
   * ```
   */
  extractAll(record: unknown): readonly unknown[] {
    return extractAll(record, this.fieldPath);
  }
}
