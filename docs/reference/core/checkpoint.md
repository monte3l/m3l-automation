# Core / checkpoint

Resume-state persistence for long-running consumer scripts: a generic, atomic
JSON checkpoint store so a killed run can `--resume` instead of restarting.

## Overview

`M3LCheckpointStore<TCheckpoint>` promotes the checkpoint/resume convention
specified by the W1 consumer-scripts plan (§1.2) out of three independently
hand-rolled, near-duplicate implementations (`athena-query`,
`cloudwatch-logs-insights`, `dynamodb-crud`) into one library class. A
checkpoint is a small JSON document — a query id, a scan cursor, a set of
completed pagination windows — written to a single flat file at
`<output-dir>/<name>.checkpoint.json` and read back when a script is invoked
with `--resume`.

The store is deliberately narrow: it owns file I/O, atomicity, and the
missing-checkpoint policy. It has no opinion on the checkpoint's payload
shape, on when a caller writes (cadence), or on whether a caller deletes on
success — those stay script-specific.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols:

- `M3LCheckpointStore<TCheckpoint>` — the store.
- `M3LCheckpointStoreOptions<TCheckpoint>` — constructor options.
- `M3LCheckpointMissingPolicy<TCheckpoint>` — what `read()` does when no
  checkpoint file exists.
- `M3LCheckpointPathsPort` — the structural subset of `M3LPaths` the store
  needs (just `resolveOutput`); a real `M3LPaths` instance satisfies it, and a
  test can inject a bare object without constructing one.
- `M3LCheckpointError` — thrown on every failure path; an `M3LError` subclass.
- `M3LCheckpointErrorCode` — the narrowed code union carried by
  `M3LCheckpointError`: `"ERR_CHECKPOINT_IO"`, `"ERR_CHECKPOINT_MISSING"`,
  `"ERR_CHECKPOINT_PARSE"`.

### `M3LCheckpointStore<TCheckpoint>`

`TCheckpoint extends object` — bounded this way rather than
`Record<string, unknown>` so a declared `interface` payload (which has no
implicit index signature) is a valid instantiation.

Constructor options (`M3LCheckpointStoreOptions<TCheckpoint>`):

