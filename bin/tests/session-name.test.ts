// Unit tests for bin/lib/session-name.mjs — the shared ADR-0087/ADR-0088
// session-name vocabulary (deriving a `{ kind, slug }` pair from a branch
// name, and composing/validating a `<kind>-<slug>` session name). Pure
// module, no I/O, so no mocking is needed anywhere in this file.
import { describe, expect, test } from "vitest";

import {
  BRANCH_KINDS,
  MAX_SESSION_NAME_LENGTH,
  SESSION_KINDS,
  SLUG_PATTERN,
  buildSessionName,
  deriveFromBranch,
} from "../lib/session-name.mjs";

describe("exported constants", () => {
  test("SESSION_KINDS contains exactly the closed set of session kinds", () => {
    expect(new Set(SESSION_KINDS)).toEqual(
      new Set([
        "feat",
        "fix",
        "docs",
        "chore",
        "refactor",
        "ci",
        "audit",
        "research",
        "review",
        "merge",
      ]),
    );
  });

  test("BRANCH_KINDS is a subset of SESSION_KINDS", () => {
    // Every branch-derivable kind must also be a session kind — a kind
    // added only to BRANCH_KINDS would let deriveFromBranch() produce a
    // { kind } that buildSessionName() then rejects. Independent sources:
    // this checks BRANCH_KINDS's content against SESSION_KINDS's content.
    expect(BRANCH_KINDS.every((kind) => SESSION_KINDS.includes(kind))).toBe(
      true,
    );
  });

  test("BRANCH_KINDS contains exactly the branch-derivable kinds", () => {
    expect(new Set(BRANCH_KINDS)).toEqual(
      new Set(["feat", "fix", "docs", "chore", "refactor", "ci"]),
    );
  });

  test("MAX_SESSION_NAME_LENGTH is 40", () => {
    expect(MAX_SESSION_NAME_LENGTH).toBe(40);
  });

  test.each([
    ["core-json", true],
    ["a", true],
    ["a1-b2", true],
    ["Some-Slug", false],
    ["-slug", false],
    ["slug-", false],
    ["a--b", false],
    ["", false],
  ])("SLUG_PATTERN.test(%j) === %s", (candidate, expected) => {
    expect(SLUG_PATTERN.test(candidate)).toBe(expected);
  });
});

describe("deriveFromBranch", () => {
  test("feat/<slug> derives a feat kind and the slug", () => {
    expect(deriveFromBranch("feat/statusline-widgets")).toEqual({
      kind: "feat",
      slug: "statusline-widgets",
    });
  });

  test("fix/<slug> derives a fix kind and the slug", () => {
    expect(deriveFromBranch("fix/main-ci-failures")).toEqual({
      kind: "fix",
      slug: "main-ci-failures",
    });
  });

  test("a multi-hyphen slug is captured in full", () => {
    expect(deriveFromBranch("feat/multi-word-slug-here")).toEqual({
      kind: "feat",
      slug: "multi-word-slug-here",
    });
  });

  test("docs/<slug> derives a docs kind and the slug", () => {
    expect(deriveFromBranch("docs/console-container-stance")).toEqual({
      kind: "docs",
      slug: "console-container-stance",
    });
  });

  test("chore/<slug> derives a chore kind and the slug", () => {
    expect(deriveFromBranch("chore/deps-bump")).toEqual({
      kind: "chore",
      slug: "deps-bump",
    });
  });

  test("a branch with no slash (main) → null", () => {
    expect(deriveFromBranch("main")).toBeNull();
  });

  test("a shape-matching but out-of-set kind (audit/something) → null", () => {
    expect(deriveFromBranch("audit/something")).toBeNull();
  });

  test("a detached HEAD ref → null", () => {
    expect(deriveFromBranch("HEAD")).toBeNull();
  });

  test("an uppercase slug segment → null (slug pattern requires lowercase)", () => {
    expect(deriveFromBranch("feat/Some-Slug")).toBeNull();
  });
});

describe("buildSessionName", () => {
  test("a valid feat kind and slug compose to kind-slug", () => {
    expect(buildSessionName("feat", "statusline-widgets")).toBe(
      "feat-statusline-widgets",
    );
  });

  test("a valid audit kind and slug compose to kind-slug", () => {
    expect(buildSessionName("audit", "session-naming")).toBe(
      "audit-session-naming",
    );
  });

  test("a valid docs kind and slug compose to kind-slug", () => {
    expect(buildSessionName("docs", "some-slug")).toBe("docs-some-slug");
  });

  test("an invalid kind throws a TypeError naming the invalid kind", () => {
    // "perf" is a valid Conventional Commit type (commitlint.config.js) but
    // was never added to SESSION_KINDS, so it stays genuinely invalid here.
    expect(() => buildSessionName("perf", "widget")).toThrowError(TypeError);
    let thrown: unknown;
    try {
      buildSessionName("perf", "widget");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain('"perf"');
  });

  test.each([
    ["Some-Slug", "an uppercase segment"],
    ["-slug", "a leading hyphen"],
    ["slug-", "a trailing hyphen"],
    ["a--b", "a double hyphen"],
  ])("an invalid slug (%s: %s) throws a TypeError", (slug) => {
    expect(() => buildSessionName("feat", slug)).toThrowError(TypeError);
  });

  test("a composed name exceeding MAX_SESSION_NAME_LENGTH throws a TypeError naming the bound", () => {
    // "feat-" (5 chars) + 36 lowercase letters = 41 chars, one over the
    // 40-char bound, while the slug alone is still valid kebab-case.
    const longSlug = "a".repeat(36);
    expect(() => buildSessionName("feat", longSlug)).toThrowError(TypeError);
    let thrown: unknown;
    try {
      buildSessionName("feat", longSlug);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain("40");
  });

  test("a composed name exactly at the 40-char boundary does not throw", () => {
    // "feat-" (5 chars) + 35 lowercase letters = exactly 40 chars; the
    // implementation's bound check is `> MAX_SESSION_NAME_LENGTH`, so the
    // boundary value itself must be accepted.
    const boundarySlug = "a".repeat(35);
    const name = buildSessionName("feat", boundarySlug);
    expect(name).toHaveLength(40);
    expect(name).toBe(`feat-${boundarySlug}`);
  });
});
