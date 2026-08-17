import { describe, expect, test } from "vitest";
import {
  ALLOWED_LICENSES,
  classifyLicense,
  evaluateSpdxAst,
  isAllowedLicenseId,
  parseSpdxExpression,
} from "../lib/licenses.mjs";

describe("ALLOWED_LICENSES", () => {
  test("contains exactly the nine documented permissive/public-domain ids", () => {
    expect([...ALLOWED_LICENSES].sort()).toEqual(
      [
        "0BSD",
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "CC0-1.0",
        "ISC",
        "MIT",
        "MIT-0",
        "Unlicense",
      ].sort(),
    );
  });
});

describe("isAllowedLicenseId", () => {
  test.each([...ALLOWED_LICENSES])("%s is allowed by default", (id) => {
    expect(isAllowedLicenseId(id)).toBe(true);
  });

  test("returns false for a copyleft id not on the default allow-list", () => {
    expect(isAllowedLicenseId("GPL-3.0-only")).toBe(false);
  });

  test("respects a custom allowSet argument", () => {
    const customSet = new Set(["WTFPL"]);
    expect(isAllowedLicenseId("WTFPL", customSet)).toBe(true);
    expect(isAllowedLicenseId("MIT", customSet)).toBe(false);
  });
});

describe("parseSpdxExpression — happy path", () => {
  test("parses a bare license id into a license node", () => {
    expect(parseSpdxExpression("MIT")).toEqual({
      type: "license",
      id: "MIT",
    });
  });

  test("parses an OR expression with left/right license nodes", () => {
    expect(parseSpdxExpression("MIT OR ISC")).toEqual({
      type: "or",
      left: { type: "license", id: "MIT" },
      right: { type: "license", id: "ISC" },
    });
  });

  test("parses an AND expression with left/right license nodes", () => {
    expect(parseSpdxExpression("MIT AND Zlib")).toEqual({
      type: "and",
      left: { type: "license", id: "MIT" },
      right: { type: "license", id: "Zlib" },
    });
  });

  test("parses a WITH expression into a with node carrying the exception id", () => {
    expect(parseSpdxExpression("Apache-2.0 WITH LLVM-exception")).toEqual({
      type: "with",
      license: { type: "license", id: "Apache-2.0" },
      exception: "LLVM-exception",
    });
  });

  test("left-associates a chain of three OR operands", () => {
    expect(parseSpdxExpression("BSD-2-Clause OR MIT OR Apache-2.0")).toEqual({
      type: "or",
      left: {
        type: "or",
        left: { type: "license", id: "BSD-2-Clause" },
        right: { type: "license", id: "MIT" },
      },
      right: { type: "license", id: "Apache-2.0" },
    });
  });

  test("parentheses group a sub-expression regardless of surrounding operators", () => {
    expect(
      parseSpdxExpression("((MIT OR GPL-3.0-only) AND Apache-2.0)"),
    ).toEqual({
      type: "and",
      left: {
        type: "or",
        left: { type: "license", id: "MIT" },
        right: { type: "license", id: "GPL-3.0-only" },
      },
      right: { type: "license", id: "Apache-2.0" },
    });
  });
});

describe("parseSpdxExpression — throws on malformed input", () => {
  test.each([
    ["", "empty expression"],
    ["(MIT", "unbalanced open paren"],
    ["MIT)", "unbalanced close paren"],
    ["MIT AND", "dangling AND with no right operand"],
    ["MIT WITH", "dangling WITH with no exception id"],
    ["AND MIT", "leading operator with no left operand"],
  ] as const)("throws for %j (%s)", (expression, _description) => {
    expect(() => {
      parseSpdxExpression(expression);
    }).toThrow();
  });
});

describe("evaluateSpdxAst — direct AST evaluation", () => {
  test("license node returns the predicate's verdict for its id", () => {
    expect(
      evaluateSpdxAst({ type: "license", id: "MIT" }, (id) => id === "MIT"),
    ).toBe(true);
    expect(
      evaluateSpdxAst({ type: "license", id: "GPL-3.0-only" }, (id) =>
        ALLOWED_LICENSES.has(id),
      ),
    ).toBe(false);
  });

  test("and node requires both sides to be allowed", () => {
    const bothAllowed = evaluateSpdxAst(
      {
        type: "and",
        left: { type: "license", id: "MIT" },
        right: { type: "license", id: "ISC" },
      },
      () => true,
    );
    const oneDenied = evaluateSpdxAst(
      {
        type: "and",
        left: { type: "license", id: "MIT" },
        right: { type: "license", id: "Zlib" },
      },
      (id) => id === "MIT",
    );
    expect(bothAllowed).toBe(true);
    expect(oneDenied).toBe(false);
  });

  test("or node is true if either side is allowed", () => {
    const leftAllowed = evaluateSpdxAst(
      {
        type: "or",
        left: { type: "license", id: "MIT" },
        right: { type: "license", id: "GPL-3.0-only" },
      },
      (id) => id === "MIT",
    );
    const neitherAllowed = evaluateSpdxAst(
      {
        type: "or",
        left: { type: "license", id: "GPL-3.0-only" },
        right: { type: "license", id: "LGPL-3.0-only" },
      },
      (id) => id === "MIT",
    );
    expect(leftAllowed).toBe(true);
    expect(neitherAllowed).toBe(false);
  });

  test("with node always evaluates to false, even when the base license and predicate would allow it", () => {
    // Conservative by design: a WITH exception changes the license's legal
    // terms in a way a plain allow-list of base license ids doesn't model,
    // so it is never treated as allowed regardless of the predicate result.
    const result = evaluateSpdxAst(
      {
        type: "with",
        license: { type: "license", id: "Apache-2.0" },
        exception: "LLVM-exception",
      },
      () => true,
    );
    expect(result).toBe(false);
  });
});

