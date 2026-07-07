# Architecture: `@m3l-automation/m3l-common`

---

## 1. System Overview

`@m3l-automation/m3l-common` (package name `@m3l-automation/m3l-common`) is a shared infrastructure library for every script, Lambda handler, and tool in the `m3l-automation` monorepo.

`packages/m3l-common/src/index.ts`: the package re-exports exactly two top-level namespace objects:

| Export | Source                                  | What it contains                                     |
| ------ | --------------------------------------- | ---------------------------------------------------- |
| `Core` | `packages/m3l-common/src/core/index.ts` | Application scaffolding, I/O, logging, UI, utilities |
| `AWS`  | `packages/m3l-common/src/aws/index.ts`  | AWS credential management and SDK client providers   |

`packages/m3l-common/package.json`: the `exports` map exposes three import paths — `.` (both namespaces via `index.ts`), `./core`, and `./aws` — so consumers can either use named namespaces or import sub-modules directly.

`packages/m3l-common/package.json`: the package is ESM-only (`"type": "module"`), compiled to `dist/` by `tsc -b`.

**Top-level shape:**

```text
packages/m3l-common/src/
├── index.ts                 ← package entry: exports Core + AWS
├── core/                    ← 19 sub-modules (application framework + utilities)
│   ├── index.ts             ← wildcard re-exports all sub-modules
│   ├── script/              ← M3LScript: CLI / Lambda entry-point framework
│   ├── config/              ← multi-source configuration
│   ├── environment/         ← runtime + deployment-mode detection
│   ├── errors/              ← M3LError, M3LResult<T,E>
│   ├── events/              ← type-safe event emitter
│   ├── logging/             ← M3LLogger + handlers
│   ├── prompt/              ← spinners, progress bars, interactive input
│   ├── importers/           ← CSV / JSON / text file parsing
│   ├── exporters/           ← CSV / JSON / HTML file writing
│   ├── files/               ← execution-directory file archival
│   ├── json/                ← field path navigation, format detection
│   ├── text/                ← multi-format text extraction (PDF, DOCX, etc.)
│   ├── storage/             ← SQLite FTS5 full-text search
│   ├── utils/               ← M3LPaths, concurrency pool, type guards, string utils
│   ├── network/             ← M3LHttpClient (undici)
│   ├── polling/             ← M3LPoller, M3LRetryRunner, M3LBackoff, classifiers
│   ├── analysis/            ← M3LThresholdEvaluator
│   ├── messaging/           ← abstract M3LMessenger interface
│   └── security/            ← prototype pollution guard
└── aws/                     ← credential management + client providers
    ├── index.ts
    ├── authentication/      ← M3LAWSCredentialsManager
    ├── clients/             ← AWSClientProvider, AWSMultiClientProvider
    └── models/              ← shared AWS model types
```

---

## 2. Module / Package Map

### 2.1 `packages/m3l-common/src/core`

#### `script` — CLI / Lambda entry-point framework

**Public surface** (`script/index.ts`): `M3LScript`, `M3LScriptOptions`, `M3LScriptMetadata`, `M3LScriptLifecycleHooks`, `M3LScriptHookContext`, `M3LScriptConfigLoader`, `M3LScriptPresetLoader`, `M3LPresetUnknownKeysError`, `installProcessGuards`, `serializeError`, `setProcessGuardRequestId`.

`script/M3LScript.ts`: `M3LScript` is instantiated with a single `M3LScriptOptions` object; it does not extend any base class. The constructor wires together config, logging, prompts, and AWS credential management.

`script/M3LScript.ts`: `run(mainFunction)` is the primary CLI entry point. It orchestrates initialization → config load → AWS credential check → user function → cleanup, and returns a `Promise<void>`.

`script/M3LScript.ts`: `createLambdaHandler<TEvent, TResult, TContext>()` wraps the same initialization pipeline in an AWS Lambda-compatible handler function. Per-invocation, the `initialized` and `configLoaded` flags are reset and the config store is cleared so each invocation starts clean. SDK clients are intentionally _not_ reset between invocations so connections are reused across warm starts — (no client teardown visible in the per-invocation reset block; only state flags and config are cleared).

`script/M3LScriptOptions.ts`: eight lifecycle hooks are available: `onBeforeInit`, `onAfterInit`, `onBeforeConfigLoad`, `onAfterConfigLoad`, `onBeforeRun`, `onAfterRun`, `onError`, `onCleanup`. Each receives a `M3LScriptHookContext` carrying the live config store.

`script/M3LScript.ts`: signal handlers (SIGTERM, SIGINT, SIGQUIT) are registered only in non-AWS environments; a second signal forces an immediate exit with code 1.

`script/M3LProcessGuards.ts`: `installProcessGuards()` is a process-global singleton that installs `unhandledRejection`, `uncaughtException`, `warning`, and `beforeExit` handlers. In Lambda, `setProcessGuardRequestId(requestId)` attributes guard-caught errors to the current invocation.

`script/M3LScriptPresetLoader.ts`: `M3LScriptPresetLoader` loads named parameter presets from YAML/JSON files. It enforces a max nesting depth of 64 (`MAX_PRESET_STRUCTURE_DEPTH`) and uses Damerau-Levenshtein distance for typo suggestions on unknown keys.

---

#### `config` — Multi-source configuration

**Public surface** (`config/index.ts`): `M3LConfig`, `M3LConfigReader`, `M3LConfigProvider`, `M3LConfigParameter`, `M3LConfigParameterType`, `M3LConfigSchema`, all provider classes, parsers, `M3LSecretsSpecifier`, `M3LUnknownParameterDetector`.

