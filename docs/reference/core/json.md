# Core `json`

JSON utilities: dot-notation field-path navigation and JSON/JSONL format detection with configurable depth.

## Overview

The `json` module provides two capabilities. **Field paths** parse a dot-notation string into segments and traverse nested data — objects by key, arrays by numeric index, and `*` wildcards that fan out over array elements and object values — to retrieve either a single value (`navigateFieldPath`) or every match (`extractAll`). **Format detection** inspects a file and reports whether it is JSON or JSONL, with four depth levels that trade speed for accuracy. These primitives back the JSON importers and exporters but are also usable directly.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols:

- `parseFieldPath` — parse a dot-notation string into path segments
- `navigateFieldPath` — traverse a nested value along a path, returning a single value
- `extractAll` — extract every value matching a field path (wildcard-aware), in document order
- `M3LJSONFieldExtractor` — field extraction over parsed paths (single-value and multi-value)
- `M3LJSONFormatDetector` — JSON vs JSONL detection
- `M3LJSONFormat` — the detected format type (`'json' | 'jsonl' | 'unknown'`)
- `M3LJSONDetectionDepth` — the depth-level enum (`'extension' | 'shallow' | 'standard' | 'deep'`)
- `M3LJSONDetectorOptions` — detector options (selects the inspection `depth`)
- `M3LJSONDetectionResult` — the `{ format, confidence, method, details }` result
- `M3LConfidence` — a detection confidence constrained to the range `0`–`1`
- `M3LJSONFormatDetectionError` — thrown by `detect()` when the file cannot be read

## Usage

### Field paths

```typescript
import { Core } from "@m3l-automation/m3l-common";

const segments = Core.parseFieldPath("metadata.author");
// segments describe the path "metadata" -> "author"

const value = Core.navigateFieldPath(
  { metadata: { author: "Ada" } },
  "metadata.author",
);
// "Ada" — returns undefined if any segment is missing

// Numeric segments index into arrays, and stay object keys on objects:
Core.navigateFieldPath({ items: ["x", "y"] }, "items.1"); // "y"
Core.navigateFieldPath({ items: { "0": "x" } }, "items.0"); // "x"

// Multi-value extraction with `*` wildcards, in document order:
Core.extractAll({ items: [{ id: 1 }, { id: 2 }] }, "items.*.id"); // [1, 2]
Core.extractAll({ a: { v: 1 }, b: { v: 2 } }, "*.v"); // [1, 2]
Core.extractAll({ metadata: { author: "Ada" } }, "metadata.author"); // ["Ada"]
Core.extractAll({ metadata: {} }, "metadata.author"); // []

// Dangerous segments never traverse the prototype chain:
Core.navigateFieldPath({ a: {} }, "a.__proto__"); // undefined
Core.extractAll({ a: {} }, "a.__proto__"); // []
```

### Format detection

```typescript
import { Core } from "@m3l-automation/m3l-common";

const detector = new Core.M3LJSONFormatDetector();
const result = await detector.detect("./data/inputs/records.jsonl");
// {
//   format: "jsonl",
//   confidence: ...,
//   method: ...,
//   details: { ... }
// }

if (result.format === "json") {
  // parse as a JSON array
}
```

## Notes and behavior

- **Dot-notation field paths** — `parseFieldPath(path)` parses a dot-notation string (for example, `metadata.author`) into path segments; `navigateFieldPath(obj, path)` traverses the nested value and returns a single value, or `undefined` when a segment cannot be resolved; `extractAll(record, path)` returns every value matching the path. `M3LJSONFieldExtractor` binds a path at construction and offers both a single-value `extract` and a multi-value `extractAll`.
- **Array indexing** — a numeric segment (for example `"1"` in `items.1.name`) indexes into an array when the current value is an array; an out-of-range index resolves to `undefined` / no match. On a plain object the same numeric segment remains an object-key lookup, so `{ "0": "x" }` still resolves at `items.0`. This is a backward-compatible widening: a path that previously dead-ended on an array now resolves.
- **Wildcards** — a `*` segment fans out over every element of an array or every own enumerable value of a plain object. Wildcards are inherently multi-valued: `extractAll` expands them (matches in document order), while the single-valued `navigateFieldPath` does not expand `*`.
- **Single vs multi-value** — `navigateFieldPath` and `M3LJSONFieldExtractor.extract` return one value (`undefined` when unresolved). `extractAll` and `M3LJSONFieldExtractor.extractAll` return a `readonly unknown[]`: a plain (wildcard-free) path yields 0 or 1 element, a wildcard path yields all matches in document order. Neither ever throws on a shape mismatch — a mismatched segment resolves to `undefined` (single-value) or is skipped (multi-value).
- **Prototype-pollution guard** — `navigateFieldPath`, `extractAll`, and `M3LJSONFieldExtractor` refuse to traverse the dangerous keys `__proto__`, `constructor`, and `prototype`. A dangerous segment resolves to `undefined` / drops the branch, exactly as a missing segment does, and wildcards never expand onto these keys, so a crafted path can never reach an object's prototype chain.
- **Detection result** — `M3LJSONFormatDetector.detect(filePath)` returns `{ format, confidence, method, details }`, where `format` is an `M3LJSONFormat` value, `confidence` is an `M3LConfidence` (a `number` constrained to `0`–`1`), `method` is the `M3LJSONDetectionDepth` actually used, and `details` reports how much was read (`bytesInspected` is a count of UTF-8 bytes; `linesInspected` a count of lines).
- **Bounded reads** — each depth reads only as much of the file as it needs: `extension` reads nothing, `shallow` a single byte, `standard` a bounded prefix covering the first lines, and `deep` bounded windows from the start, middle, and end. A large file is never buffered whole to inspect a shallow signal.
- **Read failures** — if the file cannot be read (missing, unreadable), `detect()` rejects with an `M3LJSONFormatDetectionError` (a subclass of `M3LError`) that chains the underlying filesystem error as its `cause`.
- **Detection depth levels** — four levels trade speed for accuracy:

  | Depth       | What it inspects                                       |
  | ----------- | ------------------------------------------------------ |
  | `extension` | The file extension only (fastest)                      |
  | `shallow`   | The first byte                                         |
  | `standard`  | The first N lines                                      |
  | `deep`      | A sample drawn from the middle and end (most accurate) |

- The detector underpins the JSON importer's array-vs-JSONL dispatch; see [importers](./importers.md).

## See also

- [importers](./importers.md) — JSON/JSONL parsing and field-path extraction.
- [exporters](./exporters.md) — JSON array vs JSONL output.
- [text](./text.md) — other format-aware extraction utilities.
