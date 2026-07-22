# Writing a Script

This guide walks through building a complete CLI automation script with
`Core.M3LScript`, from constructing it out of an options object to handling
graceful shutdown. By the end you will know how to declare configuration, log
structured output, prompt the user, reach AWS services, and hook into every
stage of the run.

`M3LScript` is the single entry point for every script in the project. You do
**not** subclass it. Instead you pass a single `M3LScriptOptions` object
(metadata, configuration schema, logging options, and hooks) to the
constructor, then call `run()` with your main function. The framework provides
everything else.

If you have not installed the package yet, start with
[Getting Started](../getting-started.md).

## 1. The shape of a script

Every script follows the same three-part shape: import, construct, run.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
});

await script.run(async () => {
  // Your automation logic goes here.
});
```

The interesting work is in deciding what to put in the `M3LScriptOptions`
object and what to do inside the main function. The rest of this guide builds
that up piece by piece.

## 2. Constructing from `M3LScriptOptions`

The constructor takes one `M3LScriptOptions` object. It carries the script
metadata, the configuration schema, logging options, and the lifecycle hooks.
The constructor wires together configuration, logging, prompts, and AWS
credential management from these inputs, so by the time `run()` starts those
facilities are ready.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const script = new Core.M3LScript({
  // 2.1 Metadata — identifies the script (M3LScriptMetadata).
  metadata: {
    name: "report-builder",
    version: "1.0.0",
  },

  // 2.2 Hooks — observe and extend each lifecycle stage.
  hooks: {
    onAfterConfigLoad: (ctx) => {
      // ctx is a M3LScriptHookContext carrying the live config store.
    },
  },
});
```

### 2.1 Metadata

`metadata` is an `M3LScriptMetadata` object identifying the script — most
importantly its `name` and `version`. Keep the name stable and descriptive: it
appears in logs and archives. Note that `M3LPaths` anchors one **flat**
`data/{config,input,output}` root shared by every script — there is **no**
per-script path derivation from the name. To isolate a script's I/O, point the
`M3L_CONFIG_DIR` / `M3L_INPUT_DIR` / `M3L_OUTPUT_DIR` env overrides (in its
gitignored `.env`) at a per-script subtree such as `data/<script-name>/…`
(ADR-0022).

### 2.2 Configuration schema

You declare the parameters your script accepts as `M3LConfigParameter`
instances, each with a `name`, a `M3LConfigParameterType`, and optionally a
static `defaultValue` and/or an async fallback. At run time each parameter is
resolved from the provider chain (CLI args, JSON/YAML files, environment
variables, and — under Lambda — the event payload), then the static default,
then the async fallback. See the [config reference](../reference/core/config.md)
for the full provider priority order and alias rules.

```typescript
const region = new Core.M3LConfigParameter({
  name: "region",
  type: Core.M3LConfigParameterType.STRING,
  defaultValue: "eu-south-1",
});

const maxRows = new Core.M3LConfigParameter({
  name: "maxRows",
  type: Core.M3LConfigParameterType.INT,
  defaultValue: 1000,
});
```

The supported parameter types are `STRING`, `INT`, `DOUBLE`, `BOOL`,
`STRING_ARRAY`, `INT_ARRAY`, `DOUBLE_ARRAY`, and `BUFFER`.

### 2.3 Logging options

Logging is structured and multi-handler: a single `M3LLogger` fans every
message out to an ordered array of handler instances. The three built-in
handlers cover the common sinks — `M3LConsoleLoggerHandler` (ANSI-colored
terminal output, automatically plain in non-TTY contexts),
`M3LFileLoggerHandler` (streamed to a file), and `M3LJsonLoggerHandler`
(one JSON line per event, ideal for CloudWatch). Adding a sink is just adding a
handler to the array — no subclassing. See the
[logging reference](../reference/core/logging.md) for the full handler and
method set.

### 2.4 Hooks

