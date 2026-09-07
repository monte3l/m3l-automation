// Unit tests for bin/lib/mcp-tools.mjs — the tool definitions + handlers
// backing the in-repo MCP server (ADR-0096, replacing ADR-0030 Phase 5's
// original seven-tool CLI-wrapper design). None of the six current tools
// spawns a child process, so this file needs no execFileSync mocking:
// adr_query/logs_query/hooks_query run against the real committed
// docs/adr/**, docs/logs/**, and docs/contributing/hooks-reference.md;
// commands_query runs against the real bin/lib/command-catalog.mjs;
// catalog_query and commit_lint run against the real committed
// docs/reference/*.json and bin/lint-commit.mjs respectively.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  TOOLS,
  adrQuery,
  catalogQuery,
  commandsQuery,
  commitLint,
  hooksQuery,
  logsQuery,
  resolveRepoRoot,
} from "../lib/mcp-tools.mjs";
import { root } from "../lib/reference-index.mjs";

/** Parse the single text content block every handler returns. */
function payloadOf(result: {
  content: { type: string; text: string }[];
  isError: boolean;
}): Record<string, unknown> {
  const block = result.content[0];
  if (block === undefined) throw new Error("tool result had no content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

/** A fresh, empty temp directory to build a small fixture repo tree under. */
function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "mcp-root-test-"));
}

describe("TOOLS registration contract", () => {
  test("registers exactly six tools", () => {
    expect(TOOLS).toHaveLength(6);
  });

  test("tool names, in server-registration order", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "adr_query",
      "logs_query",
      "commands_query",
      "hooks_query",
      "catalog_query",
      "commit_lint",
    ]);
  });

  test.each(TOOLS)(
    "$name: valid name, description, inputSchema, handler",
    (tool) => {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(typeof tool.config.inputSchema).toBe("object");
      expect(tool.config.inputSchema).not.toBeNull();
      expect(typeof tool.handler).toBe("function");
    },
  );

  test.each(TOOLS)(
    "$name: has a non-empty title and a non-null outputSchema",
    (tool) => {
      expect(typeof tool.config.title).toBe("string");
      expect(tool.config.title.length).toBeGreaterThan(0);
      expect(typeof tool.config.outputSchema).toBe("object");
      expect(tool.config.outputSchema).not.toBeNull();
    },
  );

  test.each(TOOLS)("$name: is annotated read-only", (tool) => {
    expect(tool.config.annotations["readOnlyHint"]).toBe(true);
  });

  test.each(TOOLS)("$name: needsRoot is a boolean", (tool) => {
    expect(typeof tool.needsRoot).toBe("boolean");
  });

  test.each(["commands_query", "commit_lint"])(
    "%s: needsRoot is false (never reads a repo file)",
    (name) => {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool?.needsRoot).toBe(false);
    },
  );

  test.each(["adr_query", "logs_query", "hooks_query", "catalog_query"])(
    "%s: needsRoot is true",
    (name) => {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool?.needsRoot).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Tool description content — replaces a proxy assertion
// (`description.split(". ").length >= 3`, a sentence count that proves
// nothing about usefulness) with a check on the actually-required content
// per this PR's plan: every tool description must state (a) what the tool
// does, (b) when/how to use it, and (c) what it returns or a behavioral
// caveat about its output.
// ---------------------------------------------------------------------------

/**
 * One regex per required facet for a tool's `config.description`. `returns`
 * is typed optional per-entry to let the second `test.each` below filter to
 * only the tools that declare it; every current tool declares one.
 */
type DescriptionFacets = {
  /** (a) what the tool does. */
  action: RegExp;
  /** (b) when/how to use it. */
  usage: RegExp;
  /** (c) what it returns or a behavioral caveat about its output. */
  returns?: RegExp;
};

const DESCRIPTION_FACETS: Record<string, DescriptionFacets> = {
  adr_query: {
    action: /Looks up architecture decision record\(s\)/,
    usage: /Use it to answer/,
    returns: /not a cached snapshot/,
  },
  logs_query: {
    action: /Looks up work log\(s\) under docs\/logs\//,
    usage: /read the specific file yourself once you've found the one you want/,
    returns: /never the log body/,
  },
  commands_query: {
    action: /Looks up `pnpm` script\(s\) by exact name/,
    usage: /use it to answer "which pnpm script does X"/,
    returns: /not a live filesystem scan/,
  },
  hooks_query: {
    action: /Looks up wired-hook row\(s\)/,
    usage: /use it to answer "what does hook X do"/,
    returns: /not a cached snapshot/,
  },
  catalog_query: {
    action: /Looks up submodule\/symbol metadata/,
    usage: /Pass exactly one of `symbol`/,
    returns: /not a live filesystem scan/,
  },
  commit_lint: {
    action: /Validates a full commit message/,
    usage: /Use it before `git commit`/,
    returns: /normal \(not an error\) response/,
  },
};

describe("tool description content: what it does, how/when to use it, what it returns", () => {
  test.each(TOOLS)(
    "$name: description states what it does and when/how to use it",
    (tool) => {
      const facets = DESCRIPTION_FACETS[tool.name];
      if (facets === undefined) {
        throw new Error(
          `no DESCRIPTION_FACETS fixture defined for tool "${tool.name}" — ` +
            "add one covering its (a) action and (b) usage facets.",
        );
      }
      expect(tool.config.description).toMatch(facets.action);
      expect(tool.config.description).toMatch(facets.usage);
    },
  );

  test.each(
    Object.entries(DESCRIPTION_FACETS).filter(
      (entry): entry is [string, Required<DescriptionFacets>] =>
        entry[1].returns !== undefined,
    ),
  )(
    "%s: description states what it returns or a behavioral caveat about its output",
    (name, facets) => {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool?.config.description).toMatch(facets.returns);
    },
  );
});

