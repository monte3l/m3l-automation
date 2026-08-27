# m3l CLI (`packages/m3l-cli`)

The script-facing CLI activated by ADR-0042 (issue #333): discovery,
introspection, and guided execution over the `configParameters` seam every
`scripts/*` package declares in `src/config.ts`. Private, unpublished, and
zero-_third-party_-dependency — every declared `dependencies` entry is a
`@m3l-automation/*` workspace package pinned to `workspace:*` (the library,
`@m3l-automation/m3l-common`, plus one entry per `scripts/*` package since
ADR-0054/U7 — see "Dependency-graph discovery" below); everything else is
`node:` builtins.

Invocation: `pnpm m3l <command>` from the workspace root (a root
`package.json` script wrapping `packages/m3l-cli/bin/m3l.mjs` — the package
is nobody's dependency, so its `bin` entry is not linked into the root
`node_modules/.bin`).

This page is the CLI's contract. It grows one section per shipped phase
(ADR-0042 phasing 8b–8g); commands not yet listed here are not yet built.

## Design invariants

- **Zero third-party runtime dependencies.** Arg parsing is `node:util` `parseArgs`
  (per-command dispatch off the first positional — parseArgs has no native
  subcommand support); colors are `util.styleText` behind a TTY/`NO_COLOR`/
  `FORCE_COLOR`-aware output layer; interactive UI (later phases) is
  `Core.M3LPrompt` and friends. Enforced at source level by an ESLint
  import-boundary block and structurally by `check:zones`.
- **Dist-first discovery.** A script's `configParameters` are loaded from
  `scripts/<name>/dist/config.js` (tsc output) when present, falling back to
  native type-stripping of `src/config.ts` only when `dist` is absent or
  stale. The fallback cannot execute type-directed emit, so an ESLint zone
  bans `enum`/runtime `namespace`/decorators/parameter properties in every
  `scripts/*/src/config.ts` (see the ADR-0042 update for the `json-etl`
  counter-example that forced dist-first).
- **Dependency-graph discovery, filesystem fallback (ADR-0054, U7).**
  `packages/m3l-cli/package.json` declares every `scripts/*` package as a
  real `dependencies` entry (alongside `@m3l-automation/m3l-common`, the
  library — excluded from discovery, since it is not a script); script
  discovery resolves each declared script package via Node's own module
  resolution over that declared graph
  (`createRequire(...).resolve("@m3l-automation/<name>/package.json")`)
  rather than scanning `<workspaceRoot>/scripts/*` on disk — the property
  that makes publishing the CLI and fleet independently of a shared
  `scripts/` directory possible (ADR-0057). The filesystem scan still runs
  and fills in anything the graph didn't resolve (a script not yet declared
  as a CLI dependency), with the graph's answer winning on a name collision.
  A declared dependency that fails to resolve (`pnpm install` not yet run)
  is tolerated — `discoverScripts` falls through to the filesystem scan for
  it, and `m3l doctor`'s `dependency-graph` row names it (`warn`, never
  `fail`).
