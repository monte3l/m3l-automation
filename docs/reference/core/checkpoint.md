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
  `M3LCheckpointError`: `"ERR_CHECKPOINT_CORRUPT"`,
  `"ERR_CHECKPOINT_DEFINITION"`, `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"`,
  `"ERR_CHECKPOINT_IO"`, `"ERR_CHECKPOINT_MISSING"`,
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
- `definition?: unknown` — **optional.** The resolved configuration that gives
  this run's stored offsets their meaning: an Athena SQL query, a
  Logs-Insights time window plus log-group list, a DynamoDB table plus segment
  count. Supplying it opts into **fingerprinting** — `write()` stamps the
  `canonicalJsonHash` of the definition's projection onto the envelope, and
  `read()` refuses to resume from a checkpoint written under a different
  definition (see **On-disk format** below). Projected and hashed **once, at
  construction**, so a value it rejects (a circular reference, a `BigInt`, a
  non-finite
  number) throws `ERR_CHECKPOINT_DEFINITION` straight out of the constructor
  rather than surfacing later on the first `read()` or `write()`. The value is
  never persisted and never reaches a message or `context` — only its hash is
  stored. Omitting the field preserves today's behaviour exactly; passing an
  explicit `definition: undefined` is treated identically to omitting it (it
  type-checks, because `undefined` is assignable to `unknown`, so a caller
  forwarding an optional config field opts out silently rather than failing).

  **The definition is validated and projected in a single traversal.** A value
  whose canonical JSON form discards its content would produce a fingerprint
  that can never mismatch — a check that silently does nothing. So at
  construction the definition is walked **once**: every value is read exactly
  once, checked against the allowlist below, and copied into a fresh
  plain-JSON structure. **The fingerprint is computed over that projection, not
  over the caller's object.** At every depth the walk accepts only:

  - a finite `number`, a `string`, a `boolean`, or `null`;
  - a **dense** array whose every element is accepted — a hole rejects;
  - a plain object — prototype `Object.prototype` or `null` — with **no own
    symbol keys**, whose every own enumerable property value is accepted. A
    property whose value is `undefined` is allowed and skipped: omitting a key
    and setting it to `undefined` both mean "unset", so the two fingerprint
    identically by design, which is how the adopters express an absent optional
    setting.

  Everything else is rejected wherever it appears: a `function`, a `symbol`, a
  `bigint`, a non-finite number, a `Map`, a `Set`, a `WeakMap`, a `RegExp`, a
  `Date`, and any class instance. An honestly-empty `{}` or `[]` is still
  accepted — it carries no information but does not _lose_ any. A `toJSON`
  method on the **caller's** value is never consulted, own or inherited: a
  definition is identified by the data it holds, not by a serialisation hook, and
  the projection is a fresh tree that shares no object with the caller. So a
  `Date` is passed as `date.toISOString()`, and a richer collection as the plain
  array or object you want fingerprinted.

  **Scope limit — a poisoned realm is a precondition, not a threat this store
  defends.** The projection's objects are `Object.create(null)` maps, but its
  arrays are ordinary arrays, so a process that has polluted
  `Array.prototype.toJSON` (or `String.prototype.toJSON`, or `Object.prototype`)
  can still make the serializer collapse a projected value before it is hashed —
  two definitions differing only in a nested array would then fingerprint alike
  and resume on each other's offsets. Nothing here can prevent that: under the
  same pollution `canonicalJsonHash`, `JSON.stringify`, the logger and the
  persisted run report are all equally compromised, so realm integrity is the
  consumer's precondition for the whole library, not a property this submodule
  can establish on its own.

  **Why one traversal, and not a check followed by a hash.** Two earlier
  attempts validated the caller's object and then let `canonicalJsonHash` read
  it again, and both were defeated — because the bytes that were _checked_ were
  not the bytes that were _hashed_. A getter was read twice and could return an
  allowed array the first time and a `Set` the second; a **non-enumerable** own
  `toJSON` was invisible to `Object.keys` yet was applied by the serializer, so
  two entirely different definitions both fingerprinted as `{}` and resumed on
  each other's offsets; own non-index properties on an array were invisible to
  both. Naming those three cases would have been a third denylist. Reading the
  graph once and fingerprinting the projection removes the divergence itself:
  there is only one observation, and the fingerprint provably covers exactly
  what was validated.

  This is the allowlist-never-denylist rule the Style Guide states outright, and
  the same conclusion ADR-0035 reached for redaction. It costs the named
  adopters nothing: all four already resolve their settings to strings, numbers,
  booleans, `readonly string[]`, and nested plain objects.

  **A definition is committed to by its hash, not concealed by it.** The hash
  is an unkeyed SHA-256 over canonical JSON, so a low-entropy definition is
  recoverable by brute force from the stored `fingerprint` — a table name drawn
  from a handful of candidates falls in well under a hundred guesses. Never put
  a credential, a token, or a secret in a `definition`; put the resolved
  settings that identify the work, which is what it is for.

