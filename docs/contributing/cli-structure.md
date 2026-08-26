# CLI structure

The canonical shape of the two surfaces that make up the m3l CLI:

- `packages/m3l-cli/` — **the package** (file layout, manifest contract, both
  tsconfigs)
- `docs/reference/cli.md` — **the contract page** (section order, per-command
  documentation, exit codes)

This document is the single source of truth for both. It is enforced by
`pnpm check:cli-scaffold` and `pnpm check:cli-docs` (see §Enforcement below).

Until those two gates landed, `packages/m3l-cli` and `docs/reference/cli.md`
were the only first-class surfaces in this repo with no machine gate on their
shape: every `scripts/*` package is held to the ADR-0022 layout by
`check:script-scaffold` and its two documents to a canonical section spec by
`check:script-docs`, while the CLI package — 22 source modules, 20 test files
and a 200-line contract page — had neither. ADR-0053 §Governance named this the
CLI programme's one governance gap, and it matters most as the CLI grows:
`m3l new` (U9), `m3l flow` (U10) and shell completion (U12) each add source
modules and `cli.md` sections, and unconstrained growth is precisely what a
structure gate exists to prevent.

---

## Package structure — `packages/m3l-cli`

### Required files

| Path                  | Why it is pinned                                                |
| --------------------- | --------------------------------------------------------------- |
| `package.json`        | the manifest contract below                                     |
| `tsconfig.json`       | the tooling project (editor, typed linting, test type-checking) |
| `tsconfig.build.json` | the build project                                               |
| `README.md`           | the package's own orientation, distinct from the contract page  |
| `bin/m3l.mjs`         | the CLI's **only** process entry                                |
| `src/main.ts`         | the CLI's **one** composition root                              |

Individual command modules are deliberately **not** pinned by name. That set
grows one entry per phase (U9 `new`, U10 `flow`, U12 `completion`); pinning
`src/commands/doctor.ts` by name would turn the gate into a changelog of
whatever shipped last.

### Layer allowlist

Every directory directly under `src/` must be one of:

```text
cli  commands  discovery  history  presets  run  scaffold
```

`main.ts` is the only file allowed to sit directly under `src/`. A new
top-level layer is a module-topology decision, not an accident of whoever
added a file first, so it fails this gate until someone consciously adds it to
`CLI_SRC_LAYERS` in `bin/check-cli-scaffold.mjs` and records the reasoning
here.

Of those layers, `src/cli`, `src/commands`, `src/discovery` and `src/run` must
each hold at least one `.ts`, and `tests/` at least one `.test.ts`.
`src/history` and `src/presets` are allowed but **not required**: they are 8f
feature stores that ADR-0054/U7 may relocate, and requiring them would make
this gate fight a refactor it has no opinion on. `src/scaffold` (U9, ADR-0053)
holds the `scripts/<name>/` generation manifest and emitter that
`commands/new.ts` calls — the single source of truth `bin/lib/script-scaffold.mjs`
re-exports from the built CLI, so the generator and `bin/check-script-scaffold.mjs`'s
checker cannot drift apart. Allowed but not required, for the same reason as
`history`/`presets`: it exists once `new` ships, not before.

`packages/m3l-cli/bin/` must hold **exactly** `m3l.mjs` — the machine-checked
form of the contract page's "the only process entry is the `bin/m3l.mjs`
wrapper" invariant.

### Manifest contract

| Field               | Requirement                                                                                             | Why                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | `@m3l-automation/m3l-cli`                                                                               | workspace identity                                                                                                                                               |
| `private`           | `true`                                                                                                  | never published to npm                                                                                                                                           |
| `type`              | `"module"`                                                                                              | ESM only (ADR-0002)                                                                                                                                              |
| `engines.node`      | matches `>=24`                                                                                          | Node 24 floor (ADR-0003)                                                                                                                                         |
| `version`           | non-empty string                                                                                        | `src/main.ts`'s `readCliVersion()` reads it; without it `m3l --version` breaks silently rather than loudly                                                       |
| `bin`               | exactly one key, `m3l` → `./bin/m3l.mjs`                                                                | the bin-first identity: one name, one entry                                                                                                                      |
| `scripts.build`     | `tsc -b tsconfig.build.json`                                                                            | value, not just presence — a `"build": "echo nope"` used to pass the equivalent script-side check                                                                |
| `scripts.typecheck` | `tsc -p tsconfig.json`                                                                                  | as above                                                                                                                                                         |
| `scripts.start`     | **absent**                                                                                              | a positive assertion of the CLI's difference from a `scripts/*` package: a `start` would imply `dist/main.js` is a process entry, contradicting import-inertness |
| `exports`           | **absent**                                                                                              | the package is bin-first and nothing in it is importable; declaring one would also pull it into `check:api` / `publint` scope                                    |
| `devDependencies`   | **absent**                                                                                              | the workspace root owns all tooling                                                                                                                              |
| `dependencies`      | `@m3l-automation/m3l-common` at `workspace:*`, and every other key `@m3l-automation/*` at `workspace:*` | see below                                                                                                                                                        |

