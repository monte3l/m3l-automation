import { describe, expect, test } from "vitest";
import {
  hasShellDetach,
  shouldBlockDoubleBackground,
} from "../../.claude/hooks/guard-double-background.mjs";

describe("hasShellDetach: nohup / disown", () => {
  test.each([
    "nohup pnpm verify > log.txt 2>&1",
    "nohup pnpm verify",
    "cd foo && nohup pnpm test",
  ])("detects nohup in %s", (command) => {
    expect(hasShellDetach(command)).toBe(true);
  });

  test.each(["pnpm verify & disown", "disown"])(
    "detects disown in %s",
    (command) => {
      expect(hasShellDetach(command)).toBe(true);
    },
  );

  test("detects nohup right after a && separator", () => {
    expect(hasShellDetach("true && nohup cmd &")).toBe(true);
  });

  test("detects nohup right after a ; separator", () => {
    expect(hasShellDetach("cmd1; nohup cmd2")).toBe(true);
  });
});

describe("hasShellDetach: trailing background &", () => {
  test.each([
    "pnpm verify > log.txt 2>&1 &",
    "long_running_cmd &",
    "cmd1 & echo started",
  ])("detects a bare backgrounding & in %s", (command) => {
    expect(hasShellDetach(command)).toBe(true);
  });

  test("detects a real trailing & even after a &> redirect earlier in the command", () => {
    expect(hasShellDetach("cmd &>/dev/null &")).toBe(true);
  });
});

describe("hasShellDetach: false positives it must NOT flag", () => {
  test.each([
    "pnpm build 2>&1 | tail -20",
    "cmd1 && cmd2",
    "cd foo && pnpm test && pnpm build",
    "pnpm verify > log.txt 2>&1",
    "echo hello",
    "",
    "pnpm build &> build.log",
    "cmd &>/dev/null",
    "cmd &>> log.txt",
    "grep -n nohup docs/logs/*.md",
    "grep -n disown docs/logs/*.md",
    'gh api "repos/o/r/pulls?per_page=100&page=2"',
  ])("does not flag %s", (command) => {
    expect(hasShellDetach(command)).toBe(false);
  });
});

describe("shouldBlockDoubleBackground: the actual guard decision", () => {
  test("blocks run_in_background:true + trailing &", () => {
    expect(
      shouldBlockDoubleBackground("pnpm verify > log.txt 2>&1 &", true),
    ).toBe(true);
  });

  test("blocks run_in_background:true + nohup", () => {
    expect(
      shouldBlockDoubleBackground("nohup pnpm verify > log.txt 2>&1", true),
    ).toBe(true);
  });

  test("blocks run_in_background:true + disown", () => {
    expect(shouldBlockDoubleBackground("pnpm verify & disown", true)).toBe(
      true,
    );
  });

  test("allows run_in_background:true with no detach construct", () => {
    expect(shouldBlockDoubleBackground("pnpm verify", true)).toBe(false);
  });

  test("allows a trailing & when run_in_background is not true", () => {
    expect(shouldBlockDoubleBackground("long_running_cmd &", false)).toBe(
      false,
    );
    expect(shouldBlockDoubleBackground("long_running_cmd &", undefined)).toBe(
      false,
    );
  });

  test("allows && (logical AND) with run_in_background:true", () => {
    expect(shouldBlockDoubleBackground("cd foo && pnpm test", true)).toBe(
      false,
    );
  });

  test("allows a 2>&1 redirect with run_in_background:true", () => {
    expect(
      shouldBlockDoubleBackground("pnpm build 2>&1 | tail -20", true),
    ).toBe(false);
  });

  test("allows a non-string command rather than throwing", () => {
    // @ts-expect-error exercising the runtime guard for a malformed hook payload
    expect(shouldBlockDoubleBackground(undefined, true)).toBe(false);
    // @ts-expect-error exercising the runtime guard for a malformed hook payload
    expect(shouldBlockDoubleBackground(null, true)).toBe(false);
  });

  test("allows a non-boolean run_in_background rather than throwing", () => {
    expect(shouldBlockDoubleBackground("cmd &", "true")).toBe(false);
    expect(shouldBlockDoubleBackground("cmd &", 1)).toBe(false);
  });

  test("allows an empty command string", () => {
    expect(shouldBlockDoubleBackground("", true)).toBe(false);
  });
});
