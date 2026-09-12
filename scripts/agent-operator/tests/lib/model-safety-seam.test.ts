/**
 * Tests for two gaps in `src/lib/model-safety.ts`'s outbound guarantees:
 *
 * 1. The **Trojan-Source escape set**. The module TSDoc claims "a
 *    bidi/format-control character embedded in CLI output must never cross
 *    this boundary unmasked", but `EXTRA_ESCAPE_TARGETS` lists only the two
 *    line/paragraph separators, the two overrides, and the four isolates —
 *    leaving the three embeddings (LRE/RLE/PDF), the two marks (LRM/RLM),
 *    the Arabic letter mark, the zero-width space, and the BOM to pass
 *    through raw. All of those are directional/invisible formatting
 *    characters usable to reorder or hide text a model then reasons over.
 *
 * 2. `projectRequiredParameters`' **silent** cap at 32 entries: a plain
 *    `.slice()` with no marker and no failure, so a model reads a truncated
 *    required-parameter list as exhaustive. Chosen contract (test-author
 *    decision, stated for the implementer): **fail closed**, matching
 *    `cli-envelopes.ts`'s `parseArray`, which rejects an over-long array
 *    (`too-many-rows`) rather than trimming it. The alternative — a visible
 *    marker element, as `truncateByCodePoint` does with `…` — is rejected
 *    here because a marker inside a *parameter-name* array is itself
 *    indistinguishable from a real parameter name.
 *
 * Every control/format character is built with `String.fromCodePoint(...)`,
 * never a literal, so this file carries no raw control byte
 * (`pnpm check:control-chars`).
 */
import { describe, expect, it } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import type { AgentOperatorParamDescriptor } from "../../src/lib/cli-envelopes.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  projectParamDescriptor,
  sanitizeForModel,
} from "../../src/lib/model-safety.js";

/** The literal six-character `\uXXXX` text `sanitizeForModel` must emit. */
function escapeText(codePoint: number): string {
  return String.raw`\u` + codePoint.toString(16).padStart(4, "0");
}

/**
 * Every code point the escaper must mask. The first block is already
 * escaped today (pinned here so the fix cannot regress it); the second is
 * the set a security probe against the built `dist/` confirmed passes
 * through raw.
 */
const ALREADY_ESCAPED: [string, number][] = [
  ["BEL (C0) (U+0007)", 0x07],
  ["DEL (U+007F)", 0x7f],
  ["NEL (C1) (U+0085)", 0x85],
  ["LINE SEPARATOR (U+2028)", 0x2028],
  ["PARAGRAPH SEPARATOR (U+2029)", 0x2029],
  ["LEFT-TO-RIGHT OVERRIDE (U+202D)", 0x202d],
  ["RIGHT-TO-LEFT OVERRIDE (U+202E)", 0x202e],
  ["LEFT-TO-RIGHT ISOLATE (U+2066)", 0x2066],
  ["RIGHT-TO-LEFT ISOLATE (U+2067)", 0x2067],
  ["FIRST STRONG ISOLATE (U+2068)", 0x2068],
  ["POP DIRECTIONAL ISOLATE (U+2069)", 0x2069],
];

const CURRENTLY_UNESCAPED: [string, number][] = [
  ["LEFT-TO-RIGHT EMBEDDING (U+202A)", 0x202a],
  ["RIGHT-TO-LEFT EMBEDDING (U+202B)", 0x202b],
  ["POP DIRECTIONAL FORMATTING (U+202C)", 0x202c],
  ["ZERO WIDTH SPACE (U+200B)", 0x200b],
  ["LEFT-TO-RIGHT MARK (U+200E)", 0x200e],
  ["RIGHT-TO-LEFT MARK (U+200F)", 0x200f],
  ["ARABIC LETTER MARK (U+061C)", 0x061c],
  ["ZERO WIDTH NO-BREAK SPACE (BOM) (U+FEFF)", 0xfeff],
];

describe("sanitizeForModel — the full bidi/format-control escape set", () => {
  it.each([...ALREADY_ESCAPED, ...CURRENTLY_UNESCAPED])(
    "escapes %s rather than passing it through raw",
    (_name, codePoint) => {
      const character = String.fromCodePoint(codePoint);

      const result = sanitizeForModel(`alpha${character}omega`);

      expect(result).not.toContain(character);
      expect(result.toLowerCase()).toContain(escapeText(codePoint));
      // The surrounding text is untouched — the escaper masks, never drops.
      expect(result).toContain("alpha");
      expect(result).toContain("omega");
    },
  );

  it("escapes a full Trojan-Source style sequence in one pass, leaving no raw format character behind", () => {
    const all = [...ALREADY_ESCAPED, ...CURRENTLY_UNESCAPED];
    const payload = all
      .map(([, codePoint]) => String.fromCodePoint(codePoint))
      .join("x");

    const result = sanitizeForModel(payload);

    for (const [, codePoint] of all) {
      expect(result).not.toContain(String.fromCodePoint(codePoint));
    }
  });
});

/** Builds a descriptor whose single operation requires `count` parameters. */
function descriptorRequiring(count: number): AgentOperatorParamDescriptor {
  const requiredParameters = Array.from(
    { length: count },
    (_unused, index) => `param${String(index)}`,
  );
  const operation: Core.M3LConfigOperationDescriptor = {
    name: "export",
    description: "Exports rows.",
    requiredParameters,
  };
  return {
    name: "awsProfile",
    aliases: [],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS profile to assume",
    secret: false,
    operations: [operation],
  };
}

describe("projectParamDescriptor — requiredParameters cap is never silent", () => {
  it("projects a list at the 32-entry cap unchanged", () => {
    const projected = projectParamDescriptor(descriptorRequiring(32));

    expect(projected.operations[0]?.requiredParameters).toHaveLength(32);
    expect(projected.operations[0]?.requiredParameters).toContain("param31");
  });

  it("fails closed on a list over the cap instead of silently slicing it (a model would read the trimmed list as exhaustive)", () => {
    let thrown: unknown;
    try {
      projectParamDescriptor(descriptorRequiring(33));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toMatch(
      /^ERR_AGENT_OPERATOR_/,
    );
  });

  it("leaks no parameter name in the fail-closed error's message", () => {
    let thrown: unknown;
    try {
      projectParamDescriptor(descriptorRequiring(64));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).message).not.toContain("param");
  });
});
