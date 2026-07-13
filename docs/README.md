# `@m3l-automation/m3l-common` Documentation

`@m3l-automation/m3l-common` is a shared infrastructure library for every automation script, Lambda handler, and tool that needs enterprise-grade building blocks — application scaffolding, multi-source configuration, structured logging, interactive prompts, file import/export, full-text search, polling/retry resilience, and AWS credential and client management. It is written in TypeScript (strict), ships ESM-only, targets Node.js 24+, and keeps runtime dependencies minimal.

> **Development status:** Internal package, not published to npm (`version` is hand-managed). 25 submodules documented; `errors`, `events`, `security`, `environment`, `utils`, `json`, `analysis`, `config`, `messaging`, `polling`, `text`, `prompt`, `exporters`, `storage`, `network`, `importers`, `files`, `logging`, `aws/models`, `script`, `aws/credentials`, `aws/clients` + `aws/dynamodb`/`aws/logs-insights`/`aws/sqs` implemented (25 of 25). See [Implementation status](implementation-status.md) for the per-module breakdown.

## Import paths

The package exposes exactly three import paths:

| Path                              | What you get                                |
| --------------------------------- | ------------------------------------------- |
| `@m3l-automation/m3l-common`      | Both top-level namespaces: `Core` and `AWS` |
| `@m3l-automation/m3l-common/core` | The `Core` namespace directly               |
| `@m3l-automation/m3l-common/aws`  | The `AWS` namespace directly                |

```typescript
import { Core, AWS } from "@m3l-automation/m3l-common";
```

## Table of contents

### Development status

- [Implementation status](implementation-status.md) — per-module tracker (❌ not-started · 🧪 tests-written · 🟢 implemented · ✅ reviewed)

### Getting started

- [Getting started](getting-started.md)

### Guides

- [Writing a script](guides/writing-a-script.md) — build a CLI automation script with `M3LScript`
- [Lambda handlers](guides/lambda-handlers.md) — expose the same logic as an AWS Lambda handler
- [Configuration](guides/configuration.md) — providers, resolution order, async fallback, presets
- [Environments and paths](guides/environments-and-paths.md) — environment detection and filesystem layout
- [Capability index](guides/capability-index.md) — which class to use for a given need

### Architecture

- [Architecture overview](m3l-common-architecture.md) — package shape, namespaces, and module map
- [Implementation plan](plans/archive/m3l-common-implementation.md) — _historical_: the 2026-06-28 build strategy (all 22 submodules now shipped; see [Implementation status](implementation-status.md))

### API Reference — Core

Application framework

- [`script`](reference/core/script.md) — `M3LScript`: CLI / Lambda entry-point framework
- [`config`](reference/core/config.md) — multi-source configuration
- [`environment`](reference/core/environment.md) — runtime and deployment-mode detection

I/O

- [`importers`](reference/core/importers.md) — CSV / JSON / text file parsing
- [`exporters`](reference/core/exporters.md) — CSV / JSON / HTML file writing
- [`files`](reference/core/files.md) — execution-directory file archival
- [`network`](reference/core/network.md) — `M3LHttpClient` (undici)
- [`prompt`](reference/core/prompt.md) — spinners, progress bars, interactive input
- [`logging`](reference/core/logging.md) — `M3LLogger` and handlers

Data

- [`json`](reference/core/json.md) — field-path navigation and format detection
- [`text`](reference/core/text.md) — multi-format text extraction
- [`storage`](reference/core/storage.md) — SQLite FTS5 full-text search
- [`analysis`](reference/core/analysis.md) — `M3LThresholdEvaluator`

Resilience

- [`polling`](reference/core/polling.md) — `M3LPoller`, `M3LRetryRunner`, `M3LBackoff`, classifiers
- [`errors`](reference/core/errors.md) — `M3LError`, `M3LResult<T, E>`
- [`events`](reference/core/events.md) — type-safe event emitter

Utilities

- [`utils`](reference/core/utils.md) — `M3LPaths`, concurrency pool, type guards, string utils
- [`messaging`](reference/core/messaging.md) — abstract `M3LMessenger` interface
- [`security`](reference/core/security.md) — prototype pollution guard

### API Reference — AWS

- [`credentials`](reference/aws/credentials.md) — `M3LAWSCredentialsManager`
- [`clients`](reference/aws/clients.md) — `AWSClientProvider`, `AWSMultiClientProvider`
- [`models`](reference/aws/models.md) — shared AWS model types

### Contributing

- [Contributing](contributing/contributing.md) — setup, commands, testing, and commit conventions
- [Coding standards](contributing/coding-standards.md) — TypeScript style and conventions
- [Model selection](contributing/model-selection.md) — which Claude model runs which task category, and how it is enforced
