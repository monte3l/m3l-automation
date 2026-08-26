import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { runWizard } from "../src/commands/wizard.js";
import type { M3LCliWizardPrompt } from "../src/commands/wizard.js";
import { M3LCliError } from "../src/cli/errors.js";
import { sanitizeTerminalText } from "../src/cli/output.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { spawnScript } from "../src/run/spawn.js";
import { recordHistoryEntry } from "../src/history/store.js";
import { writePreset } from "../src/presets/store.js";

/**
 * Contract: `src/commands/wizard.ts` (m3l-cli 8g addendum) — `runWizard`
 * guards on an interactive TTY (default `process.stdin.isTTY`, injectable via
 * `options.isTTY`), lets the caller pick a discovered script via
 * `prompt.autocomplete`, then per declared parameter (in declaration order)
 * dispatches to `password` (secret, regardless of underlying type), `confirm`
 * (BOOL), `number` (INT/DOUBLE), `text` with comma-split (STRING_ARRAY), or
 * plain `text` (everything else) — an empty answer skips an optional
 * parameter silently, and re-prompts once before skipping-with-warning a
 * required one. It renders a redacted PARAMETER/VALUE summary (secret values
 * hard-masked `********`), offers an optional save-as-preset step (a write
 * failure renders an error but still falls through to the run decision), and
 * a final "run now?" confirm — declining resolves `0` without spawning;
 * accepting translates answers through `commands/dynamic.js`'s shared
 * `translateArgv` helper (pinned below via a hoisted mock, since that helper
 * is not exported from `dynamic.ts` until the 8g refactor lands), spawns, and
 * best-effort records history. See the pinned 8g addendum in the m3l-cli-8b
 * contract scratchpad.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));
vi.mock("../src/run/spawn.js", () => ({
  spawnScript: vi.fn(),
}));
vi.mock("../src/history/store.js", () => ({
  recordHistoryEntry: vi.fn(),
}));
vi.mock("../src/presets/store.js", () => ({
  writePreset: vi.fn(),
}));

/**
 * Hoisted rather than a plain top-level `const` — `wizard.ts` is expected to
 * gain a *static* import of `translateArgv` from `commands/dynamic.js` (per
 * the 8g refactor, sharing the helper rather than duplicating it), so this
 * factory must reference an already-initialized binding at hoist time (see
 * the tests-rules "step module reached only via dynamic import" gotcha,
 * which applies here in reverse: `dynamic.js` becomes a static dependency of
 * `wizard.js`, not a dynamic one). Referencing `translateArgv` as a *value*
 * import here would additionally fail typecheck until `dynamic.ts` exports
 * it — the hoisted-mock form pins the export's *name* (the vi.mock factory
 * key) without depending on that export existing yet.
 */
const translateArgvMock = vi.hoisted(() => vi.fn());
vi.mock("../src/commands/dynamic.js", () => ({
  translateArgv: translateArgvMock,
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);
const spawnScriptMock = vi.mocked(spawnScript);
const recordHistoryEntryMock = vi.mocked(recordHistoryEntry);
const writePresetMock = vi.mocked(writePreset);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
  spawnScriptMock.mockReset();
  recordHistoryEntryMock.mockReset();
  writePresetMock.mockReset();
  translateArgvMock.mockReset();
});

/**
 * `M3LCliCommandContext` plus the run-history file's absolute path (8f) —
 * `runWizard`'s own parameter type, narrower than the shared base, mirroring
 * the same local extension pattern already used in `dynamic.test.ts`/
 * `main.test.ts` (real field once GREEN lands; harmless duplicate then).
 */
interface M3LCliCommandContextWithHistory extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

function buildOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    output: {
      colorEnabled: false,
      info: (text: string) => {
        stdoutLines.push(text);
      },
      heading: (text: string) => {
        stdoutLines.push(text);
      },
      error: (text: string) => {
        stderrLines.push(text);
      },
    },
    stdoutLines,
    stderrLines,
  };
}

function buildContext(
  overrides: Partial<M3LCliCommandContextWithHistory> = {},
): M3LCliCommandContextWithHistory {
  const { output } = buildOutputCollector();
  return {
    workspaceRoot: "/workspace",
    output,
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
    ...overrides,
  };
}

/**
 * The concrete shape {@link createScriptedPrompt} builds — declared
 * independently of `M3LCliWizardPrompt` (rather than derived from it via a
 * mapped type) so the fake stays well-typed even while that type is
 * unresolved in RED; once GREEN lands it is expected to remain structurally
 * assignable to the real port (see the "type contract" describe block below).
 */