describe("tool description facet assertions are not proxies (mutation check)", () => {
  // A description with an action-verb phrase and nothing else — no usage
  // guidance, no return/caveat statement — the exact shape tests.md asks a
  // mutation probe to construct: "a bare one-line action verb phrase with no
  // usage guidance and no return/caveat info".
  const bareActionOnlyFixture = "Looks up architecture decision record(s).";

  test("a bare action-only fixture fails the usage and returns facet regexes (proves the assertions aren't proxies)", () => {
    const facets = DESCRIPTION_FACETS["adr_query"];
    expect(facets).toBeDefined();
    expect(bareActionOnlyFixture).toMatch(facets?.action as RegExp);
    expect(bareActionOnlyFixture).not.toMatch(facets?.usage as RegExp);
    expect(bareActionOnlyFixture).not.toMatch(facets?.returns as RegExp);
  });

  test("the real adr_query description matches all three facets (confirms the mutation probe above discriminates, not just fires)", () => {
    const tool = TOOLS.find((t) => t.name === "adr_query");
    const facets = DESCRIPTION_FACETS["adr_query"];
    expect(facets).toBeDefined();
    expect(tool?.config.description).toMatch(facets?.action as RegExp);
    expect(tool?.config.description).toMatch(facets?.usage as RegExp);
    expect(tool?.config.description).toMatch(facets?.returns as RegExp);
  });
});

describe("resolveRepoRoot (fake mcpServer, no real MCP transport)", () => {
  function fakeServer(
    capabilities: { roots?: unknown } | undefined,
    listRoots: () => Promise<{ roots?: { uri: string }[] }>,
  ) {
    return {
      server: {
        getClientCapabilities: () => capabilities,
        listRoots,
      },
    };
  }

  test("no client capabilities at all → falls back to the static root", async () => {
    const server = fakeServer(undefined, () => Promise.resolve({ roots: [] }));
    await expect(resolveRepoRoot(server)).resolves.toBe(root);
  });

  test("capabilities present but no 'roots' key → falls back to the static root", async () => {
    const server = fakeServer({}, () => Promise.resolve({ roots: [] }));
    await expect(resolveRepoRoot(server)).resolves.toBe(root);
  });

  test("client declares roots and returns one → resolves to the fileURLToPath-converted path", async () => {
    const server = fakeServer({ roots: {} }, () =>
      Promise.resolve({
        roots: [{ uri: "file:///tmp/some-other-checkout" }],
      }),
    );
    await expect(resolveRepoRoot(server)).resolves.toBe(
      "/tmp/some-other-checkout",
    );
  });

  test("client declares roots but returns an empty array → falls back to the static root", async () => {
    const server = fakeServer({ roots: {} }, () =>
      Promise.resolve({ roots: [] }),
    );
    await expect(resolveRepoRoot(server)).resolves.toBe(root);
  });

  test("client declares roots but listRoots() rejects → falls back to the static root, does not throw", async () => {
    const server = fakeServer({ roots: {} }, () =>
      Promise.reject(new Error("transport error")),
    );
    await expect(resolveRepoRoot(server)).resolves.toBe(root);
  });
});

