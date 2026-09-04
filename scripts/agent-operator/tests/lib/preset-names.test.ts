import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { AgentOperatorScriptName } from "../../src/lib/cli-names.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH,
  AGENT_OPERATOR_PRESET_NAME_RE,
  type AgentOperatorPresetName,
  type AgentOperatorPresetPath,
  assertAllowedPresetName,
  hasPresetPathControlOrFormatCharacter,
  isAllowedPresetName,
  isUnpaddedNonBlankPresetPath,
  isWellFormedPresetPathShape,
} from "../../src/lib/preset-names.js";

/**
 * Contract: V9 slice 2a `src/lib/preset-names.ts`, mirroring
 * `src/lib/cli-names.ts`. `AGENT_OPERATOR_PRESET_NAME_RE` must copy
 * `PRESET_NAME_PATTERN` from `packages/m3l-cli/src/presets/store.ts` verbatim
 * (ADR-0029: a script depends only on `@m3l-automation/m3l-common`, so the
 * regex cannot be imported and must be drift-guarded against the source of
 * truth instead). `AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH` (64) is this
 * package's own additional cap, checked BEFORE the regex.
 *
 * Scope note, and the reason the fixture lists below look permissive:
 * `/^[a-z0-9-]+$/` is a CHARACTER-CLASS check only. It has no structural rules
 * — no leading-letter requirement, no ban on a bare `-` or a doubled `--`, no
 * digit-only rejection. This module therefore makes NO claim to reject an
 * argv-flag-shaped string. The actual safety property lives one layer up:
 * membership in the operator-declared `presetAllowlist`, plus the attached
 * `--preset=<path>` argv form that keeps the emitted token a single argv
 * element. Asserting a rejection here that the module does not perform would
 * be a test of a guarantee that does not exist.
 */

/**
 * The single fixed rejection message, pinned once so every assertion below
 * agrees by construction.
 *
 * Wording is a SHAPE statement, not an authorization one, and that is the
 * whole point of the pin: `assertAllowedPresetName` only ever decides whether
 * the characters are ones the upstream preset store would accept —
 * {@link isAllowedPresetName}'s own TSDoc says so ("not an authorization
 * check", membership "is decided separately"). Cited by symbol rather than by
 * line range, which rots on the next reflow of that file. The previous
 * wording ("preset name is not on the allowlist") described a rule this
 * function does not enforce and sent an operator reading it to audit
 * `presetAllowlist` when the real fault was a bad character. The
 * allowlist-miss rejection is `cli-surface.ts`'s to report, on its own arm.
 *
 * Test-author choice (the fix contract leaves the exact wording open): the
 * implementer must use this string verbatim.
 */
const REJECTION_MESSAGE = "preset name is malformed";

const REJECTED_NAMES = [
  // Uppercase is outside the character class.
  "Prod",
  "PROD",
  // Empty string: rejected by the explicit length check, not the regex.
  "",
  // Characters outside `[a-z0-9-]`.
  "prod_v2",
  "prod.v2",
  "prod v2",
  "prod/v2",
  "../../etc/passwd",
  "a;rm -rf /",
  "a\0b",
  "café",
  // Over the length cap.
  "a".repeat(65),
];

const ACCEPTED_NAMES = [
  "prod",
  "dry-run",
  "eu-west-1",
  "a",
  "0",
  "a1b2c3",
  "-",
  "x".repeat(64),
];

/**
 * Strings the upstream pattern genuinely ACCEPTS even though they read like
 * argv flags or like junk. Pinned as accepted on purpose: the pattern is the
 * only thing under test here, and it does not discriminate these. See the
 * scope note above for where the real defence lives.
 */
const ACCEPTED_BUT_FLAG_SHAPED = ["--json", "-h", "--", "123"];

