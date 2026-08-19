# 0045. Byte-offset streaming resume for list exporters

- **Status:** Accepted
- **Date:** 2026-08-15
- **Deciders:** Enrico Lionello (maintainer); Claude (implementation)

## Context and problem statement

`M3LJSONListExporter`/`M3LCSVListExporter` open their output file with
`fs.createWriteStream(filePath)` and no `flags` — Node defaults to `'w'`,
create-or-truncate. A script that supports `--resume` therefore cannot simply
reopen its output writer after a crash: doing so destroys everything a prior
interrupted run already wrote.

Every fleet script that needed resumable streaming output worked around this
by buffering the entire result set a second time, inside its checkpoint:
`cloudwatch-logs-insights`'s `LogsInsightsCheckpoint.rows` and
`rds-data-sql`'s `RunQueryCheckpoint.rows`/`RunLoadCheckpoint.failedRecords`
persisted every row/record streamed so far on every checkpoint write, then
replayed the whole buffer into a freshly-truncated writer on resume. Correct,
but it reintroduces unbounded memory and checkpoint-file growth proportional
to result size — exactly the growth per-page/per-chunk streaming exists to
avoid. Tracked as issue #427 (F11 in `docs/plans/IMPLEMENTATION.md`), found
resolving a `claude-pr-review` Must-fix on PR #425.

A fourth script, `dynamodb-crud`, had the opposite bug: its checkpoint was
already cursor-only (no row buffer), but `dispatchScan` still reopened the
exporter at the same path on `--resume`. Since the reopen truncates, a
resumed scan/query/export silently destroyed everything a prior interrupted
run had already written, with nothing to re-populate it. Found while
planning this ADR, not by the original issue — a live data-loss bug, not a
documented tradeoff.

## Decision drivers

- **Bounded resume state.** A checkpoint should describe a resume point, not
  duplicate the output.
- **No breaking changes outside a major release.** The fix must be additive
  to the exporters' public options.
- **Fail loud, never silently corrupt.** A crash mid-write or an invalid
  resume request must produce a typed error, never a partially-truncated or
  NUL-padded file with no signal.

## Considered options

1. **Byte-offset resume** — a new `resumeFromByte` construction option
   truncates the file to that offset, then opens in append mode
   (`fs.createWriteStream(filePath, { flags: "r+", start })`); the writer
   exposes `bytesWritten` so the caller checkpoints an O(1) integer instead
   of the result set.
2. **Plain append (`flags: "a"`)** — simplest possible knob, but a crash
   mid-write leaves a torn partial line that a plain append then writes
   after, corrupting the file. Rejected: truncate-to-offset is what makes a
   torn write safe; append alone is not.
3. **Keep buffering rows in the checkpoint** — the status quo. Rejected: it
   is the defect this ADR exists to close.

## Decision

We chose **option 1, byte-offset resume**, landed as:

- `M3LJSONListExporterOptions`/`M3LCSVListExporterOptions` gain
  `resumeFromByte?: number`; CSV also gains `columns?: readonly string[]`,
  **required** when `resumeFromByte > 0` (the CSV writer otherwise has no way
  to know the header already committed to disk) and independently usable on
  a fresh export to pin the column set before the first row arrives.
- `M3LListExporterStreamWriter<TItem>` gains `readonly bytesWritten: number`
  — the value a caller reads after `append()` resolves and persists in its
  checkpoint.
- The two public exporter constructors validate `resumeFromByte` is a
  non-negative safe integer, throwing synchronously (`ERR_JSON_LIST_EXPORT`/
  `ERR_CSV_EXPORT`) on a malformed value — a caller/config error, caught at
  construction rather than deferred. `M3LWriteStreamLifecycle` (internal)
  separately stats the target file and refuses to proceed if it is shorter
  than the claimed offset — closing a durability gap where
  `fs.WriteStream`'s write callback fires once the OS accepts a write, not
  once it is flushed to disk, so an unclean shutdown can leave the file
  shorter than a checkpoint claims. That size check surfaces only through
  the writer's first `append()`/`close()` call, matching the class's
  existing deferred-error contract for I/O-level failures — the value
  validation and the size reconciliation are deliberately two different
  failure modes at two different points, not one uniform deferred contract.
- `M3LHTMLListExporter` gets no new option — a mid-document HTML resume is
  incoherent (closing tags), so it stays truncate-only.

### The resume contract

1. `resumeFromByte: n` means truncate the output file to exactly `n` bytes,
   then append. `undefined`/`0` is today's truncate-to-empty behavior.
2. `bytesWritten` is `resumeFromByte` plus every byte the writer has since
   flushed — the value to checkpoint.
3. **Ordering is load-bearing.** A caller must `append` a page, _then_ read
   `bytesWritten`, _then_ write the checkpoint. A crash anywhere in that
   window leaves the checkpoint behind the file; resume truncates away the
   un-checkpointed tail and redoes that page. Duplicate work, never lost or
   doubled output.

