# Core / diagnostics

Failure reporting and runtime diagnostics for `@m3l-automation/m3l-common`: a
per-run machine-readable run report, a process exit-code registry, a recursive
cause-chain formatter, an event-fed breadcrumb trail, an on-demand diagnostic
snapshot, and the `runScript()` composition-root wrapper that ties them into a
script's lifecycle.

> **Status: implemented (ADR-0035 phase 1).** `runScript` and
> `M3LRunScriptOptions` remain **specified, not yet implemented** — they are
> [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) **phase 4**
> and are marked inline below. Every symbol here is surfaced through the `core`
> namespace barrel — never as a new `exports` subpath.

## Overview

The `diagnostics` module owns everything that turns a failure into evidence.
Where [`errors`](./errors.md) defines _what_ a failure is and
[`logging`](./logging.md) defines _how text reaches a sink_, `diagnostics`
answers the operator's questions: _what exit code did the run produce and why,
what was happening just before it failed, and what artifact can I read after
the process is gone?_

Everything here is additive — no existing `M3LScript`, logger, or error
behavior changes.

> **Two different redaction guarantees live in this module. Know which one you
> are relying on.**
>
> - **Allowlisted surfaces — a guarantee.** The breadcrumb trail, the config
>   fingerprint, and the source-label set keep only named, scalar fields
>   enumerated in advance. A payload field nobody allowlisted is dropped, so
>   there is nothing for a heuristic to miss. Header _names_ are kept, values
>   never are; importer record contents are dropped entirely.
> - **Free-text surfaces — best effort only.** Error `message`, `stack`, and
>   `context`, and the `archive` manifest, are redacted with
>   `redactSensitiveLogValue` / `redactSensitiveLogText` plus URL scrubbing.
>   Those are heuristics over unbounded input. They catch the common shapes and
>   are _not_ a guarantee.
>
> Consequently **`run-report.json` is a sensitive artifact — treat it as a
> crash dump**, not as something to attach to a public issue unreviewed. See
> [ADR-0035's 2026-07-23 update](../../adr/0035-failure-reporting-and-diagnostics.md#update-2026-07-23--the-run-report-is-a-sensitive-artifact)
> for the evidence behind that classification and the known residual gaps, and
> the [troubleshooting guide](../../guides/troubleshooting.md) for what is safe
> to share.

## Public API

Surfaced through `core` (the `diagnostics` sub-module).

### Exit codes

- `M3L_EXIT_CODES` / `M3LExitCode` — the exit-code registry and its numeric
  union (`0 | 1 | 2 | 3 | 4 | 5`).
- `M3LErrorExitCode` — the subset a thrown error can map to
  (`Exclude<M3LExitCode, 0 | 5>`, i.e. `1 | 2 | 3 | 4`). `SUCCESS` and
  `INTERRUPTED` are set by the caller, never derived from an error.
- `mapErrorToExitCode` — resolves an unknown thrown value to an
  `M3LErrorExitCode`.
- `isM3LErrorOrigin` — type guard for the `origin` field read structurally off
  an arbitrary thrown value.

### Cause chains

- `formatErrorChain` — recursive cause-chain formatter (human-readable).
- `serializeErrorChain` — the same walk as structured JSON, for the run report.
- `M3LSerializedError` — one level of that walk.
- `M3LFormatErrorChainOptions` — `{ stacks?, redact? }`, both defaulting to
  `true`.

`M3LSerializedError` carries `name` and `message` always; every other field is
present only when the level supplies it:

```typescript
interface M3LSerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly context?: Record<string, unknown>;
  readonly origin?: M3LErrorOrigin;
  readonly retryable?: M3LErrorRetryable;
}
```

`code`, `context`, `origin`, and `retryable` appear only for a level that is an
`M3LError`; `origin`/`retryable` additionally require that level's `code` to
carry a [catalog classification](./errors.md#fault-origin) (or an explicit
constructor override). **The key is omitted, not set to `undefined`** — a
serialized level for a plain `Error` has no `origin` property at all, so the
written run report contains no `"origin": null` entries and `"origin" in level`
is a reliable presence check.

- `scrubUrlsInText` — rewrites `http(s)` URLs in free text to
  `origin + pathname`, dropping userinfo, query, and fragment.

### Breadcrumbs

- `M3LBreadcrumbTrail`, `M3LBreadcrumb` — bounded event-fed context trail.
- `M3LBreadcrumbScalar` — the value type a breadcrumb payload may hold.
- `M3LBreadcrumbSource` — the structural `on`/`off` port an emitter satisfies.
- `M3LBreadcrumbTrailOptions` — `{ limit? }`, default `100`.
- `M3LBreadcrumbAttachOptions` — `{ source?, events? }`.

### Diagnostics snapshot

- `collectDiagnostics`, `M3LDiagnosticsSnapshot` — on-demand state snapshot.
- `M3LCollectDiagnosticsOptions` — the injected ports and correlation id.
- `M3LConfigSchemaPort`, `M3LConfigSourcePort`, `M3LPathsPort` — the structural
  ports the snapshot reads through (see
  [Structural ports](#structural-ports-and-why-they-are-not-m3lscript)).
- `M3LConfigFingerprintEntry` — one config parameter's name and source, never
  its value.
- `M3LDiagnosticsEnvironment` — execution-environment fields, a discriminated
  union on `deploymentMode`.
- `M3LDiagnosticsPaths` — the five resolved `M3LPaths` directories.

### Run report

- `M3LRunReport` — the run-report document, a discriminated union on `outcome`.
- `M3LRunReportBase` — the fields common to both arms.
- `M3LRunReportFailure` — the failure block (`stage` + `chain`).
- `M3LRunOutcome` — `"success" | "failure" | "dry-run" | "interrupted"`.
- `M3LRunReportInput` — what `build`/`persist` accept.
- `M3LRunReporter` — builds and persists a run report.
- `M3LRunReporterOptions` — `{ paths?, fileName? }`.

### Phase 4 (not yet implemented)

- `runScript`, `M3LRunScriptOptions` — the composition-root wrapper. See
  [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) § Rollout.
  Note ADR-0009 Zone B forbids `core/* → core/script`, so the wrapper cannot
  live in this submodule beside the rest of the machinery; its placement is
  resolved in phase 4.

The error-code classification `mapErrorToExitCode` falls back to
(`M3L_ERROR_CATALOG`, `classifyErrorCode`, `M3LErrorOrigin`,
`M3LErrorRetryable`, `M3LErrorClassification`, `isM3LErrorCode`) ships through
`core/errors` — see
[errors → Error-code catalog](./errors.md#error-code-catalog).

### Exit-code registry — `M3L_EXIT_CODES` / `mapErrorToExitCode`

A deliberately coarse, fixed registry so schedulers (cron, CI, Step Functions)
can branch on the failure _class_; the fine detail travels in the error `code`
and the run report:

| Exit code | Name           | Meaning                                         | Typical `origin` |
| --------- | -------------- | ----------------------------------------------- | ---------------- |
| `0`       | `SUCCESS`      | Run completed                                   | —                |
| `1`       | `UNCLASSIFIED` | Reserved: unclassified failure (Node's default) | unknown          |
| `2`       | `CONFIG_USAGE` | Configuration / usage error                     | `caller`         |
| `3`       | `EXTERNAL`     | External-system failure                         | `external`       |
| `4`       | `LIBRARY`      | Library-internal fault                          | `library`        |
| `5`       | `INTERRUPTED`  | Signal-forced shutdown                          | —                |

`mapErrorToExitCode(error: unknown): M3LErrorExitCode` resolves in order: the
error's `origin` field (see [`errors` → Fault origin](./errors.md#fault-origin),
read structurally via `isM3LErrorOrigin`, so it works on any thrown value, not
only an `M3LError`) → the error-code catalog's classification for `error.code`
→ `1`. It never throws — a `null`, a string, a circular object, or an object
whose `origin`/`code` getter throws all resolve to `1`.

The return type is `M3LErrorExitCode` (`1 | 2 | 3 | 4`), not `number`: `SUCCESS`
and `INTERRUPTED` describe how a run ended, not what an error was, so they are
set by the caller and are unreachable from this function by construction rather
than by convention.

**Contract:** nothing in the library calls `process.exit()` on this path.
`runScript()` (phase 4) assigns `process.exitCode` so in-flight writes (file
logger, run report) flush before the process ends naturally. The signal layer's
second-signal forced exit maps to `5` only when composed through `runScript()`;
bare `M3LScript.run()` keeps its existing behavior exactly.

### `formatErrorChain`

```typescript
function formatErrorChain(
  error: unknown,
  options?: {
    readonly stacks?: boolean; // default true
    readonly redact?: boolean; // default true
  },
): string;
```

Walks `error.cause` recursively and renders one block per level — `name`,
`code` (when present), message, and stack — joined by `caused by:` markers.
Defensive at every level: a non-`Error` cause (string, object, `undefined`) is
rendered via `toError` from [`errors`](./errors.md) rather than crashing the
formatter; cycles are broken by an identity check with a depth cap. Output is
redacted by default. A structured sibling (`serializeErrorChain`) returns the
same walk as JSON for the run report — superseding the single-level
`serializeError` (which stays, unchanged, for the guard paths).

### `M3LBreadcrumbTrail`

A bounded ring buffer (default 100 entries) of summarized, redacted context
entries, fed by subscribing to the library's existing typed event fabric — it
adds no new instrumentation to the emitting modules:

- [`polling`](./polling.md): `retry:attempt|scheduled|success|fatal|exhausted`,
  `poll:attempt|wait|success|exhausted`
- [`importers`](./importers.md): `import:started|item|progress|error|completed`
- [`network`](./network.md): `request` / `response` / `error`
- `M3LScript` lifecycle stage transitions (via `runScript()`)

```typescript
const trail = new M3LBreadcrumbTrail({ limit: 100 });
trail.attach(retryRunner); // subscribes to the known event names (below)
trail.attach(httpClient);
const detach = trail.attach(poller); // returns an idempotent detach

// later, e.g. in onError:
trail.entries(); // readonly M3LBreadcrumb[] — {timestamp, source, event, payload}
```

`attach` subscribes to a fixed registry of known library event names, or to an
explicit `options.events` list. It cannot enumerate an emitter's declared
events: `M3LEventEmitterBase` keeps its handler map private and the event map
is compile-time only. Subscribing to a name an emitter never emits is a
harmless no-op, so blind subscription over the registry is safe — but a typo in
a custom `events` list records nothing rather than erroring. Attaching the same
emitter twice records each event twice; `attach`'s returned detach removes
exactly its own registrations and is idempotent.

#### Payloads are summarized, then redacted

**Event payloads are _not_ safe to store verbatim**, and the trail never does.
Each payload is projected through a per-event **summarizer** that keeps scalars
only, and the result is then passed through `redactSensitiveLogValue`.

This matters because three event families carry caller data or secrets
directly: [`network`](./network.md)'s `request` payload holds the raw merged
`headers` (where `Authorization` rides), its `error` payload holds a raw error
instance, and [`importers`](./importers.md)' `import:item` / `import:error`
hold the raw caller record and a raw error. Only the
[`polling`](./polling.md) `retry:*` / `poll:*` payloads are scalar-only by
construction.

What the summarizers keep, for the events most likely to carry secrets:

| Event          | Stored payload                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| `request`      | `method`, `url`, `headerNames` (sorted **names only** — never values)            |
| `response`     | `method`, `url`, `status`, `ok`, `durationMs`                                    |
| `error`        | `method`, `url`, `errorName`, `errorCode?`, `reason?`, `status?`, `errorMessage` |
| `import:item`  | `index` only — **the record is dropped entirely**                                |
| `import:error` | `index?`, `errorName`, `errorCode?` — **no message** (see below)                 |

Every `url` is reduced to `origin + pathname`, dropping userinfo, query string,
and fragment, and non-`http(s)` schemes are rejected outright — so a presigned
URL's signature, an `?access_token=`, or a `user:pass@` credential cannot reach
a stored breadcrumb. The `error` event's `errorMessage` is scrubbed the same
way (an HTTP error message embeds the request URL verbatim). `import:error`
carries **no** message at all: importer error messages routinely embed the
offending record, which is exactly the caller data that must not travel into a
shared artifact.

An unrecognized event, or a payload that is not a plain record, falls back to
keeping own enumerable scalar properties and relies on `redactSensitiveLogValue`
alone — which is a **best-effort heuristic**, not a guarantee. That path is
reachable only via a custom `options.events` name or a direct `record()` call.

This is how attempt history survives retry exhaustion **without changing the
thrown error's shape**: the last error is still thrown unchanged; the trail
holds what preceded it.

### `M3LRunReport` / `M3LRunReporter`

`M3LRunReporter` persists `data/output/<startedAt>/run-report.json`, where
`<startedAt>` is the run's ISO-8601 start timestamp with `:` replaced by `-`
(Windows-safe). The directory is named by `startedAt`, not `finishedAt`, so it
is stable for the whole run and survives a hang or a kill.

> **The reporter owns this directory; stage-9 archival does not share it.**
> An earlier draft of this page claimed the two write to the same timestamped
> directory. They do not — stage-9 archival writes **flat** into
> `data/output/inputs/` and `data/output/configs/` (see
> [`script` → File archival](./script.md#file-archival-stage-9)), and phase 1
> deliberately left that behavior untouched rather than change an observable
> output layout that nine consumer scripts already depend on. Reconciling the
> two is [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) phase 5.

The path is contained: both the timestamp segment and the configured `fileName`
are validated with `isSafeRelativeSegment` (the same guard
`M3LPaths.resolveInput`/`resolveOutput` use), and the fully-resolved path is
asserted to stay inside the resolved output directory — including after symlink
resolution — before anything is written.

`M3LRunReport` is a **discriminated union on `outcome`**, so a report claiming
success cannot carry a failure block and a failure report cannot omit one —
both illegal states are unrepresentable rather than merely discouraged:

```typescript
interface M3LRunReportBase {
  readonly script: { readonly name: string; readonly version: string };
  readonly correlationId: string;
  readonly startedAt: string; // ISO-8601
  readonly finishedAt: string;
  readonly exitCode: number; // from the registry above
  readonly environment: M3LDiagnosticsSnapshot;
  readonly timeline: readonly M3LBreadcrumb[]; // stages + attached breadcrumbs
  readonly archive?: unknown; // the stage-9 archive report, when produced
}

interface M3LRunReportFailure {
  readonly stage: string; // pipeline stage that threw
  readonly chain: readonly M3LSerializedError[]; // the full walked cause chain
}

type M3LRunReport = M3LRunReportBase &
  (
    | { readonly outcome: "failure"; readonly failure: M3LRunReportFailure }
    | {
        readonly outcome: Exclude<M3LRunOutcome, "failure">;
        readonly failure?: undefined;
      }
  );
```

Narrow on `outcome`, not on `failure !== undefined`:

```typescript
if (report.outcome === "failure") {
  report.failure.chain; // no optional access needed
}
```

**Behavioral contracts:**

- The **failure path always attempts the report** — that is the report's whole
  point. The writer runs best-effort inside the error path, isolated exactly
  like the `onError`/`onCleanup` hook failures are today (a report-write
  failure falls back to the best-effort stderr diagnostic and never shadows
  the original error).
- The config fingerprint inside `environment` records parameter **names and
  resolution sources only — never values**. Redaction is structural, not
  best-effort.
- Success-path reports are written after stage 9, so the archive manifest is
  included when archival ran.

### `collectDiagnostics`

```typescript
function collectDiagnostics(
  options?: M3LCollectDiagnosticsOptions,
): M3LDiagnosticsSnapshot;

interface M3LCollectDiagnosticsOptions {
  readonly schema?: M3LConfigSchemaPort;
  readonly config?: M3LConfigSourcePort;
  readonly paths?: M3LPathsPort;
  readonly correlationId?: string;
}
```

An on-demand, redacted snapshot: package version, Node version, platform, arch,
capture timestamp, execution environment (mode, monorepo root when detected),
resolved `M3LPaths` directories, and — when the ports are supplied — the config
fingerprint (names + sources, no values) and `correlationId`. Callable
anywhere: an `onError` hook, a `--diagnostics` CLI flag a script chooses to
expose, or a support request ("run with `--diagnostics` and paste the output").

**Never throws.** Each section is collected independently and a section whose
collection fails is **omitted, not partially filled** — `new M3LPaths()` can
throw `M3LPathResolutionError` and `M3LExecutionEnvironment.detect()` can throw
`M3LEnvironmentDetectionError`, and this snapshot's primary consumer is the
failure path. `config` is omitted when no `schema` port is supplied; a `schema`
whose `declaredNames()` _throws_ is distinguishable from that case, because the
throw is reported through the best-effort stderr diagnostic.

`detectionDetails` from `M3LExecutionEnvironmentInfo` is deliberately **not**
embedded — it is a raw, unredacted environment-signal blob.

### Structural ports, and why they are not `M3LScript`

The spec originally called for `collectDiagnostics(script?: M3LScript)`. That
signature is not implementable, for two independent reasons:

1. **Layering.** ADR-0009 Zone B (enforced by `bin/check-eslint-zones.mjs`)
   makes `core/script` the composition root that no other `core` module may
   import. `core/diagnostics` importing it would be a lint failure — and would
   become a genuine import cycle once phase 4's `runScript()` needs
   diagnostics.
2. **Encapsulation.** `M3LScript`'s config schema is a private field with no
   public accessor, so a script instance could not supply declared parameter
   names even if the import were permitted.

So the snapshot reads through three minimal structural ports instead:

```typescript
interface M3LConfigSchemaPort {
  declaredNames(): readonly string[];
}
interface M3LConfigSourcePort {
  sourceOf(name: string): string | undefined;
}
interface M3LPathsPort {
  getDataDir(): string;
  getConfigDir(): string;
  getInputDir(): string;
  getOutputDir(): string;
  getCacheDir(): string;
}
```

`M3LConfigSchema`, `M3LConfig`, and `M3LPaths` satisfy these **structurally,
with no adaptation and no change to `core/config`** — pass them directly. The
seam is drawn exactly on the redaction boundary: `M3LConfigSourcePort` exposes
`sourceOf`, which returns a source _label_, and has no way to reach a value.

`M3LConfigFingerprintEntry` closes the same hole at the type level:

```typescript
interface M3LConfigFingerprintEntry {
  readonly name: string;
  readonly source: string | undefined;
  readonly value?: never; // always absent — see below
}
```

The `value?: never` field is load-bearing, not decorative. Without it,
excess-property checking protects only _fresh_ object literals, so a widened
object carrying a `value` would assign in cleanly and — since the reporter
serializes the snapshot verbatim — land in `run-report.json`. It is a
**compile-time** guard only; the runtime enforcement is a fresh-object
projection in `collectDiagnostics`, which builds every entry field-by-field and
never passes a caller-supplied object through. A `sourceOf` return that does
not look like a source label (short, lowercase, hyphen-joined) is dropped
rather than stored, so a misimplemented port cannot smuggle a value through the
`source` field.

> **`source` is `undefined` for every parameter today.**
> `M3LScriptConfigLoader.load()` calls `config.set(name, value)` with no third
> argument (`M3LScriptConfigLoader.ts:81`), and nothing else in the library
> populates one — so `M3LConfig.sourceOf()` returns `undefined` for every
> parameter a script resolves through the normal chain. The fingerprint
> therefore records **names only** in practice. Populating a real source label
> requires `M3LConfigReader` to report which provider won a lookup, which is a
> `core/config` change outside ADR-0035 phase 1 — tracked in
> [`IMPLEMENTATION.md`](../../plans/IMPLEMENTATION.md#adr-0035-rollout--failure-reporting--diagnostics).
> The `source` field and its validation are in place so adding it later is
> additive.

### `runScript`

> **Status: specified, not yet implemented — ADR-0035 phase 4.** Everything
> above this heading ships today; this section is the contract phase 4 builds
> against. Note its placement is an open question: ADR-0009 Zone B forbids
> `core/* → core/script`, so the wrapper cannot live in `core/diagnostics`
> beside the machinery it composes.

```typescript
function runScript(
  script: M3LScript,
  mainFn: () => void | Promise<void>,
  options?: M3LRunScriptOptions, // { dryRun?: boolean; report?: boolean; trail?: M3LBreadcrumbTrail }
): Promise<void>;
```

The composition-root wrapper — the one place process-wide concerns compose
(see [`script` → Process guards](./script.md#process-guards) for the
responsibility contract):

1. Installs process guards (`installProcessGuards()`).
2. Runs `script.run(mainFn)` under a top-level catch.
3. On failure: logs the error via `logger.errorFrom` when the script has a
   logger, writes the failure run report, sets `process.exitCode` from
   `mapErrorToExitCode`.
4. On success: writes the success run report, leaves `exitCode` at `0`.
5. `dryRun: true` stops the pipeline after stage 5 (AWS provisioning /
   credential validation) and records `outcome: "dry-run"` — configuration and
   credentials are validated with no side effects. Hooks observe
   `ctx.dryRun` for side-effect-aware behavior deeper than the boundary.

`runScript()` never calls `process.exit()`. Bare `script.run(mainFn)` remains
fully supported and unchanged for callers that want the primitive.

## Usage examples

Writing a run report by hand — what phase 4's `runScript()` will do for you,
and what a script can do today:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
});
const reporter = new Core.M3LRunReporter({ paths: script.paths });
const trail = new Core.M3LBreadcrumbTrail();
const startedAt = new Date();

try {
  await script.run(async () => {
    // user code
  });
  await reporter.persist({
    script: { name: "report-builder", version: "1.0.0" },
    correlationId: "run-1",
    startedAt,
    outcome: "success",
    timeline: trail.entries(),
    archive: script.getLastArchiveReport(),
  });
} catch (error) {
  // `persist` never rejects and never shadows `error` — the re-throw below
  // propagates the original value untouched, even if the write failed.
  await reporter.persist({
    script: { name: "report-builder", version: "1.0.0" },
    correlationId: "run-1",
    startedAt,
    outcome: "failure",
    stage: "main",
    error,
    timeline: trail.entries(),
  });
  process.exitCode = Core.mapErrorToExitCode(error);
  throw error;
}
```

Post-mortem, in an `onError` hook:

```typescript
const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
  hooks: {
    onError: (ctx, error) => {
      console.error(Core.formatErrorChain(error));
      console.error(JSON.stringify(Core.collectDiagnostics()));
    },
  },
});
```

## Notes and behavior

- **No new runtime dependencies.** Everything composes existing seams: the
  event emitters, the config chain, the redaction helpers, the archival
  output directory.
- **Report retention** follows the archive directory's: one timestamped
  directory per run under `data/output/`; pruning is the operator's concern
  (documented in the [troubleshooting guide](../../guides/troubleshooting.md)).
- **Lambda:** `runScript()` is CLI-oriented (exit codes are meaningless to the
  Lambda runtime). Lambda handlers keep `createLambdaHandler()`; run reports in
  Lambda are deferred until a concrete consumer needs them (`/tmp` is the only
  writable mount and CloudWatch is the natural sink there).

## See also

- [errors](./errors.md) — fault-origin classification and the error-code catalog
- [logging](./logging.md) — `minLevel`, `M3L_DEBUG`, `errorFrom`
- [script](./script.md) — lifecycle, guards, archival
- [polling](./polling.md) — the event payloads the trail captures
- [Guide: Troubleshooting](../../guides/troubleshooting.md)
- [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md)
