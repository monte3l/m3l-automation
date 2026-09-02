import { describe, expect, test } from "vitest";
import { stripForbiddenTrailers } from "../../bin/strip-claude-trailers.mjs";

describe("stripForbiddenTrailers", () => {
  test("removes a trailing Claude-Session line while keeping Co-Authored-By", () => {
    const text =
      "feat: add a helper\n\nBody text.\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n" +
      "Claude-Session: https://claude.ai/code/session_01ABC";

    const result = stripForbiddenTrailers(text);

    expect(result.removed).toEqual([
      "Claude-Session: https://claude.ai/code/session_01ABC",
    ]);
    expect(result.text).not.toContain("Claude-Session");
    expect(result.text).toContain(
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
    );
  });

  test("returns a message with no forbidden trailer unchanged", () => {
    const text =
      "feat: add a helper\n\nBody text.\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";

    const result = stripForbiddenTrailers(text);

    expect(result.text).toBe(text);
    expect(result.removed).toEqual([]);
  });

  test("strips a forbidden trailer that is the very last line with no trailing blank line", () => {
    const text =
      "feat: add a helper\n\nBody text.\n\n" +
      "Claude-Session: https://claude.ai/code/session_01ABC";

    const result = stripForbiddenTrailers(text);

    expect(result.removed).toEqual([
      "Claude-Session: https://claude.ai/code/session_01ABC",
    ]);
    expect(result.text).not.toContain("Claude-Session");
    expect(result.text).toContain("Body text.");
  });

  test("is idempotent: stripping the already-stripped text removes nothing further", () => {
    const text =
      "feat: add a helper\n\nBody text.\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n" +
      "Claude-Session: https://claude.ai/code/session_01ABC";

    const first = stripForbiddenTrailers(text);
    const second = stripForbiddenTrailers(first.text);

    expect(second.removed).toEqual([]);
    expect(second.text).toBe(first.text);
  });

  test("strips a mid-body occurrence (squash-merge shape) and preserves surrounding content", () => {
    const text =
      "feat: squashed commit\n\n" +
      "Body start.\n" +
      "Claude-Session: https://claude.ai/code/session_01ABC\n" +
      "More body content.\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";

    const result = stripForbiddenTrailers(text);

    expect(result.removed).toEqual([
      "Claude-Session: https://claude.ai/code/session_01ABC",
    ]);
    expect(result.text).not.toContain("Claude-Session");
    expect(result.text).toContain("Body start.");
    expect(result.text).toContain("More body content.");
    expect(result.text).toContain(
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
    );
  });

  test("strips multiple occurrences from a squashed multi-commit message", () => {
    const text =
      "feat: squashed commit\n\n" +
      "Claude-Session: https://claude.ai/code/session_01AAA\n" +
      "Body part one.\n" +
      "Claude-Session: https://claude.ai/code/session_01BBB\n" +
      "Body part two.\n" +
      "Claude-Session: https://claude.ai/code/session_01CCC\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";

    const result = stripForbiddenTrailers(text);

    expect(result.removed).toHaveLength(3);
    expect(result.text).not.toContain("Claude-Session");
    expect(result.text).toContain("Body part one.");
    expect(result.text).toContain("Body part two.");
  });

  test("strips a forbidden trailer whose key is matched case-insensitively", () => {
    const text =
      "feat: add a helper\n\nBody text.\n\n" +
      "claude-session: https://claude.ai/code/session_01ABC\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";

    const result = stripForbiddenTrailers(text);

    expect(result.removed).toEqual([
      "claude-session: https://claude.ai/code/session_01ABC",
    ]);
    expect(result.text).not.toContain("claude-session");
    expect(result.text).toContain(
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
    );
  });
});
