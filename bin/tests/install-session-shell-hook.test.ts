import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  MARKER_BEGIN,
  MARKER_END,
  buildShellFunctionBlock,
  computeInstallPlan,
  detectRcPath,
} from "../install-session-shell-hook.mjs";

describe("buildShellFunctionBlock", () => {
  test("contains both markers, begin before end", () => {
    const result = buildShellFunctionBlock();

    expect(result.includes(MARKER_BEGIN)).toBe(true);
    expect(result.includes(MARKER_END)).toBe(true);
    expect(result.indexOf(MARKER_BEGIN)).toBeLessThan(
      result.indexOf(MARKER_END),
    );
  });

  test("contains the shell function name, delegation target, and bypass env var", () => {
    const result = buildShellFunctionBlock();

    expect(result).toContain("claude()");
    expect(result).toContain("pnpm session:launch");
    expect(result).toContain("CLAUDE_SESSION_LAUNCH_DISABLE");
  });

  test("is deterministic across calls", () => {
    expect(buildShellFunctionBlock()).toBe(buildShellFunctionBlock());
  });

  test("restricts delegation to feat/<slug> or fix/<slug> branches", () => {
    const result = buildShellFunctionBlock();

    expect(result).toContain("git rev-parse --abbrev-ref HEAD");
    expect(result).toContain("(feat|fix)");
  });
});

describe("detectRcPath", () => {
  test.each([
    ["/bin/zsh", join("/home/x", ".zshrc")],
    ["/usr/bin/zsh", join("/home/x", ".zshrc")],
    ["/bin/bash", join("/home/x", ".bashrc")],
    ["/usr/local/bin/bash", join("/home/x", ".bashrc")],
    ["/bin/fish", join("/home/x", ".profile")],
    ["", join("/home/x", ".profile")],
  ])("SHELL=%s -> %s", (shell, expected) => {
    expect(detectRcPath({ SHELL: shell }, "/home/x")).toBe(expected);
  });

  test("falls back to .profile when SHELL is unset", () => {
    expect(detectRcPath({}, "/home/x")).toBe(join("/home/x", ".profile"));
  });
});

describe("computeInstallPlan", () => {
  test("null content: not installed, newContent is the block plus trailing newline", () => {
    const result = computeInstallPlan(null);

    expect(result.alreadyInstalled).toBe(false);
    expect(result.newContent).toBe(`${buildShellFunctionBlock()}\n`);
  });

  test("empty string content behaves the same as null", () => {
    const result = computeInstallPlan("");

    expect(result.alreadyInstalled).toBe(false);
    expect(result.newContent).toBe(`${buildShellFunctionBlock()}\n`);
  });

  test("existing content already ending in a newline: exactly one blank line before the block", () => {
    const existing = "export PATH=foo\n";

    const result = computeInstallPlan(existing);

    expect(result.alreadyInstalled).toBe(false);
    expect(result.newContent).toBe(
      `${existing}\n${buildShellFunctionBlock()}\n`,
    );
  });

  test("existing content NOT ending in a newline: a newline is inserted before the separator", () => {
    const existing = "export PATH=foo";

    const result = computeInstallPlan(existing);

    expect(result.alreadyInstalled).toBe(false);
    expect(result.newContent).toBe(
      `${existing}\n\n${buildShellFunctionBlock()}\n`,
    );
  });

  test("content already containing MARKER_BEGIN: reports already installed, content unchanged", () => {
    const alreadyInstalled = computeInstallPlan(null).newContent;

    const result = computeInstallPlan(alreadyInstalled);

    expect(result.alreadyInstalled).toBe(true);
    expect(result.newContent).toBe(alreadyInstalled);
  });

  test("idempotency: re-running against already-installed content does not duplicate the marker", () => {
    const firstPass = computeInstallPlan(null).newContent;

    const secondPass = computeInstallPlan(firstPass);

    const occurrences = secondPass.newContent.split(MARKER_BEGIN).length - 1;
    expect(occurrences).toBe(1);
    expect(secondPass.newContent.length).toBe(firstPass.length);
  });
});
