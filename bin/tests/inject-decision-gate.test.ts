import { describe, expect, test } from "vitest";
import {
  looksLikeChangeWork,
  buildContext,
} from "../../.claude/hooks/inject-decision-gate.mjs";

describe("looksLikeChangeWork", () => {
  test("triggers on imperative change verbs", () => {
    expect(looksLikeChangeWork("implement the polling submodule")).toBe(true);
    expect(looksLikeChangeWork("fix the typo in the config error")).toBe(true);
    expect(looksLikeChangeWork("add a retry helper to core")).toBe(true);
    expect(looksLikeChangeWork("refactor the M3LPaths resolver")).toBe(true);
  });

  test("stays quiet on pure questions / reads", () => {
    expect(looksLikeChangeWork("what does M3LPaths do?")).toBe(false);
    expect(looksLikeChangeWork("how is the exports map structured?")).toBe(
      false,
    );
    expect(looksLikeChangeWork("explain the error hierarchy")).toBe(false);
  });

  test("triggers when a read opener is followed by a change verb + object", () => {
    // "review the code and add a test" reads as change-work.
    expect(looksLikeChangeWork("update the docs then add a test")).toBe(true);
  });

  test("ignores empty / non-string input", () => {
    expect(looksLikeChangeWork("")).toBe(false);
    // @ts-expect-error exercising the runtime guard
    expect(looksLikeChangeWork(undefined)).toBe(false);
  });
});

describe("buildContext", () => {
  test("names all four decisions", () => {
    const ctx = buildContext("feat/x");
    expect(ctx).toMatch(/Location/);
    expect(ctx).toMatch(/Branch/);
    expect(ctx).toMatch(/PR/);
    expect(ctx).toMatch(/Push/);
    expect(ctx).toMatch(/on `feat\/x`/);
  });

  test("calls out being on main", () => {
    expect(buildContext("main")).toMatch(/on\/at `main` now/);
  });

  test("handles detached HEAD and no-repo", () => {
    expect(buildContext("HEAD")).toMatch(/detached HEAD/);
    expect(buildContext("")).toMatch(/not a git repo/);
  });
});
