import { describe, expect, test } from "vitest";
import { classifyBashCommand } from "../../.claude/hooks/guard-readonly-bash.mjs";

describe("classifyBashCommand: non-string / empty input", () => {
  test("allows an empty or whitespace-only command", () => {
    expect(classifyBashCommand("")).toEqual({ blocked: false });
    expect(classifyBashCommand("   ")).toEqual({ blocked: false });
  });

  test("allows a non-string command rather than throwing", () => {
    // @ts-expect-error exercising the runtime guard for a malformed hook payload
    expect(classifyBashCommand(undefined)).toEqual({ blocked: false });
  });
});

describe("classifyBashCommand: read-only commands", () => {
  test.each([
    "git diff --staged",
    "git log --oneline -20",
    "git status --porcelain",
    "pnpm lint",
    "pnpm test:coverage",
    "grep -rn foo src/",
    "cat coverage/coverage-final.json",
  ])("allows %s", (command) => {
    expect(classifyBashCommand(command)).toEqual({ blocked: false });
  });

  test("allows a read-only command piped into another read-only command", () => {
    expect(classifyBashCommand("git diff | grep foo")).toEqual({
      blocked: false,
    });
    expect(classifyBashCommand("find . -name x | grep y")).toEqual({
      blocked: false,
    });
  });
});

describe("classifyBashCommand: mutating verbs and subcommands", () => {
  test.each([
    "git commit -m oops",
    "git push origin main",
    "git checkout -b feat/x",
    "rm -rf node_modules",
    "pnpm add left-pad",
    "sed -i s/foo/bar/ file.ts",
    "mkdir scratch",
  ])("blocks %s", (command) => {
    expect(classifyBashCommand(command).blocked).toBe(true);
  });

  test("blocks a mutating command chained after a safe one", () => {
    expect(classifyBashCommand("git diff > /dev/null && rm file").blocked).toBe(
      true,
    );
  });
});

describe("classifyBashCommand: value-consuming global flags before the subcommand", () => {
  test("blocks a mutating subcommand hidden behind git's -C/-c flags", () => {
    expect(classifyBashCommand("git -C /tmp commit -am x").blocked).toBe(true);
    expect(classifyBashCommand("git -c k=v commit -am x").blocked).toBe(true);
  });

  test("blocks a mutating subcommand hidden behind pnpm/npm's --dir/--prefix flags", () => {
    expect(classifyBashCommand("pnpm --dir ./foo add lodash").blocked).toBe(
      true,
    );
    expect(classifyBashCommand("npm --prefix ./foo install").blocked).toBe(
      true,
    );
  });

  test("still allows a safe subcommand behind the same flags", () => {
    expect(classifyBashCommand("git -C /tmp diff --staged")).toEqual({
      blocked: false,
    });
    expect(classifyBashCommand("pnpm --dir ./foo lint")).toEqual({
      blocked: false,
    });
  });
});

describe("classifyBashCommand: write-redirection", () => {
  test("blocks a plain write redirect", () => {
    expect(classifyBashCommand("echo hi > out.txt").blocked).toBe(true);
  });

  test("blocks fd-prefixed redirects (1>/2>), not just bare >", () => {
    expect(classifyBashCommand("echo hi 1>out.txt").blocked).toBe(true);
    expect(classifyBashCommand("echo hi 2>secrets.txt").blocked).toBe(true);
  });

  test("blocks append and clobber redirects", () => {
    expect(classifyBashCommand("echo hi 2>>error.log").blocked).toBe(true);
    expect(classifyBashCommand("echo x >| file.txt").blocked).toBe(true);
  });

  test("allows fd-duplication and discard targets", () => {
    expect(classifyBashCommand("echo hi 2>&1")).toEqual({ blocked: false });
    expect(classifyBashCommand("echo hi 1>&2")).toEqual({ blocked: false });
    expect(classifyBashCommand("echo hi 2>/dev/null")).toEqual({
      blocked: false,
    });
    expect(classifyBashCommand("echo hi > /dev/null")).toEqual({
      blocked: false,
    });
    expect(classifyBashCommand("echo hi > /dev/null 2>&1")).toEqual({
      blocked: false,
    });
  });

  test("blocks a real write hidden behind a leading discard redirect in the same segment", () => {
    // A decoy /dev/null redirect must not short-circuit the scan past a
    // second, real write target later in the same segment.
    expect(
      classifyBashCommand("cat secret > /dev/null > /tmp/leaked.txt").blocked,
    ).toBe(true);
    expect(classifyBashCommand("echo hi 2>/dev/null >secret.txt").blocked).toBe(
      true,
    );
  });

  test("does not treat a real pipe as part of the clobber redirect operator", () => {
    // ">|" (clobber) must not swallow an actual "cmd > x | grep y" pipeline.
    expect(classifyBashCommand("cat file | xargs echo")).toEqual({
      blocked: false,
    });
  });
});