The dependency rule is deliberately **not** `check:script-deps`'s "exactly one
dependency". `eslint.config.js` mechanizes the CLI's zero-runtime-dependency
guarantee at source level "the same way `check:script-deps` guards the scripts'
manifests"; the manifest half was the acknowledged missing piece, and this is
it. But the invariant being expressed is **zero third-party runtime
dependencies**, not "one dependency" — U7 makes the CLI declare the script
packages as dependencies, and an "exactly one" rule would simply be torn out
there. Phrasing it as _the library, plus workspace-internal packages only_
survives U7 untouched while still failing the moment a third-party package
appears.

### tsconfig shapes

Both configs `extends` `../../tsconfig.base.json` and carry the project
reference `../m3l-common/tsconfig.build.json`.

**`tsconfig.json`** (tooling): `noEmit: true`, `composite: false`,
`declaration: false`, and an `include` containing **both** `src/**/*.ts` and
`tests/**/*.ts`. The tests glob is load-bearing — dropping it silently
un-type-checks the CLI's 20 test files while `pnpm typecheck` still reports
green.

**`tsconfig.build.json`** (build): `rootDir: "src"`, `outDir: "dist"`,
`isolatedDeclarations: true`, `include` exactly `["src/**/*.ts"]`, and an
`exclude` containing `tests`.

### Not checked here

Three things about this package are enforced, just not by `check:cli-scaffold`
— duplicating them would create two sources of truth for one rule:

- the **root tsconfig project reference** — `bin/check-scaffold.mjs` already
  asserts, in both directions, that every `packages/*` workspace appears in the
  root `references`.
- the **import boundary** (no third-party import in CLI sources) —
  `eslint.config.js` plus `pnpm check:zones`.
- **reserved command-name parity** between `bin/lib/script-scaffold.mjs` and
  `src/commands/doctor.ts` — `packages/m3l-cli/tests/doctor.test.ts`'s drift
  guard.

---

## Reference page — `docs/reference/cli.md`

### Title and preamble

The first line is exactly:

```text
# m3l CLI (`packages/m3l-cli`)
```

The preamble between the H1 and the first H2 must be non-empty, must name the
`pnpm m3l` invocation (the package's `bin` is not linked into the root
`node_modules/.bin`, so a bare `m3l` does not work), and must carry the
sentence **"This page is the CLI's contract"** — the sentence that makes an
undocumented command a defect rather than an omission.

The page asserts that prose sentence rather than a script-style contract
blockquote: the CLI's page predates the blockquote convention, and rewriting a
shipped 200-line contract to match a `scripts/*` template buys nothing.

### Section order

| #   | Heading                | Required          |
| --- | ---------------------- | ----------------- |
| 1   | `## Design invariants` | yes               |
| 2   | `## Commands`          | yes               |
| 3   | `## Flows`             | conditional (U10) |
| 4   | `## Completion`        | conditional (U12) |
| 5   | `## Exit codes`        | yes               |

Ordering **is** enforced, over whichever canonical sections are present; an
absent optional section is simply skipped rather than breaking its neighbours'
order. Non-canonical H2s carry no ordering opinion.

A conditional section is "not required now, validated if present", which needs
teeth or it means nothing: `## Flows`, once present, must carry at least one
`###` subsection; `## Completion`, once present, must name at least one of
bash/zsh/fish, since the install step differs per shell. Near-miss spellings of
the two optional sections (`## Flow`, `## Shell completion`, `## Completions`)
are rejected in favour of the canonical name — misspelling a _required_ section
already fails as a missing section, but a misspelled _optional_ one would
otherwise pass silently and never be validated at all. This is the same failure
mode `check:script-docs`'s "Command vs Operation" column check guards.

### `## Commands` — `###` is a phase, `####` is a command

