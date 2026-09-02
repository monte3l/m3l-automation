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
`process.execPath` with `--env-file-if-exists=.env` (the default — see
`--env-file`/`--no-env-file` below), `cwd` set to the script's directory,
`stdio: "inherit"` — the terminal belongs to the child — and an environment
composed as the CLI's own environment plus any secret-flagged parameter
values (ADR-0085; see [Secret delivery](#secret-delivery)). Everything after the **first bare `--`** passes through verbatim
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
declaration order — **except** a parameter declared `secret: true`, which is
routed to the child's environment instead and never appears in its argv
(ADR-0085; see [Secret delivery](#secret-delivery)) — and delegates to the 8c spawn path — with anything after
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
never prompted, absent from the summary, the preset, the spawned argv, and
the injected environment — while one the chosen operation requires is always prompted, re-asked on
an empty answer the same way a `required: true` parameter is. A parameter
declared `required: true` is always prompted regardless of scoping; so is
one no operation of that selector names, or one declared before the
selector in the script's own parameter order. A script declaring more than
one operation-selector parameter is scoped only against the first whose
answer resolves to one of its own declared operations — a later selector's
operations never contribute to scoping.

The confirmation summary masks secret values (`********`) and routes every
value through `redactSensitiveLogValue` — a wizard-entered secret reaches
only the spawned child's environment, never its argv, the terminal, a
preset, or history.
Save-as-preset is offered before the run decision (`writePreset`'s
fail-closed secret skip reports any excluded names; a failed save never
loses the composed run), then "run now?" — decline exits `0` without
spawning; accept translates the answers through the shared dynamic-argv
builder, spawns via the 8c path, and records the prompted parameter names
in history. Prompt UI is `Core.M3LPrompt` (terminal-control-escaped
rendering), constructed lazily behind an injectable port.

A wizard-entered secret is delivered the same way a directly-invoked one is
— through the child's environment, not its argv. See
[Secret delivery](#secret-delivery).

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
limitations: a script-local `.env` setting `M3L_OUTPUT_DIR` (whichever file
`--env-file` resolved to) is visible to the **child only** (the parent still scans its own resolved directory, so the
lookup reports `output-directory-missing` or misses the report); and two
truly concurrent invocations of the **same** script can, rarely, have the
younger run's scan match the older run's sibling report — this is accepted,
not solved, per ADR-0063.

A CLI-side failure **before** the spawn (unknown script, not built, spawn
failed) emits **no** envelope at all — only stderr and the corresponding exit
code (see [§Exit codes](#exit-codes)). An agent consuming `--json` output
must treat "empty stdout, non-zero exit" as a CLI-side failure distinct from
"one envelope, exit code inside it".

### U10 — orchestration engine

#### `m3l flow list|run <name> [--dry-run] [--json]`

Runs a **named flow** — an ordered, branching sequence of `scripts/*`
invocations declared in `data/config/flows/<name>.yaml` (ADR-0056). The
subcommand is **required**: a bare `m3l flow` exits `2` with the usage line, as
does an unrecognized subcommand.

`m3l flow list` prints the declared flow names (`.yaml` only — a `.yml`
sibling is deliberately not listed, since it would suggest a name that then
fails to load). Under `--json` it emits a JSON array. An empty flows directory
says so rather than printing nothing.

`m3l flow run <name>` loads and validates the definition, then executes its
steps in order. The engine drives whole scripts over the existing exit-code and
`run-report.json` contract — it never reaches inside a running script, and it
**never writes or rewrites a script's run report**.

| Aspect         | Behaviour                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branching      | each step declares `onSuccess`, `onFailure` and optionally `onPartial`, each `continue` \| `stop` \| `{ goto: <stepId> }`. `goto` may target a later step, an earlier one, or itself |
| Classification | exit `0` → `onSuccess`; exit `6` (`PARTIAL`) **or** a `partial` report outcome → `onPartial`; anything else, including `128 + signal`, → `onFailure`                                 |
| Exit code      | the **deciding** (last executed) step's own exit code, propagated unchanged — never clamped or remapped                                                                              |
| Loop guard     | `maxStepExecutions` (default `50`) counts executions cumulatively across revisits; tripping it is a definition-authoring fault and exits `2`                                         |
| `--dry-run`    | a **floor**, never lowered: it forces dry-run on every step, and a step declaring `dryRun: true` still runs dry without it                                                           |
| Execution      | `execution: auto` (default) \| `in-process` \| `spawn`. `auto` resolves to **spawn**, because only the spawn path produces the `run-report.json` the engine reads                    |
| Unknown flow   | exits `2` (`ERR_CLI_UNKNOWN_FLOW`) with Damerau–Levenshtein suggestions over the declared names                                                                                      |

**Definition faults are caught at load time, not mid-run.** `name` must match
the filename stem (otherwise a renamed file silently shadows another flow);
step ids must be unique; every `goto` must resolve; every `script` must resolve
through discovery; every `parameters` key must be one the target script
actually declares (operations are ordinary declared parameters under ADR-0055,
so there is no separate `operation:` key); and **unknown keys are rejected at
both flow and step level**, which is what makes later additions to the format
forward-safe. Step-level and `parameters` keys are screened for
prototype-pollution vectors, because the YAML provider screens only top-level
keys.

**A run record is persisted** to `data/cache/m3l-cli/flows/<name>.json`: the run
id, a canonical hash of the definition, the observed window, the status
(`completed` \| `stopped` \| `failed` \| `loop-guard-exceeded`), the flow exit
code, the cumulative step-execution count, the halting and resume step ids, and
one entry per step execution. Unlike run history, this is **not** best-effort —
it is a resume ledger, so a failed write is reported and changes the exit code
rather than being swallowed. Rendering happens before persistence, so the
result is still on stdout either way.

**U10 ships no `--resume` flag.** The engine's entry point already accepts a
resume-from step id and the record already carries everything a resume needs,
but the flag itself is U11's, and `--resume` is **rejected** at exit `2` rather
than silently ignored — a silently-dropped `--resume` would re-run a flow from
its first step.

Under `--json` a single line is emitted on stdout: a `m3l.flow.result` envelope
carrying the flow-level fields above plus one nested entry per step execution.
Each nested entry **composes the same per-run envelope** `m3l run --json` emits,
with that step's own observed window, and the flow's `exitCodeName` is copied
from the deciding step's nested envelope rather than re-derived.

Two consequences of that a consumer depends on:

- A spawned step's own stdout is **redirected to stderr** for the duration of a
  `--json` run, exactly as `m3l run --json` does, so the envelope is the only
  thing written to stdout. Without it a step that prints JSON could hand an
  agent a forged verdict.
- A `loop-guard-exceeded` run always reports `exitCodeName: null`, never the
  deciding step's name. The guard is the engine's own verdict and it trips
  _after_ the steps that did run, so copying the last step's name would report
  `SUCCESS` alongside `exitCode: 2`.

### V3 — secrets delivery

#### Secret delivery

A parameter a script declares `secret: true` is delivered to the spawned
child **through its environment, never its argv** (ADR-0085). Concretely,
`translateArgv` returns the invocation as two halves — the `--name=value`
tokens and a secret-only environment overlay — and the CLI spawns with
`env: { ...<the CLI's own environment>, ...<the secret overlay> }`. Both
spawn paths do this: the dynamic per-script dispatch and `m3l wizard`, which
spawns directly rather than through the shared execution tail.

The variable name is the SCREAMING_SNAKE_CASE form of the parameter's
**canonical** name — every `.` and `-` becomes `_`, then the whole name is
uppercased (`api.token` and `api-token` both give `API_TOKEN`). That is
`Core.deriveEnvVarName`, the same derivation
`Core.M3LEnvironmentConfigProvider` applies when it reads the value back at
level 4 of the script's own provider chain, so **no consumer script needs
any change**: the resolution path already existed.

- Dropping the argv token is **required, not cosmetic**. Argv is level 1 of
  that chain and the environment is level 4, so a value emitted both ways
  would still resolve from argv and the hardening would be silently inert.
- An alias hit still keys the variable off the canonical name.
- A `STRING_ARRAY` secret is comma-joined, matching `coerceConfigValue`'s
  documented contract — the same join the argv form performs.
- A **`BOOL` secret is a contradiction** and is treated as non-secret for
  delivery: a boolean carries no secret payload, only the fact that a flag
  was set, which the argv already reveals. It stays a bare `--name` flag.
- Two declared parameters whose canonical names derive the **same** variable
  name, where at least one is secret, fail loud with
  `ERR_CLI_CONFIG_IMPORT` — otherwise the secret would silently satisfy the
  other parameter.
- The injected overlay is applied **last**, so it beats a same-named ambient
  variable, matching the precedence the argv token it replaces had.
- `--in-process` (ADR-0054) is unaffected and needs no injection: there is no
  child process and no argv, and the value is bound straight into the hosted
  command's typed `parameterValues`.

> **What this buys, and what it does not.** `/proc/<pid>/environ` is mode
> `0400`, readable only by the process owner; `/proc/<pid>/cmdline` is
> world-readable. So this defeats a co-tenant `ps` or `/proc` reader. It does
> **not** defend against root, a debugger, another process of the same user,
> a core dump, or the child leaking its own environment to something it
> spawns. Secret-store resolution (Secrets Manager / SSM) remains
> deliberately gated — see ADR-0085.

#### `--env-file <path>` / `--no-env-file`

Two CLI-reserved flags controlling the env file the spawned child loads
(ADR-0085). Reserved exactly like `--json` and `--in-process`: stripped
before the script's own strict `parseArgs` ever sees them, so a script that
declares a same-named parameter is shadowed the same way. Unlike those two
they are stripped in `dispatch`, ahead of the static/dynamic split — a
detached `--env-file <path>` reaching the static path's non-strict
`parseArgs` would otherwise be absorbed as a bare boolean and leave its value
in `positionals`, making `m3l run --env-file staging.env json-etl` resolve
"staging.env" as the script name.

| Flags                               | Child's node argv           |
| ----------------------------------- | --------------------------- |
| _neither_ (default, unchanged)      | `--env-file-if-exists=.env` |
| `--no-env-file`                     | _no env-file token at all_  |
| `--env-file=<p>` / `--env-file <p>` | `--env-file-if-exists=<p>`  |

- A relative path resolves against the **CLI's own working directory**, not
  the script directory the child is spawned in — an operator who types
  `--env-file staging.env` means the file they can see. The `auto` default
  stays script-directory-relative, exactly as before.
- A caller-supplied path keeps the tolerant `-if-exists` form on purpose: a
  typo'd path stays the same soft miss the hardcoded `.env` has always been
  rather than becoming a hard node startup crash.
- Passing **both** flags exits `2` with `ERR_CLI_INVALID_PARAMETER_VALUE`
  rather than last-wins. They express opposite intents, and letting token
  order silently decide whether a whole configuration file reaches a command
  that is about to receive secrets is the mistake this refuses to hide.
- `--env-file` with no value, or followed by another flag, exits `2` the same
  way — `--env-file --json` is rejected rather than silently swallowing the
  `--json`.
- On `--in-process` either flag exits `2` with
  `ERR_CLI_IN_PROCESS_UNSUPPORTED`: there is no child process for an env file
  to be loaded into.
- Both are exact-token matches; `--env-file-if-exists=…` is not recognized
  and passes through to the script untouched.
- After the first bare `--`, both tokens pass through to the child verbatim
  like any other passthrough argument.

### U12 — shell completion

#### `m3l completion <shell>`

Prints a self-contained completion script for `bash`, `zsh` or `fish` on
stdout. The `<shell>` positional is **required** — there is no `$SHELL`
auto-detection, so the generated script is a function of its argument alone.
A bare `m3l completion` exits `2` with the usage line; an unrecognized shell
exits `2` (`ERR_CLI_INVALID_PARAMETER_VALUE`) with Damerau–Levenshtein
suggestions over `bash`/`zsh`/`fish`, the same treatment `inspect` gives an
unknown script.

**Statically generated, not callback-driven.** Every `m3l` invocation pays
Node startup plus module load (~0.5 s, even for `--version`, which never
touches discovery), so a completion callback that shelled back into `m3l`
would put that cost on every TAB press. Everything this command completes is
knowable at generation time, so it is baked in instead: TAB is instant, and
the script goes stale — regenerate it after adding a `scripts/*` package.

What the generated script completes:

| Position                                      | Candidates                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| first positional                              | every static command, every discovered script name, and the always-valid flags                       |
| after `completion`                            | `bash`, `zsh`, `fish`                                                                                |
| after `inspect`/`presets`/`run`               | the discovered script names (`new` is excluded — its positional is a name that must _not_ exist yet) |
| after a script name                           | that script's own parameter flags, plus the always-valid flags, `--in-process` and `--dry-run`       |
| after an operation-declaring parameter's flag | that parameter's declared operation names                                                            |

Always-valid flags are `--json`, `--help`, `-h` and `--version`.
`--in-process` (ADR-0054, U7) and `--dry-run` apply only to dynamic
per-script dispatch; `--dry-run` is honoured among the tokens after the `--`
separator rather than as a direct flag, but it is offered on a script
invocation line because that is where it is typed.

**Parameter and operation enumeration.** Each script's parameters come from
`loadParametersCached`, the same mtime-keyed discovery cache `m3l list` and
`m3l inspect` read through. A parameter contributes `--<name>` plus one flag
per declared alias (a one-character alias renders `-x`, a longer one `--xy`);
a parameter that declares an operation set (ADR-0055) additionally
contributes its operation names as the value set for **each** of its own
flags, so `m3l sqs-etl --command <TAB>` and `m3l sqs-etl -c <TAB>` offer the
same operations. A parameter declaring no operations contributes no value
set.

A script whose config will not load degrades to **name-only** completion
rather than aborting generation — the same tolerance `m3l list` gives a
single unloadable script — and the reason is written into the generated file
as a comment:

```bash
# broken-etl: parameters unavailable (dist missing) — completing by name only
```

The failure is recorded, never swallowed. One script's failure never
suppresses another script's flags.

The command set is read from `scaffold/manifest.ts`'s `RESERVED_CLI_NAMES` —
the ADR-0042 source of truth `main.ts`, `commands/dynamic.ts` and
`commands/doctor.ts` all mirror — so a new reserved name becomes completable
without a fifth literal to keep in sync. Script names come from
`discoverScripts`, sorted, so the emitted script is byte-stable across runs.

**Emitted tokens are allowlist-filtered.** Script, parameter and operation
names reach this command from `scripts/*` config modules and are written into
an executable shell script, so only tokens matching
`^-{0,2}[A-Za-z0-9][A-Za-z0-9._:-]*$` are interpolated (and each is quoted
regardless). Anything else is skipped and named in a `#` comment scrubbed to
the same allowlist — a space is allowed, since a load reason is prose, but a
newline is not, because it would end the comment and let the rest start a
statement. Nothing is silently dropped.

**No default value is ever emitted.** Completion covers flag _names_ and
operation _values_ only. `defaultValue` is never read: a `secret: true`
parameter's default renders as a mask (`"********"`), and no default of any
kind reaches the generated file.

Flags: `--json` (one object on stdout, `{ "shell": "<shell>", "script":
"<the full script text>" }`; the `<shell>` positional is still required).

Exit: `0` success; `2` a missing or unrecognized `<shell>`; `1` if discovery
itself is impossible (e.g. workspace root not found).

## Completion

`m3l completion <shell>` writes the script to stdout; installing it is a
per-shell step. **Regenerate after adding a `scripts/*` package, adding or
renaming a script parameter, or changing a parameter's declared operation
set** — the script is a static snapshot, not a live query (see
[§`m3l completion <shell>`](#m3l-completion-shell)). Nothing detects
staleness for you; a stale script simply completes the previous surface.

**bash** — source it from `~/.bashrc`, or drop it into the completion
directory:

```bash
pnpm m3l completion bash > ~/.local/share/bash-completion/completions/m3l
```

**zsh** — save it as `_m3l` on a directory in `$fpath`, ahead of `compinit`:

```zsh
pnpm m3l completion zsh > "${fpath[1]}/_m3l"
```

The emitted file carries a `#compdef m3l` header, so it autoloads from
`$fpath`; sourcing it by hand instead registers itself via `compdef`, which
makes `source <(pnpm m3l completion zsh)` work for a throwaway shell.

**fish** — drop it into the completions directory, where fish autoloads it:

```fish
pnpm m3l completion fish > ~/.config/fish/completions/m3l.fish
```

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
