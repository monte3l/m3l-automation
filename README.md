<p align="center">
<img src="assets/m3l-wordmark.svg" alt="m3l-automation" width="267" height="64">
</p>

<p align="center">
<img src="assets/m3l-hero.svg" alt="m3l-automation quick-start terminal pane" width="700">
</p>

<p align="center">
<a href="https://github.com/monte3l/m3l-automation/actions/workflows/ci.yml"><img src="https://github.com/monte3l/m3l-automation/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="https://nodejs.org/en/"><img src="https://img.shields.io/badge/node-%3E%3D24-A6E22E?style=flat-square&labelColor=272822" alt="node >=24"></a>
<a href="https://nodejs.org/api/esm.html"><img src="https://img.shields.io/badge/esm-only-66D9EF?style=flat-square&labelColor=272822" alt="ESM only"></a>
<a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-66D9EF?style=flat-square&labelColor=272822" alt="TypeScript strict"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-A6E22E?style=flat-square&labelColor=272822" alt="Apache-2.0"></a>
<a href="docs/implementation-status.md"><img src="https://img.shields.io/badge/status-pre--release-FD971F?style=flat-square&labelColor=272822" alt="status: pre-release"></a>
<a href="docs/implementation-status.md"><img src="https://img.shields.io/badge/modules-11%2F22-FD971F?style=flat-square&labelColor=272822" alt="modules: 11/22"></a>
</p>

> **Status: early development — scaffold and specs are complete; implementation is in progress.**
> Version `0.0.0-development`. All documented APIs are design targets; 11 of 22 submodules are
> implemented (`errors`, `events`, `security`, `environment`, `utils`, `json`, `analysis`, `messaging`, `config`, `polling`, `text`). See [Implementation status](docs/implementation-status.md)
> for the per-module breakdown.

A shared infrastructure library for automation scripts and AWS Lambda handlers. It provides
enterprise-grade building blocks — application scaffolding, configuration, logging, error
handling, file import/export, polling/retry resilience, and AWS credential and client management
— so consumer scripts stay free of boilerplate.

## Features (target API — not yet implemented)

The following capabilities describe the target design. Progress is tracked in
[docs/implementation-status.md](docs/implementation-status.md).

- **Application framework** — `Core.M3LScript` is a single entry point for CLI scripts and Lambda handlers, wiring together environment detection, configuration loading, logging, interactive prompts, graceful shutdown, process fault guards, and file archival.
- **Multi-source configuration** — resolve typed parameters across CLI args, JSON/YAML files, environment variables, Lambda event payloads, and presets, with static defaults and async fallbacks.
- **Structured logging** — `Core.M3LLogger` fans out to console, file, and JSON handlers; output is ANSI-rich in a TTY and machine-readable in Lambda/CI.
- **Interactive UI** — spinners, progress bars, and prompts that degrade gracefully to plain text in non-interactive environments.
- **Data I/O** — streaming CSV/JSON/text importers and CSV/JSON/HTML exporters, multi-format text extraction (PDF, DOCX, XLSX, email, ZIP), and SQLite FTS5 full-text search.
- **Resilience** — `Core.M3LPoller`, `Core.M3LRetryRunner`, backoff strategies, and composable retry classifiers; plus `M3LError` and `M3LResult<T, E>` for explicit error handling.
- **AWS integration** — `AWS.M3LAWSCredentialsManager` manages SSO credentials (validating via STS `GetCallerIdentity`), and client providers lazily create and cache AWS SDK v3 clients per profile.

## Requirements

- Node.js 24+
- ESM only (`"type": "module"`); relative imports carry the `.js` extension

## Installation

```bash
pnpm add @m3l-automation/m3l-common
```

## Quick start

> This example shows the intended usage once `M3LScript` is implemented.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  metadata: { name: "hello-script", description: "Minimal example" },
});

await script.run(async () => {
  // your automation logic here
});
```

## Namespaces and import paths

The package exposes three import paths:

| Path                              | What you get                      |
| --------------------------------- | --------------------------------- |
| `@m3l-automation/m3l-common`      | Both namespaces: `Core` and `AWS` |
| `@m3l-automation/m3l-common/core` | The `Core` namespace directly     |
| `@m3l-automation/m3l-common/aws`  | The `AWS` namespace directly      |

```typescript
import { Core, AWS } from "@m3l-automation/m3l-common";
```

- **`Core`** — application scaffolding, configuration, logging, prompts, I/O, data utilities, and resilience primitives.
- **`AWS`** — AWS credential management and SDK client providers.

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Implementation status](docs/implementation-status.md) — per-module progress tracker
- [Architecture overview](docs/m3l-common-architecture.md)
- [Contributing](.github/CONTRIBUTING.md)

## License

Apache 2.0 — see [LICENSE](LICENSE) for the full text.