describe("classifyLicense — simple ids", () => {
  test("a bare allow-listed id classifies as allowed", () => {
    expect(classifyLicense("MIT")).toEqual({ verdict: "allowed" });
    expect(classifyLicense("Apache-2.0")).toEqual({ verdict: "allowed" });
  });

  test("a bare non-allow-listed id classifies as denied", () => {
    expect(classifyLicense("GPL-3.0-only")).toEqual({ verdict: "denied" });
  });

  test("a syntactically valid but non-SPDX-precise bare string is denied, not unresolved", () => {
    // "BSD" alone is a valid single atom that parses fine — it is simply not
    // equal to "BSD-2-Clause" or "BSD-3-Clause", both of which ARE allowed.
    // Real case from this repo's dependency tree: duck@0.1.12.
    expect(classifyLicense("BSD")).toEqual({ verdict: "denied" });
  });
});

describe("classifyLicense — OR semantics", () => {
  test.each([
    ["(MIT OR WTFPL)", "expand-template"],
    ["(MIT OR GPL-3.0-or-later)", "jszip"],
    ["(BSD-2-Clause OR MIT OR Apache-2.0)", "rc, 3-way OR"],
  ])("%s classifies as allowed (real case: %s)", (expression) => {
    expect(classifyLicense(expression)).toEqual({ verdict: "allowed" });
  });

  test("a pure OR of two non-allowed ids classifies as denied", () => {
    expect(classifyLicense("(GPL-3.0-only OR LGPL-3.0-only)")).toEqual({
      verdict: "denied",
    });
  });
});

describe("classifyLicense — AND semantics", () => {
  test("AND with one non-allowed operand classifies as denied even though the other side is allowed", () => {
    // Real case: pako — MIT is allowed but Zlib is not, and AND requires both.
    expect(classifyLicense("(MIT AND Zlib)")).toEqual({ verdict: "denied" });
  });

  test("AND with both operands allowed classifies as allowed", () => {
    expect(classifyLicense("(MIT AND Apache-2.0)")).toEqual({
      verdict: "allowed",
    });
  });
});

describe("classifyLicense — WITH always denies", () => {
  test("Apache-2.0 WITH LLVM-exception classifies as denied even though Apache-2.0 alone is allowed", () => {
    // Conservative by design: an exception changes the license's legal terms
    // in a way the allow-list doesn't model, so WITH never passes.
    expect(classifyLicense("Apache-2.0 WITH LLVM-exception")).toEqual({
      verdict: "denied",
    });
  });
});

describe("classifyLicense — nested parentheses/precedence", () => {
  test("OR resolves true via one branch, AND with an allowed sibling also passes", () => {
    expect(classifyLicense("((MIT OR GPL-3.0-only) AND Apache-2.0)")).toEqual({
      verdict: "allowed",
    });
  });

  test("inner AND fails but an outer OR with an allowed id still passes", () => {
    expect(classifyLicense("((MIT AND GPL-3.0-only) OR ISC)")).toEqual({
      verdict: "allowed",
    });
  });
});

describe("classifyLicense — missing/empty license", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace-only string", "   "],
  ] as const)(
    "%s classifies as unresolved with a 'missing' reason",
    (_label, value) => {
      const result = classifyLicense(value);
      expect(result.verdict).toBe("unresolved");
      expect(result.reason).toMatch(/missing/i);
    },
  );
});

describe("classifyLicense — malformed expressions never throw", () => {
  test.each([
    ["(MIT OR", "unbalanced parens"],
    ["MIT OR OR ISC", "dangling operator"],
    ["MIT ISC", "two atoms with no operator (trailing token)"],
  ] as const)(
    "%j (%s) classifies as unresolved with a parse-failure reason",
    (expression, _description) => {
      let result: ReturnType<typeof classifyLicense> | undefined;
      expect(() => {
        result = classifyLicense(expression);
      }).not.toThrow();
      expect(result?.verdict).toBe("unresolved");
      expect(result?.reason).toMatch(/could not parse/i);
    },
  );
});