interface ScriptedPrompt {
  readonly autocomplete: ReturnType<typeof vi.fn>;
  readonly text: ReturnType<typeof vi.fn>;
  readonly password: ReturnType<typeof vi.fn>;
  readonly number: ReturnType<typeof vi.fn>;
  readonly confirm: ReturnType<typeof vi.fn>;
  readonly select: ReturnType<typeof vi.fn>;
}

/** Builds a hand-scripted fake prompt port — never `vi.mock`, per the tests convention. */
function createScriptedPrompt(): ScriptedPrompt {
  return {
    autocomplete: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
  };
}

const jsonEtlCandidate: M3LCliScriptCandidate = {
  name: "json-etl",
  directory: "/workspace/scripts/json-etl",
  description: "Transforms JSON",
};

const exporterCandidate: M3LCliScriptCandidate = {
  name: "exporter",
  directory: "/workspace/scripts/exporter",
  description: "Exports data",
};

/** Stringifies a primitive; falls back to `JSON.stringify` for anything else, never a bare `String(object)`. */
function toDisplayString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

/** Extracts a human-readable label from a bare or `M3LChoice`-shaped autocomplete suggestion. */
function choiceLabel(choice: unknown): string {
  if (typeof choice === "string") {
    return choice;
  }
  if (choice !== null && typeof choice === "object") {
    const record = choice as { name?: unknown; value?: unknown };
    if (typeof record.name === "string") {
      return record.name;
    }
    if (record.value !== undefined) {
      return toDisplayString(record.value);
    }
  }
  return toDisplayString(choice);
}

function makeDescriptor(
  overrides: Partial<M3LCliParameterDescriptor> &
    Pick<M3LCliParameterDescriptor, "name">,
): M3LCliParameterDescriptor {
  return {
    aliases: [],
    type: "STRING",
    required: false,
    defaultValue: undefined,
    description: "",
    secret: false,
    ...overrides,
  };
}

describe("runWizard — non-interactive stdin guard", () => {
  test("returns 2 with a fixed message and never calls discoverScripts when options.isTTY is false", async () => {
    const { output, stderrLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();

    const code = await runWizard(buildContext({ output }), {
      prompt,
      isTTY: false,
    });

    expect(code).toBe(2);
    expect(stderrLines.join("\n")).toContain(
      "wizard requires an interactive terminal",
    );
    expect(discoverScriptsMock).not.toHaveBeenCalled();
    expect(prompt.autocomplete).not.toHaveBeenCalled();
  });
});

describe("runWizard — script selection", () => {
  test("passes an autocomplete suggest function rendering 'name — description' for every discovered candidate", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate, exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm
      .mockResolvedValueOnce(false) // save-as-preset? no
      .mockResolvedValueOnce(false); // run now? no

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(discoverScriptsMock).toHaveBeenCalledWith("/workspace");
    expect(prompt.autocomplete).toHaveBeenCalledTimes(1);
    const [, suggestFn] = prompt.autocomplete.mock.calls[0] as [
      string,
      (term: string | undefined) => unknown,
    ];
    const suggestions = (await suggestFn(undefined)) as unknown[];
    const labels = suggestions.map(choiceLabel);
    expect(
      labels.some((label) => label.includes("json-etl — Transforms JSON")),
    ).toBe(true);
    expect(
      labels.some((label) => label.includes("exporter — Exports data")),
    ).toBe(true);
  });

  test("loads parameters for the selected script through loadParametersCached", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const context = buildContext();
    await runWizard(context, { prompt, isTTY: true });

    expect(loadParametersCachedMock).toHaveBeenCalledWith(
      "json-etl",
      jsonEtlCandidate.directory,
      context.cacheFilePath,
    );
  });
});

