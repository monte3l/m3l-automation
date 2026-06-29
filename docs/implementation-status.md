# Implementation status — m3l-common vs. documented spec

This is the **single source of truth** for what is implemented in
`@m3l-automation/m3l-common` versus what the `docs/reference/**` pages specify.
The library is a documented-but-empty scaffold: the barrels are wired, but every
submodule is unimplemented.

> **Maintenance contract (hub):** the main agent updates this file after **each
> phase** of the `implement-submodule` pipeline. It is the durable, cross-session
> memory the isolated spoke subagents do not share. See `CLAUDE.md` → _Agent
> Operating Model_ and `.claude/skills/implement-submodule/SKILL.md`.

**Status legend:** ❌ not-started · 🧪 tests-written (RED) · 🟢 implemented (GREEN) · ✅ reviewed/done

**Phase columns:** _Tests_ = TDD tests authored & failing for the right reason ·
_Reviewed_ = passed `code-reviewer` + `spec-conformance-reviewer` (+ `security-reviewer` where relevant).

## Barrels & infrastructure

| Item                                   | Status | Notes                                             |
| -------------------------------------- | ------ | ------------------------------------------------- |
| `src/index.ts` (re-exports Core + AWS) | ✅     | wired; namespaces empty                           |
| `src/core/index.ts`                    | ✅     | `export {}` placeholder; submodules surfaced here |
| `src/aws/index.ts`                     | ✅     | `export {}` placeholder; submodules surfaced here |
| `exports` map (`.`, `./core`, `./aws`) | ✅     | the public contract — do not extend (semver)      |

## Core submodules (`docs/reference/core/`)

| Submodule   | Spec                  | Symbols (≈) | Status | Tests | Reviewed | Notes (runtime deps → dependency gate)                                        |
| ----------- | --------------------- | ----------- | ------ | ----- | -------- | ----------------------------------------------------------------------------- |
| errors      | `core/errors.md`      | 22          | ✅     | ✅    | ✅       | done — 101 tests, ~98% cov; conformant + code-reviewed (must-fixes applied)   |
| events      | `core/events.md`      | 3           | ❌     | ❌    | ❌       | none — **foundational** (emitter base)                                        |
| security    | `core/security.md`    | 2           | ❌     | ❌    | ❌       | none — pure fns; good pipeline smoke test                                     |
| environment | `core/environment.md` | 7           | ❌     | ❌    | ❌       | none — drives `M3LPaths`                                                      |
| utils       | `core/utils.md`       | 39          | ❌     | ❌    | ❌       | none — `M3LPaths`, concurrency, type guards                                   |
| json        | `core/json.md`        | 5           | ❌     | ❌    | ❌       | none                                                                          |
| analysis    | `core/analysis.md`    | 4           | ❌     | ❌    | ❌       | none                                                                          |
| messaging   | `core/messaging.md`   | 10          | ❌     | ❌    | ❌       | none — abstract interfaces only                                               |
| config      | `core/config.md`      | 18          | ❌     | ❌    | ❌       | **YAML parser** (e.g. `yaml`) for YAML provider                               |
| logging     | `core/logging.md`     | 11          | ❌     | ❌    | ❌       | none (uses `files`/exporters for file handler)                                |
| files       | `core/files.md`       | 8           | ❌     | ❌    | ❌       | none                                                                          |
| network     | `core/network.md`     | 3+          | ❌     | ❌    | ❌       | **`undici`**                                                                  |
| polling     | `core/polling.md`     | 13          | ❌     | ❌    | ❌       | none                                                                          |
| prompt      | `core/prompt.md`      | 5+          | ❌     | ❌    | ❌       | **inquirer + spinner libs** (TTY UI)                                          |
| importers   | `core/importers.md`   | 13          | ❌     | ❌    | ❌       | **`csv-parse`**                                                               |
| exporters   | `core/exporters.md`   | 9           | ❌     | ❌    | ❌       | **`csv-stringify`**                                                           |
| storage     | `core/storage.md`     | 9           | ❌     | ❌    | ❌       | **`better-sqlite3`** (native)                                                 |
| text        | `core/text.md`        | 12          | ❌     | ❌    | ❌       | **`unpdf`, `mammoth`, `read-excel-file`, `mailparser`, `cheerio`, `adm-zip`** |
| script      | `core/script.md`      | 11          | ❌     | ❌    | ❌       | composes config/env/logging/aws — implement **last**                          |

## AWS submodules (`docs/reference/aws/`)

| Submodule   | Spec                 | Symbols (≈) | Status | Tests | Reviewed | Notes (runtime deps → dependency gate)                     |
| ----------- | -------------------- | ----------- | ------ | ----- | -------- | ---------------------------------------------------------- |
| models      | `aws/models.md`      | —           | ❌     | ❌    | ❌       | shared types only (no runtime)                             |
| credentials | `aws/credentials.md` | 6           | ❌     | ❌    | ❌       | **`@aws-sdk/client-sts`, `@aws-sdk/credential-providers`** |
| clients     | `aws/clients.md`     | 4           | ❌     | ❌    | ❌       | **`@aws-sdk/*` service clients** (lazy)                    |

## Suggested implementation order

Dependency-driven: foundational, dep-free modules first so later modules can
build on them.

1. **errors**, **events**, **security**, **utils**, **environment**, **json** (no deps; everything else leans on these)
2. **analysis**, **messaging** (no deps)
3. **config** (+ YAML), **logging**, **files**, **polling**, **network** (+ undici)
4. **importers** (+ csv-parse), **exporters** (+ csv-stringify)
5. **storage** (+ better-sqlite3), **text** (+ extractor libs), **prompt** (+ inquirer)
6. **aws/models → aws/credentials → aws/clients**
7. **script** last (it orchestrates env, config, logging, aws)

Symbol counts are approximate, taken from the `docs/reference` pages; treat each
page as the authoritative contract when implementing.