- `paths: M3LCheckpointPathsPort` — resolves the checkpoint file's directory.
  The file always lives flat at the output-directory root — never nested
  under a per-run subdirectory (see [Notes and behavior](#notes-and-behavior)).
- `name: string` — the run's stable identity key. The file is
  `<output-dir>/<name>.checkpoint.json`. Pick a value that a resuming
  invocation regenerates identically — a run name or an output file name.
  **Never a correlation id**: `M3LScript` mints a fresh one per invocation, so
  a `--resume` run keyed on it could never find its own checkpoint.
- `validate: (value: unknown) => value is TCheckpoint` — **required**, not
  optional. Narrows a JSON-parsed value to `TCheckpoint`; a value that fails
  this predicate is treated identically to malformed JSON
  (`ERR_CHECKPOINT_PARSE`).
- `missing: M3LCheckpointMissingPolicy<TCheckpoint>` — what `read()` returns
  when the file does not exist:
  - `{ kind: "empty", value: TCheckpoint }` — a fresh run starts from `value`
    (returned by identity, not cloned).
  - `{ kind: "error" }` — throws `M3LCheckpointError` with code
    `"ERR_CHECKPOINT_MISSING"`. This is the §1.2 contract for `--resume`: an
    absent checkpoint under an explicit resume request is a caller/config
    error, never a silent fresh start.

Methods:

- `get path(): string` — the resolved absolute checkpoint file path, computed
  once at construction (via `paths.resolveOutput(\`${name}.checkpoint.json\`)`).
Safe to log. **Constructor pass-through:** an unsafe `name`(absolute, or
containing a`..`segment) is rejected by`resolveOutput`itself, which
throws`M3LPathResolutionError`— not`M3LCheckpointError` — directly out of
  the constructor.
- `read(): Promise<TCheckpoint>` — reads, JSON-parses, and validates the
  checkpoint; applies the `missing` policy on `ENOENT`.
- `write(checkpoint: TCheckpoint): Promise<void>` — persists `checkpoint`
  atomically (write-temp-then-rename), replacing any prior contents. **Does
  not create the output directory** — `M3LPaths` performs no filesystem I/O,
  and this store follows the same contract; the output directory is assumed
  to already exist. An `ENOENT` from a missing parent directory therefore
  throws `ERR_CHECKPOINT_IO`, never `ERR_CHECKPOINT_MISSING` (that code is
  reserved for `read()` under a `{ kind: "error" }` policy). The temp file
  name is unique per call (a random suffix, not a fixed name) — the store may
  be driven by concurrent writers (e.g. one per scan segment), and a shared
  fixed temp name would let one caller's `rename` publish another caller's
  half-written contents, reintroducing the exact torn-file failure atomicity
  is designed to prevent.
- `delete(): Promise<void>` — deletes the checkpoint file; tolerant of it
  already being absent.

### `M3LCheckpointError`

One subclass, three codes — the `M3LFtsIndexError` convention. Constructor
options stay unexported (callers catch, they don't construct).

- `"ERR_CHECKPOINT_IO"` — a read, write, or delete failed for a reason other
  than the file being absent (`EACCES`, `EPERM`, `ENOSPC`, a rejected
  `rename`, …). Chains the underlying errno `Error` as `cause` — an errno
  carries no file content, so chaining it is safe and useful.
- `"ERR_CHECKPOINT_MISSING"` — `read()` was called under a `{ kind: "error" }`
  missing policy and no checkpoint file exists. Chains the `ENOENT` as
  `cause` (an errno carries no file content, so — like `ERR_CHECKPOINT_IO` —
  chaining it is safe and useful).
- `"ERR_CHECKPOINT_PARSE"` — the file is not valid JSON, or `validate`
  returned `false`. **Never chains the underlying `SyntaxError` as `cause`**:
  its message embeds a snippet of the malformed file, and a checkpoint may
  hold caller data (a `cloudwatch-logs-insights` checkpoint carries whole log
  rows; a `dynamodb-crud` checkpoint carries `LastEvaluatedKey` primary-key
  values). Only the resolved `path` reaches `context`.

## Usage

```typescript
import { Core } from "@m3l-automation/m3l-common";

interface AthenaCheckpoint {
  readonly queryExecutionId?: string;
}

function isAthenaCheckpoint(value: unknown): value is AthenaCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const id = (value as Partial<AthenaCheckpoint>).queryExecutionId;
  return id === undefined || typeof id === "string";
}

const EMPTY_CHECKPOINT: AthenaCheckpoint = {};

const paths = new Core.M3LPaths();
const resume = true; // from the script's `--resume` config parameter

const store = new Core.M3LCheckpointStore<AthenaCheckpoint>({
  paths,
  name: "athena-run-2026-07-26",
  validate: isAthenaCheckpoint,
  missing: resume
    ? { kind: "error" }
    : { kind: "empty", value: EMPTY_CHECKPOINT },
});

const checkpoint = await store.read();

if (checkpoint.queryExecutionId === undefined) {
  // start fresh work and persist progress as it happens
  await store.write({ queryExecutionId: "q-123" });
}

// ... run completes successfully ...
await store.delete();
```

## Notes and behavior

- **Atomicity is unconditional, not an option.** `write()` always writes a
  uniquely-named temp file in the **same directory** as the target (a
  `rename` is atomic only within a filesystem, and a shared fixed temp name
  would let two concurrent writers race — see `write()` above) and renames it
  onto the checkpoint path. A crash mid-write leaves either the previous
  checkpoint or the new one — never a truncated file a subsequent `read()`
  would reject with `ERR_CHECKPOINT_PARSE`. Temp-file cleanup on a failed
  write never masks the original error. `write()` delegates this to
  `internal/files/atomicWrite.ts` (`writeFileAtomic`), a new **internal-only**
  helper — no write-temp-then-rename primitive existed anywhere in
  `packages/m3l-common/src` before this submodule (the archived
  consumer-scripts plan's §1.2 describes the guarantee as "via `core/files`
  guards", but `core/files` has no atomic writer — only
  `M3LFileCopier`/`M3LFileCopyError`). It stays `internal/` and unexported
  rather than promoted into `core/files` until a second caller justifies the
  public surface.
- **`cause` chaining is resolved by error kind, not by caller option.**
  `ERR_CHECKPOINT_IO` always chains; `ERR_CHECKPOINT_PARSE` never does. A
  toggle to disable the parse-path protection would be a security footgun,
  not a legitimate variation — see the Style Guide's rule on guarding the
  parse step.
- **The checkpoint file is always flat at the output-directory root**,
  never nested under a per-run archival subdirectory. `M3LScript` derives a
  fresh, per-invocation `runStartedAt` on every run, and stage-9 archival
  plus the run report both key off it — a checkpoint written under that
  directory would be unreachable by the next (differently-timestamped)
  invocation, defeating `--resume` entirely. One consequence: stage-9
  archival walks only the input and config directories, so a flat checkpoint
  is never swept into a run's archive, and an orphaned checkpoint left by a
  killed run is not automatically reaped.
- **`validate` is required, not optional.** An optional validator makes
  "trust whatever is on disk" the path of least resistance; requiring it
  forces every caller to state the shape it expects to read back.
- **A `{ kind: "empty" }` policy does not suppress `ERR_CHECKPOINT_PARSE`.**
  The `missing` policy only governs what happens when the file is **absent**
  (`ENOENT`). A _present-but-corrupt_ checkpoint (or one that fails
  `validate`) always throws `ERR_CHECKPOINT_PARSE`, even for a fresh
  (non-`--resume`) run — the store cannot distinguish "this run doesn't care
  about resuming" from "this run should silently discard a corrupt file", and
  guessing wrong would hide real data loss. A caller that wants a fresh run to
  never touch a stale checkpoint should call `delete()` (or skip `read()`
  entirely) rather than rely on the `missing` policy to paper over corruption.
- **Write cadence, delete-on-success, and the checkpoint payload itself are
  caller-owned.** The store has no opinion on how often `write()` is called
  (e.g. every `checkpointEveryPages` pages) or whether `delete()` runs after
  a successful run (typically from an `onAfterRun` hook) — see
  `docs/reference/scripts/athena-query.md`,
  `docs/reference/scripts/cloudwatch-logs-insights.md`, and
  `docs/reference/scripts/dynamodb-crud.md` for each script's concrete policy.
- **No `exists()` method.** Omitted deliberately — no caller needs to check
  presence without also reading the contents; `read()` under a
  `{ kind: "empty" }` policy already answers "does a checkpoint exist" via
  whether the returned value differs from the supplied default.
- **`aws/*` cannot import this submodule.** ESLint Zone A restricts AWS
  client wrappers to `core/errors`, `core/prompt`, and `core/polling` only;
  checkpoint/resume state belongs to the consuming script, not an AWS
  operations wrapper.

## See also

- [Core / utils](./utils.md) — `M3LPaths.resolveOutput` resolves the
  checkpoint file's directory.
- [Core / errors](./errors.md) — the `M3LError` base class and the
  `origin`/`retryable` fault-origin catalog `M3LCheckpointErrorCode` is
  classified in.
- [Core / script](./script.md) — `M3LScript`'s per-run `runStartedAt` and
  stage-9 archival, and why the checkpoint file must stay outside that
  per-run directory.
- [Architecture overview](../../m3l-common-architecture.md)