describe("AGENT_OPERATOR_PRESET_NAME_RE / AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH", () => {
  it("caps preset names at 64 characters", () => {
    expect(AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH).toBe(64);
  });

  it("matches the drift-guarded regex source copied from presets/store.ts", () => {
    // Resolve relative to this test file's own URL, never process.cwd(), so
    // the guard is stable regardless of the invoking working directory.
    const storePath = fileURLToPath(
      new URL(
        "../../../../packages/m3l-cli/src/presets/store.ts",
        import.meta.url,
      ),
    );
    const storeText = readFileSync(storePath, "utf8");

    // Upstream's declaration is module-PRIVATE and UNANNOTATED — `const
    // PRESET_NAME_PATTERN = /.../;` — unlike `SCRIPT_NAME_RE`'s
    // `export const ...: RegExp =` form that `cli-names.test.ts` guards. The
    // `m` flag anchors `$` to the end of that one line so `.+` cannot run past
    // the literal and swallow a later declaration.
    const match = /^const PRESET_NAME_PATTERN = (\/.+\/);$/m.exec(storeText);
    expect(match).not.toBeNull();
    const literalSource = match?.[1];
    expect(literalSource).toBe("/^[a-z0-9-]+$/");

    // Round-trip AGENT_OPERATOR_PRESET_NAME_RE.source back into `/.../` form
    // so the comparison is against the exact same literal TEXT, not a
    // reconstructed approximation. Comparing the source (rather than merely
    // re-testing a few inputs through both) is what makes an upstream edit to
    // the pattern fail this test.
    expect(`/${AGENT_OPERATOR_PRESET_NAME_RE.source}/`).toBe(literalSource);
  });
});

/**
 * A clean, well-formed preset path fixture shared by the three describe
 * blocks below — the same value {@link isUnpaddedNonBlankPresetPath},
 * {@link hasPresetPathControlOrFormatCharacter} and
 * {@link isWellFormedPresetPathShape}'s own TSDoc examples use.
 */
const CLEAN_PRESET_PATH = "data/config/presets/report.yaml";

/**
 * Contract: PR review found these three exports of
 * `src/lib/preset-names.ts` had no DIRECT unit test — they were exercised
 * only transitively through `parsePresetAllowlist` (config parsing) and
 * `cli-surface.ts`'s use-site re-check. Each is tested here in isolation,
 * matching its own TSDoc example fixtures and scope claims.
 */
describe("isUnpaddedNonBlankPresetPath", () => {
  it("accepts a clean, unpadded, non-blank path", () => {
    expect(isUnpaddedNonBlankPresetPath(CLEAN_PRESET_PATH)).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isUnpaddedNonBlankPresetPath("")).toBe(false);
  });

  it("rejects an all-whitespace string", () => {
    expect(isUnpaddedNonBlankPresetPath("   ")).toBe(false);
  });

  it("rejects a leading space", () => {
    expect(isUnpaddedNonBlankPresetPath(` ${CLEAN_PRESET_PATH}`)).toBe(false);
  });

  it("rejects a trailing space", () => {
    expect(isUnpaddedNonBlankPresetPath(`${CLEAN_PRESET_PATH} `)).toBe(false);
  });

  it("rejects a trailing tab", () => {
    expect(
      isUnpaddedNonBlankPresetPath(
        `${CLEAN_PRESET_PATH}${String.fromCodePoint(0x09)}`,
      ),
    ).toBe(false);
  });

  it("rejects a leading BOM (U+FEFF)", () => {
    expect(
      isUnpaddedNonBlankPresetPath(
        `${String.fromCodePoint(0xfeff)}${CLEAN_PRESET_PATH}`,
      ),
    ).toBe(false);
  });

  it("rejects a leading NBSP (U+00A0)", () => {
    expect(
      isUnpaddedNonBlankPresetPath(
        `${String.fromCodePoint(0xa0)}${CLEAN_PRESET_PATH}`,
      ),
    ).toBe(false);
  });

  it("accepts an INNER space — this predicate checks padding and blankness only, never inner whitespace", () => {
    // The honest reading of the name: "unpadded" and "non-blank" say nothing
    // about the MIDDLE of the string. `"night ly.yaml"` survives
    // `String.prototype.trim()` completely untouched, so `trimmed ===
    // presetPath` still holds and this returns `true`. That is not a gap in
    // this predicate — rejecting an inner space is
    // `isWellFormedPresetPathShape`'s job (its standalone third conjunct),
    // not this one's. Do not mistake this row for a whitespace check: it is
    // a padding-and-blankness check only.
    expect(
      isUnpaddedNonBlankPresetPath("data/config/presets/night ly.yaml"),
    ).toBe(true);
  });
});