Methods:

- `get path(): string` — the resolved absolute checkpoint file path, computed
  once at construction (via `paths.resolveOutput(\`${name}.checkpoint.json\`)`).
Safe to log. **Constructor pass-through:** an unsafe `name`(absolute, or
containing a`..`segment) is rejected by`resolveOutput`itself, which
throws`M3LPathResolutionError`— not`M3LCheckpointError` — directly out of
  the constructor.
- `read(): Promise<TCheckpoint>` — reads, JSON-parses, verifies the
  content-addressed envelope's checksum and then — when a `definition` was
  supplied and the envelope carries a `fingerprint` — that the two agree (see
  below), and validates the checkpoint; applies the `missing` policy on
  `ENOENT`.
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

**On-disk format: a content-addressed envelope.** `write()` persists
`{ __m3lCheckpointFormat: 1, checksum, fingerprint?, payload }` — not the bare
`checkpoint` value — where `checksum` is `canonicalJsonHash(checkpoint)`
(see [Core / json](./json.md)). `read()` detects this envelope shape,
recomputes the checksum over `payload`, and compares it to the stored value
before handing `payload` to `validate`. This catches a checkpoint file that
was hand-edited or accidentally corrupted (a stray byte flip, a truncated
copy) after being written, even when the result still happens to be valid
JSON and still happens to satisfy `validate`. **This is integrity
verification against accidental corruption, not a tamper-evidence or
authentication guarantee**: the checksum is an unkeyed hash over public
canonical JSON, computable by anyone via the exported `canonicalJsonHash`,
so an adversary with write access to the checkpoint file can simply
recompute a matching checksum, or strip the envelope entirely (see the
backward-compatibility note below) — either bypasses the check with no
special knowledge. **Backward compatible:** a checkpoint file written before
this envelope existed (bare `JSON.stringify(checkpoint)`, no envelope) is
detected as legacy and read exactly as before, with no integrity check
possible on it (there is nothing to compare against). Upgrading the library
does not invalidate an in-flight checkpoint from an older version.

**`write()` snapshots the payload once, so the `checksum` provably covers the
persisted bytes.** The checkpoint is serialised a single time and the checksum is
computed over that same serialisation, rather than hashing the caller's object
and separately serialising it for disk. The two are not always the same view: a
**sparse** array is rendered `[1,,3]` by canonical stringification and
`[1,null,3]` by `JSON.stringify`, and a non-idempotent `toJSON` returns different
content on a second call — either way `write()` used to persist a file whose
stored `checksum` did not match its own `payload`, so every later `read()`
rejected the library's own output with `ERR_CHECKPOINT_CORRUPT` and the resume was
permanently dead. Snapshotting once removes the divergence. For any ordinary
payload the stored checksum is unchanged, so checkpoints written by earlier
versions stay readable.

**A non-serialisable checkpoint fails loud rather than being coerced.** The
snapshot rejects a non-finite number (`NaN`, `Infinity`, `-Infinity`) with
`ERR_CHECKPOINT_IO` instead of letting `JSON.stringify` render it as `null`.
Persisting `null` where the caller passed `Infinity` would silently substitute a
value the resume logic then reads back as real — the store's own no-silent-failure
rule. Circular references and `BigInt` values fail the same way.