`config/M3LConfigReader.ts`: `M3LConfigReader` takes an ordered `ReadonlyArray<M3LConfigProvider>` and resolves values by walking providers in priority order.

`config/M3LConfigReader.ts`: `getRawValueForKeys(keys)` implements alias support: for each provider, all alias keys are tried before moving to the next lower-priority provider. This guarantees a higher-priority provider's alias always wins over a lower-priority provider's canonical key.

`config/M3LConfigParameter.ts`: `getValueAsync()` resolves a parameter's value in this order:

1. Provider value (via `M3LConfigReader`)
2. `defaultValue` (static, if defined)
3. `asyncFallback()` (called as an async function only if both above are absent)

`config/M3LConfigParameter.ts`: `M3LConfigParameterType` includes `STRING`, `INT`, `DOUBLE`, `BOOL`, `STRING_ARRAY`, `INT_ARRAY`, `DOUBLE_ARRAY`, `BUFFER`.

`config/M3LConfig.ts`: `M3LConfig.set(name, value, source?)` tracks the source of each resolved value (e.g., `'cli'`, `'env'`, `'file'`), exposed via `sourceOf(name)`.

Available providers: `M3LCommandLineConfigProvider`, `M3LJSONConfigProvider`, `M3LYAMLConfigProvider`, `M3LEnvironmentConfigProvider`, `M3LInMemoryConfigProvider`, `M3LLambdaEventConfigProvider`, and `M3LPresetConfigProvider`. (from `config/providers/` directory listing and `config/index.ts` re-exports).

---

#### `environment` — Runtime and deployment-mode detection

**Public surface** (`environment/index.ts`): `M3LExecutionEnvironment`, `M3LEnv`, `M3LExecutionEnvironmentType`, `M3LDeploymentMode`, `M3LCredentialSource`, `M3LExecutionEnvironmentInfo`, `M3LEnvironmentDetectionDetails`.

`environment/M3LExecutionEnvironment.ts`: `M3LExecutionEnvironment.detect()` returns a cached `M3LExecutionEnvironmentInfo`. `detectFresh()` forces re-detection.

`environment/M3LExecutionEnvironment.ts`: Monorepo detection walks upward from `cwd` searching for `pnpm-workspace.yaml` or a `package.json` with a `workspaces` field. If found, `deploymentMode` is `MONOREPO` and the root path is recorded. Otherwise `STANDALONE`.

`environment/M3LExecutionEnvironmentType.ts`: environment types: `LOCAL_INTERACTIVE`, `CI`, `AWS_LAMBDA`, `AWS_ECS`, `AWS_EC2`, `AWS_CODEBUILD`, `UNKNOWN`.

`environment/M3LCredentialSource.ts`: credential source types: `SSO_PROFILE`, `ENVIRONMENT`, `CONTAINER`, `INSTANCE_METADATA`, `WEB_IDENTITY`, `DEFAULT_CHAIN`, `NONE`.

`environment/M3LExecutionEnvironmentInfo.ts`: `M3LExecutionEnvironmentInfo` includes `isInteractive`, `isAWSManaged`, `canPromptUser`, `canOpenBrowser`, `requiresAwsProfile`, and a `detectionDetails` field exposing the raw signals (TTY flags, CI env vars, AWS metadata endpoint presence, etc.).

---

#### `errors` — Structured error handling

