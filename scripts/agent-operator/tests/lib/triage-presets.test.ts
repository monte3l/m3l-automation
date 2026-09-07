/**
 * Tests for `lib/triage-presets` — the verification seam that turns an
 * operator-declared `presetAllowlist` into a `VerifiedTriagePresets` brand.
 *
 * Written RED, before `src/lib/triage-presets.ts` exists. Mirrors
 * `tests/steps/build-etl-tools.test.ts`'s idiom: a `captureThrown` helper for
 * synchronous-shaped assertions (here wrapped for the async seam), fixed
 * `M3LAgentOperatorCliError` code assertions rather than message text, and a
 * dedicated never-echo-a-value test built on a distinctive sentinel.
 *
 * `readProvider` is injected exactly as the contract describes — a function
 * from an absolute path to an object exposing `rawKeys()`/`getRawValue(key)`,
 * the same two public methods `Core.M3LYAMLConfigProvider` exposes — so no
 * test in this file touches the filesystem. Every stub below is built from a
 * per-path fixture table keyed by the EXACT absolute path the module under
 * test is expected to hand `readProvider`.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { join } from "node:path";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  TRIAGE_READ_ONLY_OPERATIONS,
  verifyTriagePresets,
} from "../../src/lib/triage-presets.js";
import type {
  TriagePresetReader,
  VerifiedTriagePresets,
  VerifyTriagePresetsDeps,
} from "../../src/lib/triage-presets.js";

/** A canned per-path preset fixture: the own keys `rawKeys()` reports and the values `getRawValue` resolves. */
interface PresetFixture {
  readonly keys: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

/** The provider a caller-supplied `readProvider` returns for one path. */
interface StubProvider {
  rawKeys(): readonly string[];
  getRawValue(key: string): unknown;
}

/** A minimal, otherwise-valid triage preset fixture: no `extends`, no `aws.profile`, a valid `operation`. */
function validFixture(overrides: Partial<PresetFixture> = {}): PresetFixture {
  return {
    keys: ["operation", "alarm"],
    values: { operation: "analyze", alarm: "checkout-5xx" },
    ...overrides,
  };
}

/**
 * Builds a `readProvider` stub from a table keyed by the EXACT absolute path
 * `verifyTriagePresets` is expected to resolve and hand to it. A path
 * requested that has no fixture throws loudly rather than silently
 * defaulting, so a wrong-resolution bug surfaces as a test failure here
 * rather than a confusing empty-keys pass downstream.
 */
function makeReadProvider(
  fixturesByAbsolutePath: ReadonlyMap<string, PresetFixture>,
): (absolutePath: string) => StubProvider {
  return (absolutePath: string): StubProvider => {
    const fixture = fixturesByAbsolutePath.get(absolutePath);
    if (fixture === undefined) {
      throw new Error(`no fixture registered for path: ${absolutePath}`);
    }
    return {
      rawKeys: () => fixture.keys,
      getRawValue: (key: string) => fixture.values[key],
    };
  };
}

/** Captures the thrown value from an async thunk, or `undefined` when it resolves. */
async function captureRejected(
  thunk: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await thunk();
    return undefined;
  } catch (error) {
    return error;
  }
}

const WORKSPACE_ROOT = "/workspace/m3l-automation";

