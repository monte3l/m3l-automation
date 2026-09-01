# Work log — V3, secrets delivery through the spawn environment (2026-09-01)

Issue #540, ADR-0058's first recorded gate. Shipped across two PRs: the
gating ADR (docs only) and this one (implementation + close-out).

## Summary

`m3l` no longer writes a `secret: true` parameter's value into the spawned
child's argv. It goes into the child's **environment** instead, under the
SCREAMING_SNAKE_CASE name the library's own provider chain already reads at
level 4 — so **no consumer script changed**, and none had to.

The leak this closes was real and verified in the tree before the change:
`translateArgv` emitted every declared parameter as `--name=value` with no
branch on `descriptor.secret`, and `spawnScript` called
`node:child_process.spawn` with **no `env` option at all**. Plaintext
therefore landed in `/proc/<pid>/cmdline`, which is world-readable.
`docs/reference/cli.md` had carried an explicit "Delivery caveat" admitting
it — advising users to leave the wizard's own masked secret prompt blank.

Also shipped: `--env-file <path>` / `--no-env-file`, closing the gate's
second half (the hardcoded, passive `--env-file-if-exists=.env`). Default
behaviour is unchanged.

One additive Core barrel export (`deriveEnvVarName`, semver-minor); Core
count unchanged, no new `exports` subpath, `check:api` did not move.

## What went as planned

- **The no-consumer-change bet held exactly.**
  `M3LScriptConfigLoader.load` already wires
  `M3LEnvironmentConfigProvider` at level 4, and that provider already
  derived `CANONICAL_NAME` from `canonical.name`. Injecting under the same
  derived key meant all 17 scripts kept working untouched. This was checked
  against the source before the ADR was written, not assumed from it.
- **Returning `{ argv, secretEnv }` rather than adding a second function.**
  The invariant that matters — "a declared parameter's value is in exactly
  one of these" — is only checkable in one place if both halves are produced
  in one place. It also made the collision guard have somewhere obvious to
  live.
- **`printUsage` → `cli/usage.ts` was decided up front, not discovered.**
  `main.ts` was 22,603 bytes against `check:file-budget`'s 25,000-byte
  ceiling with no baseline entry. Threading `envFile` through 14 signatures
  took it to 24,253 — 747 bytes of headroom, which is not headroom. Moving
  the usage text out (a sanctioned `src/cli/` layer, no gate impact) brought
  it to **22,599**, marginally _below_ where it started.

## What diverged, and why

### The mutation test was the point, and it earned its keep

Deleting the secret branch in `translateArgv` turned **10** tests red in
`dynamic-argv.test.ts` — and left `wizard.test.ts` entirely green, because
that file mocks `translateArgv` wholesale. That is the exact shape of the
"silently inert hardening" risk: a suite that only asserts "the secret
reached the environment" passes whether or not the argv token was dropped,
and argv outranks env, so the leak would have survived a green build.

The fix was not to unmock the wizard (its mock is load-bearing for the
prompt-flow tests) but to add an **end-to-end, unmocked** case in
`dynamic.test.ts` that drives the real split through a full dispatch and
asserts `JSON.stringify(forwardedArgv)` does not contain the secret. The
wizard test then asserts only what it can: that whatever `translateArgv`
returns is _routed_ correctly on the second spawn path.

### Assert on the whole array, never `.includes` of the flag name

Every negative assertion in this change tests the stringified argv array,
not `expect(argv).not.toContain("--api-token")`. The failure mode is the
_value_ surviving anywhere in the tokens, and a flag-name check would pass
on `["--api-token=hunter2"]` if the name were ever reformatted.

### A collision class that did not exist before this change

`api.token` and `api-token` are two distinct, individually legal declared
parameters that both derive `API_TOKEN`. Before ADR-0085 nothing derived
anything, so they merely coexisted. After it, injecting one as a secret
would silently satisfy the _other_ parameter whenever that other one was
absent from argv — a swapped secret, delivered quietly. No fleet script
declares such a pair today; `assertNoEnvVarNameCollision` is what keeps that
true. It rejects only pairs where at least one side is secret: failing on
two colliding non-secrets would break scripts this change has no business
breaking.

### `--env-file` had to be stripped earlier than its siblings

`--json` and `--in-process` are partitioned inside `runDynamic`.
`--env-file` cannot be, because `parseStaticCommandArgs` runs `parseArgs`
with `strict: false`: an unstripped detached `--env-file staging.env` is
absorbed as a bare boolean and its value falls into `positionals`, so
`m3l run --env-file staging.env json-etl` would resolve **"staging.env"** as
the script name. Stripping in `dispatch`, ahead of the static/dynamic split,
is a correctness requirement rather than a tidiness preference — and it has
its own named regression test.

### A `BOOL` secret needed a decision, not a crash

A boolean carries no secret payload, only the fact that a flag was set —
which its presence in the argv already reveals. Encoding it as
`"true"`/`"false"` in the environment would also make the absent case
ambiguous. It is treated as non-secret for delivery and stays a bare
`--name` flag, documented in TSDoc at the seam and in `cli.md`.

### The wizard's mock made the first fourteen tests fail for the wrong reason

`runWizard` destructures `translateArgv`'s result, so the bare `vi.fn()`
returning `undefined` threw before reaching anything those tests assert.
Typing the hoisted mock to fix it broke nine _other_ tests, whose
`.mock.calls[0] as [descriptors, values]` casts relied on the mock's
parameters being `any[]`. The working answer was to leave the mock untyped
and seed the default return in a `beforeEach` — `afterEach` would have left
the file's very first test unseeded.

## Lessons

- **A mocked seam cannot guard the thing it mocks.** If a test file mocks
  the function under change, the guarding test belongs in a file that
  doesn't — and the mutation test is how you find out which file that is.
  ([ADR-0085](../adr/0085-cli-secret-delivery-via-spawn-env.md) names this as
  the invariant the whole change rests on.)
- **Tightening a mock's type is a breaking change to its call sites.**
  `vi.fn()`'s `any[]` parameters are load-bearing for every
  `.mock.calls[0] as [...]` cast in the file.
- **Check the file budget before threading a parameter, not after.** A
  parameter added to 14 signatures cost ~1.7 KB; the extraction that paid for
  it was a two-minute change when planned and would have been a rebase when
  discovered at push time.
- **`strict: false` `parseArgs` silently reshapes positionals.** Any new
  value-taking reserved flag must be stripped before it, and the test that
  proves it must assert the resolved _script name_, not just the flag.

## Verification

`pnpm build`, `pnpm typecheck`, `pnpm test:coverage` (14,300 tests),
`pnpm verify`, `npx vitest run -c vitest.bin.config.ts`, plus
`check:cli-docs`, `check:file-budget`, `check:review-size`, `check:index`,
`check:provenance`, `check:test-counts`, `check:tracker-status`,
`check:hub-keys`.

The end-to-end proof, run against a real child spawned through the shipped
`translateArgv` → `spawnScript` chain, with the child reading its own
`/proc/self/cmdline` and resolving the parameter back through the real
`M3LEnvironmentConfigProvider`:

```text
BEFORE (argv delivery, reproduced deliberately)
  cmdline: node dist/main.js --region=eu-west-1 --api-token=hunter2-…
  resolvedApiToken: undefined

AFTER (env delivery)
  cmdline: node dist/main.js --region=eu-west-1
  resolvedApiToken: "hunter2-…"
```

The secret is gone from the command line and the script still resolves it.
The permission asymmetry the ADR rests on was measured on this host rather
than assumed: `/proc/self/cmdline` is mode **444**, `/proc/self/environ` is
mode **400**.