**The `fingerprint` binds a checkpoint to the definition that wrote it.** The
`checksum` answers "is this payload intact"; it cannot answer "does this offset
still mean what it meant". Editing an Athena query, or a Logs-Insights time
window, and then resuming would otherwise succeed silently and continue from an
offset that no longer refers to the same work. When a `definition` is supplied,
`write()` stamps `fingerprint` — the `canonicalJsonHash` of the definition's
projection — onto the envelope, and `read()` compares it against the fingerprint the current
definition produces. Because the hash is computed over **canonical** JSON, two
definition objects differing only in key order fingerprint identically — a
settings-object reordering does not invalidate an in-flight checkpoint.

`read()` verifies the `checksum` **before** the `fingerprint`: a payload that
failed its integrity check has an untrustworthy fingerprint, so
`ERR_CHECKPOINT_CORRUPT` is thrown even when the fingerprint also disagrees.
The full read matrix:

| `definition` on the store | `fingerprint` on the envelope | `read()`                                                                                                   |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| supplied                  | present, matches              | resumes                                                                                                    |
| supplied                  | present, differs              | throws `ERR_CHECKPOINT_FINGERPRINT_MISMATCH`                                                               |
| supplied                  | absent                        | resumes — reads exactly as it does without this feature                                                    |
| absent                    | present, a string             | resumes — there is no current definition to compare against                                                |
| either                    | present, not a string         | throws `ERR_CHECKPOINT_CORRUPT` — the type check is unconditional, so this fires even with no `definition` |
| either                    | no envelope at all (legacy)   | resumes — the legacy bare-JSON path is untouched                                                           |

**Backward compatible on every axis**, and only opting in changes behaviour: an
envelope written before `fingerprint` existed has none and reads as before; a
caller that supplies no `definition` writes none and compares none; and the
legacy no-envelope path is not touched. The **same
not-a-tamper-evidence caveat** as the `checksum` applies verbatim — the
fingerprint is an unkeyed hash over public canonical JSON, so anyone with write
access to the file can recompute a matching one, strip the field, or strip the
whole envelope. It defends against the caller's own stale-configuration
mistake, not against an adversary.

Two consequences of that scope are worth stating outright, because each could
otherwise be read as a stronger guarantee than it is:

**The `checksum` does not cover the `fingerprint`.** It is computed over
`payload` alone, so the `fingerprint` field carries no integrity protection —
not even against accidental corruption. A bit flip or a truncated transfer
that leaves the field a _different but still valid_ string reports
`ERR_CHECKPOINT_FINGERPRINT_MISMATCH` — "written under a different
definition" — pointing an operator at a configuration change when the real
cause was file damage. Widening the checksum to cover the fingerprint would
be an on-disk format break, so this is accepted rather than fixed.
**`ERR_CHECKPOINT_FINGERPRINT_MISMATCH` is classified `origin: "caller"`**
(see [Core / errors](./errors.md)), unlike its neighbours
`ERR_CHECKPOINT_CORRUPT` and `ERR_CHECKPOINT_PARSE`, which are `"external"`.
That is deliberate: the dominant real cause is an operator editing the query
or the window between runs, which is a configuration fault and should surface
as exit code `2` (`CONFIG_USAGE`) rather than `3` (`EXTERNAL`). An externally
tampered `fingerprint` reaches the same code and is therefore reported as a
caller fault too — a known consequence of grading by dominant cause. The
parallel `ERR_CHECKPOINT_DEFINITION` is `"caller"` for the stronger reason
that it can only ever be reached from a value the caller passed in, whereas
`ERR_CHECKPOINT_IO`'s own unhashable-`checkpoint` arm stays `"external"`
despite also originating in a caller value — a pre-existing classification
this change deliberately did not disturb.

- `delete(): Promise<void>` — deletes the checkpoint file; tolerant of it
  already being absent.

### `M3LCheckpointError`