describe("runWizard — parameter-type dispatch", () => {
  test("a secret-flagged parameter always uses password, even when its declared type is BOOL", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "featureFlag", type: "BOOL", secret: true }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.password.mockResolvedValue("");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.password).toHaveBeenCalledTimes(1);
    expect(prompt.confirm).not.toHaveBeenCalledWith(
      expect.stringContaining("featureFlag") as unknown,
      expect.anything() as unknown,
    );
  });

  test("a BOOL parameter uses confirm, defaulting false when no default is declared", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "verbose", type: "BOOL" }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm
      .mockResolvedValueOnce(true) // verbose
      .mockResolvedValueOnce(false) // save-as-preset?
      .mockResolvedValueOnce(false); // run now?

    await runWizard(buildContext(), { prompt, isTTY: true });

    const [message, options] = prompt.confirm.mock.calls[0] as [
      string,
      { default?: boolean } | undefined,
    ];
    expect(message).toContain("verbose");
    expect(options?.default).not.toBe(true);
  });

  test("a BOOL parameter defaults true when its descriptor declares defaultValue 'true'", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "verbose", type: "BOOL", defaultValue: "true" }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await runWizard(buildContext(), { prompt, isTTY: true });

    const [, options] = prompt.confirm.mock.calls[0] as [
      string,
      { default?: boolean } | undefined,
    ];
    expect(options?.default).toBe(true);
  });

  test.each<["INT" | "DOUBLE", string, number]>([
    ["INT", "10", 10],
    ["DOUBLE", "3.5", 3.5],
  ])(
    "a %s parameter uses number, with its parseable declared default forwarded",
    async (type, defaultValue, expectedDefault) => {
      discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
      loadParametersCachedMock.mockResolvedValue([
        makeDescriptor({ name: "batchSize", type, defaultValue }),
      ]);
      const prompt = createScriptedPrompt();
      prompt.autocomplete.mockResolvedValue("json-etl");
      prompt.number.mockResolvedValue(expectedDefault);
      prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runWizard(buildContext(), { prompt, isTTY: true });

      expect(prompt.number).toHaveBeenCalledTimes(1);
      const [, options] = prompt.number.mock.calls[0] as [
        string,
        { default?: number } | undefined,
      ];
      expect(options?.default).toBe(expectedDefault);
    },
  );

  test("a number parameter with no declared default forwards no default option", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "batchSize", type: "INT" }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.number.mockResolvedValue(1);
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runWizard(buildContext(), { prompt, isTTY: true });

    const [, options] = prompt.number.mock.calls[0] as [
      string,
      { default?: number } | undefined,
    ];
    expect(options?.default).toBeUndefined();
  });

  test("a STRING_ARRAY parameter uses text and comma-splits, trims, and drops empty entries", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "tags", type: "STRING_ARRAY" }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("a, b ,, c ,");
    translateArgvMock.mockReturnValue([]);
    spawnScriptMock.mockResolvedValue(0);
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(1);
    expect(translateArgvMock).toHaveBeenCalledTimes(1);
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(values["tags"]).toEqual(["a", "b", "c"]);
  });

  test("an unflagged STRING parameter uses text with its declared default prefilled", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({
        name: "region",
        type: "STRING",
        defaultValue: "eu-south-1",
      }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("us-east-1");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runWizard(buildContext(), { prompt, isTTY: true });

    const [message, options] = prompt.text.mock.calls[0] as [
      string,
      { default?: string } | undefined,
    ];
    expect(message).toContain("region");
    expect(options?.default).toBe("eu-south-1");
  });
});

describe("runWizard — terminal-text sanitization (8g addendum)", () => {
  test("a descriptor's ESC/bidi-laden defaultValue reaches prompt.text sanitized", async () => {
    const rawDefault = "eu\x1bwest‮-1⁦";
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({
        name: "region",
        type: "STRING",
        defaultValue: rawDefault,
      }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("us-east-1");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runWizard(buildContext(), { prompt, isTTY: true });

    const [, options] = prompt.text.mock.calls[0] as [
      string,
      { default?: string } | undefined,
    ];
    expect(options?.default).toBe(sanitizeTerminalText(rawDefault));
    expect(options?.default).not.toContain("\x1b");
    expect(options?.default).not.toContain("‮");
    expect(options?.default).not.toContain("⁦");
  });
});

describe("runWizard — renderSummary sanitizes rendered cells (8g addendum)", () => {
  test("a collected value containing controls/bidi overrides renders with no raw ESC/bidi in the summary", async () => {
    const maliciousValue = "us\x1beast‮-1⁦hidden";
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "region", type: "STRING" }),
    ]);
    const { output, stdoutLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue(maliciousValue);
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    const rendered = stdoutLines.join("\n");
    expect(rendered).not.toContain("\x1b");
    expect(rendered).not.toContain("‮");
    expect(rendered).not.toContain("⁦");
    expect(rendered).toContain(sanitizeTerminalText(maliciousValue));
  });

  test("a benign collected value renders unchanged in the summary (pin)", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "region", type: "STRING" }),
    ]);
    const { output, stdoutLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("us-east-1");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    const rendered = stdoutLines.join("\n");
    expect(rendered).toContain("region");
    expect(rendered).toContain("us-east-1");
  });
});

