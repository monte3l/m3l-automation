# m3l CLI (`packages/m3l-cli`)

The script-facing CLI activated by ADR-0042 (issue #333): discovery,
introspection, and guided execution over the `configParameters` seam every
`scripts/*` package declares in `src/config.ts`. Private, unpublished, and
zero-runtime-dependency — its only dependency is `@m3l-automation/m3l-common`
via `workspace:*`; everything else is `node:` builtins.

Invocation: `pnpm m3l <command>` from the workspace root (a root
`package.json` script wrapping `packages/m3l-cli/bin/m3l.mjs` — the package
is nobody's dependency, so its `bin` entry is not linked into the root
`node_modules/.bin`).

This page is the CLI's contract. It grows one section per shipped phase
(ADR-0042 phasing 8b–8g); commands not yet listed here are not yet built.

## Design invariants

- **Zero runtime dependencies.** Arg parsing is `node:util` `parseArgs`
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
  exit codes follow the ADR-0035 registry conventions: `0` success, `1`
  operational failure, `2` usage error (unknown command/script, bad flags).
- **Import-inert modules.** No `src` module executes anything at import time;
  the only process entry is the `bin/m3l.mjs` wrapper, which calls
  `runCli(argv)` and assigns its resolved number to `process.exitCode`.

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

Flags: `--json` (machine-readable descriptor on stdout).

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
involvement — `run` only needs discovery.

Exit: the **child's exit code verbatim** (preserving the ADR-0035 registry
end-to-end); a signal-terminated child yields `128 + <signal number>` (e.g.
SIGTERM → 143). CLI-side failures: `2` unknown script (with suggestions) or
missing `<script>` positional; `1` script not built (`ERR_CLI_SCRIPT_NOT_BUILT`,
message names `pnpm build`) or spawn failure (`ERR_CLI_SPAWN_FAILED`,
cause-chained).

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
  `inspect <script>` — no spawn.
- An unrecognized flag exits `2` with `ERR_CLI_UNKNOWN_PARAMETER` and
  Damerau–Levenshtein suggestions over the script's declared parameter
  names; a BOOL flag given a value (`--verbose=true`) exits `2` with
  `ERR_CLI_INVALID_PARAMETER_VALUE` naming the parameter; an unknown first
  positional exits `2` with suggestions spanning static commands and script
  names; colliding declared names/aliases fail loud with
  `ERR_CLI_CONFIG_IMPORT`.

### Phase 8e — diagnostics

#### `m3l doctor`

Renders one aligned row per check (`CHECK` / `STATUS` / `DETAIL`, statuses
`ok` / `warn` / `fail`; `--json` for the machine-readable array):
Node floor (≥ 24), workspace root, one `script:<name>` row per discovered
script (dir shape → fail when neither config exists; dist freshness → warn
naming `pnpm build`; importability through the real loader → fail with the
load-error message; all-green renders the parameter count), reserved-name
collision audit, and cache health (parent-dir writability, cache-file
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

### Later phases (not yet built)

The interactive wizard (8g) — see ADR-0042 and the m3l-cli build-out
tracker in `docs/plans/IMPLEMENTATION.md`.