**Public surface** (`errors/index.ts`): `M3LError`, `M3LErrorOptions`, `M3LResult`, `M3LResultOk`, `M3LResultErr`, and the full set of `M3LErrorUtils` functions (`getErrorMessage`, `toError`, `wrapError`, `getErrorStack`, `hasErrorName`, `errorMessageContains`), plus `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `map`, `mapErr`, `andThen`, `fromPromise`, `tryCatch`.

`errors/M3LError.ts`: `M3LError` extends `Error` and adds `code` (string), `context` (arbitrary object), and a properly-typed `cause`. `toJSON()` serializes all fields including the stack.

`errors/M3LResult.ts`: `M3LResult<T, E>` is a discriminated union of `M3LResultOk<T>` and `M3LResultErr<E>`, modeled after Rust's `Result`. The `andThen`, `map`, `fromPromise`, and `tryCatch` operators enable chainable, exception-free error handling.

---

#### `events` — Type-safe generic event emitter

**Public surface** (`events/index.ts`): `M3LEventEmitterBase`, `M3LEventEmitter`, `M3LEventHandler`.

`events/M3LEventEmitterBase.ts`: `M3LEventEmitterBase<TEventMap>` is generic over an event-map type; `on<TEvent>()` and `off<TEvent>()` enforce typed handler signatures.

`events/M3LEventEmitterBase.ts`: `emit()` (protected) catches errors thrown by individual handlers so that one failing handler does not prevent others from running.

`events/M3LEventEmitterBase.ts`: `emitAsync()` (protected) awaits all handlers via `Promise.allSettled`, so a rejecting handler does not prevent others from running.

---

#### `logging` — Structured multi-handler logging

**Public surface** (`logging/index.ts`): `M3LLogger`, `M3LLogEvent`, `M3LLogEventCateM3Lry`, `M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`, `M3LJsonLoggerHandler`, `M3LTableFormatter`, `M3LTableOptions`, `M3LTableColumn`, `redactSensitiveLogText`, `redactSensitiveLogValue`.

`logging/M3LLogger.ts`: `M3LLogger` manages an ordered array of `M3LLoggerHandler` instances. It exposes typed methods: `text`, `step`, `info`, `success`, `warning`, `error`, `fatal`, `section`, `header`, `newline`, `table`, `simpleTable`, `keyValueTable`.

`logging/M3LLogEventCategory.ts`: nine categories — `TEXT`, `STEP`, `SUCCESS`, `ERROR`, `FATAL`, `WARNING`, `HEADER`, `INFO`, `SECTION`.

Three built-in handler implementations:

1. **`M3LConsoleLoggerHandler`** (`handlers/M3LConsoleLoggerHandler.ts`): writes to `process.stdout`/`process.stderr` with ANSI colors and indentation. Disables colors automatically in non-TTY contexts (Lambda, CI, pipe) to keep logs machine-readable — (color detection guard visible in handler initialization).

2. **`M3LFileLoggerHandler`** (`handlers/M3LFileLoggerHandler.ts`): streams to a file using a `M3LFileListExporter`. A sequential write queue is maintained internally to preserve ordering under concurrent emits — (queue pattern visible in file handler). The file handler's `reset()` is a no-op to prevent log loss across script resets — (`reset()` body is empty).

3. **`M3LJsonLoggerHandler`** (`handlers/M3LJsonLoggerHandler.ts`): emits one JSON line per event (one CloudWatch log entry per message). Scalar fields from the event's `data` payload are promoted to the top level of the JSON object for easy CloudWatch Insights querying. Empty spacer events are dropped — (drop condition visible in handler).

`logging/tableRenderer/TableChars.ts`: the table renderer uses Unicode box-drawing characters (`┌`, `─`, `│`, `├`, `┤`, `└`, `┐`, `┘`) for `full` border style, minimal characters for `border-less`, and empty strings for `compact`. (`logging/M3LTableFormatter.ts`): `M3LTableFormatter` supports per-column alignment and ANSI-aware width via `string-width`.

---

#### `prompt` — Interactive CLI UI

**Public surface** (`prompt/index.ts`): `M3LPrompt`, `M3LMultiSpinner`, `M3LMultiSpinnerOptions`, `M3LLoadingBar`, `M3LLoadingBarOptions`.

`prompt/M3LPrompt.ts`: `M3LPrompt` is a unified facade that composes a `M3LMultiSpinner`, a `M3LLoadingBar`, and an `@inquirer/prompts` adapter. The adapter is injected via constructor, enabling test mocking.

Prompt methods: `text`, `password`, `number` (with `min`/`max` validation), `confirm`, `select` (single-choice), `multiselect` (checkboxes), `autocomplete` (custom suggest function) — (method signatures visible in `M3LPrompt.ts`).

`prompt/M3LMultiSpinner.ts`: `M3LMultiSpinner` operates in two modes:

- **Multi-spinner**: tracks concurrent named tasks by ID via `.spin(id, text)`, `.spinSucceed(id, text)`, `.spinFail(id, text)`, `.spinWarn(id, text)`.
- **Single-spinner** (backward-compatible): `.startSpinner(message)`, `.updateSpinner(message)`, `.spinnerStop`, `.spinnerFail`.

`prompt/M3LMultiSpinner.ts` — environment check block): `M3LMultiSpinner` calls `M3LExecutionEnvironment.isInteractive()` and checks `process.stdout.isTTY` to decide between live ANSI-redrawn output (interactive terminal) and plain-text line output (Lambda, CI, pipe). ANSI color codes are stripped in non-interactive mode.

`prompt/M3LLoadingBar.ts`: `M3LLoadingBar` renders a progress bar with configurable fill characters (default `█`/`░`), accepting percentage updates (0–100) via `.update(percentage, message)`.

---

#### `importers` — Streaming file parsing

**Public surface** (`importers/index.ts`): `M3LFileImporter`, `M3LListImporter`, `M3LListImporterEvents`, `M3LListImporterResult`, `M3LCSVListImporter`, `M3LCSVListImporterOptions`, `M3LCSVFormatAdapter`, `M3LCSVAdapterFactory`, `M3LJSONFileImporter`, `M3LJSONListImporter`, `M3LJSONListImporterOptions`, `M3LFileListImporter`, `M3LTextFileImporter`.

`importers/csv/M3LCSVListImporter.ts` and `importers/json/M3LJSONListImporter.ts`: all list importers extend `M3LEventEmitterBase` and implement `M3LListImporter<TItem>`, which defines two access patterns:

- `import(source)` — batch: returns all items at once.
- `importStream(source)` — streaming: async generator yielding items one by one.

`importers/M3LListImporterEvents.ts`: the event map emits `import:started`, `import:item`, `import:progress`, `import:error`, and `import:completed`, typed to carry structured payloads (item, index, processed count, duration, etc.).

`importers/csv/M3LCSVListImporter.ts`: the CSV importer uses `csv-parse` under the hood, streams file input for file-path sources, and processes buffer input in memory. A transformation pipeline applies: column mapping → default values → row validator → row transformer.

`importers/json/M3LJSONListImporter.ts`: the JSON importer dispatches to JSON-array parsing or JSONL (newline-delimited JSON) line-by-line streaming based on detected format. Field paths (dot notation, e.g., `metadata.author`) are supported for extracting nested values.

(via `M3LJSONFormatDetector` reference in importers): format detection supports four levels of analysis — `extension`, `shallow` (first byte), `standard` (first N lines), and `deep` (sample middle/end) — returning `{ format: 'json' | 'jsonl' | 'unknown', confidence, method }`.

---

#### `exporters` — Streaming file export

**Public surface** (`exporters/index.ts`): `M3LFileExporter`, `M3LListExporter`, stream writer types, event types, `M3LCSVListExporter`, `M3LJSONListExporter`, `M3LJSONFileExporter`, `M3LHTMLListExporter`, `M3LBinaryFileExporter`, `M3LFileListExporter`, plus their option and event types.

`exporters/M3LListExporter.ts`: `M3LListExporter<TItem>` extends `M3LEventEmitterBase` and defines two modes:

- `export(items)` — batch: writes all items.
- `exportStream()` → `M3LListExporterStreamWriter<TItem>` — streaming: exposes `append(item)` and `close()`.

`exporters/csv/M3LCSVListExporter.ts`: the CSV exporter uses `csv-stringify` and an `fs.WriteStream`. When merging original row data, column conflicts are resolved by `ColumnConflictStrategy`: `'keep-generated'` or `'keep-original'`.

`exporters/json/M3LJSONListExporter.ts`: JSON exporter supports both JSON array format and JSONL; in streaming mode it writes `[` on open and `]` on close (or nothing for JSONL), inserting commas between items.

`exporters/html/M3LHTMLListExporter.ts`: HTML exporter uses a `{{count}}` / `{{items}}` / `{{date}}` template system with configurable column selection and ordering.

(event map visible in `exporters/` types): emits `export:started`, `export:completed`, `export:error`.

---

#### `files` — Execution-directory file archival

**Public surface** (`files/index.ts`): `M3LFileCopier`, `M3L_FILE_COPIER_DEFAULTS`, `getDefaultSubdirForPathType`, `M3LFileCopierOptions`, `M3LFileCopyResult`, `M3LFileCopySkipReason`, `M3LFileCopyReport`, `M3LFileCopyReportSummary`.

`files/M3LFileCopier.ts`: `M3LFileCopier` batches registered files for copy to an execution output directory. Files are registered with `registerFile(sourcePath, options)` and a subdirectory hint; `finalizeRegisteredFiles()` executes the copies and returns a `M3LFileCopyReport` with per-file results (size, destination, timestamp) and an overall summary.

`files/M3LFileCopier.ts`: size-based skip (`'size-too-large'`), overwrite control, optional manifest JSON generation, and interactive prompt thresholds for large files are all configurable via `M3LFileCopierOptions`.

---

#### `json` — JSON utilities

**Public surface** (`json/index.ts`): `parseFieldPath`, `navigateFieldPath`, `M3LJSONFieldExtractor`, `M3LJSONFormatDetector`, `M3LJSONFormat`, detection depth/options/result types.

`json/fieldPath.ts`: `parseFieldPath(path)` parses a dot-notation string into path segments; `navigateFieldPath(obj, path)` traverses nested objects and returns the value or `undefined`.

`json/M3LJSONFormatDetector.ts`: `M3LJSONFormatDetector.detect(filePath)` returns `{ format, confidence, method, details }`. Four detection depth levels trade speed for accuracy.

---

#### `text` — Multi-format text extraction

**Public surface** (`text/index.ts`): `M3LTextExtractorRegistry`, `M3LPlainTextExtractor`, `M3LPdfTextExtractor`, `M3LDocxTextExtractor`, `M3LXlsxTextExtractor`, `M3LEmailTextExtractor`, `M3LZipTextExtractor`, `ZIP_DEPTH_SYMBOL`, `M3LTextExtractor`, `M3LTextExtractionOptions`, `M3LTextExtractionResult`, `M3LTextExtractionError`.

`text/M3LTextExtractorRegistry.ts`: `M3LTextExtractorRegistry` dispatches `extract(mimeType, filePath, options)` calls to the first registered extractor that declares support for the MIME type. If no MIME match, falls back to file extension. First-registered wins on conflicts.

Extractors and their backing libraries — (import statements in each extractor file):

| Extractor               | Library                  | Notes                                                                          |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `M3LPlainTextExtractor` | Node `fs`                | Plain `.txt` files                                                             |
| `M3LPdfTextExtractor`   | `unpdf`                  | Serverless-safe, no native deps                                                |
| `M3LDocxTextExtractor`  | `mammoth`                | `extractRawText()` — images dropped                                            |
| `M3LXlsxTextExtractor`  | `read-excel-file`        | Per-sheet headers + tab-separated cells                                        |
| `M3LEmailTextExtractor` | `mailparser` + `cheerio` | Headers + plain-text body; HTML→text via cheerio                               |
| `M3LZipTextExtractor`   | `adm-zip`                | Text entries extracted directly; binary entries re-dispatched through registry |

`text/extractors/M3LZipTextExtractor.ts` — `ZIP_DEPTH_SYMBOL` usage): recursive ZIP dispatch is limited to depth 2 by default (via a `ZIP_DEPTH_SYMBOL` attached to the options object) to prevent zip-bomb amplification.

All extractors return `{ text: string, pages?: number, truncated: boolean }` — (`text/M3LTextExtractor.ts`).

---

#### `storage` — Full-text search index

**Public surface** (`storage/index.ts`): `M3LFtsIndex`, `M3LFtsIndexConfig`, `M3LFtsIndexDocument`, `M3LFtsIndexSearchMode`, `M3LFtsIndexSearchOptions`, `M3LFtsIndexSearchResult`, `M3LFtsIndexStats`, `M3LSqliteDatabase`, `M3LSqliteStatement`.

`storage/M3LFtsIndex.ts`: `M3LFtsIndex` wraps `better-sqlite3` (native synchronous SQLite) with an FTS5 virtual table. Schema:

- `<fts_table>` — FTS5 virtual table with columns `id UNINDEXED`, `content`, plus declared metadata columns.
- `<fts_table>_meta` — side table for metadata keyed by `id`.
- `_m3l_fts_meta(key, value)` — internal KV store for schema versioning and tokenizer config.

`storage/M3LFtsIndex.ts`: `upsert(document)` and `upsertMany(documents)` (wrapped in a transaction) add or update documents; `delete(id)` and `deleteMany(ids)` remove them.

`storage/M3LFtsIndex.ts`: two search modes — `'full-text'` (FTS5 `MATCH` with BM25 ranking and `snippet()` extraction) and `'literal'` (case-insensitive substring scan for tokens with punctuation like UUIDs). Prepared statements are cached by mode + filter-signature tuple for repeated-query performance.

`storage/M3LFtsIndex.ts` — tokenizer validation: the tokenizer string is validated before use to prevent SQLite injection. `getDatabase()` returns the raw `better-sqlite3` handle as an escape hatch for custom SQL.

---

#### `utils` — General utilities

**Public surface** (`utils/index.ts`): `M3LPaths`, `M3LPathType`, `M3LPathEnvironmentVariables`, `M3LConcurrencyPool`, `safeJsonStringify`, `valueToString`, `M3LDateTokens`, `formatBytes`, `smartTruncate`, `truncatePath`, `truncateText`, `isPath`, `formatConfigValueDisplay`, `formatConfigSourceDisplay`, type guards (`isNullish`, `isPrimitive`, `isError`, `isNodeError`, `isEnoentError`, `isPlainObject`, `isObject`, `isArray`, `isString`, `isNumber`, `isBoolean`, `isFunction`, `isDate`, `isValidDate`, `isBuffer`, `isMap`, `isSet`, `isRegExp`, `isSymbol`, `isBigInt`, `isPromise`, `isNonEmptyString`, `isNonEmptyArray`, `hasProperty`, `hasMessage`).

`utils/M3LPaths.ts`: `M3LPaths` resolves data, config, input, output, and cache directories relative to the detected deployment mode (monorepo root or standalone base dir). All directories are overridable via `M3L_DATA_DIR`, `M3L_CONFIG_DIR`, `M3L_INPUT_DIR`, `M3L_OUTPUT_DIR`, `M3L_BASE_DIR`, `M3L_DEPLOYMENT_MODE` environment variables. `getProjectRoot()` throws in standalone mode — (guard visible in method body).

`utils/M3LValueToString.ts` and `safeJsonStringify` in same file: `safeJsonStringify` handles circular references (via `WeakSet` tracking, returning `'[Circular]'`), depth limiting (default 10, returning `'[Max Depth]'`), and non-JSON-serializable primitives `BigInt` → string, `Symbol` → description, `Function` → `''`, `Map`/`Set` → JSON equivalents.

`utils/M3LConcurrencyPool.ts`: `M3LConcurrencyPool` limits concurrent async tasks via a slot-count FIFO queue. `runEach(items, worker)` consumes items on-demand as slots free (backpressure), so memory stays proportional to the pool limit, not to total item count.

`utils/M3LDateTokens.ts` and `M3LPaths.ts` usage: `M3LDateTokens` expands tokens such as `{YYYY}`, `{MM}`, `{DD}` in path templates to produce time-stamped output directories.

---

#### `network` — HTTP client

**Public surface** (`network/index.ts`): `M3LHttpClient`, `M3LHttpClientOptions`, `M3LHttpClientError`, event types.

`network/M3LHttpClient.ts`: `M3LHttpClient` extends `M3LEventEmitterBase` and wraps `undici` (`fetch` from the `undici` package). Configuration: `baseUrl`, `defaultHeaders`, `timeout` (default 30 s via `AbortController`), `debug` (structured request logging), `proxyUrl` (optional `ProxyAgent` for Charles/Proxyman debugging).

`network/M3LHttpClient.ts`: responses with `Content-Type` matching `/[/+]json\b/i` are automatically parsed as JSON. Non-2xx responses throw `M3LHttpClientError`. `getAbortable<T>()` returns `{ promise, abort() }` for cancellable requests.

---

#### `polling` — Polling and retry primitives

**Public surface** (`polling/index.ts`): `M3LPoller`, `M3LRetryRunner`, `M3LBackoff`, `M3LPollingPolicies`, `M3LPollCheckFn`, `M3LPollDecision`, `M3LRetryClassifier`, `M3LRetryDecision`, `M3LRetryAdvice`, `combineClassifiers`, `awsThrottlingClassifier`, `awsNetworkClassifier`, `httpRetryAfterClassifier`.

`M3LPoller` and `M3LRetryRunner` are two separate, orthogonal primitives:

|                    | `M3LPoller`                                                 | `M3LRetryRunner`                                                      |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| **Purpose**        | Poll _external state_ until it reaches a terminal condition | Re-execute _the same operation_ until it succeeds or exhausts retries |
| **Check function** | Returns `{ type: 'success' \| 'failure' \| 'continue' }`    | Throws on failure; classifier decides retry vs. fatal                 |
| **Typical use**    | Waiting for an async job to complete                        | Retrying on transient network/throttling errors                       |

`polling/M3LPoller.ts`: `poll<T>(check)` stores per-call backoff state inside the `poll()` stack frame, not on the `M3LPoller` instance. Concurrent `poll()` calls on the same instance are therefore isolated — (line comment `// per-run state` or equivalent isolation pattern in the method).

