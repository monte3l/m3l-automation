// Unit tests for bin/lib/mcp-tools.mjs — the tool definitions + handlers
// backing the in-repo MCP server (ADR-0030 Phase 5). Spawn-backed handlers
// (repo_verify, worktree_manage, scaffold_script) mock node:child_process's
// execFileSync via a hoisted vi.fn() bag, following the repo convention in
// packages/m3l-common/tests/credentials.test.ts (hoisted vi.mock + a single
// static import so every dynamic import() inside the implementation resolves
// to the same mocked module instance — the vitest-lazy-import-mock-race
// lesson). catalog_query and commit_lint run against the real committed
// docs/reference/*.json and the real bin/lint-commit.mjs respectively — no
// mocking needed for either.
import { describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: h.execFileSync,
}));

import {
  TOOLS,
  catalogQuery,
  commitLint,
  docsSync,
  repoVerify,
  scaffoldScript,
  spokeRecover,
  worktreeManage,
} from "../lib/mcp-tools.mjs";

/** Parse the single text content block every handler returns. */
function payloadOf(result: {
  content: { type: string; text: string }[];
  isError: boolean;
}): Record<string, unknown> {
  const block = result.content[0];
  if (block === undefined) throw new Error("tool result had no content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe("TOOLS registration contract", () => {
  test("registers exactly seven tools", () => {
    expect(TOOLS).toHaveLength(7);
  });

  test.each(TOOLS)(
    "$name: valid name, description, inputSchema, handler",
    (tool) => {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.config.description.split(". ").length).toBeGreaterThanOrEqual(
        3,
      );
      expect(typeof tool.config.inputSchema).toBe("object");
      expect(tool.config.inputSchema).not.toBeNull();
      expect(typeof tool.handler).toBe("function");
    },
  );
});

describe("catalogQuery (real docs/reference index, no mocking)", () => {
  test("exact symbol hit returns only the matching entry", () => {
    const result = payloadOf(catalogQuery({ symbol: "M3LError" }));
    expect(result.module).toBeUndefined();
    expect(result.query).toBeUndefined();
    expect(result.symbol).toMatchObject({
      symbol: "M3LError",
      submodule: "errors",
      namespace: "core",
    });
  });

  test("module lookup returns that module's catalog entry", () => {
    const result = payloadOf(catalogQuery({ module: "analysis" }));
    const modules = result.module as { name: string; symbols: string[] }[];
    expect(modules).toHaveLength(1);
    expect(modules[0]?.name).toBe("analysis");
    expect(modules[0]?.symbols).toContain("M3LThresholdEvaluator");
  });

  test("query substring search respects the 25-hit cap and note", () => {
    const result = payloadOf(catalogQuery({ query: "m3l" }));
    const query = result.query as {
      total: number;
      symbols: unknown[];
      note?: string;
    };
    expect(query.total).toBeGreaterThan(25);
    expect(query.symbols).toHaveLength(25);
    expect(query.note).toContain("narrow your query");
  });

  test("query substring search with few hits carries no cap note", () => {
    const result = payloadOf(catalogQuery({ query: "M3LThresholdEvaluator" }));
    const query = result.query as {
      total: number;
      symbols: unknown[];
      note?: string;
    };
    expect(query.total).toBeGreaterThanOrEqual(1);
    expect(query.total).toBeLessThanOrEqual(25);
    expect(query.note).toBeUndefined();
  });

  test("no params at all → isError with a usage message", () => {
    const result = catalogQuery({});
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.error).toContain("requires at least one of");
  });

  test("unknown symbol → graceful not-found (null), not an error", () => {
    const result = catalogQuery({ symbol: "M3LDoesNotExist12345" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload.symbol).toBeNull();
  });

  test("a prototype-polluting symbol name (__proto__) resolves to not-found, not a prototype object", () => {
    const result = catalogQuery({ symbol: "__proto__" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload.symbol).toBeNull();
    expect(payload.symbol).not.toBe(Object.prototype);
  });
});

describe("docsSync (mocked execFileSync)", () => {
  test("happy path spawns bin/sync-docs.mjs with --json and returns its payload", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(
      JSON.stringify({ ok: true, updated: [] }),
    );
    const result = docsSync({});
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload).toEqual({ ok: true, updated: [] });
    const [cmd, args, options] = h.execFileSync.mock.calls[0] as [
      string,
      string[],
      { timeout: number },
    ];
    expect(cmd).toBe("node");
    expect(args[0]).toContain("sync-docs.mjs");
    expect(args).toContain("--json");
    expect(args).not.toContain("--affected");
    // docs_sync re-runs the full Vitest suite, so it gets the longer of the
    // two spawn timeouts (15 minutes vs. the 5-minute default for check:* scripts).
    expect(options.timeout).toBe(15 * 60 * 1000);
  });

  test("forwards 'affected' as --affected <path> in argv", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(JSON.stringify({ ok: true }));
    docsSync({ affected: "packages/m3l-common/src/core/retry/index.ts" });
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args).toContain("--affected");
    expect(args).toContain("packages/m3l-common/src/core/retry/index.ts");
  });

  test("mocked child failure (non-zero exit, JSON payload in stdout) surfaces the errors", () => {
    h.execFileSync.mockReset();
    const err = Object.assign(new Error("Command failed"), {
      stdout: JSON.stringify({ ok: false, errors: ["stale doc counts"] }),
      status: 1,
    });
    h.execFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const result = docsSync({});
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.errors).toEqual(["stale doc counts"]);
  });

  test("a non-string 'affected' → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = docsSync({ affected: 123 });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("string");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });
});