The page groups commands by delivery phase: a `### Phase 8b — discovery +
introspection` heading holds the `####` headings for `m3l list`,
`m3l inspect <script>`, and so on.

This was a genuine decision, not an accident. The U2 plan text called for "one
`###` per command", which contradicts both the shipped page and itself; the
shipped two-level shape was kept. The phase grouping is what makes the page
readable as a record of how the CLI was built — ADR-0053's phasing is visible
in the document structure — and restructuring 200 lines of shipped contract to
flatten one heading level would have been churn with no reader benefit. The
gate therefore requires at least one `###` inside `## Commands` and reads
commands off the `####` headings.

Every command `main.ts` dispatches must appear as a `####` heading whose
backticked span **begins** `m3l <name>` — so `` #### `m3l inspect <script>` ``
and `` #### `m3l help` / `m3l --version` `` both match on the token rather than
the full signature. The reverse also holds: every `` #### `m3l <token>` ``
under `## Commands` whose token is not the `<script>` placeholder must be a
command `main.ts` actually dispatches, which catches a documented-but-deleted
command.

A `####` heading that is _not_ of the form `` `m3l …` `` is left alone —
`#### Preset writing (8g consumer)` is a legitimate non-command subsection, so
the gate deliberately does **not** require every `####` under `## Commands` to
name a command.

### `## Exit codes`

One consolidated table with the columns **Code | Meaning | Raised by**,
covering at minimum `0`, `1` and `2` — the exhaustive `M3LCliExitCode` union in
`src/cli/errors.ts`. Passthrough (`run` and dynamic dispatch return the child's
code verbatim) and signal termination (`128+N`) are rows too, though the gate
does not pin their spelling.

Per-command sections keep their **command-specific** exit semantics (`list`
exits `0` including "some configs unloadable"; `doctor` exits `1` iff any check
is `fail`). What they no longer restate is what each number _means_ — that
belongs in one place, and eight scattered restatements is how the page's
exit-code prose drifted apart in the first place.

---

## Enforcement

Both gates live in `bin/`, each a single file with its pure validators exported
above a `process.argv[1] === fileURLToPath(import.meta.url)` main guard, and
each unit-tested from `bin/tests/` by importing those exports directly. They
are deliberately **not** split into a checker plus a `bin/lib/` manifest the way
`check-script-scaffold.mjs` is: that split exists so the _generator_
(`bin/scaffold-script.mjs`) and the _checker_ consume one manifest and cannot
drift, and there is no CLI generator — there is exactly one `packages/m3l-cli`.

`pnpm check:cli-scaffold` (`bin/check-cli-scaffold.mjs`) — **CI only**. Checks:

- every required file above exists, and every required directory holds at least
  one matching file.
- `package.json` satisfies the manifest contract, including the absent
  `scripts.start`, the absent `exports`, and the dependency rule.
- both tsconfigs carry their documented shape.
- **reverse:** every directory directly under `src/` is a sanctioned layer;
  `main.ts` is the only file directly under `src/`; `bin/` holds exactly
  `m3l.mjs`; and no `scripts/*/package.json` depends on
  `@m3l-automation/m3l-cli` (ADR-0029's direction is scripts ← CLI, and U7
  inverts it, so the direction is pinned before that lands).

`pnpm check:cli-docs` (`bin/check-cli-docs.mjs`) — **pre-push and CI**,
mirroring the `check:script-docs` / `check:script-scaffold` split: the doc gate
is the cheap one a contributor is most likely to trip, so it runs locally.
Checks the title, preamble, required sections, ordering, conditional sections,
near-miss headings, `## Commands` substructure, and `## Exit codes` substance
as described above.

**Ordering is enforced here, unlike `check:script-docs`.** That is a deliberate
divergence, and worth stating so the two gates are not mistaken for copies of
each other: `check:script-docs` spans 22 files with sanctioned layout
deviations, where an ordering rule would generate false positives; this is one
file with an explicitly ordered canonical list.

**The `## Commands` cross-check derives its truth from code.** The command set
comes from regex-extracting `STATIC_COMMAND_NAMES` out of
`packages/m3l-cli/src/main.ts` — the same technique
`packages/m3l-cli/tests/doctor.test.ts` already uses against
`bin/lib/script-scaffold.mjs`. The practical consequence: **adding a command
means editing `main.ts` and `cli.md` in the same PR.** The gate also fails when
the extraction returns nothing, so a rename of that literal surfaces as a loud
failure rather than silently reducing the whole cross-check to a no-op.
