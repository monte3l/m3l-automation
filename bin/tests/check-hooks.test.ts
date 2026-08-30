import { describe, expect, test } from "vitest";
import {
  KNOWN_EVENTS,
  extractHookScriptName,
  validateHooksConfig,
  extractIfGlob,
  collectSettingsIfGlobs,
  parseHooksReferenceTable,
  diffHooksReferenceIfGlobs,
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
    // @ts-expect-error exercising the runtime guard
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

describe("extractIfGlob", () => {
  test("extracts the glob from a Write(...) if-rule", () => {
    expect(extractIfGlob("Write(*.md)")).toBe("*.md");
  });

  test("extracts the glob from an Edit(...) if-rule", () => {
    expect(extractIfGlob("Edit(packages/m3l-common/package.json)")).toBe(
      "packages/m3l-common/package.json",
    );
  });

  test("returns null for a rule that is neither Write(...) nor Edit(...)", () => {
    expect(extractIfGlob("Bash(gh pr view *)")).toBeNull();
  });

  test("returns null for an empty or missing rule", () => {
    expect(extractIfGlob("")).toBeNull();
    // @ts-expect-error exercising the runtime guard
    expect(extractIfGlob(undefined)).toBeNull();
  });
});

describe("collectSettingsIfGlobs", () => {
  test("groups if-scoped globs by event::hookName, deduplicating Write+Edit pairs", () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-doc-counts.mjs"',
                timeout: 120,
                if: "Write(README.md)",
              },
              {
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-doc-counts.mjs"',
                timeout: 120,
                if: "Edit(README.md)",
              },
            ],
          },
        ],
      },
    };
    const result = collectSettingsIfGlobs(settings);
    expect(result.get("PostToolUse::guard-doc-counts.mjs")).toEqual(
      new Set(["README.md"]),
    );
  });

  test("a hook with no if field contributes nothing", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-js-extension.mjs"',
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    expect(collectSettingsIfGlobs(settings).size).toBe(0);
  });
});

describe("parseHooksReferenceTable", () => {
  test("parses a row with a single if-scoped glob out of the Matcher cell", () => {
    const md =
      "| Event | Matcher | Hook | Purpose | Mode |\n" +
      "| - | - | - | - | - |\n" +
      "| PostToolUse | `Write\\|Edit` if `packages/m3l-common/package.json` | `guard-exports-semver.mjs` | x | advisory |\n";
    const rows = parseHooksReferenceTable(md);
    expect(rows).toEqual([
      {
        event: "PostToolUse",
        hookName: "guard-exports-semver.mjs",
        ifGlobs: ["packages/m3l-common/package.json"],
      },
    ]);
  });

  test("a row with no if-clause parses with an empty ifGlobs array", () => {
    const md =
      "| Event | Matcher | Hook | Purpose | Mode |\n" +
      "| - | - | - | - | - |\n" +
      "| PreToolUse | `Bash` | `guard-git-push-signed.mjs` | x | blocking |\n";
    const rows = parseHooksReferenceTable(md);
    expect(rows).toEqual([
      {
        event: "PreToolUse",
        hookName: "guard-git-push-signed.mjs",
        ifGlobs: [],
      },
    ]);
  });

  test("ignores the header and separator rows", () => {
    const md =
      "| Event | Matcher | Hook | Purpose | Mode |\n" +
      "| - | - | - | - | - |\n";
    expect(parseHooksReferenceTable(md)).toEqual([]);
  });
});

describe("diffHooksReferenceIfGlobs", () => {
  test("no mismatch when documented globs equal the actual wired globs", () => {
    const docRows = [
      {
        event: "PostToolUse",
        hookName: "guard-doc-counts.mjs",
        ifGlobs: ["README.md"],
      },
    ];
    const actual = new Map([
      ["PostToolUse::guard-doc-counts.mjs", new Set(["README.md"])],
    ]);
    expect(diffHooksReferenceIfGlobs(docRows, actual)).toEqual([]);
  });

  test("flags a doc row whose Matcher cell omits an if-glob settings.json actually wires", () => {
    const docRows = [
      { event: "PostToolUse", hookName: "guard-doc-counts.mjs", ifGlobs: [] },
    ];
    const actual = new Map([
      ["PostToolUse::guard-doc-counts.mjs", new Set(["README.md"])],
    ]);
    expect(diffHooksReferenceIfGlobs(docRows, actual)).toEqual([
      {
        event: "PostToolUse",
        hookName: "guard-doc-counts.mjs",
        documented: [],
        actual: ["README.md"],
      },
    ]);
  });
});
