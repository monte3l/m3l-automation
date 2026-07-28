# Core `files`

Execution-directory file archival: register files during a run, then finalize them into the output directory with a per-file report and overall summary.

## Overview

`M3LFileCopier` batches files for copy to an execution output directory. Files are registered as the script runs and copied together at the end. Registration accepts a subdirectory hint, and finalization produces an `M3LFileCopyReport` describing each copy (size, destination, timestamp) along with an aggregate summary. Behavior such as size-based skipping, overwrite control, manifest generation, and large-file prompts is configurable through `M3LFileCopierOptions`.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols:

- `M3LFileCopier`
- `M3L_FILE_COPIER_DEFAULTS` — default option values
- `getDefaultSubdirForPathType` — maps a path type to its default subdirectory
- `M3LFileCopierOptions`
- `M3LFileCopyResult` — a single file's outcome
- `M3LFileCopySkipReason` — why a file was skipped: `'size-too-large'`, `'already-exists'`, `'source-unreadable'`, or `'declined-by-prompt'`
- `M3LFileCopyReport` — the full report returned by `finalizeRegisteredFiles()`
- `M3LFileCopyReportSummary` — the aggregate portion of the report
- `M3LFileCopyError` — thrown on a batch-fatal copy failure or invalid copier options (chains the underlying cause)
- `M3LInputFileReader` — reads and JSON-parses a caller-named input file under `M3LPaths`' input directory, plus defensive record-field readers over the parsed result and `M3LInputFileReaderOptions`

### Methods

- `registerFile(sourcePath, options)` — queue a file for copy, with a subdirectory hint.
- `finalizeRegisteredFiles()` — execute the queued copies and return an `M3LFileCopyReport`.

## Usage

```typescript
import { Core } from "@m3l-automation/m3l-common";

const copier = new Core.M3LFileCopier({
  // options validated against M3L_FILE_COPIER_DEFAULTS
});

// Register files as the script runs.
copier.registerFile("./data/inputs/source.csv", { subdir: "inputs" });
copier.registerFile("./config.yaml", { subdir: "configs" });

// Finalize at the end of the run.
const report = await copier.finalizeRegisteredFiles();

for (const result of report.results) {
  if (result.skipped) {
    console.warn(`skipped (${result.reason})`);
  } else {
    console.log(`copied to ${result.destination} (${result.size} bytes)`);
  }
}

console.log(report.summary);
```

### Default subdirectory for a path type

```typescript
import { Core } from "@m3l-automation/m3l-common";

const subdir = Core.getDefaultSubdirForPathType("input");
copier.registerFile("./data/inputs/source.csv", { subdir });
```

## Reading an input file (`M3LInputFileReader`)

