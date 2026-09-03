import { describe, expect, test } from "vitest";
import { parseWorktreeNewArgs, worktreeDirName } from "../lib/worktree-new.mjs";

describe("parseWorktreeNewArgs", () => {
  test("no flags defaults to a feat kind with no --from ref", () => {
    expect(parseWorktreeNewArgs(["core-json"])).toEqual({
      ok: true,
      slug: "core-json",
      kind: "feat",
      from: null,
    });
  });

  test("--fix selects a fix kind", () => {
    expect(parseWorktreeNewArgs(["core-json", "--fix"])).toEqual({
      ok: true,
      slug: "core-json",
      kind: "fix",
      from: null,
    });
  });

  test("--from <ref> yields a null kind (a detached worktree has no branch prefix)", () => {
    expect(parseWorktreeNewArgs(["core-json", "--from", "main"])).toEqual({
      ok: true,
      slug: "core-json",
      kind: null,
      from: "main",
    });
  });

  test("--from's position in argv is independent of the slug's position", () => {
    expect(parseWorktreeNewArgs(["--from", "main", "core-json"])).toEqual({
      ok: true,
      slug: "core-json",
      kind: null,
      from: "main",
    });
  });

  test("a missing slug reports a missing-slug error", () => {
    const result = parseWorktreeNewArgs([]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "missing <slug>",
    );
  });

  test.each(["Some-Slug", "-slug", "a--b"])(
    "an invalid slug (%s) reports an invalid-slug error naming it",
    (slug) => {
      const result = parseWorktreeNewArgs([slug]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        `invalid slug "${slug}"`,
      );
    },
  );

  test("--from with no value reports a requires-a-ref-argument error", () => {
    const result = parseWorktreeNewArgs(["core-json", "--from"]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "`--from` requires a ref argument",
    );
  });

  test("--from whose value looks like a flag reports the same requires-a-ref-argument error", () => {
    const result = parseWorktreeNewArgs(["core-json", "--from", "--fix"]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "`--from` requires a ref argument",
    );
  });

  test("--from combined with --fix reports a mutually-exclusive error", () => {
    const result = parseWorktreeNewArgs([
      "core-json",
      "--from",
      "main",
      "--fix",
    ]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "mutually exclusive",
    );
  });

  test.each(["feat", "fix", "docs", "chore", "refactor", "ci"])(
    "--kind %s selects that kind",
    (kind) => {
      expect(parseWorktreeNewArgs(["my-slug", "--kind", kind])).toEqual({
        ok: true,
        slug: "my-slug",
        kind,
        from: null,
      });
    },
  );

  test("--kind with an invalid value reports an invalid-kind error naming it", () => {
    const result = parseWorktreeNewArgs(["my-slug", "--kind", "perf"]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      'invalid kind "perf"',
    );
  });

  test("--kind fix combined with --fix agree and succeed with a fix kind", () => {
    expect(parseWorktreeNewArgs(["my-slug", "--kind", "fix", "--fix"])).toEqual(
      {
        ok: true,
        slug: "my-slug",
        kind: "fix",
        from: null,
      },
    );
  });

  test("--kind docs combined with --fix disagree and report a conflicts error", () => {
    const result = parseWorktreeNewArgs(["my-slug", "--kind", "docs", "--fix"]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "conflicts",
    );
  });

  test("--kind combined with --from reports a mutually-exclusive error", () => {
    const result = parseWorktreeNewArgs([
      "my-slug",
      "--kind",
      "docs",
      "--from",
      "main",
    ]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "mutually exclusive",
    );
  });

  test("--kind with no value reports a requires-a-value error", () => {
    const result = parseWorktreeNewArgs(["my-slug", "--kind"]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "requires a value",
    );
  });

  test("an unrecognized flag reports an unrecognized-flag error naming it", () => {
    const result = parseWorktreeNewArgs(["my-slug", "--typo"]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain(
      "unrecognized flag",
    );
    expect((result as { ok: false; error: string }).error).toContain("--typo");
  });
});

describe("worktreeDirName", () => {
  test("prefixes the slug with the repo name", () => {
    expect(worktreeDirName("core-json")).toBe("m3l-automation-core-json");
  });
});
