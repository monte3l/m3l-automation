# Lambda Handlers

`Core.M3LScript` is the single entry point for both CLI scripts and AWS Lambda
handlers. The same script you build for the command line can be exposed as a
Lambda handler without rewriting your logic: you swap `run()` for
`createLambdaHandler()` and let the framework adapt the lifecycle to the Lambda
execution model.

This guide assumes you have already built a script as described in
[Writing a script](./writing-a-script.md). Here we focus on what changes when
that same logic runs inside Lambda.

## 1. From `run()` to `createLambdaHandler()`

`createLambdaHandler<TEvent, TResult, TContext>()` wraps the _same_
initialization pipeline as `run()` in an AWS Lambda-compatible handler
function. You construct the script exactly as before; only the entry call
differs.

```typescript
import { Core } from "@m3l-automation/m3l-common";

interface MyEvent {
  reportId: string;
}

interface MyResult {
  ok: boolean;
}

const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
});

export const handler = script.createLambdaHandler<MyEvent, MyResult>(
  async () => {
    // The same logic you would put in run(); per-invocation state is reset,
    // SDK clients stay warm.
    return { ok: true };
  },
);
```

The three type parameters (`TEvent`, `TResult`, `TContext`) let you type the
Lambda event payload, the handler return value, and — if you need it — the
Lambda context.

## 2. Per-invocation state reset (with warm SDK clients)

Lambda reuses a process across many invocations (warm starts). `M3LScript`
accounts for this: before each invocation it resets the state that must be fresh
per request while deliberately keeping the connections that are expensive to
rebuild.

Per invocation, the framework:

- **resets the `initialized` and `configLoaded` flags**, so the initialization
  and configuration stages run again for each event; and
- **clears the configuration store**, so values from a previous event never leak
  into the next one.

Crucially, SDK clients are **not** torn down between invocations. The
`AWSClientProvider` cache persists across warm starts so TCP/TLS connections to
AWS services are reused — the most important performance optimization for a
Lambda that calls AWS on every invocation.

| State                                  | Lifecycle in Lambda                            |
| -------------------------------------- | ---------------------------------------------- |
| `initialized`, `configLoaded` flags    | reset per invocation                           |
| Configuration store                    | cleared per invocation                         |
| SDK client cache (`AWSClientProvider`) | persists across invocations (connection reuse) |

This is what lets each invocation start from a clean configuration state while
still benefiting from warm connections.

## 3. Configuration from environment and the event payload

Under Lambda, configuration is resolved from the same provider chain as a CLI
script, with one addition that fits the platform: the **Lambda event payload**.
The `M3LLambdaEventConfigProvider` exposes values carried on the incoming event
as configuration, slotted into the provider priority order just below
environment variables and above presets:

```text
1. CLI args
2. JSON config file
3. YAML config file
4. Environment variables + .env
5. Lambda event payload      ← M3LLambdaEventConfigProvider (Lambda only)
6. Preset file
7. defaultValue (static)
8. asyncFallback()
```

In practice this means a Lambda gets its baseline configuration from
**environment variables** (set on the function) and per-request overrides from
the **event payload** — without any change to how your parameters are declared.
A parameter declared once works identically whether the value arrives from the
CLI, the environment, or the event. See the
[config reference](../reference/core/config.md) for the complete resolution
order and alias behavior.

## 4. Attributing errors to the invocation

`installProcessGuards()` is a process-global singleton that captures unhandled
faults (`unhandledRejection`, `uncaughtException`, `warning`, `beforeExit`).
It is **not** installed automatically — if you want guard coverage in Lambda,
call `installProcessGuards()` once at **module scope** (it runs at cold start;
the singleton makes repeat calls harmless). The guards observe and report
only; they never alter how the invocation completes.

Because the process is shared across invocations, call
`setProcessGuardRequestId(requestId)` at the start of each invocation so any
guard-caught error is attributed to the correct request. Pass the AWS request
id from the Lambda context (note that `createLambdaHandler()` already wires
this id when it resolves the invocation's correlation id — the explicit call
below matters when your handler does not go through `createLambdaHandler()`).

```typescript
import { Core } from "@m3l-automation/m3l-common";

export const handler = script.createLambdaHandler<MyEvent, MyResult>(
  async (event, context) => {
    Core.setProcessGuardRequestId(context.awsRequestId);
    // ... handler logic ...
    return { ok: true };
  },
);
```

Note also that the `SIGTERM` / `SIGINT` / `SIGQUIT` signal handlers that
`M3LScript` installs for CLI use are **not** registered in AWS environments;
Lambda manages the process lifecycle, so signal handling is left to the
platform.

## 5. Recommended standalone settings

A Lambda is a standalone deployment, not part of the monorepo, so set the
deployment mode explicitly and point the base directory at the only writable
location in the Lambda filesystem, `/tmp`:

```text
M3L_DEPLOYMENT_MODE=standalone
M3L_BASE_DIR=/tmp
```

Set these as environment variables on the function. `M3L_DEPLOYMENT_MODE`
forces standalone path resolution (rather than walking the filesystem looking
for monorepo markers that do not exist in the deployment package), and
`M3L_BASE_DIR=/tmp` ensures the config/input/output directories resolve
under the writable `/tmp` mount. See the
[environments and paths guide](./environments-and-paths.md) for the full set of
`M3L_*` overrides and how standalone path layout works.

## 6. Putting it together

```typescript
import { Core } from "@m3l-automation/m3l-common";

interface ReportEvent {
  reportId: string;
}

interface ReportResult {
  ok: boolean;
  rows: number;
}

const region = new Core.M3LConfigParameter({
  name: "region",
  type: Core.M3LConfigParameterType.STRING,
  defaultValue: "eu-south-1",
});

const script = new Core.M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
});

export const handler = script.createLambdaHandler<ReportEvent, ReportResult>(
  async (event, context) => {
    // Attribute guard-caught faults to this invocation.
    Core.setProcessGuardRequestId(context.awsRequestId);

    // Config resolves from env vars + this event payload; state was reset
    // for this invocation, SDK clients are warm from previous ones.
    const config = await script.getConfiguration();

    script.logger.info("Processing report");
    // ... your real work, reusing warm AWS clients via script.aws ...

    return { ok: true, rows: 0 };
  },
);
```

Deploy with `M3L_DEPLOYMENT_MODE=standalone` and `M3L_BASE_DIR=/tmp` set on the
function, and the same code that runs as a CLI script runs unchanged as a
Lambda handler.

## See also

- [`Core.M3LScript` reference](../reference/core/script.md)
- [`config` reference](../reference/core/config.md)
- [Guide: Environments and paths](./environments-and-paths.md)
- [Guide: Writing a script](./writing-a-script.md)
- [Getting Started](../getting-started.md)
- [Architecture overview](../m3l-common-architecture.md)
