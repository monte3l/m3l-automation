# 0085. CLI secret delivery via the spawn environment, not argv

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** repo maintainer

## Context and problem statement

[ADR-0058](./0058-agent-operator-programme.md) recorded a deliberate gate: a
**secrets-delivery mechanism beyond argv/.env**, named as a prerequisite for
unattended Stage-3 operation with secret-bearing scripts. This ADR fires that
gate and settles the mechanism.

The gap is concrete and still present. Every declared parameter — including one
marked `secret: true` — is translated into a `--name=value` argv token by
`translateArgv` (`packages/m3l-cli/src/commands/dynamic-argv.ts`), and
`spawnScript` (`packages/m3l-cli/src/run/spawn.ts`) hands that token list to
`node:child_process.spawn` with **no `env` option at all**. A secret's
plaintext therefore lands in `/proc/<pid>/cmdline`, which is world-readable on
Linux: any local account can `cat` it for the lifetime of the child. The repo
already admits this in prose — `docs/reference/cli.md` carries an explicit
"Delivery caveat" telling wizard users to leave a secret prompt blank and use
`.env` instead.

Everything else in the secret chain is already careful. The wizard prompts
through a masked `prompt.password()`, the confirmation summary routes every
value through `redactSensitiveLogValue`, `writePreset` is fail-closed and
refuses to persist a secret at all, `load-config` masks a secret's
`defaultValue`, and shell completion never emits one. **The last hop into argv
is the only remaining leak.**

The second half of the gate is the passive `.env`. `spawnScript` hardcodes
`--env-file-if-exists=.env` into the child's node argv, so every spawned script
auto-loads `./.env` from its own directory with no flag, no opt-out, and no way
to point somewhere else. That is convenient and, today, undocumented as a
behaviour a caller can control — an agent operator running unattended has no
way to say "load this env file" or "load none".

## Decision drivers

- **Close the leak that actually exists**, without inventing a secret-store
  dependency the repo has no named consumer for — the same
  against-a-named-consumer discipline [ADR-0039](./0039-llm-integration-out-of-scope.md)
  applied to Bedrock.
- **No change to any of the 17 consumer scripts.** Whatever the CLI does must
  land on a resolution path the library already has.
- **Minimal runtime dependencies** (a non-negotiable in `CLAUDE.md`): a
  secret-store client is a dependency; an environment variable is not.
- **Honest threat modelling.** A hardening step that is described as more than
  it is becomes the reason the next, real step never gets taken.
- **The hardening must not be silently inert.** Config resolution ranks argv
  _above_ environment variables, so any mechanism that adds an env delivery
  without removing the argv token changes nothing observable.

## Considered options

1. **Keep argv delivery; document the caveat harder.** Zero code, zero risk,
   and the status quo. Rejected: the caveat's own advice ("leave the prompt
   blank and use `.env`") tells the user not to use a feature the CLI ships —
   the wizard's masked secret prompt — which is an admission the feature is
   unsafe as built. It also leaves V11 (unattended operation) blocked with no
   path forward.

2. **Inject a secret into the child's environment at spawn; drop its argv
   token.** A `secret: true` parameter's value moves out of the `argv` array
   and into the child's `env` under the SCREAMING_SNAKE_CASE name the library
   already derives from the config key. `/proc/<pid>/environ` is mode `0400`
   and readable only by the process owner (and root), where `cmdline` is
   world-readable. Requires no consumer-script change:
   `M3LScriptConfigLoader` already resolves argv (1) > config files (2–3) >
   **environment variables (4)** > extra (5) > preset (6), and
   `M3LEnvironmentConfigProvider` already derives the variable name from the
   key.

3. **Local secret references — `@file:<path>` / `@env:<name>` indirection in
   the argv token.** The argv carries a _pointer_, the script dereferences it.
   Rejected for now: it needs a resolution contract in every consumer script
   (or a library-side loader hook), which is a far larger blast radius than
   option 2 for the same threat model — and a `@file:` pointer in a
   world-readable `cmdline` still tells an observer exactly which file to try
   to read.

4. **AWS Secrets Manager / SSM Parameter Store resolution.** The CLI resolves a
   secret reference against a managed store at spawn time. This is the
   genuinely stronger answer — rotation, audit trail, IAM-scoped access — and
   it is the right eventual destination. Rejected _now_: it adds an AWS runtime
   dependency to the CLI's spawn path, needs its own credential-resolution and
   failure-mode design, and has no named consumer today. Building it ahead of
   one would repeat exactly the mistake ADR-0039 recorded.

## Decision

We chose **option 2: environment injection at spawn**, and we pair it with an
explicit `--env-file` / `--no-env-file` control for the `.env` half of the gate.

**Secret delivery.** `translateArgv` returns both halves of the invocation —
the `argv` tokens and a `secretEnv` map — so the invariant "a declared
parameter's value is in exactly one of these" lives in one place rather than
being spread across two functions that can drift. A descriptor with
`secret === true` routes to `secretEnv[deriveEnvVarName(descriptor.name)]`;
everything else keeps going to `argv`. `spawnScript` spawns with
`env: { ...baseEnv, ...secretEnv }` — inherit the parent environment, then
overlay — because every existing script relies on inheriting `AWS_*`, `PATH`,
and friends; a curated allowlist would break them all.

**Dropping the argv token is required, not optional.** Argv outranks
environment variables in `M3LScriptConfigLoader`'s precedence chain, so a
parameter emitted both ways would still resolve from argv and the hardening
would be silently inert while every "the secret is in the env" test passed.
That is the single invariant this decision most depends on, and it is
mutation-tested.

