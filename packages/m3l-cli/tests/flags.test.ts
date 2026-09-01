/**
 * Tests for src/cli/flags.ts — the CLI-reserved `--json` flag constant and
 * the exact-token partitioning helper `main.ts`/`commands/dynamic.ts` use to
 * recognize it ahead of any script's own declared parameters (V2 slice 1,
 * ADR-0063 / #539), plus its U7 sibling `--in-process`/`partitionInProcessFlag`
 * (ADR-0054), which mirrors the exact same exact-token-match semantics, and
 * the V3 `--env-file`/`--no-env-file` pair (ADR-0085) — the first reserved
 * flag that carries a value, in either the attached or detached form.
 */
import { resolve } from "node:path";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LCliError } from "../src/cli/errors.js";
import {
  AUTO_ENV_FILE,
  ENV_FILE_FLAG,
  IN_PROCESS_FLAG,
  JSON_FLAG,
  NO_ENV_FILE_FLAG,
  partitionEnvFileFlags,
  partitionInProcessFlag,
  partitionJsonFlag,
} from "../src/cli/flags.js";
import type { M3LCliEnvFileSetting } from "../src/cli/flags.js";

describe("JSON_FLAG", () => {
  test("is the literal '--json' token", () => {
    expect(JSON_FLAG).toBe("--json");
    expectTypeOf(JSON_FLAG).toEqualTypeOf<"--json">();
  });
});