`hooks` is an `M3LScriptLifecycleHooks` object. Each hook is optional and
receives a `M3LScriptHookContext` carrying the live config store, so a hook can
read resolved configuration at any stage. The eight hooks are covered in
section 4.

## 3. The `run(mainFunction)` lifecycle

`run(mainFunction)` is the primary CLI entry point. It returns a
`Promise<void>` and orchestrates the full lifecycle around your main function.
The stages, in order, are:

```text
M3LScript.run(mainFn)
  1. M3LExecutionEnvironment.detect()   ← reads env vars + filesystem markers
  2. hooks: onBeforeInit → onAfterInit
  3. config load                        ← walks provider chain; resolves asyncFallbacks
  4. hooks: onBeforeConfigLoad → onAfterConfigLoad
  5. AWS credential check               ← only if an aws.profile param is defined
  6. hooks: onBeforeRun
  7. mainFn()                           ← your code
  8. hooks: onAfterRun → onCleanup
  9. file archival                      ← copies input/config files to the output dir
```

A few things worth knowing:

- **Environment detection (step 1)** decides whether the script is interactive,
  runs in CI, or runs in an AWS-managed environment. That decision feeds
  logging, prompts, and path resolution. See the
  [environment reference](../reference/core/environment.md).
- **The AWS credential check (step 5)** runs _only_ when your schema declares an
  `aws.profile` parameter. A script that never touches AWS pays no AWS cost.
- **File archival (step 9)** copies the script's input and config files into the
  timestamped output directory, so each run is reproducible.

## 4. The eight lifecycle hooks

`M3LScriptLifecycleHooks` declares eight hooks. In execution order they are:

| Hook                 | Fires                                               |
| -------------------- | --------------------------------------------------- |
| `onBeforeInit`       | before environment detection / initialization       |
| `onAfterInit`        | after initialization completes                      |
| `onBeforeConfigLoad` | before configuration is loaded                      |
| `onAfterConfigLoad`  | after the provider chain has resolved configuration |
| `onBeforeRun`        | immediately before your main function               |
| `onAfterRun`         | after your main function returns                    |
| `onError`            | when an error escapes the run                       |
| `onCleanup`          | during teardown, regardless of success or failure   |

Each hook receives a `M3LScriptHookContext` with the live config store, which is
why `onAfterConfigLoad` is the natural place to read resolved values, validate
cross-parameter invariants, or log the effective configuration.

```typescript
const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
  hooks: {
    onAfterConfigLoad: (ctx) => {
      // ctx.config holds the resolved configuration for this run.
    },
    onError: (ctx) => {
      // Centralize error reporting here.
    },
    onCleanup: (ctx) => {
      // Release resources you opened in main.
    },
  },
});
```

## 5. Using the `script` facilities inside main

Inside your main function the framework exposes its facilities through the
`script` instance.

### 5.1 Logging

Use the logger for structured output. It renders rich, colored output on a
terminal and machine-readable plain text in CI or Lambda automatically.

```typescript
await script.run(async () => {
  script.logger.header("Report builder");
  script.logger.step("Loading data");
  // ... work ...
  script.logger.success("Report complete");
});
```

`M3LLogger` exposes typed methods including `text`, `step`, `info`, `success`,
`warning`, `error`, `fatal`, `section`, `header`, `newline`, `table`,
`simpleTable`, and `keyValueTable`.

### 5.2 Configuration

Read resolved configuration through the script's configuration facilities —
`getConfiguration()` for the whole resolved set, and the declared parameters
for individual values. Because resolution may invoke async fallbacks, value
resolution is asynchronous.

```typescript
await script.run(async () => {
  const config = await script.getConfiguration();
  // Or resolve a single parameter against the provider chain.
});
```

The [config reference](../reference/core/config.md) covers the eight-level
resolution order (CLI → JSON → YAML → env/`.env` → Lambda event → preset →
static default → async fallback), alias support, and per-value source tracking
via `sourceOf(name)`.

