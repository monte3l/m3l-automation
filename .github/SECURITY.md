# Security policy

## Supported versions

Only the latest release on the `main` branch is supported. This project follows
strict semver; breaking changes are reserved for major releases.

| Version                       | Supported                                 |
| ----------------------------- | ----------------------------------------- |
| `0.0.0-development` (current) | pre-release — no stability guarantees yet |

Once the first stable release ships, this table will reflect the supported
release range.

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
- **Dependabot** — grouped weekly updates cover both the toolchain and
  release-tooling dependency groups.

Tokens (`NPM_TOKEN`, `GITHUB_TOKEN`) exist only in the CI environment and are
never committed to source.