Reading and JSON-parsing a caller-named file under `M3LPaths`' input directory
(e.g. a consumer script's `input`/`template` config parameter) is a separate
concern from archival: it happens at the start of a run, not the end, and the
two genuinely distinct failure modes — a missing/unreadable file vs. malformed
JSON — need their own typed errors. `M3LInputFileReader` binds an `M3LPaths`
instance and a caller-supplied `M3LError` `code` so a script only names the
file.

```typescript
export interface M3LInputFileReaderOptions {
  readonly paths: M3LPaths;
  readonly code: string;
}

export class M3LInputFileReader {
  constructor(options: M3LInputFileReaderOptions);
  readText(name: string): Promise<string>;
  readJSON(name: string): Promise<unknown>;
  readJSONRecord(name: string): Promise<Readonly<Record<string, unknown>>>;
  asRecord(value: unknown, name: string): Readonly<Record<string, unknown>>;
  requireRecord(
    record: Readonly<Record<string, unknown>> | undefined,
    name: string,
    operation: string,
  ): Readonly<Record<string, unknown>>;
  requiredStringField(
    record: Readonly<Record<string, unknown>>,
    field: string,
    operation: string,
  ): string;
  requiredArrayField(
    record: Readonly<Record<string, unknown>>,
    field: string,
    operation: string,
  ): readonly unknown[];
  optionalStringField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): string | undefined;
  optionalNumberField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): number | undefined;
  optionalBooleanField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): boolean | undefined;
  optionalArrayField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): readonly unknown[] | undefined;
  optionalRecordField(
    record: Readonly<Record<string, unknown>>,
    field: string,
  ): Readonly<Record<string, unknown>> | undefined;
}
```

- **`readText(name)`** — resolves `name` via `paths.resolveInput(name)` and
  reads it as UTF-8 text. A `cause` that is already an `M3LError` (e.g.
  `M3LPathResolutionError` from a traversal-containing `name`) propagates
  unchanged; any other failure (a missing/unreadable file) is wrapped in
  `M3LError` (`options.code`, message `failed reading input file '${name}'`,
  chaining the original `cause`).
- **`readJSON(name)`** — calls `readText`, then `JSON.parse`s the result.
  **Deliberately does not chain the raw `SyntaxError` as `cause`, and never
  reads its `.message`.** `JSON.parse`'s thrown `SyntaxError.message` embeds
  up to ~10 characters of the malformed source content around the failure
  position; chaining it (or reading it into the thrown message) would let
  that snippet — and, worst case, a secret sitting at that exact offset —
  survive into a persisted `run-report.json` (`core/diagnostics`'
  name-based redaction does not match unstructured free text). On a parse
  failure, only the failing error's `name` is folded into the thrown
  message — `"SyntaxError"` for `JSON.parse`'s own throw, the only value
  reachable in practice, with `"SyntaxError"` itself as the fallback should a
  non-`Error` ever be thrown: `M3LError` (`options.code`, message
  `'${name}' must be valid JSON (${errorName})`), with **no `cause`**.
- **`readJSONRecord(name)`** — `readJSON(name)` narrowed through
  `asRecord`; the common case for a config file that must decode to a
  top-level JSON object.
- **`asRecord(value, name)`** — narrows an already-parsed JSON value to a
  `Readonly<Record<string, unknown>>`, throwing `M3LError` (`options.code`,
  message `'${name}' must decode to a JSON object`) for `null`, an array, or
  any non-object value. Also screens every **top-level** key with the same
  prototype-pollution guard `core/config`'s providers use
  (`isDangerousKey` — see [security](./security.md)): a `__proto__`,
  `constructor`, or `prototype` own key throws `M3LError` (`options.code`,
  message `'${name}' contains an unsafe key`) rather than being returned,
  since the caller could otherwise pollute `Object.prototype` via a later
  `Object.assign`/deep-merge over the returned record. Only the first level
  of keys is screened — a dangerous key nested inside a safe top-level value
  is not detected, the same documented limitation as
  `internal/config/buildSafeValueMap`.

### Reading fields off an already-parsed record

These promote the record-field reader cluster hand-duplicated across
consumer scripts' write steps (e.g. `scripts/ecs-ops/src/steps/write-service.ts`)
— each gating an already-`readJSONRecord`-parsed `input` object before
dispatching a mutating AWS call. Every read distinguishes "absent" from "set
to the wrong type": an absent optional field resolves `undefined`, but a
**present, wrong-typed** field always throws `M3LError` (`options.code`) —
it is never silently coerced or dropped, matching `M3LConfigAccessor`'s
config-read semantics ([config](./config.md)). "Absent" is checked with
`Object.hasOwn`, not bracket access — reading `record[field]` directly would
walk the prototype chain, so a record with no own `field` (e.g. `field`
literally named `"__proto__"`) would otherwise silently resolve an inherited
`Object.prototype` value instead of `undefined`.

- **`requireRecord(record, name, operation)`** — returns `record`, throwing
  `M3LError` (message `'${name}' is required for operation '${operation}'`)
  when `undefined`. Promotes the `requireInput`/`requireDeclarationRecord`
  guard scripts ran before reading any field off a maybe-absent `input`.
  **Presence-only** — it does not re-run `asRecord`'s object-shape/
  prototype-pollution screen, so callers are expected to pass a record that
  already went through it (e.g. from `readJSONRecord`).
- **`requiredStringField(record, field, operation)`** /
  **`requiredArrayField(record, field, operation)`** — read a required field,
  throwing `M3LError` when absent, wrong-typed, **or empty** (an empty string
  or empty array is rejected the same as absence). Neither screens array
  elements for a nested prototype-pollution key — only `asRecord`'s existing
  top-level-of-a-record guarantee applies.
- **`optionalStringField(record, field)`** / **`optionalNumberField`** /
  **`optionalBooleanField`** / **`optionalArrayField`** / **`optionalRecordField`**
  — read an optional field, returning `undefined` when absent and throwing
  `M3LError` when the field is present but the wrong type.
  `optionalNumberField` does not reject `NaN`; `optionalBooleanField` does not
  coerce a `"true"`/`"false"` string; `optionalArrayField`/`optionalRecordField`
  leave element/value types as `unknown` (cast at the call site, where the
  concrete shape is known) and `optionalArrayField` applies no key screening
  to elements. `optionalRecordField` reuses `asRecord`'s object-shape check
  and top-level prototype-pollution key screen once the field is known to be
  present.

### Example

```typescript
import { Core } from "@m3l-automation/m3l-common";

const input = new Core.M3LInputFileReader({
  paths: script.paths,
  code: "ERR_ECS_OPS_CONFIG",
});

const record = await input.readJSONRecord("input");

const taskDefinition = input.requiredStringField(
  record,
  "taskDefinition",
  "create-service",
);
const desiredCount = input.optionalNumberField(record, "desiredCount");
```

## Notes and behavior

- **Report shape** — `finalizeRegisteredFiles()` returns an `M3LFileCopyReport` containing per-file `M3LFileCopyResult` entries (size, destination, timestamp, and skip status) plus an `M3LFileCopyReportSummary` aggregate.
- **Size-based skip** — files exceeding the configured size limit are skipped with the `M3LFileCopySkipReason` value `'size-too-large'`.
- **Per-file skips vs. batch-fatal errors** — recoverable per-file conditions are recorded as a skipped `M3LFileCopyResult` (reasons `'size-too-large'`, `'already-exists'`, `'source-unreadable'`, `'declined-by-prompt'`) so one bad file never aborts the batch. Genuine infrastructural failures (creating the output tree, writing a file that passed all checks, or writing the manifest) and invalid copier options throw an `M3LFileCopyError` chaining the underlying `cause`.
- **Destination containment** — a `subdir` hint (from `registerFile`) or a `manifestFileName` that is absolute or contains a `..` segment is rejected with `M3LFileCopyError`, so every write stays inside the resolved output directory.
- **Overwrite control** — whether existing destination files are overwritten is configurable via `M3LFileCopierOptions`.
- **Manifest JSON** — an optional manifest JSON describing the copied files can be generated, controlled through `M3LFileCopierOptions`.
- **Large-file prompt thresholds** — interactive prompt thresholds for large files are configurable, so a run can ask the user before archiving an unusually large file.
- **Defaults** — `M3L_FILE_COPIER_DEFAULTS` holds the default option values applied when options are omitted.

## See also

- [utils](./utils.md) — `M3LPaths` resolves the data/input/output directories used here.
- [environment](./environment.md) — deployment mode drives the directory layout.
- [importers](./importers.md) / [exporters](./exporters.md) — the files typically archived after a run.
- [config](./config.md) — `M3LConfigAccessor` pairs with `M3LInputFileReader` for input-file `name` parameters resolved through config.
- [security](./security.md) — `isDangerousKey`, the prototype-pollution guard `asRecord` screens with.
