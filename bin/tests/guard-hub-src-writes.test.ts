// RED-phase test file: the module under test (.claude/hooks/guard-hub-src-writes.mjs)
// does not exist yet. Tests are expected to fail with a module-not-found error
// until the implementation is written by code-implementer.

import { describe, expect, it } from "vitest";
import { shouldBlockHubSrcWrite } from "../../.claude/hooks/guard-hub-src-writes.mjs";

describe("allow cases (returns false)", () => {
  it("allows hub to edit a docs file", () => {
    expect(
      shouldBlockHubSrcWrite("docs/contributing/style-guide.md", undefined),
    ).toBe(false);
  });

  it("allows hub to edit a config file", () => {
    expect(shouldBlockHubSrcWrite("package.json", undefined)).toBe(false);
  });

  it("allows hub to edit .claude tooling", () => {
    expect(shouldBlockHubSrcWrite(".claude/settings.json", undefined)).toBe(
      false,
    );
  });

  it("allows hub to edit bin/ tooling", () => {
    expect(shouldBlockHubSrcWrite("bin/check-hooks.mjs", undefined)).toBe(
      false,
    );
  });

  it("allows a spoke to edit a docs file", () => {
    expect(shouldBlockHubSrcWrite("docs/foo.md", "code-implementer")).toBe(
      false,
    );
  });

  it("allows code-implementer spoke to write a protected src path", () => {
    expect(
      shouldBlockHubSrcWrite(
        "packages/m3l-common/src/core/index.ts",
        "code-implementer",
      ),
    ).toBe(false);
  });

  it("allows test-author spoke to write a protected tests path", () => {
    expect(
      shouldBlockHubSrcWrite(
        "bin/tests/guard-hub-src-writes.test.ts",
        "test-author",
      ),
    ).toBe(false);
  });

  it("allows code-implementer spoke with an absolute guarded path", () => {
    expect(
      shouldBlockHubSrcWrite(
        "/home/user/workspaces/repo/packages/m3l-common/src/foo.ts",
        "code-implementer",
      ),
    ).toBe(false);
  });

  it("allows hub to edit a packages/*/package.json (non-src path)", () => {
    expect(
      shouldBlockHubSrcWrite("packages/m3l-common/package.json", undefined),
    ).toBe(false);
  });
});

describe("block cases (returns true)", () => {
  it("blocks hub writing to packages src", () => {
    expect(
      shouldBlockHubSrcWrite(
        "packages/m3l-common/src/core/index.ts",
        undefined,
      ),
    ).toBe(true);
  });

  it("blocks hub writing to scripts src", () => {
    expect(
      shouldBlockHubSrcWrite("scripts/lambda-ops/src/steps/run.ts", undefined),
    ).toBe(true);
  });

  it("blocks hub writing to bin/tests (tests/ segment)", () => {
    expect(
      shouldBlockHubSrcWrite(
        "bin/tests/guard-hub-src-writes.test.ts",
        undefined,
      ),
    ).toBe(true);
  });

  it("blocks hub writing to packages tests", () => {
    expect(
      shouldBlockHubSrcWrite(
        "packages/m3l-common/tests/foo.test.ts",
        undefined,
      ),
    ).toBe(true);
  });

  it("blocks hub writing to scripts tests", () => {
    expect(
      shouldBlockHubSrcWrite(
        "scripts/lambda-ops/tests/hooks.test.ts",
        undefined,
      ),
    ).toBe(true);
  });

  it("blocks when agentType is an empty string (treated as hub)", () => {
    expect(shouldBlockHubSrcWrite("packages/m3l-common/src/x.ts", "")).toBe(
      true,
    );
  });

  it("blocks a non-writer subagent named 'fork' (laundering hole)", () => {
    expect(shouldBlockHubSrcWrite("packages/m3l-common/src/x.ts", "fork")).toBe(
      true,
    );
  });

  it("blocks a non-writer subagent named 'general-purpose'", () => {
    expect(
      shouldBlockHubSrcWrite("packages/m3l-common/src/x.ts", "general-purpose"),
    ).toBe(true);
  });

  it("blocks a non-writer subagent named 'code-reviewer'", () => {
    expect(
      shouldBlockHubSrcWrite("packages/m3l-common/src/x.ts", "code-reviewer"),
    ).toBe(true);
  });

  it("blocks hub with an absolute guarded path and no agentType", () => {
    expect(
      shouldBlockHubSrcWrite(
        "/home/user/repo/packages/m3l-common/src/foo.ts",
        undefined,
      ),
    ).toBe(true);
  });
});

describe("fail-open / edge cases", () => {
  it("allows when filePath is undefined (fail-open)", () => {
    expect(shouldBlockHubSrcWrite(undefined, undefined)).toBe(false);
  });

  it("allows when filePath is an empty string (fail-open)", () => {
    expect(shouldBlockHubSrcWrite("", undefined)).toBe(false);
  });

  it("blocks when agentType is a non-string number (protected path + non-writer)", () => {
    // agentType: string | undefined | unknown collapses to unknown — pass number directly
    expect(shouldBlockHubSrcWrite("packages/m3l-common/src/x.ts", 42)).toBe(
      true,
    );
  });

  it("blocks when agentType is null (protected path + non-writer)", () => {
    // agentType: string | undefined | unknown collapses to unknown — pass null directly
    expect(shouldBlockHubSrcWrite("packages/m3l-common/src/x.ts", null)).toBe(
      true,
    );
  });
});