**The env-name derivation is promoted, not duplicated.** `toEnvKey` is today a
module-private helper inside `M3LEnvironmentConfigProvider`. The CLI needs the
identical derivation, and two copies of a one-line regex across two packages is
a silent-drift hazard. It becomes
`Core.deriveEnvVarName(key: string): string` in
`packages/m3l-common/src/core/config/`, with the provider importing it so there
is exactly one implementation. This follows the precedent of commit `a41cb6be`,
which promoted the script-introspection seam out of `m3l-cli` into
`core/config`. It surfaces through the **Core namespace barrel**, never a new
`exports` subpath.

**A `BOOL` secret is a contradiction, and must not crash.** A boolean carries
no secret payload, so a `secret: true` BOOL parameter is treated as non-secret
for delivery purposes and keeps going to argv as a bare `--name` flag. This is
documented in TSDoc at the seam rather than being an unstated edge.

**The `.env` half.** Two new CLI-reserved flags join `--json` and
`--in-process` in `packages/m3l-cli/src/cli/flags.ts` (stripped before the
script's own strict `parseArgs` ever sees them):

- default, no flag → `--env-file-if-exists=.env` (**behaviour unchanged**);
- `--no-env-file` → no env-file token at all;
- `--env-file=<path>` (or `--env-file <path>`) → `--env-file-if-exists=<path>`.

A caller-supplied path keeps the `-if-exists` form deliberately: a typo'd path
stays a soft miss, exactly as today, rather than becoming a hard node startup
crash. Passing **both** flags is an error (`ERR_CLI_INVALID_PARAMETER_VALUE`,
exit `2`) rather than "last wins" — last-wins would hide a mistake in the
argument list of a command that is about to receive secrets.

**The in-process path (`--in-process`, ADR-0054) is unaffected.** There is no
child process and no argv: `buildParameterValues` hands a typed in-memory
record straight to the command module. Nothing leaks and nothing needs
injecting; a test pins this so a future refactor cannot regress it.

**Options 3 and 4 stay gated.** Secret-store resolution is _not_ declared
unnecessary by this decision — it is deferred for want of a named consumer.
This ADR is the record to re-open when one appears (a shared/CI host where
process-owner isolation is not enough, or a rotation/audit requirement).

### What this buys, and what it does not

`/proc/<pid>/environ` is `0400`, owner-uid only; `/proc/<pid>/cmdline` is
world-readable. So this defeats **a co-tenant `ps` or `/proc` reader** — an
unprivileged account on the same host, the shell-history-adjacent shoulder
surf, a `ps aux` in someone else's terminal recording.

It does **not** defend against:

- **root**, which reads any `/proc/<pid>/environ`;
- **the same user** — a debugger, another process of the same uid, or a core
  dump;
- **the child itself** leaking its own environment (a crash reporter, a
  `console.log(process.env)`, a subprocess it spawns with inherited env);
- **anything at rest** — a secret in a `.env` file is still a secret in a file.

That honesty is the whole reason option 4 stays gated rather than being quietly
declared unnecessary. This is a real reduction in exposure surface, not a
secrets-management solution.

## Consequences

- **Positive:** the last plaintext-secret hop into a world-readable
  `/proc/<pid>/cmdline` is closed, on both spawn paths (dynamic dispatch and
  the wizard, which bypasses `executeScript` entirely). The wizard's masked
  secret prompt becomes a feature the docs can recommend instead of one they
  warn against. V11 (scheduled/unattended runs) loses its longest-lead
  blocker. `.env` loading becomes controllable rather than an invisible
  hardcoded behaviour. The env-name derivation has exactly one implementation
  across both packages.
- **Negative / trade-offs:** `translateArgv`'s return type changes shape, which
  touches both spawn call sites and the wizard's existing wholesale mock of it.
  `spawnScript` gains an injected `env` seam, and `M3LCliCommandContext` gains
  a `readonly env` field so the base environment is injectable rather than read
  as a global inside `spawn.ts` (following how `outputDirPath` was added for
  V2). The protection is uid-scoped, as stated above — a reader of this ADR who
  needs more must open option 4.
- **Semver impact:** **minor** on `@m3l-automation/m3l-common` — one additive
  Core export (`deriveEnvVarName`) surfaced through the namespace barrel, no
  `exports`-map change, no existing signature altered. On `m3l-cli` it is a
  **behaviour change**: a `secret: true` parameter's value stops appearing in
  the spawned child's argv and starts appearing in its environment. Since the
  library's own resolution chain reads both, and env is strictly lower
  precedence than the argv it replaces, no consumer script changes — but a
  caller that was scraping the child's `cmdline` for a secret would notice, and
  that is the point.

## Links

- Supersedes / superseded by: none
- Gate fired: [ADR-0058 (agent-operator programme)](./0058-agent-operator-programme.md)
  § "Deliberately gated behind future ADRs" — see its 2026-09-01 Update block.
- Related: [ADR-0039 (LLM integration out of scope)](./0039-llm-integration-out-of-scope.md)
  (the against-a-named-consumer discipline options 3 and 4 are held to),
  [ADR-0054 (command-module contract and hybrid execution)](./0054-command-module-contract-and-hybrid-execution.md)
  (the in-process path this decision leaves untouched),
  [ADR-0062 (runtime MCP surface)](./0062-runtime-mcp-surface.md)
  (the programme's other recorded gate, still closed).
- Tracker: `docs/plans/IMPLEMENTATION.md` § _Agent-operator wave (V-series)_
  row **V3**; detail in
  [`docs/plans/2026-08-20-agent-operator.md`](../plans/2026-08-20-agent-operator.md)
  § V3.