describe("commitLint (direct in-process import, no subprocess)", () => {
  test("a valid Conventional Commit with a valid Claude trailer → valid:true", async () => {
    const message =
      "feat(core): add a widget\n\n" +
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>";
    const result = await commitLint({ message });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload.valid).toBe(true);
    expect(payload.errors).toEqual([]);
  });

  test("a garbage message → valid:false with non-empty errors, isError stays false", async () => {
    const result = await commitLint({ message: "not a conventional header" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload.valid).toBe(false);
    expect((payload.errors as unknown[]).length).toBeGreaterThan(0);
  });

  test("empty message → isError with a usage message (input rejected before linting)", async () => {
    const result = await commitLint({ message: "   " });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.error).toContain("non-empty");
  });
});

describe("worktreeManage (mocked execFileSync)", () => {
  test("create without slug → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = worktreeManage({ action: "create" });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("slug");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  test("remove without slug → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = worktreeManage({ action: "remove" });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("slug");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  test("prune with dryRun spawns worktree-prune with --dry-run and --json", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(
      JSON.stringify({ ok: true, candidates: [] }),
    );
    const result = worktreeManage({ action: "prune", dryRun: true });
    expect(result.isError).toBe(false);
    expect(h.execFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("node");
    expect(args[0]).toContain("worktree-prune.mjs");
    expect(args).toContain("--dry-run");
    expect(args).toContain("--json");
  });

  test("prune without dryRun omits --dry-run", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(JSON.stringify({ ok: true }));
    worktreeManage({ action: "prune" });
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--dry-run");
  });

  test("mocked child failure surfaces the JSON payload's errors", () => {
    h.execFileSync.mockReset();
    const err = Object.assign(new Error("Command failed"), {
      stdout: JSON.stringify({ ok: false, errors: ["merge check failed"] }),
      status: 1,
    });
    h.execFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const result = worktreeManage({ action: "prune" });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.errors).toEqual(["merge check failed"]);
  });

  test("create with a slug spawns worktree-new with the slug and --json", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(JSON.stringify({ ok: true }));
    const result = worktreeManage({ action: "create", slug: "my-feature" });
    expect(result.isError).toBe(false);
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args[0]).toContain("worktree-new.mjs");
    expect(args).toContain("my-feature");
    expect(args).toContain("--json");
  });

  test("remove with a path-traversal slug ('../evil') → isError pattern-quoting message, no spawn", () => {
    h.execFileSync.mockReset();
    const result = worktreeManage({ action: "remove", slug: "../evil" });
    expect(result.isError).toBe(true);
    const message = payloadOf(result).error as string;
    expect(message).toContain("../evil");
    expect(message).toContain("invalid");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  test("create with a flag-like slug ('--force') → isError pattern-quoting message, no spawn", () => {
    h.execFileSync.mockReset();
    const result = worktreeManage({ action: "create", slug: "--force" });
    expect(result.isError).toBe(true);
    const message = payloadOf(result).error as string;
    expect(message).toContain("--force");
    expect(message).toContain("invalid");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  test("remove with a valid kebab-case slug still spawns worktree-remove", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce("worktree removed\n");
    const result = worktreeManage({ action: "remove", slug: "my-feature" });
    expect(result.isError).toBe(false);
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args[0]).toContain("worktree-remove.mjs");
    expect(args).toContain("my-feature");
  });
});

