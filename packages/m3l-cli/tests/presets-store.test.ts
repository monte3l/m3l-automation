/**
 * Tests for src/presets/store.ts — preset-file listing, schema derivation
 * from descriptors, preset-record reading (through
 * `Core.M3LScriptPresetLoader`), and secret-refusing preset writes (m3l-cli
 * 8f addendum).
 *
 * `M3LScriptPresetLoader` itself reads files via the bare `"fs"` specifier
 * (not `"node:fs"`) — both are mocked here, mirroring
 * `packages/m3l-common/tests/script.test.ts`'s pattern, since Vitest's module
 * registry treats the two specifiers as distinct mock targets even though
 * Node resolves them to the same underlying module.
 */
import * as fs from "fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof nodeFs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import {
  buildSchemaFromDescriptors,
  listPresetFiles,
  readPresetRecord,
  writePreset,
} from "../src/presets/store.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { M3LCliError } from "../src/cli/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const regionDescriptor: M3LCliParameterDescriptor = {
  name: "region",
  aliases: ["r"],
  type: "STRING",
  required: true,
  defaultValue: undefined,
  description: "AWS region",
  // Explicit `secret: false` — under writePreset's fail-closed rule (see
  // src/presets/store.ts), only an explicit `false` proves a key safe to
  // persist; leaving this absent would make every "written" assertion below
  // fail since an absent `secret` field is treated exactly like a proven
  // secret.
  secret: false,
  operations: [],
};

/**
 * A descriptor that omits `secret` entirely (not `undefined` via an explicit
 * key — genuinely absent), proving writePreset's fail-closed rule: only an
 * explicit `secret: false` proves a key safe to persist, so an absent field
 * is skipped exactly like a proven secret (see src/presets/store.ts).
 *
 * `secret`/`operations` are now required on `M3LConfigParameterDescriptor`
 * (X10a), but `writePreset` still only receives a plain object at runtime —
 * a descriptor cached by an older CLI version, or a duck-typed export from a
 * foreign module compiled against a dist predating both fields, can still
 * lack `secret` in practice. This literal models exactly that skew, so the
 * cast is narrow (through `unknown`, never a direct `as
 * M3LCliParameterDescriptor`) to keep the loose runtime shape visible
 * instead of silently satisfying the compile-time contract.
 */
const unflaggedDescriptor = {
  name: "unflagged",
  aliases: [],
  type: "STRING",
  required: false,
  defaultValue: undefined,
  description: "no secret field declared at all",
} as unknown as M3LCliParameterDescriptor;

// `secret` is now a required field on `M3LConfigParameterDescriptor` (X10a)
// — the local `WithSecret` extension this fixture used to need under the
// prior optional-field RED-state contract is no longer necessary.
const apiKeyDescriptor: M3LCliParameterDescriptor = {
  name: "apiKey",
  aliases: [],
  type: "STRING",
  required: false,
  defaultValue: undefined,
  description: "API key",
  secret: true,
  operations: [],
};

const verboseDescriptor: M3LCliParameterDescriptor = {
  name: "verbose",
  aliases: [],
  type: "BOOL",
  required: false,
  defaultValue: undefined,
  description: "",
  secret: false,
  operations: [],
};

