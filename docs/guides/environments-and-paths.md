# Runtime environments and filesystem layout

This guide explains how a script discovers _where_ it is running and
_where_ it should read and write files. Two modules cooperate:
`Core.M3LExecutionEnvironment` detects the execution environment and
deployment mode, and `Core.M3LPaths` resolves the standard directories
based on that mode. Both honour a set of `M3L_*` environment-variable
overrides.

All examples are ESM. Import from the namespace
(`import { Core } from "@m3l-automation/m3l-common";`) or from the
`./core` subpath.

## Detecting the environment

`Core.M3LExecutionEnvironment.detect()` inspects environment variables
and filesystem markers and returns a cached `M3LExecutionEnvironmentInfo`.
The result is a process-global singleton, so repeated calls are cheap and
consistent; call `detectFresh()` to force re-detection if the environment
may have changed.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const info = Core.M3LExecutionEnvironment.detect();

if (info.isInteractive && info.canPromptUser) {
  // safe to show spinners and ask for input
}
```

### Environment types

`M3LExecutionEnvironmentType` classifies the compute environment:

- `LOCAL_INTERACTIVE`
- `CI`
- `AWS_LAMBDA`
- `AWS_ECS`
- `AWS_EC2`
- `AWS_CODEBUILD`
- `UNKNOWN`

### Credential sources

`M3LCredentialSource` describes how AWS credentials are expected to be
supplied in the detected environment:

- `SSO_PROFILE`
- `ENVIRONMENT`
- `CONTAINER`
- `INSTANCE_METADATA`
- `WEB_IDENTITY`
- `DEFAULT_CHAIN`
- `NONE`

### Capability flags and detection details

`M3LExecutionEnvironmentInfo` carries capability flags you can branch on
without re-implementing environment sniffing:

- `isInteractive`
- `isAWSManaged`
- `canPromptUser`
- `canOpenBrowser`
- `requiresAwsProfile`

It also exposes a `detectionDetails` field (`M3LEnvironmentDetectionDetails`)
with the raw signals behind the decision — TTY flags, CI environment
variables, the presence of the AWS metadata endpoint, and similar markers.
Inspect these when you need to understand or debug why a particular type
or mode was chosen. The same flags drive the library's own
interactive-vs-plain rendering (for example, spinners and console
logging).

## Monorepo vs. standalone detection

Deployment mode tells `M3LPaths` which directory layout to use.
`M3LExecutionEnvironment` detects it by walking upward from `cwd`,
searching for a `pnpm-workspace.yaml` or a `package.json` with a
`workspaces` field:

- If one is found, `deploymentMode` is `MONOREPO` and the discovered root
  path is recorded.
- Otherwise it is `STANDALONE`.

These values come from `M3LDeploymentMode`. You can force the mode
explicitly with the `M3L_DEPLOYMENT_MODE` environment variable (see
below), which takes precedence over detection.

## Resolving directories with `M3LPaths`

`Core.M3LPaths` resolves the standard project directories — data, config,
input, output, and cache — relative to the detected deployment mode. The
`M3LPathType` type names the directory kinds.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const paths = new Core.M3LPaths();

const inputDir = paths.getInputDir();
const outputDir = paths.getOutputDir();
```

### Monorepo layout

Inside the monorepo, directories hang off the discovered root, scoped per
script:

```text
m3l-automation/
  data/{script-name}/
    config/ · input/ · output/{timestamp}/ · cache/
```

### Standalone layout

In a standalone deployment (a container, a Lambda, etc.) everything hangs
off a single base directory:

```text
{baseDir}/data/
  config/ · input/ · output/{timestamp}/ · cache/
```

> Note: `getProjectRoot()` throws in standalone mode — there is no
> monorepo root to return. Guard standalone code paths accordingly, and
> only rely on a project root when a real monorepo root exists.

## `M3L_*` environment-variable overrides

Every directory and the deployment mode itself are overridable. The
overrides take precedence over auto-detection and are documented by the
`M3LPathEnvironmentVariables` type:

| Variable              | Overrides                                    |
| --------------------- | -------------------------------------------- |
| `M3L_DATA_DIR`        | Data directory                               |
| `M3L_CONFIG_DIR`      | Config directory                             |
| `M3L_INPUT_DIR`       | Input directory                              |
| `M3L_OUTPUT_DIR`      | Output directory                             |
| `M3L_BASE_DIR`        | Standalone base directory                    |
| `M3L_DEPLOYMENT_MODE` | Forces `monorepo` or `standalone` resolution |

## Date-token output directories

Output paths use date tokens to produce time-stamped directories, which
is the mechanism behind the `output/{timestamp}/` layout above.
`Core.M3LDateTokens` expands tokens such as `{YYYY}`, `{MM}`, and `{DD}`
inside a path template:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const expanded = Core.M3LDateTokens.expand("outputs/{YYYY}-{MM}-{DD}");
// e.g. outputs/2026-06-27
```

Time-stamped output directories keep each run's artifacts separate, so
re-running a script does not overwrite a previous run's output.

## Standalone and Lambda guidance

When a script runs outside the monorepo — in a container image or as a
Lambda — there is no workspace marker to find, so make the mode and base
directory explicit:

- Set `M3L_DEPLOYMENT_MODE=standalone`.
- Set `M3L_BASE_DIR=/app` for a long-lived container, or
  `M3L_BASE_DIR=/tmp` in Lambda, where `/tmp` is the writable location.

With those two variables set, `M3LPaths` produces the standalone layout
under your chosen base directory, and the per-directory `M3L_*_DIR`
overrides above still let you redirect any individual directory if needed.

## See also

- [environment reference](../reference/core/environment.md)
- [utils reference](../reference/core/utils.md)
- [Guide: Configuration](./configuration.md)
- [Guide: Capability index](./capability-index.md)
