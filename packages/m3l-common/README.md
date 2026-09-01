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
<a href="https://github.com/monte3l/m3l-automation/blob/main/docs/implementation-status.md"><img src="https://img.shields.io/badge/library%20modules-46%2F46-A6E22E?style=flat-square&labelColor=272822" alt="library modules: 46/46"></a>
</p>

> **All 46 of 46 library submodules are implemented and reviewed.** The package is
> internal and not published to npm; `version` in `package.json` is hand-managed.
> Implemented submodules:
> <!-- BEGIN GENERATED SUBMODULE-LIST -->
>
> `errors`, `events`, `security`, `environment`, `utils`, `json`, `analysis`, `messaging`, `config`, `logging`, `files`, `network`, `polling`, `prompt`, `importers`, `exporters`, `storage`, `text`, `script`, `diagnostics`, `checkpoint`, `pipeline`, `procedure`, `cli-contract`, `agent`, `orchestration`, `aws/models`, `aws/credentials`, `aws/clients`, `aws/dynamodb`, `aws/cloudwatch-logs-insights`, `aws/sqs`, `aws/signing`, `aws/s3`, `aws/athena`, `aws/eventbridge`, `aws/lambda`, `aws/ecs`, `aws/codepipeline`, `aws/cloudformation`, `aws/eks`, `aws/cloudwatch-alarms`, `aws/cloudwatch-metrics`, `aws/secrets-manager`, `aws/rds-data`, `aws/bedrock-runtime`.
> <!-- END GENERATED SUBMODULE-LIST -->

A shared infrastructure library for automation scripts and AWS Lambda handlers. It provides
enterprise-grade building blocks — application scaffolding, configuration, logging, error
handling, file import/export, polling/retry resilience, and AWS credential and client management
— so consumer scripts stay free of boilerplate.

It is the substrate of the wider
[m3l-automation](https://github.com/monte3l/m3l-automation) monorepo, which also
ships the `m3l` CLI, a fleet of AWS consumer scripts, and an operations
console built on top of it.

See the
[implementation status](https://github.com/monte3l/m3l-automation/blob/main/docs/implementation-status.md)
for the per-module breakdown.

## Requirements

- Node.js 24+
- ESM only (`"type": "module"`)

## Installation

This package is not published to npm. Inside the monorepo, consumers depend on
it via `workspace:*`
([ADR-0029](https://github.com/monte3l/m3l-automation/blob/main/docs/adr/0029-script-dependency-boundary.md)):

```jsonc
{
  "dependencies": {
    "@m3l-automation/m3l-common": "workspace:*",
  },
}
```

External installation from a private GitHub Packages registry is planned
([ADR-0057](https://github.com/monte3l/m3l-automation/blob/main/docs/adr/0057-private-registry-distribution.md),
roadmap U13) but not yet available.

## Quick start

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  metadata: { name: "hello-script", version: "1.0.0" },
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