`polling/M3LRetryRunner.ts`: `M3LRetryRunner` feeds each thrown error through a `M3LRetryClassifier`, which returns `'retriable'`, `'fatal'`, or `'unknown'`. The `unknownDecision` option (default `'fatal'`) controls how unclassified errors are treated. A classifier can also return a `delayMs` override via `M3LRetryAdvice` for server-driven back-off (e.g., `Retry-After` headers).

`polling/classifiers/`: classifiers are pure functions composable via `combineClassifiers()` (first non-`'unknown'` decision wins).

- `awsThrottlingClassifier` — detects 16 AWS throttling/rate-limit error names plus transient 5xx codes.
- `httpRetryAfterClassifier` — maps HTTP status codes to retry decisions; respects `retryAfterMs` for server-driven delays.
- `awsNetworkClassifier` — detects network-level transient errors.

`polling/M3LPollingPolicies.ts`: pre-baked presets bind polling/retry parameters to concrete use cases (e.g., `athenaQuery()`, `cloudWatchLogsQuery()`, `awsThrottling()`, `httpDownload()`, `sqsBatchSend()`).

`polling/` — `M3LBackoff` usage: backoff strategies include `exponential(startMs, capMs)` and `exponentialJittered(startMs, capMs)` (decorrelated jitter) and `constant(delayMs)`.

