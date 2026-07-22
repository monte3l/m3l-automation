# Troubleshooting and debugging

How to diagnose a failing script or library error: triage the failure by
origin, read the diagnostic surfaces (errors, logs, exit codes, run archives),
turn on debug output, attach a debugger, and file a failure report that can be
acted on.

Some mechanisms below ship with the
[ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) rollout and are
marked **(ADR-0035)** — the surrounding workflow applies today; those specific
surfaces land phase by phase. Everything else is available now.

## 1. Triage: whose failure is it?

Every built-in error carries a stable `code` (see the
[error-code catalog](../reference/core/errors.md#error-code-catalog)) and —
**(ADR-0035)** — an `origin` field. Classify first, then act:

| `origin`   | It means                                                    | You should                                                                                                                    |
| ---------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `caller`   | The script or its configuration is wrong                    | Fix the script/config: check the parameter named in `context`, the config resolution order, the API contract in the reference |
| `external` | An external system (AWS, HTTP endpoint, remote job) failed  | Check the external system's status/permissions/limits; often retryable — see the catalog's `retryable` column                 |
| `library`  | An internal invariant of `@m3l-automation/m3l-common` broke | File a [failure report](#7-filing-a-failure-report) — this is a library bug                                                   |

Until `origin` ships, the same triage works through the code itself: config and
validation codes (`ERR_CONFIG_*`, `ERR_PRESET_*`, argument validation) are
caller-side; AWS/HTTP/poll codes (`ERR_S3_OPERATION`, `ERR_HTTP_REQUEST`,
`ERR_POLL_EXHAUSTED`, …) are external; anything the catalog marks `library` —
or any crash with no `M3LError` in its chain originating inside the package —
is a library issue.

Walk the whole chain, not just the top error: failures are chained through
`cause` (`wrapError`), and the _root_ cause usually carries the actionable
code. **(ADR-0035)** `formatErrorChain(error)` prints the full chain with
stacks; until then, inspect `error.cause` recursively (each `M3LError`
serializes via `toJSON()`).

## 2. Exit codes

Today every failure exits with Node's default code `1` (`M3LScript.run()`
re-throws; nothing maps codes). **(ADR-0035)** scripts composed through
`runScript()` produce the registry codes:

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

Each script run archives its inputs under a timestamped directory (created by
stage 9 of the [lifecycle](../reference/core/script.md#execution-flow)):

```text
data/output/<timestamp>/
├── input/    # snapshot of data/input at run time
├── config/   # snapshot of data/config at run time
└── run-report.json   # (ADR-0035) outcome, exit code, timeline, failure chain
```

- The base directory is `data/output/` at the monorepo root (or
  `$M3L_BASE_DIR/output` standalone; `M3L_OUTPUT_DIR` overrides — see the
  [environments and paths guide](./environments-and-paths.md)).
- **Today** archival runs only on the success path — a failed run leaves no
  archive. **(ADR-0035)** the failure path always writes `run-report.json`
  (outcome, failing stage, full serialized cause chain, breadcrumb timeline,
  environment snapshot), so the artifact exists precisely when you need it.
- Retention is yours: the library never prunes `data/output/`. Prune by
  timestamp directory.

To reconstruct a failed run today: pair the console/file/JSON log output (with
its `correlationId`) with the input/config files as they were at run time — if
the run succeeded far enough to archive — or re-run with debug output (§4).

## 4. Turning on debug output

**Today** the logger has no level filtering — every event reaches every
handler; "debug output" means adding log calls or handlers. **(ADR-0035)**:

- `M3L_DEBUG=1` — one-switch debug mode: drops the level floor to `DEBUG` and
  surfaces the library's own diagnostic events (breadcrumbs, timings).
- `M3L_LOG_LEVEL=<level>` / `--log-level <level>` / `--debug` — the same floor
  via the standard config precedence chain (CLI > env > config file >
  default).
- `logger.errorFrom(error)` — logs an error with code, context, and the full
  cause chain as structured fields.
- `collectDiagnostics()` — an on-demand redacted snapshot (environment, paths,
  config fingerprint) worth exposing behind a `--diagnostics` flag.

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

**(ADR-0035)** `runScript(script, mainFn, { dryRun: true })` (or `--dry-run` in
refreshed script templates) validates environment, configuration, and AWS
credentials — stages 1–5 — without executing `mainFn`: the fastest way to
separate "my config/credentials are wrong" from "my logic is wrong".

## 7. Filing a failure report

Use the **Failure report** issue form (`.github/ISSUE_TEMPLATE`), which mirrors
this guide's triage. Have ready:

1. The error `code` (and `origin` once available) of the **root** cause.
2. The exit code and how the script was invoked.
3. The `correlationId` of the failing run.
4. Environment: package version, Node version, OS, standalone vs monorepo vs
   Lambda.
5. The cause chain (stacks included) and — **(ADR-0035)** — the
   `run-report.json` from `data/output/<timestamp>/`.

**Redact before pasting.** Log output passes the library's redaction helpers,
but raw config files, env dumps, and hand-copied values do not. Never include
credentials, tokens, account ids you consider sensitive, or customer data.

## See also

- [errors](../reference/core/errors.md) — error model and code catalog
- [logging](../reference/core/logging.md) — handlers, redaction, correlation
- [script](../reference/core/script.md) — lifecycle, signals, guards
- [diagnostics](../reference/core/diagnostics.md) — run reports, exit codes,
  breadcrumbs **(ADR-0035)**
- [Writing a script](./writing-a-script.md) · [Lambda handlers](./lambda-handlers.md)
- [ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md)