describe("listPresetFiles", () => {
  const workspaceRoot = "/workspace";
  const presetsDir = join(workspaceRoot, "data", "config", "presets");

  test("returns sorted preset files for .json/.yaml/.yml, skipping other extensions", () => {
    vi.spyOn(nodeFs, "existsSync").mockReturnValue(true);
    vi.spyOn(nodeFs, "readdirSync").mockReturnValue([
      "prod.json",
      "dev.yaml",
      "staging.yml",
      "README.md",
      "notes.txt",
    ] as unknown as ReturnType<typeof nodeFs.readdirSync>);

    const result = listPresetFiles(workspaceRoot);

    expect(result).toEqual([
      { name: "dev", filePath: join(presetsDir, "dev.yaml"), format: "yaml" },
      { name: "prod", filePath: join(presetsDir, "prod.json"), format: "json" },
      {
        name: "staging",
        filePath: join(presetsDir, "staging.yml"),
        format: "yaml",
      },
    ]);
  });

  test("returns [] when the presets directory does not exist", () => {
    vi.spyOn(nodeFs, "existsSync").mockReturnValue(false);
    const readdirSpy = vi.spyOn(nodeFs, "readdirSync");

    expect(listPresetFiles(workspaceRoot)).toEqual([]);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  test("wraps a readdirSync EACCES failure in M3LCliError ERR_CLI_PRESET_INVALID, chaining the original as cause", () => {
    vi.spyOn(nodeFs, "existsSync").mockReturnValue(true);
    const original = new Error("EACCES") as NodeJS.ErrnoException;
    original.code = "EACCES";
    vi.spyOn(nodeFs, "readdirSync").mockImplementation(() => {
      throw original;
    });

    let thrown: unknown;
    try {
      listPresetFiles(workspaceRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).cause).toBe(original);
  });
});

describe("buildSchemaFromDescriptors", () => {
  test("maps descriptor types to M3LConfigParameterType members, carrying names + aliases, never required", () => {
    const schema = buildSchemaFromDescriptors([
      regionDescriptor,
      verboseDescriptor,
    ]);

    expect(schema).toBeInstanceOf(Core.M3LConfigSchema);
    expect(schema.declaredNames()).toEqual(
      expect.arrayContaining(["region", "r", "verbose"]),
    );
    const regionParam = schema.parameters.find(
      (p: Core.M3LConfigParameter) => p.getName() === "region",
    );
    expect(regionParam?.getType()).toBe(Core.M3LConfigParameterType.STRING);
    expect(regionParam?.getAliases()).toEqual(["r"]);
    expect(regionParam?.isRequired()).toBe(false);
    const verboseParam = schema.parameters.find(
      (p: Core.M3LConfigParameter) => p.getName() === "verbose",
    );
    expect(verboseParam?.getType()).toBe(Core.M3LConfigParameterType.BOOL);
  });

  test("falls back to STRING for an unrecognized type string", () => {
    const oddDescriptor: M3LCliParameterDescriptor = {
      name: "weird",
      aliases: [],
      type: "NOT_A_REAL_TYPE",
      required: false,
      defaultValue: undefined,
      description: "",
      secret: false,
      operations: [],
    };

    const schema = buildSchemaFromDescriptors([oddDescriptor]);

    expect(
      schema.parameters
        .find((p: Core.M3LConfigParameter) => p.getName() === "weird")
        ?.getType(),
    ).toBe(Core.M3LConfigParameterType.STRING);
  });
});

describe("readPresetRecord", () => {
  const filePath = "/workspace/data/config/presets/prod.json";

  test("loads a well-formed preset file into a plain record", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ region: "us-east-1" }),
    );

    const record = readPresetRecord(filePath, [regionDescriptor]);

    expect(record).toEqual({ region: "us-east-1" });
  });

  test("wraps a loader failure (e.g. unknown key) in M3LCliError ERR_CLI_PRESET_INVALID, naming the key in a content-free category, chaining the original as cause", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ nonexistentKey: "planted-secret-value-42" }),
    );

    let thrown: unknown;
    try {
      readPresetRecord(filePath, [regionDescriptor]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).cause).toBeDefined();
    expect((thrown as M3LCliError).message).toContain(
      "unknown keys: nonexistentKey",
    );
    // Content-free: the key *name* is safe to surface (already validated
    // against the script's declared schema), but the offending *value* must
    // never leak through the message chain.
    expect((thrown as M3LCliError).message).not.toContain(
      "planted-secret-value-42",
    );
  });

  test("wraps an unreadable/malformed preset file in M3LCliError ERR_CLI_PRESET_INVALID with a content-free 'invalid or unparseable' category, never the raw file content", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "{not valid json, planted-secret-value-99",
    );

    let thrown: unknown;
    try {
      readPresetRecord(filePath, [regionDescriptor]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).message).toContain("invalid or unparseable");
    expect((thrown as M3LCliError).message).not.toContain(
      "planted-secret-value-99",
    );
  });

  test("classifies a raw EACCES/EPERM throw from the loader itself as 'permission denied', even when it is not wrapped in an M3LError", () => {
    const original = new Error("EACCES") as NodeJS.ErrnoException;
    original.code = "EACCES";
    vi.spyOn(Core.M3LScriptPresetLoader.prototype, "load").mockImplementation(
      () => {
        throw original;
      },
    );

    let thrown: unknown;
    try {
      readPresetRecord(filePath, [regionDescriptor]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).message).toContain("permission denied");
    expect((thrown as M3LCliError).cause).toBe(original);
  });

  test("classifies a preset nested deeper than the loader's max structure depth as 'nesting too deep'", () => {
    // 70 levels of nesting exceeds M3LScriptPresetLoader's internal
    // MAX_PRESET_STRUCTURE_DEPTH (64) — the exact number of levels is an
    // implementation detail of the collaborator; this only needs to exceed
    // whatever that bound is.
    let deeplyNested: unknown = { leaf: true };
    for (let depth = 0; depth < 70; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(deeplyNested));

    let thrown: unknown;
    try {
      readPresetRecord(filePath, [regionDescriptor]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).message).toContain("nesting too deep");
  });

  test("falls back to the generic 'invalid preset' category for an M3LError the classifier does not otherwise recognize (e.g. a dangerous top-level key)", () => {
    // A raw JSON *string* literal `"__proto__"` key — unlike the `{ __proto__:
    // ... }` object-literal syntax (which sets the prototype rather than an
    // own property) — parses via JSON.parse into a genuine own property, so
    // the loader's dangerous-key guard actually sees and rejects it.
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      '{"__proto__": {"polluted": true}}',
    );

    let thrown: unknown;
    try {
      readPresetRecord(filePath, [regionDescriptor]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).message).toContain("invalid preset");
  });
});