---

#### `analysis` — Threshold evaluation

**Public surface** (`analysis/index.ts`): `M3LThresholdEvaluator`, `M3LThresholdRule`, `M3LThresholdRuleResult`, `M3LThresholdEvaluation`.

`analysis/M3LThresholdEvaluator.ts`: `M3LThresholdRule` carries: `name`, `field` (optional column name), `operator` (`>` `>=` `<` `<=` `==` `!=`), `value` (threshold), `aggregation` (`any-row` | `count` | `sum` | `avg` | `min` | `max`), `severity` (`info` | `warning` | `critical`).

`analysis/M3LThresholdEvaluator.ts`: `M3LThresholdEvaluator.evaluate(rules, rows)` applies each rule independently and returns a `M3LThresholdEvaluation` with overall `breached` boolean, human-readable `summary`, and per-rule `results`.

`analysis/M3LThresholdEvaluator.ts`: locale-aware numeric parsing handles comma-decimal formats (e.g., Italian locale `"1,5"` → `1.5`).

---

#### `messaging` — Abstract message interface

**Public surface** (`messaging/index.ts`): `M3LMessenger`, `M3LMessageWriter`, `M3LMessageReader`, `M3LOutboundMessage`, `M3LReceivedMessage`, `M3LMessageTarget`, `M3LMessageAuthor`, `M3LMessageReceipt`, `M3LInboundAttachment`, `M3LOutboundAttachment`.