describe("runWizard — empty-answer handling", () => {
  test("an empty answer on an optional parameter is skipped silently, without a re-prompt", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "note", type: "STRING", required: false }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(1);
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(Object.hasOwn(values, "note")).toBe(false);
  });

  test("an empty answer on a required parameter re-prompts exactly once, then skips with a rendered warning naming it", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "region", type: "STRING", required: true }),
    ]);
    const { output, stdoutLines, stderrLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValueOnce("").mockResolvedValueOnce("");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(2);
    const rendered = [...stdoutLines, ...stderrLines].join("\n");
    expect(rendered).toMatch(/region/i);
    expect(rendered.toLowerCase()).toContain("skip");
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(Object.hasOwn(values, "region")).toBe(false);
  });

  test("a required parameter answered on the re-prompt is kept, not skipped", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "region", type: "STRING", required: true }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValueOnce("").mockResolvedValueOnce("us-east-1");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(2);
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(values["region"]).toBe("us-east-1");
  });
});

describe("runWizard — CRITICAL: secret values never rendered, only in spawn argv", () => {
  test("a secret parameter's raw entered value never appears in any rendered stdout/stderr output, masks as ******** in the summary, and reaches spawnScript only through the translated argv", async () => {
    const secretValue = "SUPER-SECRET-VALUE-9000";
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "licenseCode", type: "STRING", secret: true }),
      makeDescriptor({ name: "region", type: "STRING", required: true }),
    ]);
    const { output, stdoutLines, stderrLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.password.mockResolvedValue(secretValue);
    prompt.text.mockResolvedValue("us-east-1");
    prompt.confirm
      .mockResolvedValueOnce(false) // save-as-preset? no
      .mockResolvedValueOnce(true); // run now? yes
    translateArgvMock.mockReturnValue([
      `--licenseCode=${secretValue}`,
      "--region=us-east-1",
    ]);
    spawnScriptMock.mockResolvedValue(0);
    recordHistoryEntryMock.mockReturnValue(true);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    const rendered = [...stdoutLines, ...stderrLines].join("\n");
    expect(rendered).not.toContain(secretValue);
    expect(rendered).toContain("********");

    expect(spawnScriptMock).toHaveBeenCalledWith(jsonEtlCandidate.directory, [
      `--licenseCode=${secretValue}`,
      "--region=us-east-1",
    ]);
  });
});

describe("runWizard — save-as-preset", () => {
  test("declining save-as-preset never calls writePreset and still proceeds to the run decision", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm
      .mockResolvedValueOnce(false) // save-as-preset? no
      .mockResolvedValueOnce(true); // run now? yes
    translateArgvMock.mockReturnValue([]);
    spawnScriptMock.mockResolvedValue(0);

    const code = await runWizard(buildContext(), { prompt, isTTY: true });

    expect(writePresetMock).not.toHaveBeenCalled();
    expect(spawnScriptMock).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  test("accepting save-as-preset prompts for a name, writes it, and renders a notice naming any skipped secrets", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "licenseCode", type: "STRING", secret: true }),
    ]);
    const { output, stdoutLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.password.mockResolvedValue("shh");
    prompt.confirm
      .mockResolvedValueOnce(true) // save-as-preset? yes
      .mockResolvedValueOnce(false); // run now? no
    prompt.text.mockResolvedValue("my-preset");
    writePresetMock.mockReturnValue({
      filePath: "/workspace/data/config/presets/my-preset.json",
      written: [],
      skippedSecrets: ["licenseCode"],
    });
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    expect(writePresetMock).toHaveBeenCalledTimes(1);
    const rendered = stdoutLines.join("\n");
    expect(rendered).toContain("licenseCode");
  });

  test("a save-as-preset write failure renders the error and still falls through to the run decision", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const { output, stdoutLines, stderrLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm
      .mockResolvedValueOnce(true) // save-as-preset? yes
      .mockResolvedValueOnce(true); // run now? yes
    prompt.text.mockResolvedValue("bad name!!");
    writePresetMock.mockImplementation(() => {
      throw new M3LCliError("ERR_CLI_PRESET_INVALID", "invalid preset name");
    });
    translateArgvMock.mockReturnValue([]);
    spawnScriptMock.mockResolvedValue(0);

    const code = await runWizard(buildContext({ output }), {
      prompt,
      isTTY: true,
    });

    const rendered = [...stdoutLines, ...stderrLines].join("\n");
    expect(rendered).toContain("invalid preset name");
    // A failed save must not lose the composed run — spawnScript still runs.
    expect(spawnScriptMock).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });
});