describe("options.root override (regression: silently reverting to the static load-time root, resurrecting ADR-0096's stale-cwd-after-EnterWorktree bug)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("adrQuery: options.root reads a fixture repo, not the real one", () => {
    dir = mktemp();
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "adr", "0001-fixture.md"),
      "# 0001. Fixture ADR\n\n- **Status:** Accepted\n",
    );

    const fixturePayload = payloadOf(adrQuery({ id: "0001" }, { root: dir }));
    const fixtureResults = fixturePayload["results"] as {
      id: string;
      title: string;
      status: string;
    }[];
    expect(fixturePayload["total"]).toBe(1);
    expect(fixtureResults[0]?.id).toBe("0001");
    expect(fixtureResults[0]?.title).toBe("Fixture ADR");
    expect(fixtureResults[0]?.status).toBe("Accepted");

    // Same query, no options — reads the real repo's own ADR-0001, whose
    // title is never "Fixture ADR". Proves the two calls read genuinely
    // different roots rather than coincidentally agreeing.
    const realPayload = payloadOf(adrQuery({ id: "0001" }));
    const realResults = realPayload["results"] as { title: string }[];
    expect(realResults[0]?.title).not.toBe("Fixture ADR");
  });

  test("logsQuery: options.root reads a fixture repo; the real repo has no log dated 2099-01-01", () => {
    dir = mktemp();
    mkdirSync(join(dir, "docs", "logs"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "logs", "2099-01-01-fixture.md"),
      "# Work log — fixture (2099-01-01)\n",
    );

    const fixturePayload = payloadOf(
      logsQuery({ date: "2099-01-01" }, { root: dir }),
    );
    const fixtureResults = fixturePayload["results"] as {
      date: string;
      file: string;
      title: string;
    }[];
    expect(fixturePayload["total"]).toBe(1);
    expect(fixtureResults[0]?.date).toBe("2099-01-01");
    expect(fixtureResults[0]?.file).toBe("2099-01-01-fixture.md");
    expect(fixtureResults[0]?.title).toBe("Work log — fixture (2099-01-01)");

    // Same query against the real repo, no options — 2099-01-01 is a clearly
    // fake future date no real log carries, so this must report zero.
    const realPayload = payloadOf(logsQuery({ date: "2099-01-01" }));
    expect(realPayload["total"]).toBe(0);
  });

  test("hooksQuery: options.root reads a fixture repo; the real repo has no such hook", () => {
    dir = mktemp();
    mkdirSync(join(dir, "docs", "contributing"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "contributing", "hooks-reference.md"),
      [
        "# Hooks reference",
        "",
        "| Event | Matcher | Hook | Purpose | Mode |",
        "| --- | --- | --- | --- | --- |",
        "| SessionStart | fixture | `fixture-hook.mjs` | Fixture purpose text | blocking |",
        "",
      ].join("\n"),
    );

    const fixturePayload = payloadOf(
      hooksQuery({ name: "fixture-hook.mjs" }, { root: dir }),
    );
    const fixtureResults = fixturePayload["results"] as {
      event: string;
      hook: string;
      purpose: string;
      mode: string;
    }[];
    expect(fixturePayload["total"]).toBe(1);
    expect(fixtureResults[0]?.hook).toBe("fixture-hook.mjs");
    expect(fixtureResults[0]?.event).toBe("SessionStart");
    expect(fixtureResults[0]?.purpose).toBe("Fixture purpose text");

    // Same query against the real repo, no options — "fixture-hook.mjs" is
    // not a real hook filename.
    const realPayload = payloadOf(hooksQuery({ name: "fixture-hook.mjs" }));
    expect(realPayload["total"]).toBe(0);
  });

  test("catalogQuery: options.root reads a fixture repo; the real repo has no such symbol", () => {
    dir = mktemp();
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(join(dir, "docs", "reference", "catalog.json"), "[]");
    writeFileSync(
      join(dir, "docs", "reference", "symbol-map.json"),
      JSON.stringify({
        FixtureSymbol: {
          submodule: "fixture",
          namespace: "core",
          file: "fixture.ts",
        },
      }),
    );

    const fixturePayload = payloadOf(
      catalogQuery({ symbol: "FixtureSymbol" }, { root: dir }),
    );
    expect(fixturePayload["symbol"]).toMatchObject({
      symbol: "FixtureSymbol",
      submodule: "fixture",
      namespace: "core",
      file: "fixture.ts",
    });

    // Same query against the real repo, no options — "FixtureSymbol" is not
    // a real exported symbol, so the lookup must report not-found.
    const realPayload = payloadOf(catalogQuery({ symbol: "FixtureSymbol" }));
    expect(realPayload["symbol"]).toBeNull();
  });
});