`messaging/M3LMessenger.ts`: `M3LMessenger` wraps a `M3LMessageWriter` (required) and optional `M3LMessageReader` with a `defaultTarget` fallback. It provides `sendMessage(text, target?)`, `sendReport(template, data, attachments?, target?)` (with `{{ key }}` interpolation), and `sendError(errorMessage, error?, target?)`.

---

#### `security` — Prototype pollution guard

**Public surface** (`security/DangerousKeys.ts`): `isDangerousKey`, `formatUnsafeKeyLocation`.

`security/DangerousKeys.ts`: `isDangerousKey(key)` returns `true` for `'__proto__'`, `'constructor'`, and `'prototype'`. Used by the config module during object deserialization — (imported in `config/M3LConfigProvider.ts` or equivalent provider validation path).

---

### 2.2 `packages/m3l-common/src/aws`

#### Credential management — `M3LAWSCredentialsManager`

**Public surface** (`packages/m3l-common/src/aws/authentication/` and `packages/m3l-common/src/aws/index.ts`): `M3LAWSCredentialsManager`, `M3LAWSCredentialsManagerOptions`, `M3LAWSCredentialsErrorType`, `M3LAWSCredentialsErrorAnalysis`, `M3LAWSRetryContext`, `M3LAWSLoginResult`.

`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`: `M3LAWSCredentialsManager` manages AWS SSO credentials for one or more profiles.

`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`: SSO login is performed by spawning `aws sso login --profile=<name>` as a child process with `stdio: 'inherit'`, allowing the browser-based SSO flow to interact with the user's terminal. Timeout is configurable (default 120 s).

`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`: credential validation uses `@aws-sdk/client-sts` `GetCallerIdentityCommand` — this tests the actual credential resolution path, not just local file presence.

`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`: error analysis detects SSO expiry patterns via regex sets (6 patterns for expired session, additional patterns for invalid session and profile-not-found). `M3LAWSCredentialsErrorType` enum values: `SSO_SESSION_EXPIRED`, `SSO_SESSION_INVALID`, `CREDENTIALS_PROVIDER_FAILED`, `PROFILE_NOT_FOUND`, `UNKNOWN`.

`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`: retry logic wraps an AWS operation: on credential error, if recoverable and retries remain, the manager optionally prompts the user (interactive mode) then re-runs SSO login before retrying.

`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`: `ensureValidCredentialsMultiple()` validates multiple profiles in parallel (phase 1), separates valid from invalid profiles (phase 2), then executes SSO login _sequentially_ for invalid ones (phase 3) — parallel browser windows would be unusable.

---

#### Client providers — `AWSClientProvider`, `AWSMultiClientProvider`

`packages/m3l-common/src/aws/clients/AWSClientProvider.ts`: `AWSClientProvider` creates and lazily caches on first access AWS SDK clients for a single profile:

- Credential resolution: if a profile name is provided, uses `fromIni()` from `@aws-sdk/credential-provider-ini` (SSO-aware); otherwise falls back to the SDK default credential chain.
- `close()` destroys all cached clients.

`packages/m3l-common/src/aws/clients/AWSMultiClientProvider.ts`: `AWSMultiClientProvider` manages a map of `AWSClientProvider` instances keyed by profile name. Profiles are deduplicated on construction. `mapParallel<T>(fn)` executes an operation across all profiles in parallel; `mapParallelSettled<T>(fn)` collects per-profile results/errors without throwing.

`packages/m3l-common/src/aws/AWSProvider.ts`: `AWSProvider` is the facade exposed by `M3LScript` via `script.aws`. It lazily instantiates `AWSClientsProvider` (`clients` getter) and `AWSServiceProvider` (`services` getter) from a shared `AWSMultiClientProviderConfig`.