describe("repoVerify (mocked execFileSync per scope)", () => {
  test("scope 'docs' runs the five doc checks and reports ok:true when all pass", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockImplementation(() => JSON.stringify({ ok: true }));
    const result = repoVerify({ scope: "docs" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    const checks = payload.checks as { name: string; ok: boolean }[];
    expect(checks.map((c) => c.name)).toEqual([
      "check-doc-counts",
      "check-impl-counts",
      "check-doc-exports",
      "check-doc-provenance",
      "check-reference-index",
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test("a failing doc check → ok:false with that check's errors attached", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockImplementation((...args: unknown[]) => {
      const [, argv] = args as [string, string[]];
      const scriptPath = argv[0] ?? "";
      if (scriptPath.includes("check-doc-provenance")) {
        const err = Object.assign(new Error("Command failed"), {
          stdout: JSON.stringify({
            ok: false,
            errors: ["stale provenance sidecar"],
          }),
          status: 1,
        });
        throw err;
      }
      return JSON.stringify({ ok: true });
    });
    const result = repoVerify({ scope: "docs" });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.ok).toBe(false);
    const checks = payload.checks as {
      name: string;
      ok: boolean;
      errors: string[];
    }[];
    const failing = checks.find((c) => c.name === "check-doc-provenance");
    expect(failing?.ok).toBe(false);
    expect(failing?.errors).toEqual(["stale provenance sidecar"]);
    const others = checks.filter((c) => c.name !== "check-doc-provenance");
    expect(others.every((c) => c.ok)).toBe(true);
  });

  test("scope 'hooks' (non-JSON script) takes the exit-code success path", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce("hooks look fine\n");
    const result = repoVerify({ scope: "hooks" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const checks = payload.checks as { name: string; ok: boolean }[];
    expect(checks).toEqual([{ name: "check-hooks", ok: true, errors: [] }]);
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--json");
  });

  test("scope 'hooks' (non-JSON script) takes the exit-code failure path", () => {
    h.execFileSync.mockReset();
    const err = Object.assign(new Error("Command failed"), {
      stdout: "checking hooks...\n",
      stderr: "hook wiring mismatch for guard-secret-writes\n",
    });
    h.execFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const result = repoVerify({ scope: "hooks" });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    const checks = payload.checks as {
      name: string;
      ok: boolean;
      errors: string[];
    }[];
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.errors).toContain(
      "hook wiring mismatch for guard-secret-writes",
    );
  });

  test("an invalid scope → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = repoVerify({ scope: "bogus" });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("scope");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });
});

describe("scaffoldScript (mocked execFileSync)", () => {
  test("forwards name as a positional arg plus --json", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(JSON.stringify({ ok: true }));
    const result = scaffoldScript({ name: "data-sync" });
    expect(result.isError).toBe(false);
    const [cmd, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("node");
    expect(args[0]).toContain("scaffold-script.mjs");
    expect(args).toContain("data-sync");
    expect(args).toContain("--json");
  });

  test("forwards an optional purpose as --purpose <value>", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(JSON.stringify({ ok: true }));
    scaffoldScript({ name: "data-sync", purpose: "Sync S3 exports" });
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args).toContain("--purpose");
    expect(args).toContain("Sync S3 exports");
  });

  test("a validation-failure payload from the script is surfaced", () => {
    h.execFileSync.mockReset();
    const err = Object.assign(new Error("Command failed"), {
      stdout: JSON.stringify({
        ok: false,
        errors: ["scripts/data-sync already exists"],
      }),
      status: 1,
    });
    h.execFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const result = scaffoldScript({ name: "data-sync" });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.errors).toEqual(["scripts/data-sync already exists"]);
  });

  test("missing name → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = scaffoldScript({});
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("name");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });
});

describe("spokeRecover (mocked execFileSync)", () => {
  test("happy path spawns bin/spoke-recovery.mjs with --journal <path> and --json, returning its payload", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(
      JSON.stringify({
        ok: true,
        recommendation: { action: "resume", punchList: [], rationale: "..." },
      }),
    );
    const result = spokeRecover({ journal: "scratchpad/writer-a.md" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    const [cmd, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("node");
    expect(args[0]).toContain("spoke-recovery.mjs");
    expect(args).toContain("--journal");
    expect(args).toContain("scratchpad/writer-a.md");
    expect(args).toContain("--json");
  });

  test("forwards 'expected' as a comma-joined --expected list", () => {
    h.execFileSync.mockReset();
    h.execFileSync.mockReturnValueOnce(JSON.stringify({ ok: true }));
    spokeRecover({
      journal: "scratchpad/writer-a.md",
      expected: ["src/a.ts", "src/b/**"],
    });
    const [, args] = h.execFileSync.mock.calls[0] as [string, string[]];
    expect(args).toContain("--expected");
    expect(args).toContain("src/a.ts,src/b/**");
  });

  test("missing 'journal' → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = spokeRecover({});
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("journal");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  test("a non-array 'expected' → isError usage message, no spawn attempted", () => {
    h.execFileSync.mockReset();
    const result = spokeRecover({
      journal: "scratchpad/writer-a.md",
      expected: "src/a.ts",
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("array of strings");
    expect(h.execFileSync).not.toHaveBeenCalled();
  });

  test("child exits 1 with a JSON redispatch-recommendation payload on stdout → payload surfaced, isError stays false", () => {
    h.execFileSync.mockReset();
    const redispatchPayload = {
      ok: false,
      recommendation: {
        action: "redispatch",
        punchList: [],
        rationale: "no durable trace",
      },
    };
    const err = Object.assign(new Error("Command failed"), {
      stdout: JSON.stringify(redispatchPayload),
      status: 1,
    });
    h.execFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const result = spokeRecover({ journal: "scratchpad/missing.md" });
    // The CLI's own contract treats a missing/unreadable journal (or the
    // "no durable trace" case) as exit 1 with a well-formed recommendation on
    // stdout, not a malfunction — spokeRecover surfaces that payload with
    // isError:false, per its handler comment.
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload).toEqual(redispatchPayload);
  });

  test("child spawn failure with no parseable stdout → isError true with the spoke_recover-prefixed message", () => {
    h.execFileSync.mockReset();
    const err = Object.assign(new Error("spawn ENOENT"), { status: 1 });
    h.execFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const result = spokeRecover({ journal: "scratchpad/writer-a.md" });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toContain("spoke_recover");
  });
});