### Adoption scope per script

- **`m3l-common`**: the seam itself (this ADR).
- **`dynamodb-crud`**: full adoption — `ScanCheckpoint.outputBytes`, closing
  the live data-loss bug. JSONL-only output, no CSV column concern.
- **`rds-data-sql`**: full adoption for both `query` (JSON, JSONL, _and_
  CSV) and `load`'s `failed.jsonl`. CSV's column set is available from the
  SQL result metadata on the very first page, before any row is written, so
  no bootstrap buffering is needed — `RunQueryDeps.writer` became a
  `createWriter({ resumeFromByte, columns })` factory the step calls itself,
  after fetching page one on a fresh run.
- **`cloudwatch-logs-insights`**: **JSON/JSONL only.** CSV output keeps the
  original full-checkpoint-buffering design for this change. CloudWatch Logs
  Insights rows carry no upfront schema — unlike a SQL result set, a fixed
  CSV column set can only be inferred from row _content_, which would need
  either an unbounded bootstrap buffer or a design this ADR does not
  attempt. Documented as a deliberate scope boundary, not silently unfixed:
  a checkpoint carrying buffered rows with no byte offset (written by the
  prior version, or a CSV-format run's checkpoint reused under `json`) is
  rejected outright (`ERR_LOGS_INSIGHTS_LEGACY_CHECKPOINT`) rather than
  silently dropping those rows on resume.
- **`athena-query`**: no change — its checkpoint holds only
  `queryExecutionId`, and it exports the full row set once, after the query
  completes; the defect never applied to it.

Checkpoint validators across all four scripts reject `NaN`/`Infinity`/
non-integer/negative values outright on every numeric field. `dynamodb-crud`
and `rds-data-sql` additionally require a numeric offset field and its
co-occurring byte-length field to be present together in their
`M3LCheckpointStore` type guard (a checkpoint with one but not the other —
most realistically a file left over from before this change — is rejected
rather than silently resumed from byte 0 while its cursor advances past
already-written data). `cloudwatch-logs-insights` enforces the equivalent
`rows`⟺`outputBytes` correlate downstream instead, in the JSON-writer-open
step rather than the type guard itself, because the correlate there is
format-dependent (`rows` is legitimately populated for a CSV-format
checkpoint) rather than a structural invariant the guard alone can express.

## Consequences

- **Positive:** checkpoint size and resume-time memory are O(1) with respect
  to result size across all four scripts, closing both the original
  unbounded-growth complaint and the independently-found `dynamodb-crud`
  data-loss bug.
- **Positive:** a crash mid-write is now handled exactly (truncate-to-offset,
  redo the un-checkpointed page) rather than papered over by duplicating the
  whole result set.
- **Negative / trade-offs:** the four scripts' checkpoint file formats are
  not backward-compatible with the pre-ADR shape. A checkpoint written by
  the old code fails its updated type guard on read — a loud
  `ERR_CHECKPOINT_PARSE`/script-specific rejection, not silent corruption,
  but an in-flight `--resume` across this deploy boundary needs a fresh
  start.
- **Negative / trade-offs:** `cloudwatch-logs-insights` CSV output still
  buffers the full result set in its checkpoint — the original complaint is
  only half-closed for that one format/script combination. A follow-up
  would need either a bootstrap-buffer-until-first-row design or accepting
  CSV log exports as inherently unbounded.
- **Semver impact:** minor (`3.0.0` → `3.1.0`) — `resumeFromByte`/`columns`
  are additive options. `bytesWritten` is a new required member on
  `M3LListExporterStreamWriter<TItem>` (an interface with exactly three
  first-party implementors); consumer test fakes in `rds-data-sql`,
  `cloudwatch-logs-insights`, and `dynamodb-crud` DO hand-construct object
  literals satisfying this interface, but all were updated in the same
  commit series that added the member, so no source-breaking gap was ever
  left unaddressed within this repo — still treated as additive rather than
  breaking, since a future external consumer's hand-built writer (were one
  to exist) would need the same update.

## Update (2026-08-18) — checkpoints bind to the definition that wrote them

This ADR settled how a resumable consumer records _where it stopped_. A capability
audit found the adjacent gap: nothing records _what it was doing_ when it stopped.

`M3LCheckpointStore`'s envelope carries a `checksum` computed as
`canonicalJsonHash(payload)` — payload **integrity** only. No field binds a
checkpoint to the configuration that produced it. Editing an Athena query, or a
CloudWatch Logs Insights time window, and then resuming will therefore succeed
silently and continue from an offset that no longer means what it meant when it was
written.

The envelope gains an **optional** `fingerprint`, computed with the same existing
`canonicalJsonHash` over a caller-supplied definition value — the resolved settings
that give the stored offsets their meaning. On read, a mismatch fails with a
dedicated error code rather than resuming.

