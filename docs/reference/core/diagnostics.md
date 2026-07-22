# Core / diagnostics

Failure reporting and runtime diagnostics for `@m3l-automation/m3l-common`: a
per-run machine-readable run report, a process exit-code registry, a recursive
cause-chain formatter, an event-fed breadcrumb trail, an on-demand diagnostic
snapshot, and the `runScript()` composition-root wrapper that ties them into a
script's lifecycle.

> **Status: specified, not yet implemented.** This page is the contract for the
> [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) rollout
> (phases 1 and 4). Symbols below are surfaced through the `core` namespace
> barrel when implemented — never as a new `exports` subpath.

## Overview

The `diagnostics` module owns everything that turns a failure into evidence.
Where [`errors`](./errors.md) defines _what_ a failure is and
[`logging`](./logging.md) defines _how text reaches a sink_, `diagnostics`
answers the operator's questions: _what exit code did the run produce and why,
what was happening just before it failed, and what artifact can I read after
the process is gone?_

Everything here is redaction-first (reusing `redactSensitiveLogValue` /
`redactSensitiveLogText` from [`logging`](./logging.md)) and additive — no
existing `M3LScript`, logger, or error behavior changes.

## Public API

To be surfaced through `core` (the `diagnostics` sub-module):

- `M3LRunReport` — the run-report document type.
- `M3LRunReporter` — builds and persists a run report.
- `M3LExitCode` / `M3L_EXIT_CODES` — the exit-code registry.
- `mapErrorToExitCode` — resolves an unknown thrown value to a registry code.
- `formatErrorChain` — recursive cause-chain formatter.
- `M3LBreadcrumbTrail`, `M3LBreadcrumb` — bounded event-fed context trail.
- `collectDiagnostics`, `M3LDiagnosticsSnapshot` — on-demand state snapshot.
- `runScript`, `M3LRunScriptOptions` — the composition-root wrapper.

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

`mapErrorToExitCode(error: unknown): number` resolves in order: the error's
`origin` field (see [`errors` → Fault origin](./errors.md#fault-origin)) → the
error-code catalog's classification for `error.code` → `1`. It never throws.

**Contract:** nothing in the library calls `process.exit()` on this path.
`runScript()` assigns `process.exitCode` so in-flight writes (file logger, run
report) flush before the process ends naturally. The signal layer's second-
signal forced exit maps to `5` only when composed through `runScript()`; bare
`M3LScript.run()` keeps its existing behavior exactly.

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

A bounded ring buffer (default 100 entries) of redaction-safe context entries,
fed by subscribing to the library's existing typed event fabric — it adds no
new instrumentation to the emitting modules:

- [`polling`](./polling.md): `retry:attempt|scheduled|success|fatal|exhausted`,
  `poll:attempt|wait|success|exhausted`
- [`importers`](./importers.md): `import:started|item|progress|error|completed`
- [`network`](./network.md): `request` / `response` / `error`
- `M3LScript` lifecycle stage transitions (via `runScript()`)

```typescript
const trail = new M3LBreadcrumbTrail({ limit: 100 });
trail.attach(retryRunner); // subscribes to every event the emitter declares
trail.attach(httpClient);

// later, e.g. in onError:
trail.entries(); // readonly M3LBreadcrumb[] — {timestamp, source, event, payload}
```

Because event payloads are redaction-safe by construction (attempt counts,
delays, statuses — never raw errors or caller data), the trail inherits that
property and can be embedded verbatim in run reports and issue attachments.
This is how attempt history survives retry exhaustion **without changing the
thrown error's shape**: the last error is still thrown unchanged; the trail
holds what preceded it.

### `M3LRunReport` / `M3LRunReporter`

Every run composed through `runScript()` persists
`data/output/<timestamp>/run-report.json` (same timestamped directory the
stage-9 archival already creates — see
[`script` → File archival](./script.md#file-archival-stage-9)):

```typescript
interface M3LRunReport {
  readonly script: { readonly name: string; readonly version: string };
  readonly correlationId: string;
  readonly startedAt: string; // ISO-8601
  readonly finishedAt: string;
  readonly outcome: "success" | "failure" | "dry-run" | "interrupted";
  readonly exitCode: number; // from the registry above
  readonly environment: M3LDiagnosticsSnapshot;
  readonly timeline: readonly M3LBreadcrumb[]; // stages + attached breadcrumbs
  readonly failure?: {
    // present only when outcome = "failure"
    readonly stage: string; // pipeline stage that threw
    readonly chain: readonly ReturnType<typeof serializeErrorChain>[];
  };
  readonly archive?: unknown; // the stage-9 archive report, when produced
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
function collectDiagnostics(script?: M3LScript): M3LDiagnosticsSnapshot;
```

An on-demand, redacted snapshot: package version, Node version, platform,
execution environment (mode, monorepo root when detected), resolved `M3LPaths`
directories, and — when a script instance is supplied — the config fingerprint
(names + sources, no values) and `correlationId`. Callable anywhere: an
`onError` hook, a `--diagnostics` CLI flag a script chooses to expose, or a
support request ("run with `--diagnostics` and paste the output").

### `runScript`

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

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
});

// The composition root (main.ts) — replaces bare `await script.run(...)`.
await Core.runScript(script, async () => {
  // user code
});
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
