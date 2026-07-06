# Security policy

## Supported versions

Only the latest state of the `main` branch is supported. This package is
internal and not published to npm.

| Version          | Supported               |
| ---------------- | ----------------------- |
| `main` (current) | latest commit on `main` |

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Report security issues privately via
[GitHub Security Advisories](https://github.com/monte3l/m3l-automation/security/advisories/new).
The maintainer will acknowledge the report within 72 hours and coordinate a
disclosure timeline.

## CI security posture

- **Secret scanning** — enabled on the repository; pushes containing known
  secret patterns are blocked automatically.
- **Dependency review** — the `dependency-review` workflow runs on every PR to
  `main` and blocks merges that introduce HIGH or CRITICAL vulnerability
  advisories.
- **Dependabot** — grouped weekly updates cover the toolchain and
  commit-tooling dependency groups.

CI's only credential is the auto-provided `GITHUB_TOKEN`; tokens of any kind
are never committed to source.
