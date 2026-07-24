# Troubleshooting and debugging

How to diagnose a failing script or library error: triage the failure by
origin, read the diagnostic surfaces (errors, logs, exit codes, run archives),
turn on debug output, attach a debugger, and file a failure report that can be
acted on.

Everything below is available today. The log-level precedence chain
(`M3L_DEBUG=1` / `M3L_LOG_LEVEL` / `--log-level` / `--debug`, resolved for
`M3LScript`'s default logger) shipped in
[ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) phase 4b — CLI and
environment tiers only; a config-file tier was deliberately not added (see §4).

## 1. Triage: whose failure is it?

Every built-in error carries a stable `code` (see the
[error-code catalog](../reference/core/errors.md#error-code-catalog)) and an
[`origin`](../reference/core/errors.md#fault-origin) field, defaulted from that
catalog. Classify first, then act:

| `origin`   | It means                                                    | You should                                                                                                                    |
| ---------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `caller`   | The script or its configuration is wrong                    | Fix the script/config: check the parameter named in `context`, the config resolution order, the API contract in the reference |
| `external` | An external system (AWS, HTTP endpoint, remote job) failed  | Check the external system's status/permissions/limits; often retryable — see the catalog's `retryable` column                 |
| `library`  | An internal invariant of `@m3l-automation/m3l-common` broke | File a [failure report](#7-filing-a-failure-report) — this is a library bug                                                   |

When `origin` is absent — a thrown value that is not an `M3LError`, or one
carrying a code the catalog does not classify — the same triage works through
the code itself: config and validation codes (`ERR_CONFIG_*`, `ERR_PRESET_*`,
argument validation) are caller-side; AWS/HTTP/poll codes
(`ERR_S3_OPERATION`, `ERR_HTTP_REQUEST`, `ERR_POLL_EXHAUSTED`, …) are external;
anything the catalog marks `library` — or any crash with no `M3LError` in its
chain originating inside the package — is a library issue.

Walk the whole chain, not just the top error: failures are chained through
`cause` (`wrapError`), and the _root_ cause usually carries the actionable
code. [`formatErrorChain(error)`](../reference/core/diagnostics.md) prints the
full chain with stacks, and `serializeErrorChain(error)` returns it as
structured levels carrying each `M3LError`'s `code`, `origin`, and `retryable`.

## 2. Exit codes

A script composed through [`runScript()`](../reference/core/script.md#runscript)
produces the registry codes below. A bare `M3LScript.run()` still exits with
Node's default `1` — it re-throws and maps nothing, by design.

| Exit code | Meaning                              | Scheduler guidance                          |
| --------- | ------------------------------------ | ------------------------------------------- |
| `0`       | Success                              | —                                           |
| `1`       | Unclassified failure                 | Inspect the run report / logs               |
| `2`       | Configuration / usage error (caller) | Do not retry; fix config first              |
| `3`       | External-system failure              | Retry with backoff is usually reasonable    |
| `4`       | Library-internal fault               | Do not blind-retry; file a failure report   |
| `5`       | Interrupted (signal-forced)          | Re-run when the interruption cause is clear |

See the [exit-code registry](../reference/core/diagnostics.md#exit-code-registry--m3l_exit_codes--maperrortoexitcode)
for the resolution rules.

## 3. Post-mortem: run archives and run reports

Each script run archives its inputs (stage 9 of the
[lifecycle](../reference/core/script.md#execution-flow)), and — once composed
through the diagnostics reporter — writes a per-run report:

```text
data/output/
└── 2026-07-24T10-14-02.000Z/  # one directory per run, named by its start time
    ├── inputs/                 # snapshot of data/input at run time
    ├── configs/                # snapshot of data/config at run time
    └── run-report.json         # outcome, exit code, timeline, failure chain
```

Everything for one run lives under a single per-run `<timestamp>/` directory:
the input/config archive and the run report share it, both derived from the same
run-start timestamp (ADR-0035 phase 5). Nothing is flat or overwritten across
runs anymore, so each run's post-mortem is self-contained — copy or prune a run
by its one directory.

- The base directory is `data/output/` at the monorepo root (or
  `$M3L_BASE_DIR/output` standalone; `M3L_OUTPUT_DIR` overrides — see the
  [environments and paths guide](./environments-and-paths.md)).
- Archival runs only on the success path — a failed run leaves no archive.
  The failure path, however, always writes `run-report.json` (outcome, failing
  stage, full serialized cause chain, breadcrumb timeline, environment
  snapshot), so the artifact exists precisely when you need it.
- Retention is yours: the library never prunes `data/output/`. Prune by
  timestamp directory.

To reconstruct a failed run today: pair the console/file/JSON log output (with
its `correlationId`) with the input/config files as they were at run time — if
the run succeeded far enough to archive — or re-run with debug output (§4).

## 4. Turning on debug output

Available today:

- `logger.errorFrom(error)` — logs an error with its code, context, and the
  full recursive cause chain as structured fields. Safe to call on any caught
  value; it never throws.
- `logger.time(label)` — returns a callable that logs a `DEBUG` event carrying
  the elapsed `durationMs`.
- `minLevel` — a severity floor, set per logger and per handler when you
  construct them (e.g. a console handler at `INFO` alongside a file handler at
  `DEBUG`). The `DEBUG` category carries the library's own diagnostic events.
- `collectDiagnostics()` — an on-demand redacted snapshot (environment, paths,
  config fingerprint) worth exposing behind a `--diagnostics` flag.

Also available today, for a script composed via `M3LScript` **(ADR-0035 phase
4b)** — these set the floor on the default logger `M3LScript` builds (a
caller-supplied `options.logger` opts out entirely):

- `M3L_DEBUG=1` — one-switch debug mode: drops the level floor to `DEBUG` and
  surfaces the library's own diagnostic events (breadcrumbs, timings). Truthy
  values are `1`/`true`; anything else is off.
- `M3L_LOG_LEVEL=<level>` / `--log-level=<level>` / `--debug` — the same floor
  via the precedence chain **CLI > env > default**: `--log-level`/`--debug` beat
  `M3L_LOG_LEVEL`/`M3L_DEBUG`, which beat the built-in default. `<level>` is one
  of `debug`/`info`/`success`/`warning`/`error`/`fatal` (case-insensitive); an
  unknown value — or a valueless `--log-level` — fails loud with `M3LError`
  (`ERR_INVALID_ARGUMENT`) at construction.

A **config-file tier was deliberately not added**: a config-file floor cannot
affect the logs emitted while config is still loading, and CLI + env cover the
operational need
([ADR §2.5 carve-out](../adr/0035-failure-reporting-and-diagnostics.md#25-log-levels-and-the-debug-toggle-logging)).
When you construct a logger yourself (outside `M3LScript`), set `minLevel`
explicitly in your composition root.

Structured JSON output for machine consumption is available today: add
`M3LJsonLoggerHandler` to the logger's handler array
([logging](../reference/core/logging.md)).

## 5. Correlation IDs and CloudWatch Insights

Every run resolves one `correlationId` (UUID, or the Lambda request id — see
[script → Correlation IDs](../reference/core/script.md#correlation-ids)).
Construct your logger with it and every JSON log line carries it:

```typescript
const script = new Core.M3LScript({
  metadata: { name: "etl", version: "1.0.0" },
  hooks: {
    onBeforeRun: (ctx) => {
      // ctx.correlationId is always resolved by now
    },
  },
});
```

With `M3LJsonLoggerHandler` shipping logs to CloudWatch, typical Insights
queries:

```text
# All lines from one run/invocation
fields @timestamp, category, message
| filter correlationId = "6f1d9c2e-..."
| sort @timestamp asc

# Recent failures across runs, grouped
fields @timestamp, correlationId, message
| filter category in ["ERROR", "FATAL"]
| sort @timestamp desc
| limit 50

# Which runs touched a promoted data field (scalar `data` fields are top-level)
fields @timestamp, correlationId, durationMs
| filter ispresent(durationMs) and durationMs > 5000
```

In Lambda, the correlation id prefers `context.awsRequestId`, so these queries
join directly against the platform's own `@requestId`.

## 6. Live debugging a script

Scripts are plain Node ESM processes; the standard inspector workflow applies:

```bash
# From the script package after `pnpm build`:
node --inspect-brk --enable-source-maps dist/main.js --profile dev
```

- `tsc` emits source maps; `--enable-source-maps` makes stack traces point at
  `.ts` sources.
- Attach VS Code via a `node` attach configuration (port 9229), or
  `chrome://inspect`.
- Breakpoint targets that pay off: your `mainFn`, the `onError` hook, and the
  step modules under `src/steps/`.
- Second-signal kill: if a hung script ignores the first `SIGINT`, a second one
  force-exits (see [script → Signal handling](../reference/core/script.md#signal-handling)).

[`runScript(script, mainFn, { dryRun: true })`](../reference/core/script.md#dry-runs)
validates environment, configuration, and AWS credentials — stages 1–5 —
without executing `mainFn`: the fastest way to separate "my config/credentials
are wrong" from "my logic is wrong". Scripts scaffolded from the template expose
this as a **`--dry-run`** flag (ADR-0035 phase 5), so `node dist/main.js
--dry-run` runs the validation without side effects.

## 7. Filing a failure report

Use the **Failure report** issue form (`.github/ISSUE_TEMPLATE`), which mirrors
this guide's triage. Have ready:

1. The error `code` and `origin` of the **root** cause.
2. The exit code and how the script was invoked.
3. The `correlationId` of the failing run.
4. Environment: package version, Node version, OS, standalone vs monorepo vs
   Lambda.
5. The cause chain of the root failure — see the sharing rules below before
   pasting any of it.

### `run-report.json` is a crash dump — treat it as sensitive

**Do not attach `run-report.json` to a public issue without reviewing it
first.** It deliberately carries full diagnostic fidelity: error messages,
stack traces, cause-chain context bags, and the archive manifest. Any of those
can contain whatever a caller or an upstream service put there — a request URL
with a presigned signature, a credential embedded in an error string, absolute
paths that disclose your OS username.

The library redacts it on a best-effort basis (`redactSensitiveLogValue` plus
URL scrubbing) and that catches the common shapes, but it is a heuristic, not a
guarantee. Four adversarial reviews of the phase-1 implementation each found
inputs it did not catch; see
[ADR-0035's 2026-07-23 update](../adr/0035-failure-reporting-and-diagnostics.md#update-2026-07-23--the-run-report-is-a-sensitive-artifact)
for the reasoning and the known residual gaps.

Practical guidance:

- **Read the report before sharing it.** It is small and human-readable.
- Prefer pasting the specific fields a maintainer asked for — `outcome`,
  `exitCode`, `correlationId`, the failing `stage`, and the root cause's `name`
  and `code` — over the whole file. Those fields carry no free text.
- The **breadcrumb timeline** is held to a stricter standard: every event is
  summarized to named scalar fields before storage (header _names_ only, never
  values; importer record contents dropped entirely), so it is the safest part
  of the report to share wholesale.
- Store reports where you would store a crash dump, and prune
  `data/output/` accordingly.

**Redact before pasting anything else, too.** Raw config files, env dumps, and
hand-copied values pass through no redaction at all. Never include credentials,
tokens, account ids you consider sensitive, or customer data.

## See also

- [errors](../reference/core/errors.md) — error model and code catalog
- [logging](../reference/core/logging.md) — handlers, redaction, correlation
- [script](../reference/core/script.md) — lifecycle, signals, guards
- [diagnostics](../reference/core/diagnostics.md) — run reports, exit codes,
  breadcrumbs
- [Writing a script](./writing-a-script.md) · [Lambda handlers](./lambda-handlers.md)
- [ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md)
