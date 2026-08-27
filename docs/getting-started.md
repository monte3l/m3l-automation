# Getting Started

`@m3l-automation/m3l-common` is the shared infrastructure library behind every
automation script, CLI tool, and AWS Lambda handler in the `m3l-automation`
project. It bundles the cross-cutting concerns those scripts keep
re-implementing — configuration loading, structured logging, interactive
prompts, AWS credential management, file import/export, polling/retry, and
more — into one cohesive framework so your own code stays focused on the task
at hand.

This page gets you from an empty project to a running script. When you are
ready to build something real, continue with the
[Writing a script](./guides/writing-a-script.md) guide.

## 1. Requirements

- **Node.js 24 LTS or newer.** The library targets the Node 24 runtime floor
  and uses APIs that are not available on older releases.
- **ESM only.** The package is published as ECMAScript modules
  (`"type": "module"`); there is no CommonJS build. Your project must also be
  ESM (`"type": "module"` in your `package.json`), and relative imports in
  your own source must carry the `.js` extension.

## 2. Installation

`@m3l-automation/m3l-common` is not published to npm. Consumers live inside
this monorepo and depend on it via `workspace:*`
([ADR-0029](adr/0029-script-dependency-boundary.md)):

```jsonc
{
  "dependencies": {
    "@m3l-automation/m3l-common": "workspace:*",
  },
}
```

External installation from a private GitHub Packages registry is planned
([ADR-0057](adr/0057-private-registry-distribution.md), roadmap U13) but not
yet available. That single dependency brings in the whole framework — there is
nothing else to configure to start, no scaffolding step and no generated
files.

## 3. The two namespaces

Everything the library exposes is grouped under exactly two top-level
namespaces:

| Namespace | What it contains                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Core`    | Application scaffolding and entry points (`M3LScript`), configuration, logging, prompts, environment detection, errors, importers/exporters, polling/retry, and general utilities. |
| `AWS`     | AWS credential management (`M3LAWSCredentialsManager`) and SDK client providers (`AWSClientProvider`, `AWSMultiClientProvider`).                                                   |

You will spend most of your time in `Core`, reaching into `AWS` when a script
needs to talk to AWS services.

## 4. The three import paths

The package `exports` map exposes three entry points, so you can import the way
that best fits your code:

```typescript
// 1. Both namespaces from the package root
import { Core, AWS } from "@m3l-automation/m3l-common";

// 2. The Core sub-module directly (named exports, no namespace prefix)
import { M3LScript, M3LConfigParameter } from "@m3l-automation/m3l-common/core";

// 3. The AWS sub-module directly
import { M3LAWSCredentialsManager } from "@m3l-automation/m3l-common/aws";
```

The root path (`.`) re-exports the `Core` and `AWS` namespace objects. The
`./core` and `./aws` sub-paths expose the same symbols as flat named exports,
which lets you import only what you use. Both styles are equivalent; pick one
and keep it consistent within a file. The examples in these guides mostly use
the namespaced form (`Core.M3LScript`).

## 5. Your first script

Every script is built around `Core.M3LScript`. You construct it with a single
options object and then call `run()` with your `async` main function. The
framework detects the environment, loads configuration, validates AWS
credentials (only when you ask for them), runs your function, and cleans up —
all without boilerplate in your code.

Create `hello.ts`:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  metadata: { name: "hello", version: "1.0.0" },
});

await script.run(async () => {
  // Your automation logic goes here.
  console.log("Hello from M3LScript");
});
```

Build and run it like any other ESM script under Node 24+:

```bash
node hello.js
```

When `run()` executes, it walks the full lifecycle for you:
environment detection → configuration load → AWS credential check (skipped
here, since no AWS profile parameter is declared) → your main function →
cleanup and file archival. You only wrote the main function; the framework
provided the rest.

## 6. Where to go next

- [Writing a script](./guides/writing-a-script.md) — the end-to-end guide to
  building a real CLI automation: configuration schemas, logging, prompts,
  lifecycle hooks, AWS access, and graceful shutdown.
- [Lambda handlers](./guides/lambda-handlers.md) — expose the same logic as an
  AWS Lambda handler with `createLambdaHandler()`.

## See also

- [`Core.M3LScript` reference](./reference/core/script.md)
- [`config` reference](./reference/core/config.md)
- [`logging` reference](./reference/core/logging.md)
- [`environment` reference](./reference/core/environment.md)
- [Architecture overview](./m3l-common-architecture.md)
