/**
 * Tests for src/config/paths.ts — `resolveStoreDatabasePath` (X3 console-
 * persistence, slice A2, ADR-0069), `resolveSessionArtifactRoot` (X6
 * workbench-sessions module, slice 3) and `resolveAuditStreamRoot` (X7
 * human-action audit, slice 3, ADR-0070). Drives only `src/config/paths.ts`;
 * keep `env.ts` out of this file so v8's `perFile` coverage binds this src
 * slice to this test file alone (see `tests.md`'s per-file-size note).
 *
 * No filesystem I/O anywhere in this file: both functions are pure path
 * computations, so the tests need none either.
 */
import * as path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  resolveAuditStreamRoot,
  resolveRunsOutputRoot,
  resolveSessionArtifactRoot,
  resolveStoreDatabasePath,
} from "../src/config/paths.js";
import type { ResolveStoreDatabasePathOptions } from "../src/config/paths.js";

/** Dotted config key every rejection must name (never the rejected value). */
const DB_PATH_KEY = "m3l.console.db.path";

/** Env vars this file deliberately pollutes to prove the resolver never reads them. */
const ENV_KEYS_UNDER_TEST = ["M3L_DATA_DIR", "M3L_CONSOLE_DB_PATH"] as const;

/** Snapshot of the two env vars above, captured before each polluting test mutates them. */
let savedEnv: Record<(typeof ENV_KEYS_UNDER_TEST)[number], string | undefined> =
  {
    M3L_DATA_DIR: undefined,
    M3L_CONSOLE_DB_PATH: undefined,
  };

afterEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv = {
    M3L_DATA_DIR: undefined,
    M3L_CONSOLE_DB_PATH: undefined,
  };
});

describe("ResolveStoreDatabasePathOptions", () => {
  test("declares both fields optional", () => {
    expectTypeOf<ResolveStoreDatabasePathOptions>().toEqualTypeOf<{
      readonly configuredPath?: string | undefined;
      readonly resolveDataDir?: () => string;
    }>();
  });
});

