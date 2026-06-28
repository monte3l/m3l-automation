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
- `M3LFileCopySkipReason` — why a file was skipped (e.g. `'size-too-large'`)
- `M3LFileCopyReport` — the full report returned by `finalizeRegisteredFiles()`
- `M3LFileCopyReportSummary` — the aggregate portion of the report

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

## Notes and behavior

- **Report shape** — `finalizeRegisteredFiles()` returns an `M3LFileCopyReport` containing per-file `M3LFileCopyResult` entries (size, destination, timestamp, and skip status) plus an `M3LFileCopyReportSummary` aggregate.
- **Size-based skip** — files exceeding the configured size limit are skipped with the `M3LFileCopySkipReason` value `'size-too-large'`.
- **Overwrite control** — whether existing destination files are overwritten is configurable via `M3LFileCopierOptions`.
- **Manifest JSON** — an optional manifest JSON describing the copied files can be generated, controlled through `M3LFileCopierOptions`.
- **Large-file prompt thresholds** — interactive prompt thresholds for large files are configurable, so a run can ask the user before archiving an unusually large file.
- **Defaults** — `M3L_FILE_COPIER_DEFAULTS` holds the default option values applied when options are omitted.

## See also

- [utils](./utils.md) — `M3LPaths` resolves the data/input/output directories used here.
- [environment](./environment.md) — deployment mode drives the directory layout.
- [importers](./importers.md) / [exporters](./exporters.md) — the files typically archived after a run.
