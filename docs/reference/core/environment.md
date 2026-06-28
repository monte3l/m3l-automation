# `environment` — Runtime and deployment-mode detection

The `environment` module detects how and where a script is running — local terminal, CI, or an AWS-managed compute environment — and whether it lives inside a monorepo or a standalone deployment. The result drives interactive-vs-plain rendering, path resolution, and AWS credential handling.

## Overview

`M3LExecutionEnvironment.detect()` inspects environment variables and filesystem markers to produce a cached `M3LExecutionEnvironmentInfo`. The info object exposes capability flags (interactive, AWS-managed, can prompt, can open browser, requires AWS profile), the detected environment type, deployment mode, and the raw detection signals used to reach those conclusions.

## Public API

Exported from `@m3l-automation/m3l-common/core` (the `environment` sub-module):

- `M3LExecutionEnvironment`
- `M3LEnv`
- `M3LExecutionEnvironmentType`
- `M3LDeploymentMode`
- `M3LCredentialSource`
- `M3LExecutionEnvironmentInfo`
- `M3LEnvironmentDetectionDetails`

## Detection and caching

`M3LExecutionEnvironment.detect()` returns a cached `M3LExecutionEnvironmentInfo`. The detection result is a process-global singleton, so repeated calls are cheap and consistent across a process. Call `detectFresh()` to force re-detection when the environment may have changed.

## Monorepo vs. standalone detection

Monorepo detection walks upward from `cwd`, searching for a `pnpm-workspace.yaml` or a `package.json` with a `workspaces` field. If one is found, `deploymentMode` is `MONOREPO` and the discovered root path is recorded. Otherwise the deployment mode is `STANDALONE`. These values come from `M3LDeploymentMode`.

## Environment types

`M3LExecutionEnvironmentType` values:

- `LOCAL_INTERACTIVE`
- `CI`
- `AWS_LAMBDA`
- `AWS_ECS`
- `AWS_EC2`
- `AWS_CODEBUILD`
- `UNKNOWN`

## Credential sources

`M3LCredentialSource` values describe how AWS credentials are expected to be supplied in the detected environment:

- `SSO_PROFILE`
- `ENVIRONMENT`
- `CONTAINER`
- `INSTANCE_METADATA`
- `WEB_IDENTITY`
- `DEFAULT_CHAIN`
- `NONE`

## Environment info and detection details

`M3LExecutionEnvironmentInfo` includes the capability flags:

- `isInteractive`
- `isAWSManaged`
- `canPromptUser`
- `canOpenBrowser`
- `requiresAwsProfile`

It also carries a `detectionDetails` field (`M3LEnvironmentDetectionDetails`) exposing the raw signals behind the decision — TTY flags, CI environment variables, AWS metadata endpoint presence, and similar markers. Inspect these when you need to understand or debug why a particular environment type or mode was chosen.

## Usage example

```typescript
import { Core } from "@m3l-automation/m3l-common";

const info = Core.M3LExecutionEnvironment.detect();

if (info.isInteractive && info.canPromptUser) {
  // safe to show spinners and ask for input
}

if (info.environmentType === Core.M3LExecutionEnvironmentType.AWS_LAMBDA) {
  // running in Lambda; prefer plain-text logging
}

// Force re-detection after changing the environment
const refreshed = Core.M3LExecutionEnvironment.detectFresh();
```

The property accesses above (`environmentType`) illustrate documented fields; the example is illustrative where the overview does not pin an exact accessor name.

## Notes and behavior

- The detection result is cached as a process-global singleton; use `detectFresh()` to refresh it.
- Capability flags such as `isInteractive` are consulted elsewhere in the library (for example, spinner and console-logging rendering) to choose between ANSI-rich and plain-text output.
- Deployment mode feeds path resolution in the `utils` module.

## See also

- [script](./script.md)
- [config](./config.md)
- [utils](./utils.md)
- [Guide: Environments and paths](../../guides/environments-and-paths.md)
- [Architecture overview](../../m3l-common-architecture.md)