describe("runWizard — final run decision", () => {
  test("declining to run resolves 0, never spawns, and never records history", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm
      .mockResolvedValueOnce(false) // save-as-preset? no
      .mockResolvedValueOnce(false); // run now? no

    const code = await runWizard(buildContext(), { prompt, isTTY: true });

    expect(code).toBe(0);
    expect(spawnScriptMock).not.toHaveBeenCalled();
    expect(recordHistoryEntryMock).not.toHaveBeenCalled();
  });

  test("accepting to run spawns the translated argv and resolves the child's exit code verbatim", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    translateArgvMock.mockReturnValue(["--region=us-east-1"]);
    spawnScriptMock.mockResolvedValue(5);
    recordHistoryEntryMock.mockReturnValue(true);

    const code = await runWizard(buildContext(), { prompt, isTTY: true });

    expect(code).toBe(5);
    expect(spawnScriptMock).toHaveBeenCalledWith(jsonEtlCandidate.directory, [
      "--region=us-east-1",
    ]);
  });

  test("records a history entry naming the prompted canonical parameter names and the spawned exit code", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      makeDescriptor({ name: "region", type: "STRING", required: true }),
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("us-east-1");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    translateArgvMock.mockReturnValue(["--region=us-east-1"]);
    spawnScriptMock.mockResolvedValue(3);
    recordHistoryEntryMock.mockReturnValue(true);

    const context = buildContext();
    const code = await runWizard(context, { prompt, isTTY: true });

    expect(code).toBe(3);
    expect(recordHistoryEntryMock).toHaveBeenCalledTimes(1);
    const [historyFilePath, entry] = recordHistoryEntryMock.mock.calls[0] as [
      string,
      { script: string; parameterNames: readonly string[]; exitCode: number },
    ];
    expect(historyFilePath).toBe(context.historyFilePath);
    expect(entry.script).toBe("json-etl");
    expect(entry.parameterNames).toEqual(
      expect.arrayContaining(["region"]) as unknown,
    );
    expect(entry.exitCode).toBe(3);
    expect(typeof (entry as { timestamp?: unknown }).timestamp).toBe("string");
  });

  test("a history-recording failure never affects the resolved exit code", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    translateArgvMock.mockReturnValue([]);
    spawnScriptMock.mockResolvedValue(0);
    recordHistoryEntryMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    const code = await runWizard(buildContext(), { prompt, isTTY: true });

    expect(code).toBe(0);
  });
});

describe("runWizard — type contract", () => {
  test("M3LCliWizardPrompt's methods resolve to the same primitive shapes M3LPrompt's do", () => {
    expectTypeOf<M3LCliWizardPrompt["text"]>().returns.toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf<M3LCliWizardPrompt["password"]>().returns.toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf<M3LCliWizardPrompt["confirm"]>().returns.toEqualTypeOf<
      Promise<boolean>
    >();
    expectTypeOf<M3LCliWizardPrompt["number"]>().returns.toEqualTypeOf<
      Promise<number>
    >();
    expectTypeOf<M3LCliWizardPrompt["select"]>().returns.toEqualTypeOf<
      Promise<string>
    >();
  });

  test("the real Core.M3LPrompt structurally satisfies the widened M3LCliWizardPrompt (U8 — gains select)", () => {
    expectTypeOf<Core.M3LPrompt>().toExtend<M3LCliWizardPrompt>();
  });
});