describe("resolveStoreDatabasePath — default", () => {
  test("resolves <dataDir>/console/console.sqlite when configuredPath is absent", () => {
    const result = resolveStoreDatabasePath({
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.join("/data", "console", "console.sqlite"));
  });

  test("resolveStoreDatabasePath is callable with no options at all", () => {
    expectTypeOf(resolveStoreDatabasePath).toBeCallableWith();
  });
});

describe("resolveStoreDatabasePath — configuredPath resolution", () => {
  test("resolves a relative configuredPath against the injected data dir", () => {
    const result = resolveStoreDatabasePath({
      configuredPath: "custom/store.sqlite",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "custom/store.sqlite"));
  });

  test("passes an absolute configuredPath through path.resolve unchanged", () => {
    const absolute = path.resolve(path.sep, "abs", "store.sqlite");

    const result = resolveStoreDatabasePath({
      configuredPath: absolute,
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(absolute);
  });
});

describe("resolveStoreDatabasePath — rejects an unsafe configuredPath", () => {
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
    ["the literal :memory:", ":memory:"],
    ["a file: prefix", "file:///tmp/store.sqlite"],
    ["a trailing path separator", `some/dir${path.sep}`],
  ])(
    "rejects %s as ERR_CONSOLE_CONFIG_INVALID naming the key and never echoing the value",
    (_label, rejectedValue) => {
      let thrown: unknown;
      try {
        resolveStoreDatabasePath({
          configuredPath: rejectedValue,
          resolveDataDir: () => "/data",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      const error = thrown as M3LConsoleError;
      expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
      expect(error.message).toContain(DB_PATH_KEY);
      // A blank/whitespace-only rejected value trivially satisfies "message
      // does not contain the value" (every string contains "" or is itself
      // whitespace-adjacent noise), so that assertion only carries signal
      // for a non-blank rejected value.
      if (rejectedValue.trim().length > 0) {
        expect(error.message).not.toContain(rejectedValue);
      }
    },
  );
});

describe("resolveStoreDatabasePath — resolveDataDir failure", () => {
  test("wraps a thrown resolveDataDir failure as M3LConsoleError, chaining the original as cause", () => {
    const original = new Error(
      "boom - simulates M3LPathResolutionError/M3LEnvironmentDetectionError escaping M3LPaths",
    );

    let thrown: unknown;
    try {
      resolveStoreDatabasePath({
        resolveDataDir: () => {
          throw original;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(error.cause).toBe(original);
  });
});

describe("resolveStoreDatabasePath — never reads process.env", () => {
  test("ignores M3L_DATA_DIR and M3L_CONSOLE_DB_PATH sentinels planted in process.env", () => {
    const SENTINEL = "sentinel-value-9f3c1a-should-never-appear";
    savedEnv = {
      M3L_DATA_DIR: process.env["M3L_DATA_DIR"],
      M3L_CONSOLE_DB_PATH: process.env["M3L_CONSOLE_DB_PATH"],
    };
    process.env["M3L_DATA_DIR"] = SENTINEL;
    process.env["M3L_CONSOLE_DB_PATH"] = SENTINEL;

    const result = resolveStoreDatabasePath({
      resolveDataDir: () => "/data",
    });

    expect(result).not.toContain(SENTINEL);
    expect(result).toBe(path.join("/data", "console", "console.sqlite"));
  });
});

describe("resolveStoreDatabasePath — path traversal / absolute paths (accepted-behavior regression lock)", () => {
  // Escaping the data directory is accepted, not overlooked.
  // `M3L_CONSOLE_DB_PATH` is set by the operator, for a loopback-only
  // process that runs as them and can already write anywhere their umask
  // allows; containment would break the legitimate "put the database on a
  // separate volume" case while preventing nothing they could not do more
  // directly. Revisit if this path ever becomes settable through the HTTP
  // surface — at that point the actor is no longer necessarily the
  // operator, and containment becomes worth its cost.
  //
  // This test PASSES today — it pins the current, deliberate behavior as a
  // regression lock, not a RED test proving a fix.
  test("a relative configuredPath containing ../ traversal resolves outside the injected data dir", () => {
    const dataDir = path.join(path.sep, "data", "dir");

    const result = resolveStoreDatabasePath({
      configuredPath: path.join("..", "..", "elsewhere", "db.sqlite"),
      resolveDataDir: () => dataDir,
    });

    expect(result).toBe(
      path.resolve(dataDir, "..", "..", "elsewhere", "db.sqlite"),
    );
    // The discriminating assertion: the resolved path is NOT contained
    // within `dataDir` — proving traversal actually escapes, not merely
    // that some path was returned.
    const relative = path.relative(dataDir, result);
    expect(relative.startsWith("..")).toBe(true);
  });

  test("an absolute configuredPath passes through unchanged, regardless of the injected data dir", () => {
    const dataDir = path.join(path.sep, "data", "dir");
    const absolute = path.resolve(path.sep, "somewhere", "else", "db.sqlite");

    const result = resolveStoreDatabasePath({
      configuredPath: absolute,
      resolveDataDir: () => dataDir,
    });

    expect(result).toBe(absolute);
    const relative = path.relative(dataDir, result);
    expect(relative.startsWith("..")).toBe(true);
  });
});

describe("resolveSessionArtifactRoot — default (X6 slice 3)", () => {
  test("resolves <dataDir>/console/artifacts when configuredPath is absent", () => {
    const result = resolveSessionArtifactRoot({
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.join("/data", "console", "artifacts"));
  });

  test("resolveSessionArtifactRoot is callable with no options at all", () => {
    expectTypeOf(resolveSessionArtifactRoot).toBeCallableWith();
  });
});

describe("resolveSessionArtifactRoot — configuredPath resolution", () => {
  test("resolves a relative configuredPath against the injected data dir", () => {
    const result = resolveSessionArtifactRoot({
      configuredPath: "custom/artifacts",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "custom/artifacts"));
  });

  test("passes an absolute configuredPath through path.resolve unchanged", () => {
    const absolute = path.resolve(path.sep, "abs", "artifacts");

    const result = resolveSessionArtifactRoot({
      configuredPath: absolute,
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(absolute);
  });
});

describe("resolveSessionArtifactRoot — a directory path may have no extension (unlike the database FILE path)", () => {
  test("accepts a configuredPath with no file extension — the natural shape for a directory root", () => {
    const result = resolveSessionArtifactRoot({
      configuredPath: "artifacts-root",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "artifacts-root"));
  });
});

describe("resolveSessionArtifactRoot — rejects an unsafe configuredPath", () => {
  // Only the two rejections the contract explicitly commits to for a
  // DIRECTORY root (as opposed to resolveStoreDatabasePath's FILE path,
  // which additionally rejects the `:memory:` sentinel and a trailing path
  // separator — neither of those two checks is meaningful for a directory
  // target, so this file deliberately does not pin either one here).
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
    ["a file: prefix", "file:///tmp/artifacts"],
  ])("rejects %s as ERR_CONSOLE_CONFIG_INVALID", (_label, rejectedValue) => {
    let thrown: unknown;
    try {
      resolveSessionArtifactRoot({
        configuredPath: rejectedValue,
        resolveDataDir: () => "/data",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    if (rejectedValue.trim().length > 0) {
      expect(error.message).not.toContain(rejectedValue);
    }
    // The shared guard takes the config key as a parameter, and nothing
    // pinned it: swapping the two constants at `paths.ts:299`/`paths.ts:365`
    // passes the whole suite otherwise — exactly the drift the
    // generalization was meant to prevent.
    expect(error.message).toContain("m3l.console.sessions.artifact.root");
    expect(error.context).toMatchObject({
      key: "m3l.console.sessions.artifact.root",
    });
  });
});

describe("resolveSessionArtifactRoot — resolveDataDir failure", () => {
  test("wraps a thrown resolveDataDir failure as M3LConsoleError, chaining the original as cause", () => {
    const original = new Error(
      "boom - simulates M3LPathResolutionError/M3LEnvironmentDetectionError escaping M3LPaths",
    );

    let thrown: unknown;
    try {
      resolveSessionArtifactRoot({
        resolveDataDir: () => {
          throw original;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(error.cause).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// resolveAuditStreamRoot (X7 slice 3) — cloned from resolveSessionArtifactRoot
// above, INCLUDING its unsafe-path guard. These cases deliberately mirror that
// block one for one: the two resolvers are the same shape over a different
// default, so a divergence between them is itself the defect to catch.
//
// RED: `resolveAuditStreamRoot` is not exported from `../src/config/paths.js`
// yet — the import at the top of this file is expected to fail until the
// implementer lands it.
// ---------------------------------------------------------------------------

describe("resolveAuditStreamRoot — default (X7 slice 3)", () => {
  test("resolves <dataDir>/console/audit when configuredPath is absent", () => {
    const result = resolveAuditStreamRoot({
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.join("/data", "console", "audit"));
  });

  test("resolveAuditStreamRoot is callable with no options at all", () => {
    expectTypeOf(resolveAuditStreamRoot).toBeCallableWith();
  });

  test("does not collide with the session artifact root's default", () => {
    // Both default under `<dataDir>/console`; the human-action trail must not
    // land inside the directory the session artifact store owns.
    const auditRoot = resolveAuditStreamRoot({ resolveDataDir: () => "/data" });
    const artifactRoot = resolveSessionArtifactRoot({
      resolveDataDir: () => "/data",
    });

    expect(auditRoot).not.toBe(artifactRoot);
    expect(path.relative(artifactRoot, auditRoot).startsWith("..")).toBe(true);
  });
});

describe("resolveAuditStreamRoot — configuredPath resolution", () => {
  test("resolves a relative configuredPath against the injected data dir", () => {
    const result = resolveAuditStreamRoot({
      configuredPath: "custom/audit",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "custom/audit"));
  });

  test("passes an absolute configuredPath through path.resolve unchanged", () => {
    const absolute = path.resolve(path.sep, "abs", "audit");

    const result = resolveAuditStreamRoot({
      configuredPath: absolute,
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(absolute);
  });

  test("accepts a configuredPath with no file extension — the natural shape for a directory root", () => {
    const result = resolveAuditStreamRoot({
      configuredPath: "audit-root",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "audit-root"));
  });
});

describe("resolveAuditStreamRoot — rejects an unsafe configuredPath", () => {
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
    ["a file: prefix", "file:///tmp/audit"],
  ])("rejects %s as ERR_CONSOLE_CONFIG_INVALID", (_label, rejectedValue) => {
    let thrown: unknown;
    try {
      resolveAuditStreamRoot({
        configuredPath: rejectedValue,
        resolveDataDir: () => "/data",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    if (rejectedValue.trim().length > 0) {
      expect(error.message).not.toContain(rejectedValue);
    }
    expect(error.message).toContain("m3l.console.audit.root");
    expect(error.context).toMatchObject({ key: "m3l.console.audit.root" });
  });
});

describe("resolveAuditStreamRoot — resolveDataDir failure", () => {
  test("wraps a thrown resolveDataDir failure as M3LConsoleError, chaining the original as cause", () => {
    const original = new Error(
      "boom - simulates M3LPathResolutionError/M3LEnvironmentDetectionError escaping M3LPaths",
    );

    let thrown: unknown;
    try {
      resolveAuditStreamRoot({
        resolveDataDir: () => {
          throw original;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(error.cause).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// resolveRunsOutputRoot (X7d) — the third directory root, same shape as the
// two above over a different default. It is what makes a run's report
// addressable: the orchestrator pins each child's `M3L_OUTPUT_DIR` to
// `<thisRoot>/<runId>`.
// ---------------------------------------------------------------------------

describe("resolveRunsOutputRoot — default (X7d)", () => {
  test("resolves <dataDir>/console/runs when configuredPath is absent", () => {
    const result = resolveRunsOutputRoot({ resolveDataDir: () => "/data" });

    expect(result).toBe(path.join("/data", "console", "runs"));
  });

  test("resolveRunsOutputRoot is callable with no options at all", () => {
    expectTypeOf(resolveRunsOutputRoot).toBeCallableWith();
  });

  // INVARIANT: all three roots default under `<dataDir>/console` and must be
  // SIBLINGS, never nested. A spawned script owns everything beneath its own
  // per-run directory — it writes archives there and may clean them up — so
  // neither the artifact store nor the audit trail may sit inside it, and it
  // may not sit inside theirs. Mutation-tested: changing the default segments
  // to `["console", "audit", "runs"]` fails here.
  test("is a sibling of both the artifact root and the audit root, never nested", () => {
    const runsRoot = resolveRunsOutputRoot({ resolveDataDir: () => "/data" });
    const artifactRoot = resolveSessionArtifactRoot({
      resolveDataDir: () => "/data",
    });
    const auditRoot = resolveAuditStreamRoot({ resolveDataDir: () => "/data" });

    for (const other of [artifactRoot, auditRoot]) {
      expect(runsRoot).not.toBe(other);
      expect(path.relative(other, runsRoot).startsWith("..")).toBe(true);
      expect(path.relative(runsRoot, other).startsWith("..")).toBe(true);
    }
  });
});

describe("resolveRunsOutputRoot — configuredPath resolution", () => {
  test("resolves a relative configuredPath against the injected data dir", () => {
    const result = resolveRunsOutputRoot({
      configuredPath: "custom/runs",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "custom/runs"));
  });

  test("passes an absolute configuredPath through path.resolve unchanged", () => {
    const absolute = path.resolve(path.sep, "abs", "runs");

    const result = resolveRunsOutputRoot({
      configuredPath: absolute,
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(absolute);
  });
});

describe("resolveRunsOutputRoot — rejects an unsafe configuredPath", () => {
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
    ["a file: prefix", "file:///tmp/runs"],
  ])("rejects %s as ERR_CONSOLE_CONFIG_INVALID", (_label, rejectedValue) => {
    let thrown: unknown;
    try {
      resolveRunsOutputRoot({
        configuredPath: rejectedValue,
        resolveDataDir: () => "/data",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    if (rejectedValue.trim().length > 0) {
      expect(error.message).not.toContain(rejectedValue);
    }
    expect(error.message).toContain("m3l.console.runs.output.root");
    expect(error.context).toMatchObject({
      key: "m3l.console.runs.output.root",
    });
  });
});

describe("resolveRunsOutputRoot — resolveDataDir failure", () => {
  test("wraps a thrown resolveDataDir failure as M3LConsoleError, chaining the original as cause", () => {
    const original = new Error("boom");

    let thrown: unknown;
    try {
      resolveRunsOutputRoot({
        resolveDataDir: () => {
          throw original;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(error.cause).toBe(original);
  });
});

describe("the failing configuration key is attributed to the resolver that failed", () => {
  // `runResolveDataDir` hard-codes `DB_PATH_KEY` in both its message and its
  // `context.key`, so a data-dir failure raised while resolving the AUDIT or
  // ARTIFACT root reports `m3l.console.db.path` — an operator is sent to fix
  // a key they never set. Pre-existing, but this slice adds the third caller
  // while fixing the same drift class in the sibling directory-root guard.
  const original = new Error("boom - simulates M3LPaths escaping the resolver");

  function keyFor(resolve: () => string): unknown {
    let thrown: unknown;
    try {
      resolve();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    return (thrown as M3LConsoleError).context["key"];
  }

  const failing = (): string => {
    throw original;
  };

  test("resolveStoreDatabasePath attributes m3l.console.db.path", () => {
    expect(
      keyFor(() => resolveStoreDatabasePath({ resolveDataDir: failing })),
    ).toBe("m3l.console.db.path");
  });

  test("resolveSessionArtifactRoot attributes m3l.console.sessions.artifact.root", () => {
    expect(
      keyFor(() => resolveSessionArtifactRoot({ resolveDataDir: failing })),
    ).toBe("m3l.console.sessions.artifact.root");
  });

  test("resolveAuditStreamRoot attributes m3l.console.audit.root", () => {
    expect(
      keyFor(() => resolveAuditStreamRoot({ resolveDataDir: failing })),
    ).toBe("m3l.console.audit.root");
  });

  test("resolveRunsOutputRoot attributes m3l.console.runs.output.root", () => {
    expect(
      keyFor(() => resolveRunsOutputRoot({ resolveDataDir: failing })),
    ).toBe("m3l.console.runs.output.root");
  });
});