describe("writePreset — secret skip", () => {
  test("refuses to persist a secret-flagged key, records it in skippedSecrets, and never writes its raw value", () => {
    const mkdirSpy = vi.spyOn(nodeFs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi
      .spyOn(nodeFs, "writeFileSync")
      .mockReturnValue(undefined);
    const renameSpy = vi.spyOn(nodeFs, "renameSync").mockReturnValue(undefined);

    const result = writePreset(
      "/workspace",
      "prod",
      { region: "us-east-1", apiKey: "super-secret-token-value" },
      [regionDescriptor, apiKeyDescriptor],
    );

    expect(result.skippedSecrets).toEqual(["apiKey"]);
    expect(result.written).toEqual(["region"]);
    expect(mkdirSpy).toHaveBeenCalled();

    // Atomic write: writeFileSync targets a same-directory temp file, never
    // the final <name>.json path directly; only renameSync targets the
    // final path.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData] = writeSpy.mock.calls[0] ?? ["", ""];
    expect(typeof writtenData).toBe("string");
    expect(writtenData as string).not.toContain("super-secret-token-value");
    expect(JSON.parse(writtenData as string)).toEqual({
      region: "us-east-1",
    });
    const presetsDir = join("/workspace", "data", "config", "presets");
    expect(String(writtenPath)).not.toBe(join(presetsDir, "prod.json"));
    expect(String(writtenPath).startsWith(presetsDir)).toBe(true);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [renameFrom, renameTo] = renameSpy.mock.calls[0] ?? ["", ""];
    expect(renameFrom).toBe(writtenPath);
    expect(renameTo).toBe(join(presetsDir, "prod.json"));
  });

  test("returns filePath ending in <presetName>.json under data/config/presets", () => {
    vi.spyOn(nodeFs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(nodeFs, "writeFileSync").mockReturnValue(undefined);
    vi.spyOn(nodeFs, "renameSync").mockReturnValue(undefined);

    const result = writePreset("/workspace", "prod", { region: "us-east-1" }, [
      regionDescriptor,
    ]);

    expect(result.filePath).toBe(
      join("/workspace", "data", "config", "presets", "prod.json"),
    );
  });

  test("treats a secret-descriptor field left entirely absent as unproven-safe, skipping it exactly like a proven secret (fail-closed)", () => {
    vi.spyOn(nodeFs, "mkdirSync").mockReturnValue(undefined);
    const writeSpy = vi
      .spyOn(nodeFs, "writeFileSync")
      .mockReturnValue(undefined);
    vi.spyOn(nodeFs, "renameSync").mockReturnValue(undefined);

    const result = writePreset(
      "/workspace",
      "prod",
      { unflagged: "some-value" },
      [unflaggedDescriptor],
    );

    expect(result.skippedSecrets).toEqual(["unflagged"]);
    expect(result.written).toEqual([]);
    const [, writtenData] = writeSpy.mock.calls[0] ?? ["", ""];
    expect(JSON.parse(writtenData as string)).toEqual({});
  });
});

describe("writePreset — validation", () => {
  test("throws M3LCliError ERR_CLI_PRESET_INVALID for a name with characters outside [a-z0-9-]", () => {
    let thrown: unknown;
    try {
      writePreset("/workspace", "Prod_1!", { region: "us-east-1" }, [
        regionDescriptor,
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
  });

  test("throws M3LCliError ERR_CLI_PRESET_INVALID naming an unknown key with no matching descriptor", () => {
    let thrown: unknown;
    try {
      writePreset("/workspace", "prod", { totallyUnknown: "x" }, [
        regionDescriptor,
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).message).toContain("totallyUnknown");
  });
});

describe("writePreset — loud write failures", () => {
  test("wraps an mkdirSync failure in M3LCliError ERR_CLI_PRESET_INVALID, chaining the original as cause", () => {
    const original = new Error("EACCES");
    vi.spyOn(nodeFs, "mkdirSync").mockImplementation(() => {
      throw original;
    });

    let thrown: unknown;
    try {
      writePreset("/workspace", "prod", { region: "us-east-1" }, [
        regionDescriptor,
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).cause).toBe(original);
  });

  test("wraps a writeFileSync failure in M3LCliError ERR_CLI_PRESET_INVALID, chaining the original as cause", () => {
    vi.spyOn(nodeFs, "mkdirSync").mockReturnValue(undefined);
    const original = new Error("ENOSPC");
    vi.spyOn(nodeFs, "writeFileSync").mockImplementation(() => {
      throw original;
    });

    let thrown: unknown;
    try {
      writePreset("/workspace", "prod", { region: "us-east-1" }, [
        regionDescriptor,
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_PRESET_INVALID");
    expect((thrown as M3LCliError).cause).toBe(original);
  });
});
