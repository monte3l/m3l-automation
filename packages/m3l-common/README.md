<p align="center">
<img src="https://raw.githubusercontent.com/monte3l/m3l-automation/main/assets/m3l-wordmark.svg" alt="m3l-common" width="260" height="64">
</p>

<p align="center">
<img src="https://raw.githubusercontent.com/monte3l/m3l-automation/main/assets/m3l-hero.svg" alt="m3l-common quick-start terminal pane" width="700">
</p>

<p align="center">
<a href="https://github.com/monte3l/m3l-automation/actions/workflows/ci.yml"><img src="https://github.com/monte3l/m3l-automation/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="https://nodejs.org/en/"><img src="https://img.shields.io/badge/node-%3E%3D24-A6E22E?style=flat-square&labelColor=272822" alt="node >=24"></a>
<a href="https://nodejs.org/api/esm.html"><img src="https://img.shields.io/badge/esm-only-66D9EF?style=flat-square&labelColor=272822" alt="ESM only"></a>
<a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-66D9EF?style=flat-square&labelColor=272822" alt="TypeScript strict"></a>
<a href="https://github.com/monte3l/m3l-automation/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-A6E22E?style=flat-square&labelColor=272822" alt="Apache-2.0"></a>
<a href="https://github.com/monte3l/m3l-automation/blob/main/docs/implementation-status.md"><img src="https://img.shields.io/badge/status-pre--release-FD971F?style=flat-square&labelColor=272822" alt="status: pre-release"></a>
<a href="https://github.com/monte3l/m3l-automation/blob/main/docs/implementation-status.md"><img src="https://img.shields.io/badge/modules-9%2F22-FD971F?style=flat-square&labelColor=272822" alt="modules: 9/22"></a>
</p>

> **Status: early development — scaffold and specs are complete; implementation is in progress.**
> Version `0.0.0-development`. All documented APIs are design targets; 9 of 22 submodules are
> implemented (`errors`, `events`, `security`, `environment`, `utils`, `json`, `analysis`, `messaging`, `config`).

A shared infrastructure library for automation scripts and AWS Lambda handlers. It provides
enterprise-grade building blocks — application scaffolding, configuration, logging, error
handling, file import/export, polling/retry resilience, and AWS credential and client management
— so consumer scripts stay free of boilerplate.

All APIs below are design targets. See the
[implementation status](https://github.com/monte3l/m3l-automation/blob/main/docs/implementation-status.md)
for the per-module breakdown.

## Requirements

- Node.js 24+
- ESM only (`"type": "module"`)

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

## Import paths

| Path                              | What you get                      |
| --------------------------------- | --------------------------------- |
| `@m3l-automation/m3l-common`      | Both namespaces: `Core` and `AWS` |
| `@m3l-automation/m3l-common/core` | The `Core` namespace directly     |
| `@m3l-automation/m3l-common/aws`  | The `AWS` namespace directly      |

- **`Core`** — application scaffolding, configuration, logging, prompts, I/O, data utilities, and resilience primitives.
- **`AWS`** — AWS credential management and SDK client providers.

## Links

- [Repository](https://github.com/monte3l/m3l-automation)
- [Implementation status](https://github.com/monte3l/m3l-automation/blob/main/docs/implementation-status.md)
- [Architecture](https://github.com/monte3l/m3l-automation/blob/main/docs/m3l-common-architecture.md)
- [Getting started](https://github.com/monte3l/m3l-automation/blob/main/docs/getting-started.md)

## License

Apache 2.0 — see [LICENSE](https://github.com/monte3l/m3l-automation/blob/main/LICENSE).