### 5.3 Prompts

When the environment is interactive, prompt the user; in CI or Lambda the same
calls degrade to plain-text equivalents (and color codes are stripped). The
prompt facade offers `text`, `password`, `number` (with `min`/`max`),
`confirm`, `select`, `multiselect`, and `autocomplete`, plus spinners and a
loading bar for progress UI.

```typescript
await script.run(async () => {
  const confirmed = await script.prompt.confirm("Generate the report now?");
  if (!confirmed) return;
});
```

See the [prompt reference](../reference/core/prompt.md).

### 5.4 AWS

When your script needs AWS, declare an `aws.profile` parameter so the framework
validates credentials during step 5, then reach AWS through `script.aws`. The
AWS facade lazily creates and caches SDK clients per profile, so repeated
access reuses connections.

```typescript
await script.run(async () => {
  const s3 = script.aws.clients.s3();
  // ... use the cached S3 client ...
});
```

Credential validation and SSO login are handled by `M3LAWSCredentialsManager`;
see the [credentials reference](../reference/aws/credentials.md) and the
[clients reference](../reference/aws/clients.md).

## 6. Graceful signal handling

In non-AWS environments, `M3LScript` registers handlers for `SIGTERM`,
`SIGINT`, and `SIGQUIT` so an interrupted script can shut down cleanly through
its cleanup stage. A _second_ signal forces an immediate exit with code `1`, so
an unresponsive script can still be killed. In AWS execution environments (such
as Lambda) these handlers are not installed, because the platform manages
process lifecycle there.

For unhandled faults that escape normal flow, `installProcessGuards()` installs
a process-global guard layer (`unhandledRejection`, `uncaughtException`,
`warning`, and `beforeExit`). **Installing it is your composition root's job**
— `M3LScript` never installs it for you, and no consumer script gets it by
default. For a CLI script, call it once at the top of `main.ts`, before
`script.run(...)`; the guards are observe-only (they report faults to stderr,
they never exit the process), while the signal layer above is what controls
shutdown. See the
[script reference](../reference/core/script.md#process-guards) for the full
responsibility contract, and the
[troubleshooting guide](./troubleshooting.md) for how guard output is used in
diagnosis. The `runScript()` wrapper
([diagnostics](../reference/core/diagnostics.md#runscript), ADR-0035) will make
this automatic — guards, top-level catch, exit code, and run report in one
call.

## 7. A worked end-to-end example

The following script ties the pieces together: a typed configuration schema,
hooks, structured logging, a prompt, and a clean main function.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const region = new Core.M3LConfigParameter({
  name: "region",
  type: Core.M3LConfigParameterType.STRING,
  defaultValue: "eu-south-1",
});

const maxRows = new Core.M3LConfigParameter({
  name: "maxRows",
  type: Core.M3LConfigParameterType.INT,
  defaultValue: 1000,
});

const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
  hooks: {
    onAfterConfigLoad: (ctx) => {
      // Validate cross-parameter invariants here using ctx's config store.
    },
    onError: (ctx) => {
      // Centralized error reporting.
    },
  },
});

await script.run(async () => {
  script.logger.header("Report builder");

  const config = await script.getConfiguration();
  script.logger.info("Configuration loaded");

  const proceed = await script.prompt.confirm("Build the report now?");
  if (!proceed) {
    script.logger.warning("Aborted by user");
    return;
  }

  script.logger.step("Building report");
  // ... your real work: query data, transform, export ...

  script.logger.success("Done");
});
```

## See also

- [`Core.M3LScript` reference](../reference/core/script.md)
- [`config` reference](../reference/core/config.md)
- [`logging` reference](../reference/core/logging.md)
- [`prompt` reference](../reference/core/prompt.md)
- [`environment` reference](../reference/core/environment.md)
- [Guide: Lambda handlers](./lambda-handlers.md)
- [Getting Started](../getting-started.md)
- [Architecture overview](../m3l-common-architecture.md)