describe("logsQuery limit validation", () => {
  test.each([0, -1, 1.5, "5", Number.NaN])(
    "limit %p → isError with a 'positive integer' message",
    (limit) => {
      const result = logsQuery({ topic: "worktree", limit });
      expect(result.isError).toBe(true);
      const payload = payloadOf(result);
      expect(payload["error"]).toContain("positive integer");
    },
  );
});

describe("adrQuery (real docs/adr corpus, no mocking)", () => {
  test("id '0096' → exactly one result, Accepted, with a dated reviewBy field", () => {
    const result = adrQuery({ id: "0096" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as {
      id: string;
      status: string;
      reviewBy?: string;
    }[];
    expect(payload["total"]).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("0096");
    expect(results[0]?.status).toBe("Accepted");
    expect(results[0]?.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("id '0001' → exactly one result with a non-empty status", () => {
    const result = adrQuery({ id: "0001" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as { id: string; status: string }[];
    expect(payload["total"]).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("0001");
    expect(typeof results[0]?.status).toBe("string");
    expect((results[0]?.status ?? "").length).toBeGreaterThan(0);
  });

  test("a nonexistent ADR number → isError:false, total:0, results:[]", () => {
    const result = adrQuery({ id: "9999" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["total"]).toBe(0);
    expect(payload["results"]).toEqual([]);
  });

  test("status 'Accepted' → every result has that status, total is positive", () => {
    const result = adrQuery({ status: "Accepted" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as { status: string }[];
    expect(payload["total"]).toBeGreaterThan(0);
    expect(results.every((entry) => entry.status === "Accepted")).toBe(true);
  });

  test("query 'worktree' → at least one title contains it case-insensitively", () => {
    const result = adrQuery({ query: "worktree" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as { title: string }[];
    expect(payload["total"]).toBeGreaterThan(0);
    expect(
      results.some((entry) => entry.title.toLowerCase().includes("worktree")),
    ).toBe(true);
  });

  test("no params at all → isError with a usage message", () => {
    const result = adrQuery({});
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload["error"]).toContain("requires at least one of");
  });

  test("status matching is case-insensitive", () => {
    const lower = payloadOf(adrQuery({ status: "accepted" }));
    const proper = payloadOf(adrQuery({ status: "Accepted" }));
    expect(lower["total"]).toBe(proper["total"]);
    expect(lower["total"]).toBeGreaterThan(0);
  });
});

describe("logsQuery (real docs/logs corpus, no mocking)", () => {
  test("topic 'worktree' → every result has date/file/title strings, one title matches", () => {
    const result = logsQuery({ topic: "worktree" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as {
      date: string;
      file: string;
      title: string;
    }[];
    expect(payload["total"]).toBeGreaterThan(0);
    for (const entry of results) {
      expect(typeof entry.date).toBe("string");
      expect(typeof entry.file).toBe("string");
      expect(typeof entry.title).toBe("string");
    }
    expect(
      results.some((entry) => entry.title.toLowerCase().includes("worktree")),
    ).toBe(true);
  });

  test("date '2026-09-07' → total positive, every result's date matches exactly", () => {
    const result = logsQuery({ date: "2026-09-07" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as { date: string }[];
    expect(payload["total"]).toBeGreaterThan(0);
    expect(results.every((entry) => entry.date === "2026-09-07")).toBe(true);
  });

  test("a date with no logs → isError:false, total:0", () => {
    const result = logsQuery({ date: "1999-01-01" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["total"]).toBe(0);
  });

  test("no params at all → isError with a usage message", () => {
    const result = logsQuery({});
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload["error"]).toContain("requires at least one of");
  });

  test("limit caps the returned results even when total reports more matches", () => {
    const result = logsQuery({ topic: "worktree", limit: 1 });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as unknown[];
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe("commandsQuery (real COMMAND_CATALOG, no mocking, no options)", () => {
  test("name 'verify' → exactly one result with a non-empty description", () => {
    const result = commandsQuery({ name: "verify" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as {
      name: string;
      description: string;
    }[];
    expect(payload["total"]).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("verify");
    expect((results[0]?.description ?? "").length).toBeGreaterThan(0);
  });

  test("an unknown script name → isError:false, total:0", () => {
    const result = commandsQuery({ name: "this-script-does-not-exist" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["total"]).toBe(0);
  });

  test("query 'worktree' → every result matches name or description case-insensitively", () => {
    const result = commandsQuery({ query: "worktree" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as {
      name: string;
      description: string;
    }[];
    expect(payload["total"]).toBeGreaterThan(0);
    for (const entry of results) {
      const hit =
        entry.name.toLowerCase().includes("worktree") ||
        entry.description.toLowerCase().includes("worktree");
      expect(hit).toBe(true);
    }
  });

  test("no params at all → isError with a usage message", () => {
    const result = commandsQuery({});
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload["error"]).toContain("requires at least one of");
  });
});

describe("hooksQuery (real docs/contributing/hooks-reference.md, no mocking)", () => {
  test("name 'guard-branch-isolation.mjs' → exactly one result with event/purpose strings", () => {
    const result = hooksQuery({ name: "guard-branch-isolation.mjs" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as {
      hook: string;
      event: string;
      purpose: string;
    }[];
    expect(payload["total"]).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.hook).toBe("guard-branch-isolation.mjs");
    expect((results[0]?.event ?? "").length).toBeGreaterThan(0);
    expect((results[0]?.purpose ?? "").length).toBeGreaterThan(0);
  });

  test("event 'SessionStart' → total positive, every result matches that event", () => {
    const result = hooksQuery({ event: "SessionStart" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as { event: string }[];
    expect(payload["total"]).toBeGreaterThan(0);
    expect(results.every((entry) => entry.event === "SessionStart")).toBe(true);
  });

  test("an unknown hook filename → isError:false, total:0", () => {
    const result = hooksQuery({ name: "this-hook-does-not-exist.mjs" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["total"]).toBe(0);
  });

  test("no params at all → isError with a usage message", () => {
    const result = hooksQuery({});
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload["error"]).toContain("requires at least one of");
  });

  test("query 'worktree' → total positive, every result's purpose matches case-insensitively", () => {
    const result = hooksQuery({ query: "worktree" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    const results = payload["results"] as { purpose: string }[];
    expect(payload["total"]).toBeGreaterThan(0);
    expect(
      results.every((entry) =>
        entry.purpose.toLowerCase().includes("worktree"),
      ),
    ).toBe(true);
  });
});

describe("catalogQuery (real docs/reference index, no mocking)", () => {
  test("exact symbol hit returns only the matching entry", () => {
    const result = payloadOf(catalogQuery({ symbol: "M3LError" }));
    expect(result["module"]).toBeUndefined();
    expect(result["query"]).toBeUndefined();
    expect(result["symbol"]).toMatchObject({
      symbol: "M3LError",
      submodule: "errors",
      namespace: "core",
    });
  });

  test("module lookup returns that module's catalog entry", () => {
    const result = payloadOf(catalogQuery({ module: "analysis" }));
    const modules = result["module"] as { name: string; symbols: string[] }[];
    expect(modules).toHaveLength(1);
    expect(modules[0]?.name).toBe("analysis");
    expect(modules[0]?.symbols).toContain("M3LThresholdEvaluator");
  });

  test("query substring search respects the 25-hit cap and note", () => {
    const result = payloadOf(catalogQuery({ query: "m3l" }));
    const query = result["query"] as {
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
    const query = result["query"] as {
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
    expect(payload["error"]).toContain("requires at least one of");
  });

  test("unknown symbol → graceful not-found (null), not an error", () => {
    const result = catalogQuery({ symbol: "M3LDoesNotExist12345" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["symbol"]).toBeNull();
  });

  test("a prototype-polluting symbol name (__proto__) resolves to not-found, not a prototype object", () => {
    const result = catalogQuery({ symbol: "__proto__" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["symbol"]).toBeNull();
    expect(payload["symbol"]).not.toBe(Object.prototype);
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
    expect(payload["valid"]).toBe(true);
    expect(payload["errors"]).toEqual([]);
  });

  test("a garbage message → valid:false with non-empty errors, isError stays false", async () => {
    const result = await commitLint({ message: "not a conventional header" });
    expect(result.isError).toBe(false);
    const payload = payloadOf(result);
    expect(payload["valid"]).toBe(false);
    expect((payload["errors"] as unknown[]).length).toBeGreaterThan(0);
  });

  test("empty message → isError with a usage message (input rejected before linting)", async () => {
    const result = await commitLint({ message: "   " });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload["error"]).toContain("non-empty");
  });
});
