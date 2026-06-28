# Core `json`

JSON utilities: dot-notation field-path navigation and JSON/JSONL format detection with configurable depth.

## Overview

The `json` module provides two capabilities. **Field paths** parse a dot-notation string into segments and traverse nested objects to retrieve a value. **Format detection** inspects a file and reports whether it is JSON or JSONL, with four depth levels that trade speed for accuracy. These primitives back the JSON importers and exporters but are also usable directly.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols:

- `parseFieldPath` — parse a dot-notation string into path segments
- `navigateFieldPath` — traverse a nested object along a path
- `M3LJSONFieldExtractor` — field extraction over parsed paths
- `M3LJSONFormatDetector` — JSON vs JSONL detection
- `M3LJSONFormat` — the detected format type (`'json' | 'jsonl' | 'unknown'`)
- Detection depth / options / result types — the depth-level enum, detector options, and the `{ format, confidence, method, details }` result

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

- **Dot-notation field paths** — `parseFieldPath(path)` parses a dot-notation string (for example, `metadata.author`) into path segments; `navigateFieldPath(obj, path)` traverses the nested object and returns the value, or `undefined` when a segment is absent. `M3LJSONFieldExtractor` builds on these to extract fields from parsed records.
- **Detection result** — `M3LJSONFormatDetector.detect(filePath)` returns `{ format, confidence, method, details }`, where `format` is an `M3LJSONFormat` value.
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