describe("partitionJsonFlag — presence detection", () => {
  test("detects a lone '--json' token, removing it from rest", () => {
    const result = partitionJsonFlag(["--json"]);

    expect(result.jsonOutput).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("reports jsonOutput false and leaves rest unchanged when '--json' is absent", () => {
    const args = ["--region", "us-east-1"];

    const result = partitionJsonFlag(args);

    expect(result.jsonOutput).toBe(false);
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("does NOT match '--json=true' (exact-token only) — it stays in rest and jsonOutput is false", () => {
    const result = partitionJsonFlag(["--json=true"]);

    expect(result.jsonOutput).toBe(false);
    expect(result.rest).toEqual(["--json=true"]);
  });

  test("detects repeated '--json --json', removing both occurrences", () => {
    const result = partitionJsonFlag(["--json", "--json"]);

    expect(result.jsonOutput).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("preserves the original order of the remaining tokens", () => {
    const result = partitionJsonFlag([
      "--region",
      "us-east-1",
      "--json",
      "--verbose",
    ]);

    expect(result.jsonOutput).toBe(true);
    expect(result.rest).toEqual(["--region", "us-east-1", "--verbose"]);
  });

  test("returns jsonOutput false and an empty rest for an empty array", () => {
    const result = partitionJsonFlag([]);

    expect(result.jsonOutput).toBe(false);
    expect(result.rest).toEqual([]);
  });
});

describe("partitionJsonFlag — type contract", () => {
  test("returns a readonly { jsonOutput: boolean; rest: readonly string[] } shape", () => {
    expectTypeOf(partitionJsonFlag([])).toEqualTypeOf<{
      readonly jsonOutput: boolean;
      readonly rest: readonly string[];
    }>();
  });
});

describe("IN_PROCESS_FLAG", () => {
  test("is the literal '--in-process' token", () => {
    expect(IN_PROCESS_FLAG).toBe("--in-process");
    expectTypeOf(IN_PROCESS_FLAG).toEqualTypeOf<"--in-process">();
  });
});

describe("partitionInProcessFlag — presence detection", () => {
  test("detects a lone '--in-process' token, removing it from rest", () => {
    const result = partitionInProcessFlag(["--in-process"]);

    expect(result.inProcess).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("reports inProcess false and leaves rest unchanged when '--in-process' is absent", () => {
    const args = ["--region", "us-east-1"];

    const result = partitionInProcessFlag(args);

    expect(result.inProcess).toBe(false);
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("does NOT match '--in-process=true' (exact-token only) — it stays in rest and inProcess is false", () => {
    const result = partitionInProcessFlag(["--in-process=true"]);

    expect(result.inProcess).toBe(false);
    expect(result.rest).toEqual(["--in-process=true"]);
  });

  test("detects repeated '--in-process --in-process', removing both occurrences", () => {
    const result = partitionInProcessFlag(["--in-process", "--in-process"]);

    expect(result.inProcess).toBe(true);
    expect(result.rest).toEqual([]);
  });

  test("preserves the original order of the remaining tokens", () => {
    const result = partitionInProcessFlag([
      "--region",
      "us-east-1",
      "--in-process",
      "--verbose",
    ]);

    expect(result.inProcess).toBe(true);
    expect(result.rest).toEqual(["--region", "us-east-1", "--verbose"]);
  });

  test("returns inProcess false and an empty rest for an empty array", () => {
    const result = partitionInProcessFlag([]);

    expect(result.inProcess).toBe(false);
    expect(result.rest).toEqual([]);
  });
});

describe("partitionInProcessFlag — type contract", () => {
  test("returns a readonly { inProcess: boolean; rest: readonly string[] } shape", () => {
    expectTypeOf(partitionInProcessFlag([])).toEqualTypeOf<{
      readonly inProcess: boolean;
      readonly rest: readonly string[];
    }>();
  });
});

describe("ENV_FILE_FLAG / NO_ENV_FILE_FLAG", () => {
  test("are the literal '--env-file' and '--no-env-file' tokens", () => {
    expect(ENV_FILE_FLAG).toBe("--env-file");
    expectTypeOf(ENV_FILE_FLAG).toEqualTypeOf<"--env-file">();
    expect(NO_ENV_FILE_FLAG).toBe("--no-env-file");
    expectTypeOf(NO_ENV_FILE_FLAG).toEqualTypeOf<"--no-env-file">();
  });

  test("AUTO_ENV_FILE is the unchanged-default setting", () => {
    expect(AUTO_ENV_FILE).toEqual({ kind: "auto" });
  });
});

describe("partitionEnvFileFlags — resolution", () => {
  test("resolves to auto and leaves rest unchanged when neither flag is present", () => {
    const result = partitionEnvFileFlags(["--region", "us-east-1"], "/repo");

    expect(result.envFile).toEqual({ kind: "auto" });
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("returns auto and an empty rest for an empty array", () => {
    const result = partitionEnvFileFlags([], "/repo");

    expect(result.envFile).toEqual({ kind: "auto" });
    expect(result.rest).toEqual([]);
  });

  test("'--no-env-file' resolves to disabled and is stripped", () => {
    const result = partitionEnvFileFlags(
      ["--region", "us-east-1", "--no-env-file"],
      "/repo",
    );

    expect(result.envFile).toEqual({ kind: "disabled" });
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("the attached '--env-file=<path>' form resolves the path against cwd and strips one token", () => {
    const result = partitionEnvFileFlags(
      ["--env-file=staging.env", "--region", "us-east-1"],
      "/repo",
    );

    expect(result.envFile).toEqual({
      kind: "path",
      path: resolve("/repo", "staging.env"),
    });
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("the detached '--env-file <path>' form strips BOTH tokens, not just the flag", () => {
    const result = partitionEnvFileFlags(
      ["--env-file", "staging.env", "--region", "us-east-1"],
      "/repo",
    );

    expect(result.envFile).toEqual({
      kind: "path",
      path: resolve("/repo", "staging.env"),
    });
    expect(result.rest).toEqual(["--region", "us-east-1"]);
  });

  test("an absolute path is not re-resolved against cwd", () => {
    const result = partitionEnvFileFlags(
      ["--env-file", "/etc/m3l/staging.env"],
      "/repo",
    );

    expect(result.envFile).toEqual({
      kind: "path",
      path: "/etc/m3l/staging.env",
    });
  });

  test("a repeated '--env-file' is last-wins", () => {
    const result = partitionEnvFileFlags(
      ["--env-file", "a.env", "--env-file=b.env"],
      "/repo",
    );

    expect(result.envFile).toEqual({
      kind: "path",
      path: resolve("/repo", "b.env"),
    });
    expect(result.rest).toEqual([]);
  });

  test("preserves the original order of every remaining token", () => {
    const result = partitionEnvFileFlags(
      ["--a", "1", "--env-file", "x.env", "--b", "2", "--json"],
      "/repo",
    );

    expect(result.rest).toEqual(["--a", "1", "--b", "2", "--json"]);
  });
});

describe("partitionEnvFileFlags — rejection", () => {
  test.each([
    [["--env-file=x.env", "--no-env-file"]],
    [["--no-env-file", "--env-file=x.env"]],
    [["--no-env-file", "--env-file", "x.env"]],
  ])(
    "rejects %j — the two flags are mutually exclusive, in either order",
    (args) => {
      expect(() => partitionEnvFileFlags(args, "/repo")).toThrowError(
        /mutually exclusive/,
      );
      try {
        partitionEnvFileFlags(args, "/repo");
      } catch (error) {
        expect(error).toBeInstanceOf(M3LCliError);
        expect((error as M3LCliError).code).toBe(
          "ERR_CLI_INVALID_PARAMETER_VALUE",
        );
      }
    },
  );

  test("rejects a trailing '--env-file' with no value", () => {
    expect(() =>
      partitionEnvFileFlags(["--region", "--env-file"], "/repo"),
    ).toThrowError(/requires a path/);
  });

  test("rejects '--env-file --json' rather than silently swallowing the '--json' as its value", () => {
    expect(() =>
      partitionEnvFileFlags(["--env-file", "--json"], "/repo"),
    ).toThrowError(/requires a path/);
  });

  test("rejects an empty attached value '--env-file='", () => {
    expect(() => partitionEnvFileFlags(["--env-file="], "/repo")).toThrowError(
      /requires a path/,
    );
  });

  test("rejects an empty detached value", () => {
    expect(() =>
      partitionEnvFileFlags(["--env-file", ""], "/repo"),
    ).toThrowError(/requires a path/);
  });
});

describe("partitionEnvFileFlags — exact-token discipline", () => {
  test.each([
    ["--env-file-if-exists=.env"],
    ["--env-filex"],
    ["--no-env-filex"],
  ])(
    "passes the lookalike token %j through untouched, resolving to auto",
    (token) => {
      const result = partitionEnvFileFlags([token], "/repo");

      expect(result.envFile).toEqual({ kind: "auto" });
      expect(result.rest).toEqual([token]);
    },
  );
});

describe("partitionEnvFileFlags — type contract", () => {
  test("returns a readonly { envFile: M3LCliEnvFileSetting; rest: readonly string[] } shape", () => {
    expectTypeOf(partitionEnvFileFlags([], "/repo")).toEqualTypeOf<{
      readonly envFile: M3LCliEnvFileSetting;
      readonly rest: readonly string[];
    }>();
  });
});