This applies the stance already accepted for the shape-validation half of this same
class of defect, where `isLogsInsightsCheckpoint`'s validation was tightened and a
previously-resumable checkpoint was allowed to start failing: **failing loud beats
resuming into a corrupt offset.**

Backward compatibility is preserved on every axis. An envelope with no
`fingerprint` reads exactly as it does today; a caller that supplies no definition
writes none; and the legacy no-envelope path is untouched. Only opting in changes
behaviour. Named adopters: `athena-query`, `cloudwatch-logs-insights`,
`dynamodb-crud`.

## Addendum (2026-08-19) — two codes, not one, and the hash lands at construction

The Update above authorises a single dedicated error code, for the read-time
mismatch. Implementing it (A4, `docs/plans/IMPLEMENTATION.md`) surfaced a
second decision the Update did not contemplate, settled by the maintainer
during that work and recorded here so the shipped public surface is not wider
than its decision record.

**The definition is hashed once, at construction, not lazily on first use.**
`canonicalJsonHash` rejects a circular reference, a `BigInt` and a non-finite
number, so an unusable definition has to surface somewhere. Deferring it to the
first `read()`/`write()` would report a composition-time mistake as a runtime
I/O-adjacent failure, minutes into a run. Hashing eagerly makes it a
construction failure instead, which is where the caller can act on it.

**That needs a second code: `ERR_CHECKPOINT_DEFINITION`** (`origin: caller`,
non-retryable). Routing it through the read-time mismatch code would conflate
"your configuration changed since this checkpoint was written" with "the value
you passed cannot be hashed at all" — two different faults with two different
fixes. Routing it through `ERR_CHECKPOINT_IO`, which already absorbs the
equivalent failure for an unhashable _checkpoint_, would repeat a
misclassification rather than extend one: that arm is `origin: external` even
though its trigger is a caller value. The pre-existing arm is left alone;
the new one is classified honestly.

**The same code also rejects any definition whose content is not fully visible
to `canonicalJsonStringify`, decided by a recursive allowlist.** Verified
against the real `canonicalJsonHash`: a `function` and a `symbol` both
canonicalise to `null`, and `new Map([["a", 1]])` and `new Set([1, 2, 3])` both
canonicalise to `{}`. A caller passing any of those would opt into
fingerprinting, get a stamped envelope, and get a comparison that can never
mismatch — a silent no-op precisely where this Update's whole purpose is to fail
loud. Rejecting them at construction applies the Update's own stance ("failing
loud beats resuming into a corrupt offset") one level earlier.

The mechanism is an **allowlist, not a list of known-bad shapes**, and the first
attempt is why. A denylist rejecting only top-level `Map`/`Set`/`RegExp` still
accepted `{ region: "eu-west-1", logGroups: new Set(["/aws/lambda/a"]) }`, where
the nested `Set` canonicalises to `{}` — reproduced end-to-end: two runs over
different log groups fingerprinted identically and the second resumed silently
from the first's offsets, which is this Update's own motivating defect surviving
inside its own fix. The general case is undetectable by inspection, since an
object may hold state in `#private` fields or prototype accessors that no
serializer and no type test can reach. So the walk admits, at every depth, only
a finite number, a string, a boolean, `null`, an array of accepted values, or a
plain object whose own enumerable property values are accepted
(`undefined`-valued properties are allowed and ignored — omitted and
explicitly-`undefined` mean the same thing and fingerprint alike by design).
Everything else is rejected wherever it appears, `Date` and class instances
included; a `Date` is passed as `toISOString()`. An honestly-empty `{}` or `[]`
is still accepted: it carries no information but, unlike a `Map`, it does not
_lose_ any.

This is the same conclusion ADR-0035 reached for redaction — a denylist over
open-ended input does not converge — and it costs the named adopters nothing:
all four already resolve their settings to strings, numbers, booleans,
`readonly string[]`, and nested plain objects.

**`ERR_CHECKPOINT_FINGERPRINT_MISMATCH` is `origin: caller`**, unlike the
`external` classification its file-reading neighbours `ERR_CHECKPOINT_CORRUPT`
and `ERR_CHECKPOINT_PARSE` carry. Graded by dominant cause: the case this
Update exists for is an operator editing the query or the window between runs,
which should exit `2` (`CONFIG_USAGE`), not `3` (`EXTERNAL`). Externally
tampered fingerprints reach the same code and are therefore reported as caller
faults — an accepted consequence, documented in
`docs/reference/core/checkpoint.md`.

## Links

- Related: issue #427 (F11, `docs/plans/IMPLEMENTATION.md`); PR #425 (the
  `claude-pr-review` Must-fix that originated the row-buffering workaround);
  `docs/logs/2026-08-14-rds-data-sql.md`; `docs/reference/core/exporters.md`.