describe("runWizard — operation scoping (U8)", () => {
  const operationDescriptor = makeDescriptor({
    name: "operation",
    type: "STRING",
    operations: [
      {
        name: "get",
        description: "Fetch an item",
        requiredParameters: ["key"],
      },
      {
        name: "put",
        description: "Store an item",
        requiredParameters: ["bucket"],
      },
    ],
  });
  const keyDescriptor = makeDescriptor({
    name: "key",
    type: "STRING",
    required: false,
  });
  const bucketDescriptor = makeDescriptor({
    name: "bucket",
    type: "STRING",
    required: false,
  });
  const regionDescriptor = makeDescriptor({ name: "region", type: "STRING" });

  test("a descriptor declaring operations is prompted via select, with choices rendered as 'name — description' and value = operation.name", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      operationDescriptor,
      keyDescriptor,
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.select.mockResolvedValue("get");
    prompt.text.mockResolvedValue("abc123");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.select).toHaveBeenCalledTimes(1);
    expect(prompt.text).not.toHaveBeenCalledWith(
      expect.stringContaining("operation") as unknown,
      expect.anything() as unknown,
    );
    const [message, choices] = prompt.select.mock.calls[0] as [
      string,
      readonly { readonly value: string; readonly name?: string }[],
    ];
    expect(message).toContain("operation");
    expect(choices).toEqual([
      { value: "get", name: "get — Fetch an item" },
      { value: "put", name: "put — Store an item" },
    ]);

    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(values["operation"]).toBe("get");
  });

  test("a scoped parameter required by a DIFFERENT operation than the one chosen is never prompted, and is absent from values, summary, and argv", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      operationDescriptor,
      keyDescriptor,
      bucketDescriptor,
    ]);
    const { output, stdoutLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.select.mockResolvedValue("get");
    prompt.text.mockResolvedValue("abc123");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(1); // only 'key', never 'bucket'
    expect(prompt.text).not.toHaveBeenCalledWith(
      expect.stringContaining("bucket") as unknown,
      expect.anything() as unknown,
    );
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(Object.hasOwn(values, "bucket")).toBe(false);
    expect(stdoutLines.join("\n")).not.toContain("bucket");
  });

  test("a parameter required by the CHOSEN operation, left blank twice, gets the same re-ask-once-then-warn-and-skip treatment as a required: true parameter — even though its own required field is false", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      operationDescriptor,
      keyDescriptor,
    ]);
    const { output, stdoutLines, stderrLines } = buildOutputCollector();
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.select.mockResolvedValue("get");
    prompt.text.mockResolvedValueOnce("").mockResolvedValueOnce("");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext({ output }), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(2);
    const rendered = [...stdoutLines, ...stderrLines].join("\n");
    expect(rendered).toMatch(/key/i);
    expect(rendered.toLowerCase()).toContain("skip");
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(Object.hasOwn(values, "key")).toBe(false);
  });

  test("a parameter with no declared operations and not scoped by any operation is prompted exactly as before", async () => {
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      operationDescriptor,
      keyDescriptor,
      regionDescriptor,
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.select.mockResolvedValue("get");
    prompt.text
      .mockResolvedValueOnce("abc123")
      .mockResolvedValueOnce("us-east-1");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(2);
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(values["region"]).toBe("us-east-1");
  });

  test("a parameter that WOULD be scoped once an operation is chosen is still always prompted when it is declared BEFORE the operation-selector descriptor, regardless of which operation gets chosen", async () => {
    // `bucket` is required by the "put" operation (part of the union
    // `collectAllParameterValues` scopes against), but it is declared
    // BEFORE `operation` in the descriptors array — per this file's own
    // `collectAllParameterValues` TSDoc, `chosenOperation` only updates
    // AFTER the selector descriptor's own turn completes, so at the point
    // `bucket` is reached during iteration no operation has been chosen
    // yet and it must always be prompted, even though the operation chosen
    // below ("get") does not itself require `bucket`.
    const earlyBucketDescriptor = makeDescriptor({
      name: "bucket",
      type: "STRING",
      required: false,
    });
    const lateOperationDescriptor = makeDescriptor({
      name: "operation",
      type: "STRING",
      operations: [
        {
          name: "get",
          description: "Fetch an item",
          requiredParameters: ["key"],
        },
        {
          name: "put",
          description: "Store an item",
          requiredParameters: ["bucket"],
        },
      ],
    });
    discoverScriptsMock.mockReturnValue([jsonEtlCandidate]);
    loadParametersCachedMock.mockResolvedValue([
      earlyBucketDescriptor,
      lateOperationDescriptor,
    ]);
    const prompt = createScriptedPrompt();
    prompt.autocomplete.mockResolvedValue("json-etl");
    prompt.text.mockResolvedValue("my-bucket");
    prompt.select.mockResolvedValue("get");
    prompt.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    translateArgvMock.mockReturnValue([]);

    await runWizard(buildContext(), { prompt, isTTY: true });

    expect(prompt.text).toHaveBeenCalledTimes(1);
    const [, values] = translateArgvMock.mock.calls[0] as [
      readonly M3LCliParameterDescriptor[],
      Record<string, unknown>,
    ];
    expect(values["bucket"]).toBe("my-bucket");
  });
});
