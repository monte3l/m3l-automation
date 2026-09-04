import { describe, expect, test } from "vitest";
import {
  KNOWN_EVENTS,
  KNOWN_MATCHERS,
  extractHookScriptName,
  validateHooksConfig,
  extractIfGlob,
  collectSettingsIfGlobs,
  parseHooksReferenceTable,
  diffHooksReferenceIfGlobs,
  STATUSLINE_SETTINGS_KEYS,
  validateStatuslineShape,
  scanStatuslineScriptForForbiddenPatterns,
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

  test("a statusLine.command wiring an existing hook script produces no error or dead-hook warning and is added to referenced", () => {
    const settings = {
      hooks: {},
      statusLine: {
        command:
          'node "$CLAUDE_PROJECT_DIR/.claude/hooks/render-statusline.mjs"',
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["render-statusline.mjs"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(new Set(["render-statusline.mjs"]));
  });

  test("a statusLine.command wiring a hook script that does not exist on disk is exactly one error naming statusLine", () => {
    const settings = {
      hooks: {},
      statusLine: {
        command:
          'node "$CLAUDE_PROJECT_DIR/.claude/hooks/missing-statusline.mjs"',
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => false,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([
      '.claude/settings.json\'s "statusLine" wires "missing-statusline.mjs" but .claude/hooks/missing-statusline.mjs does not exist.',
    ]);
  });

  test("settings.statusLine absent behaves identically to before: no statusLine errors/warnings, existing dead-hook warnings still fire", () => {
    const settings = { hooks: {} };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["orphan-hook.mjs"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("orphan-hook.mjs exists but is not wired"),
    ]);
    expect(result.referenced).toEqual(new Set());
  });

  test("a statusLine.command that is not a .claude/hooks/*.mjs-shaped string is silently ignored: no crash, no referenced entry, no statusLine error", () => {
    const settings = {
      hooks: {},
      statusLine: { command: "some-other-statusline-binary --flag" },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(new Set());
  });

  test("a subagentStatusLine.command wiring an existing hook script produces no error or dead-hook warning and is added to referenced", () => {
    const settings = {
      hooks: {},
      subagentStatusLine: {
        command:
          'node "$CLAUDE_PROJECT_DIR/.claude/hooks/render-subagent-statusline.mjs"',
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["render-subagent-statusline.mjs"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(
      new Set(["render-subagent-statusline.mjs"]),
    );
  });

  test("a subagentStatusLine.command wiring a hook script that does not exist on disk is exactly one error naming subagentStatusLine", () => {
    const settings = {
      hooks: {},
      subagentStatusLine: {
        command:
          'node "$CLAUDE_PROJECT_DIR/.claude/hooks/missing-subagent-statusline.mjs"',
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => false,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([
      '.claude/settings.json\'s "subagentStatusLine" wires "missing-subagent-statusline.mjs" but .claude/hooks/missing-subagent-statusline.mjs does not exist.',
    ]);
  });

  test("settings.subagentStatusLine absent behaves identically to before: no subagentStatusLine errors/warnings, existing dead-hook warnings still fire", () => {
    const settings = { hooks: {} };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: ["orphan-hook.mjs"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("orphan-hook.mjs exists but is not wired"),
    ]);
    expect(result.referenced).toEqual(new Set());
  });

  test("a subagentStatusLine.command that is not a .claude/hooks/*.mjs-shaped string is silently ignored: no crash, no referenced entry, no subagentStatusLine error", () => {
    const settings = {
      hooks: {},
      subagentStatusLine: {
        command: "some-other-subagent-statusline-binary --flag",
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(new Set());
  });

  test("statusLine and subagentStatusLine wired simultaneously both resolve independently with no cross-interference", () => {
    const settings = {
      hooks: {},
      statusLine: {
        command:
          'node "$CLAUDE_PROJECT_DIR/.claude/hooks/statusline-context-pressure.mjs"',
      },
      subagentStatusLine: {
        command:
          'node "$CLAUDE_PROJECT_DIR/.claude/hooks/subagent-statusline.mjs"',
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [
        "statusline-context-pressure.mjs",
        "subagent-statusline.mjs",
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.referenced).toEqual(
      new Set(["statusline-context-pressure.mjs", "subagent-statusline.mjs"]),
    );
  });
});

describe("KNOWN_MATCHERS", () => {
  test("holds the documented matcher sets for SessionStart, PreCompact, PostCompact", () => {
    expect(KNOWN_MATCHERS.get("SessionStart")).toEqual(
      new Set(["startup", "resume", "clear", "compact", "fork"]),
    );
    expect(KNOWN_MATCHERS.get("PreCompact")).toEqual(
      new Set(["manual", "auto"]),
    );
    expect(KNOWN_MATCHERS.get("PostCompact")).toEqual(
      new Set(["manual", "auto"]),
    );
  });
});

describe("matcher validation", () => {
  function hook(command: string, timeout?: number) {
    return timeout === undefined ? { command } : { command, timeout };
  }

  test("a SessionStart entry with a known-good matcher produces no matcher error", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "compact",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reinject-compact-handoff.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("a SessionStart entry with an unknown matcher is exactly one error naming the event, value, and undocumented-ness", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "compct",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reinject-compact-handoff.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([expect.stringContaining('"SessionStart"')]);
    expect(result.errors[0]).toContain("compct");
    expect(result.errors[0]).toContain("not one of the documented values");
  });

  test.each([["manual"], ["auto"]])(
    "a PreCompact entry with matcher %s produces no error",
    (matcher) => {
      const settings = {
        hooks: {
          PreCompact: [
            {
              matcher,
              hooks: [
                hook(
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-precompact-hook.mjs"',
                  30,
                ),
              ],
            },
          ],
        },
      };
      const result = validateHooksConfig(settings, {
        hookFileExists: () => true,
        onDiskHookNames: [],
      });
      expect(result.errors).toEqual([]);
    },
  );

  test("a PreCompact entry with an unknown matcher is an error", () => {
    const settings = {
      hooks: {
        PreCompact: [
          {
            matcher: "sometimes",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-precompact-hook.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([expect.stringContaining("sometimes")]);
  });

  test.each([
    ["clear"],
    ["resume"],
    ["logout"],
    ["prompt_input_exit"],
    ["other"],
  ])("a SessionEnd entry with matcher %s produces no error", (matcher) => {
    const settings = {
      hooks: {
        SessionEnd: [
          {
            matcher,
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-sessionend-hook.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("a SessionEnd entry with an unknown matcher is an error", () => {
    const settings = {
      hooks: {
        SessionEnd: [
          {
            matcher: "shutdown",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-sessionend-hook.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([expect.stringContaining("shutdown")]);
  });

  test.each([["slash_command"], ["register_repo_root"]])(
    "a DirectoryAdded entry with matcher %s produces no error",
    (matcher) => {
      const settings = {
        hooks: {
          DirectoryAdded: [
            {
              matcher,
              hooks: [
                hook(
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-diradded-hook.mjs"',
                  30,
                ),
              ],
            },
          ],
        },
      };
      const result = validateHooksConfig(settings, {
        hookFileExists: () => true,
        onDiskHookNames: [],
      });
      expect(result.errors).toEqual([]);
    },
  );

  test("a DirectoryAdded entry with an unknown matcher is an error", () => {
    const settings = {
      hooks: {
        DirectoryAdded: [
          {
            matcher: "manual_add",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-diradded-hook.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([expect.stringContaining("manual_add")]);
  });

  test("WorktreeCreate has no closed matcher set — any matcher value is unchecked", () => {
    const settings = {
      hooks: {
        WorktreeCreate: [
          {
            matcher: "anything-at-all",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/some-worktreecreate-hook.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("an event with no known matcher set (e.g. PreToolUse) is never checked against KNOWN_MATCHERS", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "NotARealTool",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-js-extension.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("an entry with no matcher field at all produces no matcher error, for a known- or unknown-matcher event", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reinject-compact-handoff.mjs"',
                30,
              ),
            ],
          },
        ],
        PreToolUse: [
          {
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-js-extension.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("a pipe-alternation matcher with all-valid tokens produces no error", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "compact|fork",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reinject-compact-handoff.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toEqual([]);
  });

  test("a pipe-alternation matcher with one bad token is exactly one error naming only the bad token", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "compact|bogus",
            hooks: [
              hook(
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reinject-compact-handoff.mjs"',
                30,
              ),
            ],
          },
        ],
      },
    };
    const result = validateHooksConfig(settings, {
      hookFileExists: () => true,
      onDiskHookNames: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bogus");
    expect(result.errors[0]).not.toContain('"compact" is not');
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

describe("validateStatuslineShape", () => {
  test("returns no errors when both statusLine and subagentStatusLine are absent", () => {
    expect(validateStatuslineShape({})).toEqual([]);
  });

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "returns no errors for %s with a valid type and refreshInterval",
    (key) => {
      const settings = { [key]: { type: "command", refreshInterval: 5 } };
      expect(validateStatuslineShape(settings)).toEqual([]);
    },
  );

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "returns no errors for %s when refreshInterval is undefined but type is valid",
    (key) => {
      const settings = { [key]: { type: "command" } };
      expect(validateStatuslineShape(settings)).toEqual([]);
    },
  );

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "flags %s when type is not the literal 'command'",
    (key) => {
      const settings = { [key]: { type: "other" } };
      expect(validateStatuslineShape(settings)).toEqual([
        `.claude/settings.json's "${key}.type" is "other" — must be the literal "command" (any other value silently disables it).`,
      ]);
    },
  );

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "flags %s when type is missing entirely",
    (key) => {
      const settings = { [key]: { refreshInterval: 5 } };
      expect(validateStatuslineShape(settings)).toEqual([
        `.claude/settings.json's "${key}.type" is undefined — must be the literal "command" (any other value silently disables it).`,
      ]);
    },
  );

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "flags %s when refreshInterval is present but not a number",
    (key) => {
      const settings = { [key]: { type: "command", refreshInterval: "5" } };
      expect(validateStatuslineShape(settings)).toEqual([
        `.claude/settings.json's "${key}.refreshInterval" is "5" — must be a number >= 1.`,
      ]);
    },
  );

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "flags %s when refreshInterval is present but non-finite",
    (key) => {
      const settings = {
        [key]: { type: "command", refreshInterval: Number.POSITIVE_INFINITY },
      };
      expect(validateStatuslineShape(settings)).toEqual([
        `.claude/settings.json's "${key}.refreshInterval" is null — must be a number >= 1.`,
      ]);
    },
  );

  test.each(STATUSLINE_SETTINGS_KEYS)(
    "flags %s when refreshInterval is present but less than 1",
    (key) => {
      const settings = { [key]: { type: "command", refreshInterval: 0 } };
      expect(validateStatuslineShape(settings)).toEqual([
        `.claude/settings.json's "${key}.refreshInterval" is 0 — must be a number >= 1.`,
      ]);
    },
  );

  test("reports errors for both keys independently when both are present and invalid", () => {
    const settings = {
      statusLine: { type: "bad" },
      subagentStatusLine: { type: "command", refreshInterval: -1 },
    };
    expect(validateStatuslineShape(settings)).toEqual([
      `.claude/settings.json's "statusLine.type" is "bad" — must be the literal "command" (any other value silently disables it).`,
      `.claude/settings.json's "subagentStatusLine.refreshInterval" is -1 — must be a number >= 1.`,
    ]);
  });

  test("skips a key whose value is not a non-null object (no crash, no error)", () => {
    expect(validateStatuslineShape({ statusLine: "not-an-object" })).toEqual(
      [],
    );
    expect(validateStatuslineShape({ statusLine: null })).toEqual([]);
    expect(validateStatuslineShape({ statusLine: 5 })).toEqual([]);
  });
});

describe("scanStatuslineScriptForForbiddenPatterns", () => {
  test("returns no errors for clean source", () => {
    const source = [
      'import process from "node:process";',
      "export function foo() { return 1; }",
    ].join("\n");
    expect(
      scanStatuslineScriptForForbiddenPatterns("clean.mjs", source),
    ).toEqual([]);
  });

  test("flags a node:child_process import", () => {
    const source = 'import { spawn } from "node:child_process";';
    expect(scanStatuslineScriptForForbiddenPatterns("bad.mjs", source)).toEqual(
      [
        `.claude/hooks/bad.mjs imports node:child_process — violates ADR-0080's "no subprocess, no network" invariant for a statusline script.`,
      ],
    );
  });

  test("flags a bare spawn(...) call", () => {
    const source = "spawn('ls');";
    expect(scanStatuslineScriptForForbiddenPatterns("bad.mjs", source)).toEqual(
      [
        `.claude/hooks/bad.mjs calls spawn(...) — violates ADR-0080's "no subprocess, no network" invariant for a statusline script.`,
      ],
    );
  });

  test.each(["exec", "execSync", "execFile", "execFileSync"])(
    "flags a bare %s(...) call",
    (fnName) => {
      const source = `${fnName}('ls');`;
      expect(
        scanStatuslineScriptForForbiddenPatterns("bad.mjs", source),
      ).toEqual([
        `.claude/hooks/bad.mjs calls exec*(...) — violates ADR-0080's "no subprocess, no network" invariant for a statusline script.`,
      ]);
    },
  );

  test("flags a fetch(...) call", () => {
    const source = 'fetch("https://example.test");';
    expect(scanStatuslineScriptForForbiddenPatterns("bad.mjs", source)).toEqual(
      [
        `.claude/hooks/bad.mjs calls fetch(...) — violates ADR-0080's "no subprocess, no network" invariant for a statusline script.`,
      ],
    );
  });

  test("flags a node:http(s) import", () => {
    const source = 'import http from "node:http";';
    expect(scanStatuslineScriptForForbiddenPatterns("bad.mjs", source)).toEqual(
      [
        `.claude/hooks/bad.mjs imports node:http(s) — violates ADR-0080's "no subprocess, no network" invariant for a statusline script.`,
      ],
    );
  });

  test("does NOT flag a RegExp.prototype.exec(...) method call (dot-prefixed .exec(...))", () => {
    const source =
      "const m = /^ref:\\s*refs\\/heads\\/(.+)$/.exec(headContent.trim());";
    expect(
      scanStatuslineScriptForForbiddenPatterns("clean.mjs", source),
    ).toEqual([]);
  });

  test("does NOT flag a dot-prefixed .match(...) call (sanity check the discriminator targets a leading boundary, not just the word)", () => {
    const source = "content.match(/gitdir:\\s*(.+)/m);";
    expect(
      scanStatuslineScriptForForbiddenPatterns("clean.mjs", source),
    ).toEqual([]);
  });

  test("does NOT flag a dot-prefixed spawn(...)/exec(...) call (e.g. childProcess.spawn) -- by design, only a bare unqualified call triggers this pattern", () => {
    const source = "childProcess.spawn('ls'); childProcess.exec('ls');";
    expect(
      scanStatuslineScriptForForbiddenPatterns("clean.mjs", source),
    ).toEqual([]);
  });

  test("flags multiple distinct violations in one source, one error per pattern", () => {
    const source = [
      'import { spawn } from "node:child_process";',
      'fetch("https://example.test");',
    ].join("\n");
    const errors = scanStatuslineScriptForForbiddenPatterns("bad.mjs", source);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("imports node:child_process");
    expect(errors[1]).toContain("calls fetch(...)");
  });

  test("does not flag prose mentioning 'spawn' or 'exec' with no following call parenthesis", () => {
    const source =
      "// This script must never spawn a subprocess or exec anything.";
    expect(
      scanStatuslineScriptForForbiddenPatterns("clean.mjs", source),
    ).toEqual([]);
  });
});