One subclass, six codes — the `M3LFtsIndexError` convention. Constructor
options stay unexported (callers catch, they don't construct).

- `"ERR_CHECKPOINT_CORRUPT"` — thrown from two distinct sites, both inside
  envelope verification and both before `validate` ever sees the payload. (1)
  `read()` detected a content-addressed envelope (see above) whose stored
  `checksum` does not match the recomputed checksum of its `payload` — the file
  was hand-edited or corrupted after being written. (2) The envelope's
  `fingerprint` field is **present but not a string**, which is a corrupt
  envelope rather than a legacy file (see the note under
  [Notes and behavior](#notes-and-behavior) on why the envelope guard is
  deliberately not widened to cover this). Arm (2) is unconditional — it fires
  whether or not a `definition` was supplied. **Never chains a `cause`** on
  either arm (there is no underlying thrown error to chain — both are direct
  comparisons, not caught exceptions) and `context` carries only the resolved
  `path`, never file content, matching `"ERR_CHECKPOINT_PARSE"`'s rationale
  below.
- `"ERR_CHECKPOINT_DEFINITION"` — the `definition` supplied to the constructor
  could not be hashed (a circular reference, a `BigInt`, a non-finite number —
  anything `canonicalJsonHash` rejects). Thrown **from the constructor**, so an
  unusable definition surfaces at composition time rather than on the first
  `read()`. **Never chains a `cause`**, for the same reason `write()`'s
  checksum-computation arm of `"ERR_CHECKPOINT_IO"` does not: the underlying
  error's message can embed the caller's actual definition value, which is
  resolved configuration. `context` carries only the resolved `path`.
- `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"` — `read()` found an envelope whose
  stored `fingerprint` does not match the fingerprint the store's current
  `definition` produces: the checkpoint is intact, but it was written under a
  different configuration, so its offsets no longer mean what they meant.
  Failing loud beats resuming into a meaningless offset. Thrown before
  `validate` ever sees the payload, and **after** the `checksum` check, so a
  file that is both corrupt and stale reports `"ERR_CHECKPOINT_CORRUPT"`.
  **Never chains a `cause`** (the mismatch is a direct comparison, not a caught
  exception), and neither the definition nor either fingerprint reaches the
  message or `context` — only the resolved `path` does, matching
  `"ERR_CHECKPOINT_CORRUPT"`.
- `"ERR_CHECKPOINT_IO"` — thrown from two distinct sites, with different
  `cause` handling. (1) A read, write, or delete failed for a reason other
  than the file being absent (`EACCES`, `EPERM`, `ENOSPC`, a rejected
  `rename`, …) — chains the underlying errno `Error` as `cause` (an errno
  carries no file content, so chaining it is safe and useful). (2) `write()`
  could not compute the envelope checksum for the supplied `checkpoint` (e.g.
  a circular reference, a `BigInt`, or a non-finite number — anything
  `canonicalJsonHash` rejects) — **never chains a `cause`**, since the
  underlying error's message can embed the caller's actual checkpoint value.
- `"ERR_CHECKPOINT_MISSING"` — `read()` was called under a `{ kind: "error" }`
  missing policy and no checkpoint file exists. Chains the `ENOENT` as
  `cause` (an errno carries no file content, so — like `ERR_CHECKPOINT_IO`'s
  I/O-failure arm — chaining it is safe and useful).
- `"ERR_CHECKPOINT_PARSE"` — the file is not valid JSON, `validate` returned
  `false`, or (for an enveloped file) the checksum recomputation over
  `payload` itself failed (e.g. a `RangeError` from an adversarially or
  accidentally deeply-nested payload). **Never chains the underlying error as
  `cause`** on any of these three paths: a `SyntaxError`'s message embeds a
  snippet of the malformed file, and a checkpoint may hold caller data (a
  `cloudwatch-logs-insights` checkpoint carries whole log rows; a
  `dynamodb-crud` checkpoint carries `LastEvaluatedKey` primary-key values).
  Only the resolved `path` reaches `context`.

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
const settings = { queryString: "SELECT 1", database: "analytics" };

const store = new Core.M3LCheckpointStore<AthenaCheckpoint>({
  paths,
  name: "athena-run-2026-07-26",
  validate: isAthenaCheckpoint,
  missing: resume
    ? { kind: "error" }
    : { kind: "empty", value: EMPTY_CHECKPOINT },
  // Opt in to fingerprinting: resuming after an edited query now fails loud
  // with ERR_CHECKPOINT_FINGERPRINT_MISMATCH instead of reattaching to a
  // query execution that answered a different question.
  definition: settings,
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
- **`cause` chaining is resolved by error kind and content risk, not by
  caller option.** Four codes never chain, for **two different reasons** that
  are worth keeping distinct. `ERR_CHECKPOINT_PARSE` and
  `ERR_CHECKPOINT_DEFINITION` have an underlying error that must not be chained:
  it can embed the malformed file's content or the caller's definition value.
  `ERR_CHECKPOINT_CORRUPT` and `ERR_CHECKPOINT_FINGERPRINT_MISMATCH` have
  **nothing to chain at all** — each is a direct comparison, not a caught
  exception, so no `cause` exists to suppress in the first place.
  `ERR_CHECKPOINT_MISSING` and `ERR_CHECKPOINT_IO`'s underlying-I/O-failure
  arm chain an errno `Error` (safe — an errno carries no file content), but
  `ERR_CHECKPOINT_IO`'s other arm — a `write()`-time checksum-computation
  failure — never chains, since that underlying error's own message can embed
  the caller's checkpoint value. A toggle to disable any of this protection
  would be a security footgun, not a legitimate variation — see the Style
  Guide's rule on guarding the parse step.
- **A present-but-non-string `fingerprint` is a corrupt envelope, not a
  legacy file.** Envelope detection keys off `__m3lCheckpointFormat`, a string
  `checksum`, and a `payload` — deliberately **not** off `fingerprint`'s type.
  Widening that guard would be fail-open: a file whose `fingerprint` was
  hand-edited to a number would stop looking like an envelope and be read down
  the legacy bare-JSON path, which skips the `checksum` verification too. So
  the guard's shape is unchanged and `fingerprint`'s type is checked **inside**
  the envelope branch, where a non-string value throws
  `ERR_CHECKPOINT_CORRUPT`.
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
- **A `{ kind: "empty" }` policy does not suppress `ERR_CHECKPOINT_PARSE`,
  `ERR_CHECKPOINT_CORRUPT` or `ERR_CHECKPOINT_FINGERPRINT_MISMATCH`.** The
  `missing` policy only governs what happens
  when the file is **absent** (`ENOENT`). A _present-but-unusable_ checkpoint
  (fails `validate`, isn't valid JSON, fails its envelope checksum, or was
  written under a different `definition`) always
  throws, even for a fresh (non-`--resume`) run — the store cannot
  distinguish "this run doesn't care about resuming" from "this run should
  silently discard a corrupt file", and guessing wrong would hide real data
  loss. A caller that wants a fresh run to never touch a stale checkpoint
  should call `delete()` (or skip `read()` entirely) rather than rely on the
  `missing` policy to paper over corruption.
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
  client wrappers to `core/errors`, `core/prompt`, `core/polling`, and the
  single file `core/utils/M3LSingleFlight.ts` (ADR-0040) only; checkpoint/
  resume state belongs to the consuming script, not an AWS operations
  wrapper.

## See also

- [Core / utils](./utils.md) — `M3LPaths.resolveOutput` resolves the
  checkpoint file's directory.
- [Core / errors](./errors.md) — the `M3LError` base class and the
  `origin`/`retryable` fault-origin catalog `M3LCheckpointErrorCode` is
  classified in.
- [Core / script](./script.md) — `M3LScript`'s per-run `runStartedAt` and
  stage-9 archival, and why the checkpoint file must stay outside that
  per-run directory.
- [ADR-0045](../../adr/0045-streaming-safe-resume-contract.md) — the
  streaming-safe resume contract, whose 2026-08-18 Update decided that a
  checkpoint binds to the definition that wrote it.
- [Architecture overview](../../m3l-common-architecture.md)