`packages/m3l-common/src/aws/AWSRegion.ts`: `AWS_REGION` defaults to `'eu-south-1'` (Milan) if unspecified.

---

## 3. Data Flow and State Management

### Script execution flow

```text
M3LScript.run(mainFn)
  1. M3LExecutionEnvironment.detect()         ← singleton; reads env vars + filesystem markers
  2. hooks: onBeforeInit → onAfterInit
  3. M3LScriptConfigLoader.load()             ← walks provider chain; resolves asyncFallbacks
  4. hooks: onBeforeConfigLoad → onAfterConfigLoad
  5. M3LAWSCredentialsManager.ensureValidCredentials()   ← only if aws.profile param defined
  6. hooks: onBeforeRun
  7. mainFn()                                ← user code
  8. hooks: onAfterRun → onCleanup
  9. M3LFileCopier.finalizeRegisteredFiles()  ← archives input/config files to output dir
```

`script/M3LScript.ts`: steps 1–9 correspond to the `run()` and `createLambdaHandler()` method bodies.

### Configuration resolution order

For each `M3LConfigParameter`, values are resolved in this priority order — (`config/M3LConfigParameter.ts`):

1. CLI args (`M3LCommandLineConfigProvider`)
2. JSON config file (`M3LJSONConfigProvider`)
3. YAML config file (`M3LYAMLConfigProvider`)
4. Environment variables + `.env` (`M3LEnvironmentConfigProvider`)
5. Lambda event payload (`M3LLambdaEventConfigProvider`, Lambda only)
6. Preset file (`M3LPresetConfigProvider`)
7. `defaultValue` (static literal)
8. `asyncFallback()` (async function, called only when all above are absent)

### State locations and lifecycle

| State                                           | Owner                                                  | Lifecycle                                                           |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Lifecycle flags (`initialized`, `configLoaded`) | `M3LScript` instance                                   | Reset per Lambda invocation                                         |
| Config store (`M3LConfig`)                      | `M3LScript` instance                                   | Cleared per Lambda invocation                                       |
| SDK client cache                                | `AWSClientProvider`                                    | Persists across Lambda invocations (intentional — connection reuse) |
| Environment detection result                    | `M3LExecutionEnvironment` static                       | Process-global singleton; `detectFresh()` to refresh                |
| Backoff / attempt counter                       | `M3LPoller.poll()` / `M3LRetryRunner.run()` call frame | Per-call; concurrent calls on same instance are isolated            |

`script/M3LScript.ts`: Lambda reset clears `initialized`, `configLoaded`, and the config store; does not tear down client providers.

### I/O flow for file processing

```text
Importers (CSV / JSON / text)
  ─── streaming ──→ EventEmitter events (import:item, import:progress, import:error)
                          ↓
                    user code (transform, validate, accumulate)
                          ↓
Exporters (CSV / JSON / HTML)
  ─── streaming ──→ fs.WriteStream → output file
```

Both importers and exporters expose a batch API (`import()` / `export()`) and a streaming API (`importStream()` / `exportStream()`) — (`importers/M3LListImporter.ts` and `exporters/M3LListExporter.ts` interfaces).

---

## 4. Key Abstractions and Design Patterns

### 4.1 `M3LScript` — lifecycle framework

`M3LScript` is the single entry point for consumer automation scripts and Lambda handlers. It is not subclassed; consumer code passes a `M3LScriptOptions` object (metadata, config schema, hooks, logging options) and calls `run(async () => { ... })`.

The framework handles: environment detection, config loading with provider chain, AWS credential validation, ANSI-aware logging to up to three simultaneous sinks, interactive prompts or TTY-free equivalents, graceful signal shutdown, process fault guards, and file archival — all without any boilerplate in consumer code.

### 4.2 Multi-source config provider chain

`M3LConfigReader` walks `ReadonlyArray<M3LConfigProvider>` in declared priority order. Alias support is non-trivial: `getRawValueForKeys(keys)` exhausts _all_ alias keys within _one_ provider before moving to the next — (`config/M3LConfigReader.ts`). This ensures that a CLI `--alias-name` always wins over a JSON file's canonical `canonical.name`, even if the CLI provider is checked first.

### 4.3 Async parameter fallback

`asyncFallback` on a `M3LConfigParameter` enables lazy I/O defaults: load a local file, call an API, or read from a secret manager — but only when no provider or static default supplies a value. This makes `getConfiguration<T>()` an `async` method — (`config/M3LConfigParameter.ts`).

### 4.4 Type-safe event emitter

`M3LEventEmitterBase<TEventMap>` is parameterized by an event-name → payload type map. `on<TEvent>()` and `emit<TEvent>()` enforce that handler signatures match the declared payload type. Importers, exporters, `M3LHttpClient`, and messaging adapters all extend it. Handler errors are isolated — one failing handler does not affect others — (`events/M3LEventEmitterBase.ts`).

### 4.5 `M3LResult<T, E>` — explicit error propagation

Rather than catching and re-throwing, code that may fail can return `M3LResult<T, E>`. The `andThen`, `map`, `fromPromise`, and `tryCatch` operators chain operations without nested try/catch. `unwrap()` converts back to an exception when needed at a boundary — (`errors/M3LResult.ts`).

### 4.6 `M3LPoller` vs. `M3LRetryRunner` — two distinct retry primitives

Both primitives keep backoff state _per call_ (inside `poll()` / `run()`), not on the instance. Two concurrent callers sharing one `M3LPoller` instance do not interfere — (per-call isolation pattern in both files).

`M3LPoller` is for _checking external state_ (has an async job finished?). `M3LRetryRunner` is for _retrying a failed operation_ (can we re-send after a throttle?). They compose naturally: Athena query execution uses `M3LPoller` to wait for query completion after the initial submission.