describe("verifyTriagePresets — empty allowlist", () => {
  it("throws ERR_AGENT_OPERATOR_PRESET when presetAllowlist has no entries", async () => {
    const thrown = await captureRejected(() =>
      verifyTriagePresets({
        presetAllowlist: new Map(),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map()),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });
});

describe("verifyTriagePresets — extends own key present", () => {
  // Without this rule, checks 3-4 below would be vacuous: a triage preset is
  // declared a LEAF, and `Core.M3LYAMLConfigProvider` does not follow
  // `extends` — so an inherited `aws.profile` or `operation` would be
  // invisible to the shallow own-key read this module performs. Refusing an
  // own `extends` key is what makes that shallow read complete.
  it("throws ERR_AGENT_OPERATOR_PRESET when the preset declares its own extends key", async () => {
    const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
    const absolutePath = join(WORKSPACE_ROOT, relativePath);
    const thrown = await captureRejected(() =>
      verifyTriagePresets({
        presetAllowlist: new Map([["checkout-5xx", relativePath]]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(
          new Map([
            [
              absolutePath,
              validFixture({
                keys: ["operation", "extends"],
                values: { operation: "analyze", extends: "base.yaml" },
              }),
            ],
          ]),
        ),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });
});

describe("verifyTriagePresets — aws.profile own key present", () => {
  it("throws ERR_AGENT_OPERATOR_PRESET when the preset declares its own aws.profile key", async () => {
    const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
    const absolutePath = join(WORKSPACE_ROOT, relativePath);
    const thrown = await captureRejected(() =>
      verifyTriagePresets({
        presetAllowlist: new Map([["checkout-5xx", relativePath]]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(
          new Map([
            [
              absolutePath,
              validFixture({
                keys: ["operation", "aws.profile"],
                values: { operation: "analyze", "aws.profile": "prod" },
              }),
            ],
          ]),
        ),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });
});

describe("verifyTriagePresets — operation own key", () => {
  const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
  const absolutePath = join(WORKSPACE_ROOT, relativePath);

  function verifyWith(fixture: PresetFixture): Promise<VerifiedTriagePresets> {
    return verifyTriagePresets({
      presetAllowlist: new Map([["checkout-5xx", relativePath]]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[absolutePath, fixture]])),
    });
  }

  it("throws ERR_AGENT_OPERATOR_PRESET when operation is absent", async () => {
    const thrown = await captureRejected(() =>
      verifyWith({ keys: ["alarm"], values: { alarm: "checkout-5xx" } }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });

  it("throws ERR_AGENT_OPERATOR_PRESET when operation is not a string", async () => {
    const thrown = await captureRejected(() =>
      verifyWith({ keys: ["operation"], values: { operation: 42 } }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });

  it('throws ERR_AGENT_OPERATOR_PRESET when operation is "convert" (writes a preset skeleton to disk)', async () => {
    const thrown = await captureRejected(() =>
      verifyWith({ keys: ["operation"], values: { operation: "convert" } }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });

  // Iterates the frozen set itself rather than a hand-written literal, so
  // this stays an accept-proof for whatever `TRIAGE_READ_ONLY_OPERATIONS`
  // actually contains — currently its one member, `analyze`.
  it.each(TRIAGE_READ_ONLY_OPERATIONS)(
    'accepts operation "%s"',
    async (operation) => {
      const verified = await verifyWith({
        keys: ["operation"],
        values: { operation },
      });

      expect(verified.get("checkout-5xx")).toBe(relativePath);
    },
  );

  // `AgentCliSurface.triageRun` unconditionally pins `--operation=analyze`
  // at config precedence level 1 (CLI), so `validate` and `explain` are NOT
  // reachable through this seam even though `cloudwatch-logs-analysis`
  // itself supports them: a preset naming either one would pass this
  // verification step and then fail at the child's config load, because
  // `analyze`'s own `requiredParameters` (`aws.profile`, `alarm`,
  // `triggeredAt`) are not what a `validate`/`explain` preset need carry.
  // Verification must therefore refuse both, not merely decline to name
  // them, so authorization and execution agree on what can run.
  it.each(["validate", "explain"])(
    'throws ERR_AGENT_OPERATOR_PRESET when operation is "%s" (not reachable through triageRun\'s pinned --operation=analyze)',
    async (operation) => {
      const thrown = await captureRejected(() =>
        verifyWith({ keys: ["operation"], values: { operation } }),
      );

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_PRESET",
      );
    },
  );

  // The accepted set has exactly one member — `analyze` — and not three,
  // because `AgentCliSurface.triageRun` pins `--operation=analyze` at config
  // precedence level 1 regardless of what a preset's own `operation` key
  // names. Accepting a verb the seam can never actually run would let
  // verification authorize a request that then dies at the child script's
  // config load; naming the constant's single member keeps verification and
  // execution agreeing on what this seam can run.
  it("TRIAGE_READ_ONLY_OPERATIONS is frozen and is exactly analyze", () => {
    expect(Object.isFrozen(TRIAGE_READ_ONLY_OPERATIONS)).toBe(true);
    expect([...TRIAGE_READ_ONLY_OPERATIONS]).toEqual(["analyze"]);
  });
});

describe("verifyTriagePresets — multi-entry allowlist", () => {
  it("resolves a map with every entry when all are valid", async () => {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ["checkout-5xx", "data/config/presets/triage-checkout-5xx.yaml"],
      ["payments-5xx", "data/config/presets/triage-payments-5xx.yaml"],
    ];
    const fixtures = new Map(
      entries.map(([, relativePath]) => [
        join(WORKSPACE_ROOT, relativePath),
        validFixture(),
      ]),
    );

    const verified = await verifyTriagePresets({
      presetAllowlist: new Map(entries),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(fixtures),
    });

    for (const [name, relativePath] of entries) {
      expect(verified.get(name)).toBe(relativePath);
    }
    expect(verified.size).toBe(entries.length);
  });

  it("throws when the SECOND entry is bad, proving the loop does not stop at the first entry", async () => {
    const firstRelative = "data/config/presets/triage-checkout-5xx.yaml";
    const secondRelative = "data/config/presets/triage-payments-5xx.yaml";
    const firstAbsolute = join(WORKSPACE_ROOT, firstRelative);
    const secondAbsolute = join(WORKSPACE_ROOT, secondRelative);

    const thrown = await captureRejected(() =>
      verifyTriagePresets({
        presetAllowlist: new Map([
          ["checkout-5xx", firstRelative],
          ["payments-5xx", secondRelative],
        ]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(
          new Map([
            [firstAbsolute, validFixture()],
            [
              secondAbsolute,
              validFixture({
                keys: ["operation", "aws.profile"],
                values: { operation: "analyze", "aws.profile": "prod" },
              }),
            ],
          ]),
        ),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_PRESET",
    );
  });
});

describe("verifyTriagePresets — path resolution", () => {
  it("hands readProvider the allowlist's relative path resolved against workspaceRoot, as an exact absolute string", async () => {
    const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
    const expectedAbsolutePath = join(WORKSPACE_ROOT, relativePath);
    const seenPaths: string[] = [];
    const readProvider = vi.fn((absolutePath: string): StubProvider => {
      seenPaths.push(absolutePath);
      return {
        rawKeys: () => validFixture().keys,
        getRawValue: (key: string) => validFixture().values[key],
      };
    });

    await verifyTriagePresets({
      presetAllowlist: new Map([["checkout-5xx", relativePath]]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider,
    });

    expect(seenPaths).toContain(expectedAbsolutePath);
    expect(readProvider).toHaveBeenCalledWith(expectedAbsolutePath);
  });
});

describe("verifyTriagePresets — never echoes a preset VALUE", () => {
  it("does not contain the sentinel value anywhere in the thrown message", async () => {
    const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
    const absolutePath = join(WORKSPACE_ROOT, relativePath);
    const sentinel = "SENTINEL-LEAK-VALUE";

    const thrown = await captureRejected(() =>
      verifyTriagePresets({
        presetAllowlist: new Map([["checkout-5xx", relativePath]]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(
          new Map([
            [
              absolutePath,
              validFixture({
                keys: ["operation", "aws.profile"],
                values: { operation: "analyze", "aws.profile": sentinel },
              }),
            ],
          ]),
        ),
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.message).not.toContain(sentinel);
    expect(JSON.stringify(error.context ?? {})).not.toContain(sentinel);
  });
});

describe("verifyTriagePresets — VerifiedTriagePresets brand", () => {
  it("is not assignable from a plain ReadonlyMap<string, string>", () => {
    expectTypeOf<
      ReadonlyMap<string, string>
    >().not.toExtend<VerifiedTriagePresets>();
  });

  it("verifyTriagePresets's return type unwraps to VerifiedTriagePresets", () => {
    expectTypeOf(verifyTriagePresets).returns.toEqualTypeOf<
      Promise<VerifiedTriagePresets>
    >();
  });
});

// --- Review finding B/security 2: preset file extension is pinned --------
//
// `verifyTriagePresets` always parses through `Core.M3LYAMLConfigProvider`
// (via the injected `readProvider`), but the real run's
// `M3LScriptPresetLoader.parsePresetFile` dispatches on the file's own
// extension: `.yaml`/`.yml` as YAML, anything else — including `.json` — as
// `JSON.parse`. Nothing pins the extension today, so verification and
// execution can read the same bytes through two different parsers.
// `cli-surface.ts`'s own documented example allowlist entry is a `.json`
// path, so this is not a hypothetical shape.
describe("verifyTriagePresets — preset file extension is pinned (security 2)", () => {
  it.each([
    "data/config/presets/triage-checkout-5xx.json",
    "data/config/presets/triage-checkout-5xx",
    "data/config/presets/triage-checkout-5xx.yaml.json",
  ])(
    "throws ERR_AGENT_OPERATOR_PRESET for an allowlist entry not ending in .yaml or .yml: %s",
    async (relativePath) => {
      const absolutePath = join(WORKSPACE_ROOT, relativePath);
      const thrown = await captureRejected(() =>
        verifyTriagePresets({
          presetAllowlist: new Map([["checkout-5xx", relativePath]]),
          workspaceRoot: WORKSPACE_ROOT,
          readProvider: makeReadProvider(
            new Map([[absolutePath, validFixture()]]),
          ),
        }),
      );

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_PRESET",
      );
    },
  );

  it.each([
    "data/config/presets/triage-checkout-5xx.yaml",
    "data/config/presets/triage-checkout-5xx.yml",
  ])("still accepts a well-formed %s entry", async (relativePath) => {
    const absolutePath = join(WORKSPACE_ROOT, relativePath);
    const verified = await verifyTriagePresets({
      presetAllowlist: new Map([["checkout-5xx", relativePath]]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[absolutePath, validFixture()]])),
    });

    expect(verified.get("checkout-5xx")).toBe(relativePath);
  });
});

// --- Review finding B/security 3: containment screen ----------------------
//
// `verifyTriagePresets` does `join(workspaceRoot, relativePath)` and reads,
// with no containment check. It is an exported function taking a bare
// `ReadonlyMap<string, string>`, so a second call site turns it into an
// arbitrary-file-read primitive — exactly the shape `cli-surface.ts`'s
// sibling `resolveAllowedPresetPath` re-checks containment for at its own
// use site. Each case below asserts both the refusal AND that the refusal
// happens BEFORE any read: a containment check that reads first and rejects
// after is not a containment check.
describe("verifyTriagePresets — containment screen (security 3)", () => {
  it.each([
    [
      "a '..' traversal segment",
      "data/config/presets/../../../etc/triage-checkout-5xx.yaml",
    ],
    ["an absolute path", "/etc/triage-checkout-5xx.yaml"],
    [
      "a path outside data/config/presets/",
      "data/config/other/triage-checkout-5xx.yaml",
    ],
  ])(
    "refuses %s without ever calling readProvider",
    async (_label, relativePath) => {
      const readProvider = vi.fn((): StubProvider => ({
        rawKeys: () => validFixture().keys,
        getRawValue: (key: string) => validFixture().values[key],
      }));

      const thrown = await captureRejected(() =>
        verifyTriagePresets({
          presetAllowlist: new Map([["checkout-5xx", relativePath]]),
          workspaceRoot: WORKSPACE_ROOT,
          readProvider,
        }),
      );

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      expect((thrown as M3LAgentOperatorCliError).code).toBe(
        "ERR_AGENT_OPERATOR_PRESET",
      );
      expect(readProvider).not.toHaveBeenCalled();
    },
  );
});

// --- Review finding B/type-design 1: synchronous throw behind a Promise --
//
// `verifyTriagePresets` is declared as a plain (non-`async`) function
// returning `Promise<VerifiedTriagePresets>`. Every refusal in the current
// implementation throws SYNCHRONOUSLY, before any `Promise` is ever
// constructed — so `verifyTriagePresets(x).catch(handler)` never runs
// `handler`, because the call to `verifyTriagePresets` itself throws before
// `.catch` can even be attached. A caller relying on the declared `Promise`
// return type to route failures through rejection, not a synchronous
// `try`/`catch` around the call, silently loses every one of these errors.
describe("verifyTriagePresets — synchronous throw behind a Promise return type (type-design 1)", () => {
  it("rejects rather than throwing synchronously for an empty allowlist", async () => {
    // Call `verifyTriagePresets` exactly ONCE and assert both properties off
    // that single promise. Calling it a second time (once inside
    // `expect(call).not.toThrow()`, again for the `.rejects` assertion) would
    // produce two rejected promises — the first never gets a `.catch`
    // attached, so Node reports it as an unhandled rejection even though
    // every assertion in the test still passes. That's a green test list
    // riding on a run that doesn't actually exit clean.
    let syncThrow: unknown;
    let promise: Promise<VerifiedTriagePresets> | undefined;
    try {
      promise = verifyTriagePresets({
        presetAllowlist: new Map(),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(new Map()),
      });
    } catch (cause) {
      syncThrow = cause;
    }

    // A synchronous throw would have populated `syncThrow` and left
    // `promise` undefined.
    expect(syncThrow).toBeUndefined();
    await expect(promise).rejects.toThrow(M3LAgentOperatorCliError);
  });

  it("rejects rather than throwing synchronously when a preset declares its own extends key", async () => {
    const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
    const absolutePath = join(WORKSPACE_ROOT, relativePath);

    // Same single-call shape as above — see the comment there for why a
    // second call would leave the first rejection unhandled.
    let syncThrow: unknown;
    let promise: Promise<VerifiedTriagePresets> | undefined;
    try {
      promise = verifyTriagePresets({
        presetAllowlist: new Map([["checkout-5xx", relativePath]]),
        workspaceRoot: WORKSPACE_ROOT,
        readProvider: makeReadProvider(
          new Map([
            [
              absolutePath,
              validFixture({
                keys: ["operation", "extends"],
                values: { operation: "analyze", extends: "base.yaml" },
              }),
            ],
          ]),
        ),
      });
    } catch (cause) {
      syncThrow = cause;
    }

    expect(syncThrow).toBeUndefined();
    await expect(promise).rejects.toThrow(M3LAgentOperatorCliError);
  });
});

// --- Review finding B/type-design 2: the brand must not certify a mutable
// handle ------------------------------------------------------------------
//
// `verifyTriagePresets` currently returns the caller's OWN `Map`, re-branded
// in place. The brand is supposed to certify a verified INSTANCE, but if the
// return value is the same object the caller still holds a mutable
// reference to, the caller can `set` a brand-new, never-checked entry onto
// it after minting — and the brand still claims the whole map was verified.
describe("verifyTriagePresets — brand must not certify a mutable handle (type-design 2)", () => {
  it("does not reflect a mutation made to the original Map after minting", async () => {
    const relativePath = "data/config/presets/triage-checkout-5xx.yaml";
    const absolutePath = join(WORKSPACE_ROOT, relativePath);
    const originalAllowlist = new Map([["checkout-5xx", relativePath]]);

    const verified = await verifyTriagePresets({
      presetAllowlist: originalAllowlist,
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: makeReadProvider(new Map([[absolutePath, validFixture()]])),
    });

    // Never checked by `verifyTriagePresets` — set on the caller's own
    // handle after the brand was already minted.
    originalAllowlist.set(
      "unverified-injected",
      "data/config/presets/../../../etc/injected.yaml",
    );

    expect(verified.has("unverified-injected")).toBe(false);
    expect(verified.size).toBe(1);
  });
});

// --- Review finding B/type-design 3: the exported deps types --------------
//
// `VerifyTriagePresetsDeps` and `TriagePresetReader` are the parameter types
// of an exported function, but are themselves unexported today — while the
// sibling `BuildTriageToolsDeps` is exported. A consumer cannot annotate its
// own `readProvider` implementation or build a `deps` object with a named
// type; this test only compiles once both are exported.
describe("verifyTriagePresets — exported deps types (type-design 3)", () => {
  it("VerifyTriagePresetsDeps and TriagePresetReader are importable by name and usable to type a caller's own implementation", () => {
    const reader: TriagePresetReader = {
      rawKeys: () => validFixture().keys,
      getRawValue: (key: string) => validFixture().values[key],
    };

    const deps: VerifyTriagePresetsDeps = {
      presetAllowlist: new Map([
        ["checkout-5xx", "data/config/presets/triage-checkout-5xx.yaml"],
      ]),
      workspaceRoot: WORKSPACE_ROOT,
      readProvider: () => reader,
    };

    expect(deps.presetAllowlist.size).toBe(1);
    expect(deps.readProvider("/any/path").rawKeys()).toEqual(
      validFixture().keys,
    );
  });
});
