# AWS Models

Shared AWS model types used across the `AWS` namespace — primarily by the credentials manager and the client providers.

## Overview

`libs/aws/models/` holds the shared AWS model types that the rest of the `AWS` namespace builds on. These are the cross-cutting type definitions that the credentials manager and client providers exchange, rather than a separate runtime feature.

Examples of the kinds of types that live in this shared layer include the credential error-analysis and login-result types surfaced by the credentials manager. The concrete types are documented alongside the components that produce and consume them (see the links below).

## Public API

The shared AWS model types are exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace). The concrete, named types are defined and documented next to the components they describe:

- Credential-related types — `M3LAWSCredentialsErrorType`, `M3LAWSCredentialsErrorAnalysis`, `M3LAWSRetryContext`, `M3LAWSLoginResult`, and `M3LAWSCredentialsManagerOptions` — are documented in [AWS credentials](./credentials.md).
- Client-provider configuration and the providers themselves are documented in [AWS clients](./clients.md).

## Notes and behavior

- These types form the shared vocabulary used by the credentials manager and the client providers; they are not a standalone runtime feature.
- For exact symbol names, fields, and usage, refer to the component pages where each type is defined.

## See also

- [AWS credentials](./credentials.md) — credential management types and behavior.
- [AWS clients](./clients.md) — SDK client providers.
