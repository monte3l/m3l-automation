/**
 * `core/json/M3LJSONFieldExtractor` — field extraction over a fixed path.
 *
 * @packageDocumentation
 */

import { navigateFieldPath } from "./fieldPath.js";

/**
 * Extracts a single field from arbitrary records using a dot-notation field
 * path fixed at construction time.
 *
 * A thin wrapper over {@link navigateFieldPath}: it inherits the same
 * semantics, including the object-keys-only rule for numeric segments, the
 * prototype-pollution guard, and returning `undefined` (never throwing) when
 * a segment is missing or the record shape does not match.
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
   * extractor.extract({ items: ["x"] }); // undefined — arrays are not indexed
   * ```
   */
  extract(record: unknown): unknown {
    return navigateFieldPath(record, this.fieldPath);
  }
}