describe("hasPresetPathControlOrFormatCharacter", () => {
  it("returns false for a clean path", () => {
    expect(hasPresetPathControlOrFormatCharacter(CLEAN_PRESET_PATH)).toBe(
      false,
    );
  });

  it.each([
    ["an embedded NUL (U+0000)", 0x00],
    ["an embedded LF (U+000A)", 0x0a],
    ["an embedded CR (U+000D)", 0x0d],
    ["an embedded ESC (U+001B)", 0x1b],
    // `\p{C}` is the Unicode "Other" supercategory, which includes control
    // (Cc) AND format (Cf) characters — that is why these next two, neither
    // of which is whitespace, still trip this predicate.
    ["a leading BOM (U+FEFF, category Cf)", 0xfeff],
    ["an embedded zero-width joiner (U+200D, category Cf)", 0x200d],
  ] as const)("returns true for a path with %s", (_label, codePoint) => {
    const pathWithControlCharacter = `data/config/presets/report${String.fromCodePoint(codePoint)}.yaml`;
    expect(
      hasPresetPathControlOrFormatCharacter(pathWithControlCharacter),
    ).toBe(true);
  });
});

describe("isWellFormedPresetPathShape", () => {
  it("accepts a clean path", () => {
    expect(isWellFormedPresetPathShape(CLEAN_PRESET_PATH)).toBe(true);
  });

  it("rejects a padded path (conjunct 1: isUnpaddedNonBlankPresetPath)", () => {
    // This fixture also independently trips the third conjunct (the
    // standalone whitespace check, since a trailing space IS whitespace) —
    // see the boundary test below for the one input where conjunct 1 is
    // uniquely load-bearing rather than merely redundant with conjunct 3.
    expect(isWellFormedPresetPathShape(`${CLEAN_PRESET_PATH} `)).toBe(false);
  });

  it("rejects a NUL-bearing path (conjunct 2: hasPresetPathControlOrFormatCharacter)", () => {
    const pathWithNul = `data/config/presets/report${String.fromCodePoint(0x00)}.yaml`;
    expect(isWellFormedPresetPathShape(pathWithNul)).toBe(false);
  });

  it("rejects an inner-space path (conjunct 3: the standalone whitespace check)", () => {
    expect(
      isWellFormedPresetPathShape("data/config/presets/night ly.yaml"),
    ).toBe(false);
  });

  /*
   * The subsumption boundary, verified by execution rather than assumed:
   * `!/\s/u.test(...)` (conjunct 3) already rejects every PADDING case above
   * on its own, including BOM- and NBSP-padded ones — `String.prototype.trim`
   * and `\s` agree on all of those. The empty string is the ONE input the
   * first conjunct, `isUnpaddedNonBlankPresetPath`, uniquely rejects: it
   * contains no whitespace character at all (so the whitespace conjunct
   * alone would ADMIT it) and no control/format character either. This is
   * what makes conjunct 1 provably load-bearing rather than decorative —
   * without it, `isWellFormedPresetPathShape("")` would be `true`.
   */
  it("[boundary] the empty string is rejected only by the first conjunct — the standalone whitespace rule alone would admit it", () => {
    // Mirrors the module's private whitespace regex locally rather than
    // reaching into its internals, purely to demonstrate the boundary.
    const whitespaceRuleMirror = /\s/u;

    expect(isWellFormedPresetPathShape("")).toBe(false);
    expect(hasPresetPathControlOrFormatCharacter("")).toBe(false);
    // No match on "" means its negation (the third conjunct alone) would be
    // `true` — i.e. the whitespace rule alone would ADMIT the empty string.
    expect(whitespaceRuleMirror.test("")).toBe(false);
  });
});

