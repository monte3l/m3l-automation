# 0102. Sealed-segment manifest: the append-only audit trail becomes bounded and provable

- **Status:** Accepted
- **Relations:** amends: 0061, fires-trigger-of: 0070
- **Date:** 2026-09-12
- **Deciders:** repo maintainer; Claude (design synthesis)

## Context and problem statement

ADR-0070's 2026-09-05 (second) Update filed **X8b**: the human-action audit
trail is unbounded by design, and the report-only fourth section of
`m3l-console-server cleanup` that X8 slice 5a-ii shipped
(`audit-trail-usage.ts`'s `reportAuditTrailUsage`) is the only signal an
operator gets about its footprint. That Update also named the direction —
"Bounding it needs a writer-format change — a per-segment entry count or a
chained digest — so whole-date archival becomes provable rather than merely
tolerated." This ADR executes that declared revisit trigger.

Both ADRs classify the audit streams as **segment + retain** (ADR-0070
§ Self-telemetry and retention; ADR-0061 § Decision), and ADR-0070's same
Update argues that "retain" is a safety property rather than a preference.
The difficulty is that retain-forever is currently the only _safe_ option,
because the trail cannot survive having anything removed from it:

- `assertNoSequenceGap` (`internal/storage/append-only-reader.ts`) proves
  `(datePrefix, sequence)` contiguity only **within one date**. Intra-date
  deletion therefore makes every later `read()` of the whole stream throw
  `"append-only stream: a segment sequence number is missing"` — and
  permanently, since nothing renumbers a date's segments to repair the hole.
- Whole-**date** deletion survives that check, because every remaining date
  still numbers from 1. But nothing records that the deleted date ever
  existed, so an archived date, a never-written date and a maliciously
  deleted date are indistinguishable — and an archive copy cannot be proven
  to hold the segment's real bytes. `assertNoSequenceGap`'s own TSDoc
  concedes the matching intra-date hole: it "cannot detect the deletion of a
  date's own LAST segment (the remaining ones are still perfectly contiguous
  starting at 1)".
- The only production reader, `rebuildHumanActionIndexOnBoot`
  (`packages/m3l-console-server/src/boot/audit-rebuild.ts`), **never throws**
  by contract — its TSDoc's "Why it never throws" paragraph states the
  rationale — so any of the above damage is invisible at boot.

The trail is therefore _observed_ but not _bounded_: an operator who acts on
the usage report has no operation that both shrinks the retained footprint
and leaves the record's evidentiary value intact. ADR-0070 sanctions
whole-date archival (copying a date away, then `rm 2026-09-*`) as a manual
procedure, but the procedure is only _tolerated_ — the trail afterwards
cannot distinguish it from tampering, and the archive cannot be checked
against anything.

Independently, ADR-0061 recorded an exclusion this decision lifts:
`"append-only" is filesystem-honest, not cryptographically tamper-evident
(recorded as out of scope)` (§ Consequences, trade-offs). Nothing in
ADR-0061's § Decision is replaced — hence `amends` rather than a supersession
verb — but an exclusion cannot be lifted by an `## Update` on an ADR that
never declared a trigger for it (`docs/adr/README.md`, the Update rule), and
that is why this is a new record rather than a third Update on ADR-0061.

## Decision drivers

- **Archival must become provable, not merely survivable.** The operator
  already has an archival procedure; what it lacks is a way for a later
  reader to say "this date was sealed, archived, and the archive holds the
  real bytes."
- **A deletion that is not archival must get louder, not quieter.** Any
  mechanism that buys tolerance for archival by weakening the existing
  sequence-gap throw makes the trail worse. The two cases have to be
  distinguishable at the point of escalation.
- **Cover both owners of `AppendOnlyWriter`.** The console's human-action
  trail (`Core.M3LAppendOnlyStream`) and ADR-0061's agent decision log
  (`internal/agent/decision-log-writer.ts`) are one artifact class with two
  write paths; a proof mechanism on only one of them splits the class.
- **The proof must survive the archival operation itself.** ADR-0070's
  sanctioned procedure is a date glob. A proof the glob deletes is not a
  proof.
- **No new state outside the stream directory.** The primitive's whole
  character is that it carries no index and no cross-process state
  (`internal/storage/append-only-segments.ts` header); an external store
  would make it a different, heavier thing.
