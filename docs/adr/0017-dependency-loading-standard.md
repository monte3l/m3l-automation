# 0017. Dependency loading, declaration, and pinning standard

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Enrico Lionello

## Context and problem statement

When ADR-0007 was written, `m3l-common` carried zero runtime production
dependencies. That is no longer true: the implemented submodules now pull in
`yaml`, `undici`, `csv-parse`, `csv-stringify`, `string-width`,
`@inquirer/prompts`, `better-sqlite3`, the AWS SDK v3 (14 `@aws-sdk/client-*`
packages plus `@aws-sdk/credential-provider-ini`, `@aws-sdk/client-sts`, and
`@aws-sdk/credential-providers`), and six document-extraction libraries
(`mammoth`, `unpdf`, `read-excel-file`, `mailparser`, `cheerio`, `adm-zip`).

Two different strategies grew up organically, with no written rule to say which
applies when:

- **Hard `dependencies` + static import** — `yaml`, `undici`, `csv-parse`,
  `csv-stringify`, `string-width`, `@inquirer/prompts`, `better-sqlite3`, and the
  AWS SDK client packages.
- **Optional `peerDependencies` (+ `peerDependenciesMeta.optional`) + lazy
  `await import()` behind a typed missing-dependency error** — the six text
  extractors and `@aws-sdk/credential-providers`.

Because the choice was made per-submodule rather than by policy, the AWS SDK
ended up declared **both** ways: `@aws-sdk/client-sts` is a hard dependency yet
`aws/credentials` lazy-loads it and its TSDoc/error messages call it an "optional
peer," while `@aws-sdk/credential-providers` really was declared optional. Version
pinning was equally unruled — some deps exact-pinned, others caret-ranged, with no
stated reason.

This ADR fixes the standard so the next dependency has an obvious, enforceable
home, and reconciles the existing declarations to it.

## Decision drivers

- Minimal runtime footprint and a shallow, tree-shakeable import graph
  (`"sideEffects": false`; "avoid pulling a heavy dependency into the main entry").
- A predictable, reproducible install (the lockfile is authoritative).
- Ergonomics of the public API must not regress to satisfy a packaging rule.
- The rule must be mechanically checkable so it does not drift again
  (`bin/check-deps.mjs`).
- No breaking change to the `exports` contract or any exported signature.

## Considered options

1. **Tier by raw weight** — force every "heavy" dependency (by install size) into
   optional-peer + lazy. Rejected: it would drag genuinely required, heavily-used
   dependencies (e.g. the AWS SDK behind the `aws` namespace) into an optional,
   consumer-installs-it-themselves model and, for `aws/clients`, force a breaking
   redesign of its synchronous client getters into async accessors — a large,
   ergonomics-degrading change to a just-shipped module for a marginal packaging
   win.

2. **Everything hard `dependencies` + static** — simplest, but always installs the
   six document extractors even for consumers who never parse a PDF or spreadsheet,
   and forfeits the graceful "install the extra you need" experience the extractors
   already provide.

3. **Tier by _required vs optional_ intent, with loading left free for required
   deps** — declare by whether the library needs the dependency to fulfil its
   stated purpose, not by size; mandate the graceful lazy pattern only where the
   dependency is genuinely optional. Keeps required-but-heavy dependencies hard and
   ergonomic while still letting an author lazy-load one for cold-start reasons.

## Decision

We chose **option 3**.

### The standard

- **Required dependency** — the library cannot fulfil its declared purpose without
  it. Declare in hard `dependencies`, **exact-pinned** (no range). _Loading is the
  author's choice_: a static top-level `import` by default, but a lazy
  `await import()` is explicitly permitted — and encouraged — where it avoids
  paying a heavy module's parse/eval cost on a cold start that does not use it
  (e.g. `core/script`'s dynamic `import("../../aws/clients/index.js")`, gated on an
  `aws.profile` being declared, and the credentials manager's memoized SDK
  loaders). Lazily loading a _guaranteed-present_ dependency is a performance
  choice, not a contract; it does not make the dependency optional.

- **Optional dependency** — a feature only some consumers use, and the library
  degrades gracefully without it. Declare in `peerDependencies` **and**
  `peerDependenciesMeta.optional`, **caret-ranged** (the consumer resolves the
  version — pinning a peer to an exact version is wrong). It **must** be loaded via
  lazy `await import()` wrapped so an absent package surfaces as a typed
  `M3LError` subclass carrying an `ERR_*_MISSING_DEP`-style code naming the missing
  package — never a raw `ERR_MODULE_NOT_FOUND`. The six `core/text` extractors are
  the reference implementation.

- **Pinning** — every `dependencies` entry is exact; every `peerDependencies`
  entry is caret-ranged. Dependabot (ADR-0007) owns the bumps.

### The AWS SDK is a required, first-class dependency (the documented exception)

The AWS SDK is heavy, but it is **required**, not optional: AWS integration is a
first-class purpose of this package (the `aws` namespace and `script.aws`). It
stays in hard `dependencies` with `aws/clients`' synchronous client getters
intact, for three reasons:

- The sync getters (`provider.s3`, no `await`) are the ergonomic feature; making
  them async to enable lazy-loading would degrade every call site permanently.
- The eager-load cost is narrow and opt-out-able. Only importing the **root `.`
  entry** in unbundled Node eagerly evaluates the SDK (via
  `export * as AWS`); consumers who want only core import
  `@m3l-automation/m3l-common/core`, which has no edge to `aws`. `core/script`
  already reaches `aws/clients` through a dynamic import, so the framework's own
  hot path is already lazy.
- A bundler drops the unused `AWS` namespace anyway (`"sideEffects": false`).

Consequently **all** AWS SDK packages are hard `dependencies`. This ADR moves
`@aws-sdk/credential-providers` from optional `peerDependencies` into hard
`dependencies`, and the false "optional peer" wording in
`aws/credentials/manager.ts` is corrected. The manager keeps its memoized lazy
loaders (a permitted cold-start optimisation for a required dep) and its defensive
load-failure error (a corrupt install of even a required package is worth a typed
error).

### Enforcement

`bin/check-deps.mjs` (`pnpm check:deps`, already in CI) is extended to fail when a
`dependencies` entry is not exact-pinned, or when an optional peer is not listed in
both `peerDependencies` and `peerDependenciesMeta.optional`.

## Consequences

- **Positive:** every future dependency has one obvious home; the AWS SDK is
  declared one way; the graceful lazy pattern is required exactly where it earns
  its keep; the rule is machine-checked so it cannot silently drift. The
  `.claude/rules/library-src.md` extract surfaces the rule at edit time.
- **Negative / trade-offs:** the "avoid heavy deps in the main entry" ideal is
  knowingly not met for the root `.` entry in unbundled Node — accepted, because
  the `/core` subpath is the opt-out and the AWS DX is worth it. Lazily-loading a
  required dep leaves a defensive missing-dependency branch that, for a hard dep,
  fires only on a corrupt install.
- **Semver impact:** none. No exported signature or `exports` entry changes;
  moving `@aws-sdk/credential-providers` to `dependencies` only widens what is
  guaranteed-installed for consumers, and the pin normalisation and wording fixes
  are non-breaking.

## Links

- Related: ADR-0004 (three-entry `exports` map), ADR-0007 (dependency monitoring
  and security gating — this ADR supersedes its "zero runtime dependencies"
  premise), `bin/check-deps.mjs`, `.claude/rules/library-src.md`,
  `packages/m3l-common/src/core/text/*` (reference optional-peer pattern),
  `packages/m3l-common/src/aws/clients/provider.ts` (required-hard + sync getters).
