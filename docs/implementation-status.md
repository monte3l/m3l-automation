# Implementation status — m3l-common vs. documented spec

This is the **single source of truth** for what is implemented in
`@m3l-automation/m3l-common` versus what the `docs/reference/**` pages specify.
The library started as a documented-but-empty scaffold. The barrels are wired; `errors`, `events`, `security`, `environment`, `utils`, `json`, `analysis`, `messaging`, and `config` are implemented and reviewed (9 of 22 submodules). See the table below for per-submodule status.

> **Maintenance contract (hub):** the main agent updates this file after **each
> phase** of the `implementing-submodules` pipeline. It is the durable, cross-session
> memory the isolated spoke subagents do not share. See `CLAUDE.md` → _Agent
> Operating Model_ and `.claude/skills/implementing-submodules/SKILL.md`.

**Status legend:** ❌ not-started · 🧪 tests-written (RED) · 🟢 implemented (GREEN) · ✅ reviewed/done

**Phase columns:** _Tests_ = TDD tests authored & failing for the right reason ·
_Reviewed_ = passed `code-reviewer` + `spec-conformance-reviewer` (+ `security-reviewer` where relevant) ·
_Planned_ = implementation plan exists in `docs/plans/`.

## Barrels & infrastructure

| Item                                   | Status | Notes                                             |
| -------------------------------------- | ------ | ------------------------------------------------- |
| `src/index.ts` (re-exports Core + AWS) | ✅     | wired; namespaces empty                           |
| `src/core/index.ts`                    | ✅     | `export {}` placeholder; submodules surfaced here |
| `src/aws/index.ts`                     | ✅     | `export {}` placeholder; submodules surfaced here |
| `exports` map (`.`, `./core`, `./aws`) | ✅     | the public contract — do not extend (semver)      |

## Core submodules (`docs/reference/core/`)

| Submodule   | Spec                  | Planned | Symbols (≈) | Status | Tests | Reviewed | Notes (runtime deps → dependency gate)                                                                                                                                                             |
| ----------- | --------------------- | ------- | ----------- | ------ | ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| errors      | `core/errors.md`      | ✅      | 22          | ✅     | ✅    | ✅       | done — 103 tests, ~98% cov; conformant + code-reviewed (must-fixes applied)                                                                                                                        |
| events      | `core/events.md`      | ✅      | 3           | ✅     | ✅    | ✅       | none — **foundational** (emitter base); 33 tests, 100% cov; reviewed (no must-fix)                                                                                                                 |
| security    | `core/security.md`    | ✅      | 2           | ✅     | ✅    | ✅       | none — 28 tests, 100% cov; reviewed (must-fix applied: @example uses M3LError)                                                                                                                     |
| environment | `core/environment.md` | ✅      | 8           | ✅     | ✅    | ✅       | none — 105 tests, 100% cov; reviewed (all must-fixes applied)                                                                                                                                      |
| utils       | `core/utils.md`       | ✅      | 39          | ✅     | ✅    | ✅       | 278 tests (39/39 symbols; Phase D shipped — M3LPaths cluster); reviewed (must-fixes applied)                                                                                                       |
| json        | `core/json.md`        | ✅      | 10          | ✅     | ✅    | ✅       | 10 exports; 59 tests; detector 96.9% (84.2% br), rest 100%; reviewed (must-fixes applied)                                                                                                          |
| analysis    | `core/analysis.md`    | ✅      | 8           | ✅     | ✅    | ✅       | done — 66 tests; evaluator ~91% (89.5% br), error class 100%; conformant + reviewed (must-fix: value validation applied). +`parseLocaleNumber` (utils)                                             |
| messaging   | `core/messaging.md`   | ✅      | 10          | ✅     | ✅    | ✅       | done — 36 tests, 100% cov; conformant + reviewed (no must-fix)                                                                                                                                     |
| config      | `core/config.md`      | ✅      | 19          | ✅     | ✅    | ✅       | done — 19 exports (18 classes + `coerceConfigValue`); 5-spoke review clean (CLI/.env parsing + S1 secret-redaction + secretNames-copy fixed); 163 tests, cov ≥80%. `yaml@2.9.0`.                   |
| logging     | `core/logging.md`     | ✅      | 11          | ❌     | ❌    | ❌       | none (uses `files`/exporters for file handler)                                                                                                                                                     |
| files       | `core/files.md`       | ✅      | 8           | ❌     | ❌    | ❌       | none                                                                                                                                                                                               |
| network     | `core/network.md`     | ✅      | 3+          | ❌     | ❌    | ❌       | **`undici`**                                                                                                                                                                                       |
| polling     | `core/polling.md`     | ✅      | 13          | ❌     | ❌    | ❌       | none                                                                                                                                                                                               |
| prompt      | `core/prompt.md`      | ✅      | 12          | ✅     | ✅    | ✅       | done — 80 tests, per-file cov ≥80% (ansi/adapter 100%); 5-spoke review clean (no must-fix; DRY + password-mask why-comment applied). `@inquirer/prompts@8.5.2`; spinner + bar in-house (pure ANSI) |
| importers   | `core/importers.md`   | ✅      | 13          | ❌     | ❌    | ❌       | **`csv-parse`**                                                                                                                                                                                    |
| exporters   | `core/exporters.md`   | ✅      | 9           | ❌     | ❌    | ❌       | **`csv-stringify`**                                                                                                                                                                                |
| storage     | `core/storage.md`     | ✅      | 9           | ❌     | ❌    | ❌       | **`better-sqlite3`** (native)                                                                                                                                                                      |
| text        | `core/text.md`        | ✅      | 12          | ❌     | ❌    | ❌       | **`unpdf`, `mammoth`, `read-excel-file`, `mailparser`, `cheerio`, `adm-zip`**                                                                                                                      |
| script      | `core/script.md`      | ✅      | 11          | ❌     | ❌    | ❌       | composes config/env/logging/aws — implement **last**                                                                                                                                               |

## AWS submodules (`docs/reference/aws/`)

| Submodule   | Spec                 | Planned | Symbols (≈) | Status | Tests | Reviewed | Notes (runtime deps → dependency gate)                     |
| ----------- | -------------------- | ------- | ----------- | ------ | ----- | -------- | ---------------------------------------------------------- |
| models      | `aws/models.md`      | ❌      | —           | ❌     | ❌    | ❌       | shared types only (no runtime)                             |
| credentials | `aws/credentials.md` | ❌      | 6           | ❌     | ❌    | ❌       | **`@aws-sdk/client-sts`, `@aws-sdk/credential-providers`** |
| clients     | `aws/clients.md`     | ❌      | 4           | ❌     | ❌    | ❌       | **`@aws-sdk/*` service clients** (lazy)                    |

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