- **Lazy, cached discovery.** Static commands (`help`, `--version`) never pay
  the discovery cost. Discovery results are cached under the directory named
  by the `M3L_CACHE_DIR` environment variable (the same override `M3LPaths`
  honors) or, when unset, `<workspaceRoot>/data/cache` — keyed on both
  `src/config.ts` and `dist/config.js` mtimes; cache read/write is
  best-effort and never fatal. (The CLI resolves this path itself rather
  than constructing `M3LPaths`, whose singleton environment detection would
  defeat the CLI's injectable-`cwd` testability.)
- **Named errors, mapped exits.** Failures surface as `M3LCliError`
  (extending `Core.M3LError`, always cause-chained) — never a raw stack — and
  each one maps to a process exit code through a `Record` keyed by the full
  `M3LCliErrorCode` union, so a new error code cannot be added without an
  explicit exit-code decision for it. The mapping is
  [§Exit codes](#exit-codes).
- **Import-inert modules.** No `src` module executes anything at import time;
  the only process entry is the `bin/m3l.mjs` wrapper, which calls
  `runCli(argv)` and assigns its resolved number to `process.exitCode`.
- **Allowlisted machine surface.** `run <script> --json` emits exactly one
  result envelope on stdout carrying allowlisted scalars only — never the
  run report's own content. ADR-0035 classifies that report as a sensitive,
  crash-dump-class artifact: it is referenced by path and summarized by
  allowlist, never re-emitted. Emission is read-tolerant — an absent or
  unreadable report yields a named `reportUnavailable` reason, never a crash
  and never a fabricated outcome ([§V2 — structured run results](#v2--structured-run-results)).
- **Spawn stays default; in-process is opt-in (ADR-0054, U7).** The dynamic
  per-script dispatch (`m3l <script> --in-process ...`) can run a script that
  exports `commandModule` (`dist/command.js`) directly inside the CLI's own
  process instead of spawning `dist/main.js` as a child — see
  [§Phase 8d](#phase-8d--per-script-dynamic-subcommands). `run <script>` and
  `wizard` do not offer this opt-in; they always spawn.

## Commands

### Phase 8b — discovery + introspection

#### `m3l list`

Enumerates every `scripts/*` package: name, description (from the package
manifest), and declared parameter count. Reads through the discovery cache;
a script whose config cannot be loaded is listed with its load error noted
rather than aborting the whole listing.

Flags: `--json` (machine-readable array on stdout, no styling).

Exit: `0` on success (including "some configs unloadable"); `1` only when
discovery itself is impossible (e.g. workspace root not found).

#### `m3l inspect <script>`

Prints one script's declared parameter table via the `M3LConfigParameter`
getters: name, aliases, type, required, default, description. An unknown
`<script>` exits `2` with Damerau–Levenshtein suggestions (via
`Core.M3LUnknownParameterDetector`) over the known script names.

For every parameter that declares an operation set (ADR-0055's
`Core.M3LOperationDeclaration`, U4), an additional `Operations
(--<parameterName>)` table follows the parameter table — columns
`OPERATION` / `DESCRIPTION` / `REQUIRES` (a comma-joined list of any
other parameter names the operation needs), one row per declared
operation, in declaration order. The heading names the selector
parameter itself, since it is not always called `operation` (`sqs-etl`
and `api-gateway-client` call theirs `command`). No table renders for a
parameter that declares no operations. A declared `Core.M3LConfigParameter`
rejects a malformed operation set at construction (the config module
fails to import, surfacing as `inspect`'s existing `1` config-load-failure
exit); only a duck-typed or stale config export whose `getOperations()`
is absent, non-callable, throws, or returns a malformed shape degrades
tolerantly to no table for that parameter.

Flags: `--json` (machine-readable descriptor on stdout; every parameter
carries an `operations` array — `[]` when none is declared, otherwise
one `{ name, description, requiredParameters }` object per operation).

Exit: `0` success; `2` unknown script; `1` config load failure (the named
`M3LCliError` reason is printed, e.g. an unbuilt script whose `src/config.ts`
needs type-directed emit).

#### `m3l help` / `m3l --version`

Hand-written usage text (parseArgs generates none) and the package version.
Never trigger discovery.

### Phase 8c — execution

#### `m3l run <script> -- [args...]`

Spawns the named script's built entry (`scripts/<name>/dist/main.js`) via
`process.execPath` with `--env-file-if-exists=.env`, `cwd` set to the
script's directory, and `stdio: "inherit"` — the terminal belongs to the
child. Everything after the **first bare `--`** passes through verbatim
(never parsed by the CLI's own flag handling). No config load and no cache
involvement on the spawn path — `run` only needs discovery to resolve the
script directory. (`run <script> --help`/`-h` is the one exception — see
below.)

Exit: the **child's exit code verbatim**, signals included — see
[§Exit codes](#exit-codes). CLI-side failures on the spawn path: `2` unknown
script (with suggestions) or missing `<script>` positional; `1` script not
built (`ERR_CLI_SCRIPT_NOT_BUILT`, message names `pnpm build`) or spawn
failure (`ERR_CLI_SPAWN_FAILED`, cause-chained).

`run <script> --help`/`-h` renders the same per-script parameter table as
`inspect <script>` — the dynamic form's own `--help`/`-h` redirect (below),
extended to the canonical `run` form so the two invocations no longer
diverge (V2, ADR-0063). This redirect delegates to `inspect`, so it **does**
load config and read the discovery cache — the "no config load, no cache"
statement above covers only the spawn path. Its CLI-side failures follow
`inspect`'s, not the spawn path's (e.g. an unbuilt or malformed script fails
`ERR_CLI_CONFIG_IMPORT`, exit `1` — never `ERR_CLI_SCRIPT_NOT_BUILT`, which is
spawn-path only). `run --help` with no `<script>` positional still prints the
generic usage block; `run <script> -- --help` still passes `--help` through
to the child verbatim, unaffected.

### Phase 8d — per-script dynamic subcommands

#### `m3l <script> [--param value ...] [-- args...]`

Any first positional that is not a static command resolves through
discovery: an exact script-name match builds a per-script `parseArgs`
configuration from the script's declared `configParameters` (BOOL →
boolean flag; STRING_ARRAY → repeatable; every other type → string; each
alias maps back to its canonical name), parses the pre-`--` flags strictly,
translates the parsed values back to canonical `--name=value` child argv in
declaration order, and delegates to the 8c spawn path — with anything after
the first bare `--` appended verbatim.

- Static commands always win the dispatch (and the reserved-name list keeps
  future scripts from shadowing them); `run <script>` remains the canonical
  unambiguous form.
- `m3l <script> --help` renders the same parameter table as
  `inspect <script>` — no spawn — including its per-parameter
  `Operations (--<parameterName>)` table (U8) when the script declares any.
- `--json` is CLI-reserved: the **exact `--json` token** (not `--json=value`)
  is stripped before the script's own strict `parseArgs` ever sees it, and is
  never forwarded to the spawned child. For a script that declares no `json`
  parameter, or declares it as BOOL, this is transparent shadowing — the
  same treatment `--help`/`-h` already get. `--json=value` is **not**
  recognized by this stripping and reaches `parseArgs` like any other
  undeclared flag — it still fails `ERR_CLI_UNKNOWN_PARAMETER` (or
  `ERR_CLI_INVALID_PARAMETER_VALUE` for a declared BOOL). A script that
  declares `json` as a value-taking parameter (STRING/INT/STRING_ARRAY) is
  **not** safely shadowed: a bare `--json` still strips, but the value that
  would have followed it is left as an unexpected bare positional and fails
  (an empty-named `ERR_CLI_UNKNOWN_PARAMETER`). A script that genuinely needs
  to receive the literal `--json` token gets it via `-- --json` (V2,
  ADR-0063). Today `--json` only changes behavior through the `--help`/`-h`
  redirect above and below (`m3l <script> --json --help` renders `inspect`'s
  machine-readable descriptor instead of the human table); on the spawn path
  it has no observable effect yet — the allowlisted-scalar run-result
  envelope is a separate, later V2 slice.
- An unrecognized flag exits `2` with `ERR_CLI_UNKNOWN_PARAMETER` and
  Damerau–Levenshtein suggestions over the script's declared parameter
  names; a BOOL flag given a value (`--verbose=true`) exits `2` with
  `ERR_CLI_INVALID_PARAMETER_VALUE` naming the parameter; an unknown first
  positional exits `2` with suggestions spanning static commands and script
  names; colliding declared names/aliases fail loud with
  `ERR_CLI_CONFIG_IMPORT`.
- **`--in-process` opts into running the script in the CLI's own process
  instead of spawning (ADR-0054, U7).** Reserved exactly like `--json` — the
  exact `--in-process` token is stripped before the script's own strict
  `parseArgs` ever sees it, so a script that happens to declare its own
  same-named parameter is shadowed the same way. When present, the CLI
  resolves `<script>/dist/command.js`, validates its `commandModule` export,
  and calls its `execute` directly with the parsed parameter values bound
  (typed, not re-serialized to argv — a `STRING_ARRAY` parameter's repeated
  values are joined into one comma-separated string, matching what the
  library's own config coercion expects) rather than spawning
  `dist/main.js`. `--dry-run` is not a declared parameter on either
  execution path; on `--in-process` it is detected from the tokens after the
  first bare `--` (the same place a spawn-path caller already puts it,
  `m3l <script> [params] -- --dry-run`), since there is no child process argv
  for the script to read on its own. Cancellation forwarding
  (`context.signal`) is wired as a port only — it is always `undefined` in
  this slice, since no in-process host yet owns process signals; real
  Ctrl-C → `AbortSignal` wiring is issue tracker item U11's job, which
  depends on this seam existing first. A script that has not adopted the
  ADR-0054 seam (no `dist/command.js`, or an invalid export) exits `1`
  (`ERR_CLI_COMMAND_MODULE_INVALID`); a script whose `dist/command.js` exists
  but fails to import exits `1` (`ERR_CLI_COMMAND_MODULE_IMPORT_FAILED`,
  cause-chained); `execute` itself throwing or resolving a malformed outcome
  exits `1` (`ERR_CLI_IN_PROCESS_FAILED`, cause-chained where applicable).
  `m3l doctor` reports each discovered script's command-module availability
  as its own `command-module:<name>` row (`ok`/`warn` only, never `fail` —
  absence is expected for a script that has not adopted the optional seam;
  see [§Phase 8e](#phase-8e--diagnostics)).

### Phase 8e — diagnostics

#### `m3l doctor`

Renders one aligned row per check (`CHECK` / `STATUS` / `DETAIL`, statuses
`ok` / `warn` / `fail`; `--json` for the machine-readable array):
Node floor (≥ 24), workspace root, a `dependency-graph` row (ADR-0054, U7 —
how many of the CLI's declared `@m3l-automation/*` script dependencies
resolved via `createRequire`; `ok` when all resolve, `warn` — never `fail` —
naming any that don't, e.g. after adding a script dependency without running
`pnpm install`; a collaborator failure inside this check itself also
degrades to `warn` rather than aborting the rest of the run), one
`script:<name>` row per discovered
script (dir shape → fail when neither config exists; dist freshness → warn
naming `pnpm build`; importability through the real loader → fail with the
load-error message; all-green renders the parameter count) immediately
followed by that script's own `command-module:<name>` row (ADR-0054, U7 —
whether `dist/command.js` exports a usable in-process `commandModule`; `ok`
when valid, `warn` when absent or malformed, **never** `fail` — the seam is
optional, and most fleet scripts have not adopted it; a malformed export's
underlying error is never rendered into `detail`, only a fixed, safe
message, since `dist/command.js` may be script-controlled content), reserved-
name collision audit, and cache health (parent-dir writability, cache-file
integrity — an invalid file warns "will be rebuilt", an absent one is ok).

Exit: `1` iff any check is `fail` (`warn` never affects the code); `0`
otherwise. An unhealthy workspace is a doctor _result_ — only doctor's own
infrastructure failing throws (`ERR_CLI_DOCTOR_FAILED`, cause-chained).

### Phase 8f — presets + history

#### `m3l presets <script>`

Lists every preset file under `data/config/presets/` (`.json`/`.yaml`/
`.yml`), validating each against the script's declared schema via
`Core.M3LScriptPresetLoader`: one row per file — NAME / FORMAT /
PARAMETERS / STATUS — where PARAMETERS shows the preset's **key names
only, never values** (preset files may hold secrets), and an invalid
preset renders its load-error summary as a row rather than aborting.
Unknown script exits `2` with suggestions; empty listing is ok (exit 0).

#### `m3l history`

Renders the run history — TIME / SCRIPT / PARAMETERS / EXIT — recorded
best-effort after every `run`/dynamic spawn. Entries carry the script
name, the parsed canonical **parameter names** (dynamic form; `run`
records none since it never parses), the child exit code, and a
timestamp — **never values** (the entry type cannot carry them). Bounded
ring buffer (cap 100) persisted beside the discovery cache
(`<cacheDir>/m3l-cli/history.json`); recording and reading are
best-effort and never affect an exit code; a corrupt file is surfaced by
`doctor` ("will be rebuilt") and rebuilt on the next write.

#### Preset writing (8g consumer)

`writePreset` (internal) stores JSON presets in the loader-compatible
format, **refuses to persist any secret-flagged parameter** (skipped
names are reported explicitly), refuses unknown keys, and fails loud on
IO errors (`ERR_CLI_PRESET_INVALID`) — the wizard's save-as-preset (8g)
is its consumer. Secret flags reach the CLI through the parameter
descriptors (`secret`, threaded tolerantly from `isSecret()` so a stale
pre-2.3.0 `dist` build simply reads as non-secret) and cached
descriptors are validated element-wise on read.

Reserved command names now include `presets` and `history` (scaffold +
doctor drift-guard updated).

### Phase 8g — interactive wizard

#### `m3l wizard`

The guided composition flow (explicitly invoked — bare `m3l` still prints
help; a non-interactive stdin exits `2`): fuzzy `autocomplete` script
selection ("name — description"), then one typed prompt per declared
parameter in declaration order — `password` (masked input) for
secret-flagged parameters, `select` for a parameter declaring an operation
set (ADR-0055, U8 — choices rendered "name — description", value the
chosen operation's name), `confirm` for BOOL, `number` for INT/DOUBLE,
comma-split `text` for STRING_ARRAY, `text` with the default prefilled
otherwise. An empty answer skips an optional parameter; a required one is
re-asked once, then skipped with a warning (the script's own validation
stays the authority at run time).

Once an operation is chosen, every subsequent declared parameter whose own
`required` is `false` is scoped against it (U8): named by an operation of
that _same selector_ but not the chosen one, it is skipped entirely —
never prompted, absent from the summary, the preset, and the spawned argv
— while one the chosen operation requires is always prompted, re-asked on
an empty answer the same way a `required: true` parameter is. A parameter
declared `required: true` is always prompted regardless of scoping; so is
one no operation of that selector names, or one declared before the
selector in the script's own parameter order. A script declaring more than
one operation-selector parameter is scoped only against the first whose
answer resolves to one of its own declared operations — a later selector's
operations never contribute to scoping.

The confirmation summary masks secret values (`********`) and routes every
value through `redactSensitiveLogValue` — a wizard-entered secret reaches
only the spawned child's argv, never the terminal, a preset, or history.
Save-as-preset is offered before the run decision (`writePreset`'s
fail-closed secret skip reports any excluded names; a failed save never
loses the composed run), then "run now?" — decline exits `0` without
spawning; accept translates the answers through the shared dynamic-argv
builder, spawns via the 8c path, and records the prompted parameter names
in history. Prompt UI is `Core.M3LPrompt` (terminal-control-escaped
rendering), constructed lazily behind an injectable port.

> Delivery caveat: a wizard-entered secret reaches the child **via argv**
> (`--name=value`), exactly as invoking the script directly would — on a
> shared host that is visible in `/proc/<pid>/cmdline`, so prefer `.env` /
> environment delivery for secrets there and leave the prompt blank.

`wizard` completes the reserved command-name set:
`list, inspect, run, doctor, presets, history, new, help, wizard`.

### U9 — script scaffolding

#### `m3l new <name> [options]`

Activates the long-reserved `new` command (ADR-0053 U9, issue #533):
generates a new `scripts/<name>/` package (ADR-0022 fleet conventions) plus
its `docs/reference/scripts/<name>.md` contract page, and wires the root
`tsconfig.json` project reference — the same shape `bin/scaffold-script.mjs`
used to generate directly; that script is now a thin delegate onto this
command for one release (ADR-0053), and `pnpm scaffold:script` keeps working
unchanged. Emits every file from the committed `templates/script/*.tmpl`
sources via plain token substitution, with **no reformatting pass** — the
templates are authored (and machine-verified, `check:template-format`) to
already be prettier-conformant after substitution, since `packages/m3l-cli`
carries a zero-third-party-runtime-dependency contract
([§Design invariants](#design-invariants)) that forbids importing `prettier`.

Options:

- `--purpose "<one-line purpose>"` — injected into the package description,
  README, and contract page (defaults to a `TODO` placeholder).
- `--variant <cli|lambda>` — which composition-root/README pair to emit
  (default `cli`): `cli` wires `Core.runScript` for a terminal invocation;
  `lambda` wires `M3LScript.createLambdaHandler()` instead, with a matching
  README. Every other emitted file (config, hooks, the starter step, the
  config smoke test, the contract page) is identical between variants and
  never differs in target filename, so `check:script-scaffold`'s shape
  validation needs no variant awareness for them. The one exception is the
  ADR-0054 `src/command.ts` in-process command-module seam (U6): `cli` emits
  it (plus `tests/command.test.ts`); `lambda` does not, since a Lambda-variant
  script has no `dist/main.js` CLI process for an in-process host to be an
  alternative to. Choosing `lambda` scaffolds the shape only; it does not
  itself activate ADR-0018's event-source seam (see that ADR's 2026-08-26
  Update) — that trigger is a real deployed consumer, not a template.
- `--dry-run` — renders every file and reports what would be written, writing
  nothing.
- `--force` — overwrite a pre-existing `scripts/<name>/` or contract page;
  anything else already there is left untouched, and a failure mid-run under
  `--force` is **not** rolled back (only the default, nothing-pre-existing
  path rolls back atomically on failure).

Flags: `--json` (machine-readable `{ scriptName, variant, dryRun, changes }`
on stdout, where `changes` is one `{ action: "created" | "updated", path }`
entry per emitted/updated file).

A name that fails ADR-0028's full-service-name convention, collides with a
reserved CLI command name (ADR-0042), or is not kebab-case exits `2`
(`ERR_CLI_SCAFFOLD_INVALID`), as does an invalid `--purpose` (a control
character, or a character that would break out of the JSON/doc-comment
context it's substituted into) or an unrecognized `--variant`. A pre-existing
target without `--force` exits `2` (`ERR_CLI_SCAFFOLD_EXISTS`). A write
failure exits `1` (`ERR_CLI_SCAFFOLD_FAILED`, cause-chained; the run is rolled
back first unless the target pre-existed under `--force`).

### V2 — structured run results

#### The `--json` run-result envelope

`m3l run <script> --json` and the dynamic `m3l <script> --json` form both
route through one shared execution tail (`run/execute.ts`), so they behave
identically. After the child exits, exactly one line of JSON — the
"envelope" — is written to stdout. Under `--json` the child's own stdout is
redirected to the parent's **stderr** instead of being inherited, so the
envelope is the only thing on stdout; nothing the script itself writes is
lost, it simply moves streams.

ADR-0035 classifies the run report (`run-report.json`, produced by
`M3LRunReporter`) as a sensitive, crash-dump-class artifact. The envelope
**never re-emits report content** — it carries only allowlisted scalars,
plus the report's own path:

| Field                 | Type               | Notes                                                                                           |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `kind`                | `"m3l.run.result"` | Schema discriminant.                                                                            |
| `schemaVersion`       | `1`                | Bumped only on a breaking field change.                                                         |
| `script`              | `string`           | The resolved script name — never read from the report.                                          |
| `startedAt`           | ISO-8601 `string`  | Parent-observed, immediately before spawn.                                                      |
| `finishedAt`          | ISO-8601 `string`  | Parent-observed, immediately after the child's `close` event.                                   |
| `durationMs`          | `number`           | `finishedAt − startedAt`, not clamped.                                                          |
| `exitCode`            | `number`           | The child's exit code, verbatim (`128+N` for a signal-killed child).                            |
| `exitCodeName`        | `string \| null`   | The ADR-0035 registry name for `exitCode`; `null` outside `0`–`6`.                              |
| `outcome`             | `string \| null`   | The report's outcome (one of the 5 registered literals); `null` if unavailable or unrecognized. |
| `reportPath`          | `string \| null`   | Absolute path to the matched `run-report.json`; `null` if unavailable.                          |
| `reportUnavailable`   | `string \| null`   | A reason below when no report was matched; `null` when one was.                                 |
| `timelineCount`       | `number \| null`   | Breadcrumb count — never the breadcrumbs themselves.                                            |
| `timelineSourceCount` | `number \| null`   | Count of distinct breadcrumb `source` labels.                                                   |
| `recoveryTotal`       | `number \| null`   | Absorbed-failure count, only when `outcome` is `"partial"`.                                     |

Emission is **read-tolerant**: an absent, unreadable, or malformed report
never crashes the CLI and never fabricates an outcome — `reportUnavailable`
names one of:

| Reason                        | Meaning                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `output-directory-missing`    | The managed output directory does not exist.                              |
| `output-directory-unreadable` | It exists but couldn't be listed (e.g. a permission fault).               |
| `no-matching-report`          | The directory was scanned but no report matched this script's run window. |
| `report-unreadable`           | A matching candidate's report file couldn't be read.                      |
| `report-malformed`            | A matching candidate's report file didn't parse as valid JSON.            |

The parent cannot learn the report's path directly (it's named after the
_child's_ own start time), so it scans the managed output directory
(`M3L_OUTPUT_DIR`, defaulting to `<workspaceRoot>/data/output` — the exact
same variable name and default `@m3l-automation/m3l-common`'s own `M3LPaths`
already uses, so setting it redirects both this scan and every spawned
script's own output directory in agreement) for the newest directory, within
the observed run window, whose report's `script.name` matches. Two known
limitations: a script-local `.env` setting `M3L_OUTPUT_DIR` is visible to the
**child only** (the parent still scans its own resolved directory, so the
lookup reports `output-directory-missing` or misses the report); and two
truly concurrent invocations of the **same** script can, rarely, have the
younger run's scan match the older run's sibling report — this is accepted,
not solved, per ADR-0063.

A CLI-side failure **before** the spawn (unknown script, not built, spawn
failed) emits **no** envelope at all — only stderr and the corresponding exit
code (see [§Exit codes](#exit-codes)). An agent consuming `--json` output
must treat "empty stdout, non-zero exit" as a CLI-side failure distinct from
"one envelope, exit code inside it".

## Exit codes

The CLI's own exit codes are `M3LCliExitCode` — exactly `0 | 1 | 2`, the
coarse ADR-0035 subset (`SUCCESS` / `UNCLASSIFIED` / `CONFIG_USAGE`). It never
mints `3`–`6` itself; a finer-grained registry code reaches the caller only by
passthrough from a spawned script. The `M3LCliErrorCode` → exit-code mapping
lives in `src/cli/errors.ts` as a `Record` keyed by the full union, so adding
an error code is a compile error until its exit code is chosen.

| Code    | Meaning             | Raised by                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`     | Success             | every happy path — including `list` with some configs unloadable, `doctor` with no `fail` row (a `warn` never affects the code), `wizard` declining "run now?", and an empty `presets` listing                                                                                                                                                           |
| `1`     | Operational failure | `ERR_CLI_CONFIG_IMPORT`, `ERR_CLI_WORKSPACE_NOT_FOUND`, `ERR_CLI_SCRIPT_NOT_BUILT`, `ERR_CLI_SPAWN_FAILED`, `ERR_CLI_DOCTOR_FAILED`, `ERR_CLI_PRESET_INVALID`, `ERR_CLI_SCAFFOLD_FAILED`, `ERR_CLI_COMMAND_MODULE_INVALID`, `ERR_CLI_COMMAND_MODULE_IMPORT_FAILED`, `ERR_CLI_IN_PROCESS_FAILED` — and any non-`M3LCliError` value reaching the top level |
| `2`     | Usage error         | `ERR_CLI_UNKNOWN_COMMAND`, `ERR_CLI_UNKNOWN_SCRIPT`, `ERR_CLI_UNKNOWN_PARAMETER`, `ERR_CLI_INVALID_PARAMETER_VALUE`, `ERR_CLI_SCAFFOLD_INVALID`, `ERR_CLI_SCAFFOLD_EXISTS`; a missing required positional; `wizard` on a non-interactive stdin                                                                                                           |
| child's | Passthrough         | `run <script>` and dynamic per-script dispatch return the child's code **verbatim**, preserving the ADR-0035 registry end-to-end                                                                                                                                                                                                                         |
| `128+N` | Signal-terminated   | a signal-killed child, e.g. SIGTERM → `143`                                                                                                                                                                                                                                                                                                              |

Under `--json`, the envelope's `exitCodeName` carries the ADR-0035 registry
name for `exitCode` when it falls in `0`–`6`, and `null` for anything else
(including a passthrough child code or `128+N`) — see
[§V2 — structured run results](#v2--structured-run-results).