describe("isAllowedPresetName", () => {
  it.each(REJECTED_NAMES.map((name) => [name] as const))(
    "rejects %j",
    (name) => {
      expect(isAllowedPresetName(name)).toBe(false);
    },
  );

  it.each(ACCEPTED_NAMES.map((name) => [name] as const))(
    "accepts %j",
    (name) => {
      expect(isAllowedPresetName(name)).toBe(true);
    },
  );

  it.each(ACCEPTED_BUT_FLAG_SHAPED.map((name) => [name] as const))(
    "accepts the flag-shaped %j, because the character-class pattern does not discriminate it",
    (name) => {
      // Deliberately asserted as ACCEPTED. Safety for these comes from
      // allowlist membership and the attached `--preset=<path>` argv form, not
      // from this pattern; a `false` here would mean the copied regex had
      // silently diverged from upstream.
      expect(isAllowedPresetName(name)).toBe(true);
    },
  );

  it("rejects non-string values", () => {
    expect(isAllowedPresetName(42)).toBe(false);
    expect(isAllowedPresetName(null)).toBe(false);
    expect(isAllowedPresetName(undefined)).toBe(false);
    expect(isAllowedPresetName({})).toBe(false);
    expect(isAllowedPresetName(["prod"])).toBe(false);
    expect(isAllowedPresetName(Symbol("prod"))).toBe(false);
  });

  it("checks length before the regex (an over-length otherwise-valid name is rejected on length alone)", () => {
    // The discriminating part: this fixture is made ONLY of characters the
    // regex accepts, so the regex would return `true` for it. The rejection
    // can therefore only have come from the length cap. An over-length string
    // that ALSO fails the pattern would prove nothing about the ordering.
    const overLength = "a".repeat(65);
    expect(overLength.length).toBeGreaterThan(
      AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH,
    );
    expect(AGENT_OPERATOR_PRESET_NAME_RE.test(overLength)).toBe(true);
    expect(isAllowedPresetName(overLength)).toBe(false);
  });

  it("accepts a name exactly at the cap and rejects one character past it", () => {
    expect(
      isAllowedPresetName("a".repeat(AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH)),
    ).toBe(true);
    expect(
      isAllowedPresetName(
        "a".repeat(AGENT_OPERATOR_PRESET_NAME_MAX_LENGTH + 1),
      ),
    ).toBe(false);
  });

  it("rejects the empty string on length, not on the pattern", () => {
    // `/^[a-z0-9-]+$/` already rejects "" via the `+` quantifier, so this
    // asserts the OUTCOME rather than which branch fired — but it pins that
    // the explicit `length === 0` guard cannot be dropped in favour of a
    // pattern that someone later relaxes to `*`.
    expect(isAllowedPresetName("")).toBe(false);
  });
});

