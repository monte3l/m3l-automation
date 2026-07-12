import { describe, expect, test } from "vitest";
import {
  KNOWN_EVENTS,
  extractHookScriptName,
  validateHooksConfig,
} from "../../bin/check-hooks.mjs";

describe("extractHookScriptName", () => {
  test("pulls the script name out of a quoted $CLAUDE_PROJECT_DIR command", () => {
    expect(
      extractHookScriptName(
        'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-secret-writes.mjs"',
      ),
    ).toBe("guard-secret-writes.mjs");
  });

  test("returns null for a command with no .claude/hooks/*.mjs reference", () => {
    expect(extractHookScriptName("node some/other/script.mjs")).toBeNull();
  });

  test("returns null for an empty or missing command", () => {
    expect(extractHookScriptName("")).toBeNull();
    expect(extractHookScriptName(undefined)).toBeNull();
  });
});

describe("KNOWN_EVENTS", () => {
  test("includes every event currently wired in settings.json", () => {
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "Stop",
      "PostToolUse",
    ]) {
      expect(KNOWN_EVENTS.has(event)).toBe(true);
    }
  });
});

describe("validateHooksConfig", () => {
  function hook(command: string, timeout?: number) {
    return timeout === undefined ? { command } : { command, timeout };
  }

  test("a fully wired, existing, timed-out hook produces no errors or warnings", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/remind-sync-docs.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["remind-sync-docs.mjs"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(new Set(["remind-sync-docs.mjs"]));
  });

  test("an unknown event key is an error", () => {
    const settings = { hooks: { PostToolUseX: [{ hooks: [] }] } };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([
      expect.stringContaining('unknown hook event "PostToolUseX"'),
    ]);
  });

  test("a referenced script that does not exist on disk is an error", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/deleted-hook.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => false,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([
      expect.stringContaining(
        'wires "deleted-hook.mjs" but .claude/hooks/deleted-hook.mjs does not exist',
      ),
    ]);
  });

  test("a hook missing an explicit timeout is a warning, not an error", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/remind-sync-docs.mjs"',
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["remind-sync-docs.mjs"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('no explicit "timeout"'),
    ]);
  });

  test("an on-disk hook never referenced by settings.json is a warning (orphan)", () => {
    const settings = { hooks: {} };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["orphan-hook.mjs"],
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("orphan-hook.mjs exists but is not wired"),
    ]);
  });

  test("empty settings.hooks produces no errors or warnings", () => {
    const result = validateHooksConfig(
      {},
      { hookFileExists: () => true, onDiskHookNames: [] },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(new Set());
  });
});