### 4.7 Classifier-driven retry

`M3LRetryClassifier` separates the retry _policy_ from the retry _mechanism_. Classifiers are pure functions composable via `combineClassifiers()`. Pre-baked classifiers (`awsThrottlingClassifier`, `httpRetryAfterClassifier`, `awsNetworkClassifier`) each handle a narrow concern and return `'unknown'` for everything else, making them safe to combine without overlap — (classifier implementations and `combineClassifiers` in `polling/classifiers/`).

### 4.8 Handler composition in logging

`M3LLogger` delegates to an ordered array of `M3LLoggerHandler`. Adding JSON output for CloudWatch means passing `[new M3LConsoleLoggerHandler(), new M3LFileLoggerHandler(...), new M3LJsonLoggerHandler()]` at construction — no subclassing needed. Each handler independently decides how to render each `M3LLogEvent` — (`logging/M3LLogger.ts` and handler constructors).

### 4.9 Environment-aware rendering

`M3LMultiSpinner` and `M3LConsoleLoggerHandler` both consult `M3LExecutionEnvironment.isInteractive()` and `process.stdout.isTTY` to choose between ANSI-rich live output and plain-text line-by-line output suitable for Lambda/CI log capture — (guard conditions in both files).

### 4.10 Deployment-mode path resolution

`M3LPaths` produces different directory layouts depending on whether the script runs inside the monorepo or as a standalone deployment (Podman container, Lambda, etc.) — (`utils/M3LPaths.ts`). All directories are overridable via `M3L_*` env vars, documented in the `M3LPathEnvironmentVariables` type.

Monorepo layout:

```text
m3l-automation/
  data/{workload-name}/
    config/ · input/ · output/{timestamp}/ · cache/
```

Standalone layout:

```text
{baseDir}/data/
  config/ · input/ · output/{timestamp}/ · cache/
```

### 4.11 Text extractor registry

`M3LTextExtractorRegistry` decouples format detection from extraction logic. A single `extract(mimeType, filePath, options)` call dispatches to the correct library without the caller knowing which one. The ZIP extractor recurses through archives with a depth cap (`ZIP_DEPTH_SYMBOL`, max 2) to resist zip-bomb amplification — (`text/extractors/M3LZipTextExtractor.ts`).

### 4.12 SQLite FTS5 full-text index

`M3LFtsIndex` provides an embedded, zero-network full-text search capability backed by SQLite's FTS5 extension via `better-sqlite3`. It is appropriate for in-process search over thousands to low-millions of documents. Prepared statements are cached by (mode, filter-signature) so repeated searches with the same filter do not re-compile SQL — from the caching pattern visible in `M3LFtsIndex.ts`; the exact cache key structure is an implementation detail not independently confirmed to a specific line.

---

## 5. External Dependencies and Integration Points

### AWS SDK v3 (credential layer)

| Package                            | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `@aws-sdk/client-sts`              | `GetCallerIdentityCommand` for credential validation |
| `@aws-sdk/credential-provider-ini` | `fromIni()` for SSO profile resolution               |

### File parsing

| Package                       | Used by                                     | Availability          |
| ----------------------------- | ------------------------------------------- | --------------------- |
| `csv-parse` / `csv-stringify` | `M3LCSVListImporter` / `M3LCSVListExporter` | Runtime               |
| `yaml`                        | `M3LYAMLConfigProvider`                     | Runtime               |
| `unpdf`                       | `M3LPdfTextExtractor`                       | Optional (peer, lazy) |
| `mammoth`                     | `M3LDocxTextExtractor`                      | Optional (peer, lazy) |
| `read-excel-file`             | `M3LXlsxTextExtractor`                      | Optional (peer, lazy) |
| `mailparser` + `cheerio`      | `M3LEmailTextExtractor`                     | Optional (peer, lazy) |
| `adm-zip`                     | `M3LZipTextExtractor`                       | Optional (peer, lazy) |

### Storage

| Package          | Used by                                           |
| ---------------- | ------------------------------------------------- |
| `better-sqlite3` | `M3LFtsIndex` (native synchronous SQLite binding) |

### UI

| Package             | Used by                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `@inquirer/prompts` | `M3LPrompt` (interactive CLI input)                                      |
| `string-width`      | `M3LTableFormatter` (ANSI-aware column width)                            |
| `undici`            | `M3LHttpClient` (HTTP client; optional `ProxyAgent` for proxy debugging) |

### Date / time

| Package | Used by                                                |
| ------- | ------------------------------------------------------ |
| `luxon` | `M3LDateTokens` (date-token expansion in output paths) |

### External I/O patterns

- **AWS SSO login** — `M3LAWSCredentialsManager` spawns `aws sso login --profile=<name>` with `stdio: 'inherit'` so the browser-based SSO flow appears in the user's terminal — (`packages/m3l-common/src/aws/M3LAWSCredentialsManager.ts`).
- **Outbound HTTP** — `M3LHttpClient` makes calls via `undici` with optional `ProxyAgent` for local proxy debugging tools — (`network/M3LHttpClient.ts`).

### Container / Lambda deployment notes

`M3LPaths` and `M3LExecutionEnvironment` together handle the monorepo-vs-standalone distinction. For Podman or Lambda deployments, setting `M3L_DEPLOYMENT_MODE=standalone` and `M3L_BASE_DIR=/app` (or `/tmp` in Lambda) is the recommended approach. `createLambdaHandler()` in `M3LScript` resets per-invocation state while keeping SDK connections warm — (`script/M3LScript.ts` and `script/M3LScript.ts`).

---