describe("assertAllowedPresetName", () => {
  it.each(ACCEPTED_NAMES.map((name) => [name] as const))(
    "returns the narrowed string for %j",
    (name) => {
      expect(assertAllowedPresetName(name)).toBe(name);
    },
  );

  it.each(REJECTED_NAMES.map((name) => [name] as const))(
    "throws M3LAgentOperatorCliError coded ERR_AGENT_OPERATOR_PRESET for %j",
    (name) => {
      let thrown: unknown;
      try {
        assertAllowedPresetName(name);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
      const cliError = thrown as M3LAgentOperatorCliError;
      expect(cliError.code).toBe("ERR_AGENT_OPERATOR_PRESET");
    },
  );

  it("throws with the exact fixed rejection message", () => {
    let thrown: unknown;
    try {
      assertAllowedPresetName("NOT VALID");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).toBe(REJECTION_MESSAGE);
  });

  /*
   * The wording-INDEPENDENT half of the same rule, so the guarantee survives
   * a later rewording that {@link REJECTION_MESSAGE} alone would just follow:
   * whatever this message says, it must not describe an AUTHORIZATION
   * outcome. `assertAllowedPresetName` never consults `presetAllowlist` — it
   * cannot know whether the operator granted the preset — so a message
   * mentioning the allowlist (or permission/authorization) names a rule this
   * function does not enforce and sends the reader to the wrong file. This
   * assertion is what discriminates the fix: it fails against the pre-fix
   * "preset name is not on the allowlist" string.
   */
  it("describes the name shape, never an allowlist or authorization outcome", () => {
    let thrown: unknown;
    try {
      assertAllowedPresetName("NOT VALID");
    } catch (error) {
      thrown = error;
    }

    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).not.toMatch(/allow.?list/i);
    expect(cliError.message).not.toMatch(/permitted|permission|authori[sz]/i);
    // Still names its subject, so the message is not merely inoffensive.
    expect(cliError.message).toMatch(/preset name/i);
  });

  it.each(REJECTED_NAMES.map((name) => [name] as const))(
    "uses the same fixed message for every rejection, including %j",
    (name) => {
      let thrown: unknown;
      try {
        assertAllowedPresetName(name);
      } catch (error) {
        thrown = error;
      }

      const cliError = thrown as M3LAgentOperatorCliError;
      expect(cliError.message).toBe(REJECTION_MESSAGE);
    },
  );

  it("never echoes a path-traversal value in the thrown message", () => {
    const traversal = "../../etc/passwd";
    let thrown: unknown;
    try {
      assertAllowedPresetName(traversal);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).not.toContain(traversal);
    // Assert the distinctive fragments too, so a message that echoed only part
    // of the value still fails.
    expect(cliError.message).not.toContain("..");
    expect(cliError.message).not.toContain("etc/passwd");
  });

  it("never echoes a shell-metacharacter value in the thrown message", () => {
    const metacharacters = "prod; rm -rf /$(secret-marker)";
    let thrown: unknown;
    try {
      assertAllowedPresetName(metacharacters);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).not.toContain(metacharacters);
    expect(cliError.message).not.toContain("secret-marker");
    expect(cliError.message).not.toContain(";");
    expect(cliError.message).not.toContain("$(");
  });

  it("never echoes a non-string rejected value either", () => {
    let thrown: unknown;
    try {
      assertAllowedPresetName({ toString: () => "secret-marker" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.message).toBe(REJECTION_MESSAGE);
    expect(cliError.message).not.toContain("secret-marker");
  });

  it("attaches no cause, because there is no underlying failure to chain", () => {
    let thrown: unknown;
    try {
      assertAllowedPresetName("Prod");
    } catch (error) {
      thrown = error;
    }

    const cliError = thrown as M3LAgentOperatorCliError;
    expect(cliError.cause).toBeUndefined();
  });
});

describe("AgentOperatorPresetName — the brand is the contract", () => {
  it("returns the branded type from assertAllowedPresetName", () => {
    expectTypeOf(
      assertAllowedPresetName,
    ).returns.toEqualTypeOf<AgentOperatorPresetName>();
  });

  it("does not accept a bare string where the branded type is required", () => {
    // The whole point of the brand: an unvalidated `string` must be a COMPILE
    // error at a site typed to the branded name, so the only way to obtain one
    // is through `assertAllowedPresetName`.
    expectTypeOf<string>().not.toExtend<AgentOperatorPresetName>();
  });

  it("is still assignable TO string, so it needs no unwrapping at an argv boundary", () => {
    expectTypeOf<AgentOperatorPresetName>().toExtend<string>();
  });

  it("is distinct from the script-name brand, so the two cannot be swapped", () => {
    // Both brands are `string & { readonly __brand: unique symbol }`, and
    // `unique symbol` makes each declaration's brand its own nominal type — so
    // a validated SCRIPT name cannot be passed where a preset name is required
    // and vice versa. `cli-surface.ts` relies on exactly this: its `run`
    // operation carries one of each, and swapping the two arguments must be a
    // compile error, not a runtime surprise in the emitted argv.
    expectTypeOf<AgentOperatorScriptName>().not.toExtend<AgentOperatorPresetName>();
    expectTypeOf<AgentOperatorPresetName>().not.toExtend<AgentOperatorScriptName>();
    expectTypeOf<AgentOperatorPresetName>().not.toEqualTypeOf<string>();
  });

  it("takes an unknown value, so a caller cannot pre-narrow its way past the check", () => {
    expectTypeOf(assertAllowedPresetName).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(isAllowedPresetName).parameter(0).toEqualTypeOf<unknown>();
  });

  it("types isAllowedPresetName as a type guard narrowing to string", () => {
    const value: unknown = "prod";
    if (isAllowedPresetName(value)) {
      expectTypeOf(value).toEqualTypeOf<string>();
    }
  });
});

/**
 * V9 slice 2a review fix M1 — the PATH brand.
 *
 * `AgentOperatorPresetName` alone was decorative: the value that actually
 * reaches argv is the resolved preset PATH, and the `run` union member carried
 * it as a bare `string`, so the brand was consumed as a `Map` key and
 * discarded. `AgentOperatorPresetPath` closes that: it is declared here with
 * its OWN `unique symbol` and minted only by `cli-surface.ts`'s
 * `resolveAllowedPresetPath`, which can produce one only after the name check
 * AND allowlist membership AND the containment re-check have all passed.
 *
 * These are type-level assertions only — a brand has no runtime
 * representation, so there is nothing else to observe. What they pin is that
 * THREE brands now exist and no two of them are interchangeable: a validated
 * script name, a validated preset name and a resolved preset path all erase to
 * `string`, and every pair must be a compile error at the other's position.
 * `cli-surface.ts`'s `run` carries a script name and a preset path in adjacent
 * fields, which is exactly where a swap would otherwise emit a nonsense argv.
 */
describe("AgentOperatorPresetPath — the path brand is the contract", () => {
  it("does not accept a bare string where the branded path is required", () => {
    // The point of branding the path rather than only the name: an
    // unvalidated `string` (a model-proposed path, or a `path.join` result
    // that skipped the containment re-check) must be a COMPILE error at a
    // site typed to the branded path.
    expectTypeOf<string>().not.toExtend<AgentOperatorPresetPath>();
  });

  it("is still assignable TO string, so it needs no unwrapping at an argv boundary", () => {
    expectTypeOf<AgentOperatorPresetPath>().toExtend<string>();
  });

  it("is not the same type as string", () => {
    expectTypeOf<AgentOperatorPresetPath>().not.toEqualTypeOf<string>();
  });

  it("is distinct from the preset-NAME brand, so a name cannot stand in for a path", () => {
    // The pair that matters most: the name is what the model supplies and the
    // path is what `resolveAllowedPresetPath` earns from it. Passing the name
    // where the path is expected would emit `--preset=<name>`, a token the
    // CLI resolves against the spawned child's own cwd — the exact silent
    // wrong-file outcome the resolver's docstring says must never happen.
    expectTypeOf<AgentOperatorPresetName>().not.toExtend<AgentOperatorPresetPath>();
    expectTypeOf<AgentOperatorPresetPath>().not.toExtend<AgentOperatorPresetName>();
  });

  it("is distinct from the script-name brand, so the two cannot be swapped", () => {
    expectTypeOf<AgentOperatorScriptName>().not.toExtend<AgentOperatorPresetPath>();
    expectTypeOf<AgentOperatorPresetPath>().not.toExtend<AgentOperatorScriptName>();
  });

  it("is not minted by assertAllowedPresetName, which only earns the NAME brand", () => {
    // The mint site is the contract: the name check cannot know a workspace
    // root or an allowlist, so it must not be able to produce a path brand.
    expectTypeOf(
      assertAllowedPresetName,
    ).returns.not.toExtend<AgentOperatorPresetPath>();
  });
});
