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

### Later phases (not yet built)

`run` (8c), per-script dynamic subcommands (8d), `doctor` (8e), presets +
history (8f, blocked on the `M3LConfigParameter.secret` library
prerequisite), interactive wizard (8g) — see ADR-0042 and the m3l-cli
build-out tracker in `docs/plans/IMPLEMENTATION.md`.

## Reserved command names

`list`, `inspect`, `run`, `doctor`, `new`, `help` — a script may not take one
of these as its package name; `bin/scaffold-script.mjs` and
`check:script-scaffold` reject them (`RESERVED_CLI_NAMES` in
`bin/lib/script-scaffold.mjs`).

## Cache layout

`<cacheDir>/m3l-cli/discovery.json` — a JSON map of script name to
`{ srcMtimeMs, distMtimeMs, descriptor }`. Deleting it is always safe; it is
rebuilt on the next discovery-bearing command.