- **The append itself must never fail because a proof could not be
  written.** ADR-0061's loud-write rule protects the _entry_. Refusing an
  append to protect metadata about older, already-durable bytes would discard
  a new auditable record to defend a proof about an old one.
- **Verification must run on the hot path.** A check no production reader
  calls is X8b's own defect — observability without enforcement — recurring
  one layer up.

## Considered options

1. **Retain forever (status quo).** Rejected: it is what X8b was filed
   against. The footprint grows without bound on a single-maintainer host,
   and ADR-0070 already recorded the usage report as insufficient.
2. **Per-entry chained digest** (ADR-0070's other named suggestion).
   Rejected on a structural ground worth recording so it is not re-proposed:
   a chain needs a library-owned field _inside the caller's entry_, which
   `read()`'s verbatim-record contract forbids, and it voids the advertised
   guarantee that two instances over one directory "interleave whole lines"
   — two writers cannot both extend one chain without coordination the
   `O_APPEND` design deliberately does not have.
3. **A per-segment sidecar file** (`2026-09-11-0001.jsonl.seal`). Rejected on
   the decisive case: the sidecar shares its segment's date prefix, so the
   `rm 2026-09-*` that ADR-0070 sanctions deletes the proof along with the
   thing it proves. It fails the fourth driver by construction.
4. **A directory-wide append-only `manifest.jsonl`.** Chosen.
5. **State outside the stream directory** — a SQLite table, a signing
   service, an append-only remote. Rejected as the first step: it closes the
   one residual hole option 4 leaves (deleting the manifest itself) but
   changes what the primitive _is_, and ADR-0061/ADR-0070 both scope this to
   a single-maintainer fleet. Recorded here as the available later step if
   custody ever needs to move off-host.

## Decision

We chose **option 4**. The writer seals each segment it rotates away from
into one directory-wide append-only manifest; the reader verifies those seals
inline; and whole-date archival becomes a provable operation whose proof the
archival glob cannot reach.

### The manifest

One file per stream directory, `manifest.jsonl`, exported as
`M3L_APPEND_ONLY_MANIFEST_NAME`. Append-only JSONL like the segments
themselves, with two record kinds discriminated by `kind`:

```jsonc
{ "kind": "baseline", "formatVersion": 1, "at": "<ISO>", "upTo": null }
{
  "kind": "seal",
  "formatVersion": 1,
  "at": "<ISO>",
  "segment": "2026-09-11-0001.jsonl",
  "entryCount": 128,
  "byteLength": 8388012,
  "sha256": "<64 lowercase hex>"
}
```

A single non-date-named file cannot be matched by a date glob, so the proof
survives ADR-0070's archival procedure **by construction** rather than by the
operator remembering to spare it. That is the whole reason the manifest is
directory-wide rather than per-segment.

The name is also invisible to the segment layer without a special case:
`SEGMENT_NAME_PATTERN` does not match `manifest.jsonl`, so
`discoverActiveSegment`, `discoverSegmentsInOrder` and `listSegmentFiles` all
ignore it — and it never raises `listSegments()`' `skipped` count either,
because the unparseable-name branch `continue`s before `skipped` is
incremented. It therefore enters no caller's byte total and no caller's
inventory.

### The baseline record, and why backward compatibility is provable

On its first act the sealer loads-or-initializes the manifest:

- **Absent, with segments already present** (a pre-upgrade trail): write one
  `baseline` whose `upTo` is the highest existing segment name, **digesting
  nothing**.
- **Absent, with no segments**: write `baseline` with `upTo: null` — a
  positive assertion that sealing has been in force since this stream's first
  segment.

Segments at or before the baseline classify as `legacy` and are never
retro-digested. That is the honest choice: a digest taken now cannot vouch
for bytes some earlier process wrote, and a manifest implying otherwise would
be worse than one that says "unproven before here." The baseline is what
makes backward compatibility **bounded and stated** rather than silently
assumed.

### Seal triggers

- **Rotation.** `append()` records the segment it rotated away from;
  `write()`'s serialized chain step calls the sealer after the append
  resolves. Inside the chain, so there is no self-race and no double-seal;
  **outside** `append()`'s existing `try`/`finally`, whose documented claims
  a re-scoped guard would invalidate.
- **Cold-start sweep**, once per instance after the first successful append,
  for segments a crashed process left unsealed. The admission rule is a
  **strictly older date prefix than the current one**. This is airtight:
  `shouldRotate`'s date check forces any conforming writer off a non-today
  segment on its next write, and `discoverActiveSegment` only ever adopts
  today's prefix. The looser-looking rule "today's segments below the highest
  sequence" is **not** safe and is rejected explicitly: writer A can sit at
  sequence 3 while writer B creates sequence 4, and B's sweep would then
  digest a prefix of a file A is still appending to — a false positive on a
  tamper guard, which is the worst failure this design can have.
- The sweep set is on-disk segments minus manifest-named, minus
  at-or-before-baseline, minus today's date. On a healthy trail that is one
  manifest read and **zero** segment bytes re-read. A per-instance ceiling,
  oldest first, keeps a pathological directory from turning one cold start
  into an unbounded read.

### The digest is plain sha256 of the file's raw bytes — a contract

The writer re-reads the sealed file in one bounded sequential pass (at most
`maxSegmentBytes`, default 8 MiB) and yields `entryCount`, `byteLength` and
`sha256` together. An in-memory incremental hash maintained while appending
is rejected: it cannot cover an adopted segment, a crashed process's segment,
or two interleaved writers, and it would digest "what I wrote" rather than
"what is on disk" — inverting the point of a tamper proof.

The digest is a **plain sha256 over the file's raw bytes**, with no framing,
salt or canonicalization, so that `sha256sum <archived-segment>` reproduces
it with no library involved. That property is precisely what makes an archive
provable off-host, so it is a public contract rather than an implementation
detail, and it is pinned by a test against an independently computed hash.

### Read-side verification is inline and non-optional

`read()` verifies as it goes: sealed-but-absent detection (free — a manifest
lookup), `entryCount` and `byteLength` (already counted), and `sha256` via an
incremental digest fed from the chunks the reader already reads. The cost is
CPU only; no segment is read twice. A verification the caller had to opt into
would reproduce X8b's own defect.

One limitation is honest and must be documented rather than engineered away:
a digest only completes at a segment's **end**, so a mismatch throws _after_
the caller has already consumed that segment's entries. That is harmless for
`rebuildHumanActionIndexOnBoot`, which buffers the whole trail before opening
its transaction by design, but an incremental consumer must be told to buffer
or to call `verify()` first.

`verify()` is the `listSegments()`-shaped half: it re-digests without parsing
or yielding entries, **never throws** on a finding, and returns per-segment
verdicts (`sealed`, `unsealed`, `archived`, `mismatched`, `legacy`) plus an
`unprovenBefore` marker and totals. It is what an operator reaches for once
`read()` is throwing, and the only in-library way to re-verify an archive.

### Escalation rules

- **Sealed-but-absent** (the archival case) mirrors the existing
  `onTruncatedTail` policy exactly: a new optional `onArchivedSegment`
  handler on the read options, tolerated **only** when the caller supplies
  it, otherwise thrown. The payload carries the manifest's full claim
  including `sha256`, which is what makes the tolerance provable rather than
  merely polite. Per the established polarity rule, validation rejects only a
  _truthy_ non-function, so a falsy one degrades to the **throwing** path.
- **Gap classification moves ahead of the throw.** A missing sequence that
  _is_ sealed routes to the archival escalation; one that is not keeps
  today's `"a segment sequence number is missing"` throw byte-for-byte. The
  ordering is load-bearing and is pinned by a test on `code` and `context`.
- **A deleted-but-sealed segment now escalates** — including a date's own
  last segment, and a fully deleted trail. This is **new** tamper detection,
  not a relaxation: it closes exactly the hole `assertNoSequenceGap`'s TSDoc
  concedes.
- **Seal-write failure is best-effort and never fatal to the append.**
  ADR-0061's loud-write rule governs the entry; a seal is metadata about
  bytes already durably appended. Loudness relocates rather than
  disappearing: bounded in-process retry, a new optional `onSealFailed`
  handler on both owners' options, and the `unsealed` verdict in `verify()`.
  The sealer **never throws** — a claim enforced by its own guard and
  mutation-tested.
- **Duplicate seals** (two writers sealing one segment) are tolerated
  silently when they agree on `(entryCount, byteLength, sha256)` **only**.
  `at` differs by construction, so comparing whole lines would manufacture a
  false positive. Disagreement throws, and is deliberately **not** gated by
  `onArchivedSegment`: there is no version of "the manifest cannot say what
  the segment held" a caller can consent to, and tolerating it would let an
  attacker neutralize a real seal by appending a false one.
- **Manifest integrity.** A torn last line is ignored unconditionally (a
  half-written seal claims nothing; its segment simply reads as unsealed). A
  malformed mid-file line is fatal. An unknown `kind` is ignored, for forward
  compatibility. A `seal` whose `formatVersion` exceeds the reader's is
  **fatal** — an audit reader must never report "verified" for a claim it
  skipped, which means readers upgrade before writers. The manifest is read
  through the same bounded chunk and ceiling machinery and the same
  `O_NOFOLLOW` + single-link + `0o600` refusals as a segment, and field reads
  go through `Object.hasOwn` into a local per property.

### Intra-date archival stays an explicit non-goal

Sealing makes intra-date deletion _technically_ safe the moment it ships: a
sealed hole inside a date routes to the archival escalation instead of the
sequence-gap throw. It stays forbidden anyway. ADR-0070 forbids it as a
safety property whose second half — custody of the archive — this change does
not address, and unlocking a capability is not the same as granting
permission. It is filed as its own tracker row, pending an archive-custody
retention feature.

### What this decision deliberately cannot do

**Deleting the manifest downgrades a sealed trail to `legacy`**, silently, on
the next writer's cold start. The only thing bounding that is the directory's
owner-only `0o700` mode — exactly the bound that already applies to
`assertNoSequenceGap`'s documented renumbering hazard. `verify()`'s
`unprovenBefore` makes the downgrade visible after the fact; closing it needs
state outside the directory, which is option 5 above and which this primitive
deliberately does not have.

## Consequences

- **Positive:** whole-date archival becomes provable — the manifest survives
  the glob, and an archive re-verifies with plain `sha256sum` — so the
  retained footprint can shrink without the trail losing evidentiary value,
  which is what "segment + retain" needed to stay honest. Tamper detection
  strictly improves: a date's deleted last segment and a fully deleted trail
  both escalate where they were previously silent. Both owners of
  `AppendOnlyWriter` gain it, so the artifact class does not split.
  ADR-0061's tamper-evidence exclusion is lifted with a stated, bounded scope
  rather than quietly.
- **Negative / trade-offs:** a write-side format change, so a downgraded
  reader meeting a newer `formatVersion` fails closed by design. One extra
  bounded read of the sealed segment on the append that rotates (the latency
  figure is probed on the host before any number enters public TSDoc, not
  guessed). Manifest growth is O(segments) at roughly 200 bytes per segment
  and the manifest is **not itself rotated**, which grows the append-only
  stream's public "limitations are part of the public contract" list from
  three items to five. A seal is best-effort, so `unsealed` is a reachable
  steady state rather than an anomaly. Deleting the manifest silently
  downgrades the trail (above). Four public TSDoc sites plus one module
  header advertise "no index file is kept" and stop being true — they must
  change together with the code.
- **Semver impact:** **minor**. The implementation is purely additive on
  `@m3l-automation/m3l-common`: a public `verify()` method, the manifest
  types, a new `M3LAppendOnlyStreamManifestError` with code
  `ERR_APPEND_ONLY_STREAM_MANIFEST`, and the optional `onArchivedSegment` /
  `onSealFailed` handlers. No existing signature changes and no `exports`
  subpath is added — the new symbols reach consumers through the existing
  Core namespace barrel. `4.7.0` becomes `4.8.0`.

## Links

- Trigger: [ADR-0070](./0070-console-audit-and-observability.md)'s 2026-09-05
  (second) Update, which filed X8b and named the writer-format direction.
  Amended: [ADR-0061](./0061-agent-decision-log.md) (its § Consequences
  tamper-evidence exclusion).
- Taxonomy: [ADR-0035](./0035-failure-reporting-and-diagnostics.md). Slice
  discipline: [ADR-0072](./0072-reviewable-slice-discipline.md).
- Plan: [`docs/plans/2026-08-20-m3l-console.md`](../plans/2026-08-20-m3l-console.md)
  § X8, slices X8b1 to X8b5. Tracker row: X8b (issue #1057).
