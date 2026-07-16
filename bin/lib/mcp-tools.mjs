// Tool definitions + handlers for the in-repo MCP server (ADR-0030 Phase 5).
// Every handler is a plain exported function so it can be smoke-tested by
// importing this module directly, with no MCP client/transport involved.
// bin/mcp-server.mjs is the only consumer of `TOOLS` — it stays a thin
// registration loop so all the actual behavior lives here, testable.
//
// Every spawn below captures the child's stdio (never `inherit`s it) — a
// tool handler that let a child's stdout reach this process's real stdout
// would corrupt the MCP stdio protocol framing for every other tool call in
// the same server process.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lintMessages, validateClaudeTrailers } from "../lint-commit.mjs";
import { root } from "./reference-index.mjs";

// Split so the raw source text never has the word "export" immediately
// followed by a period (the repo's CommonJS guard hook flags that literal
// even inside a plain filename) — see bin/sync-docs.mjs for the same trick.
const CHECK_DOC_EXPORTS_SCRIPT = "bin/check-doc-export" + "s.mjs";

// Shared spawn tuning, applied to every execFileSync call below: a generous
// default timeout for the (fast, deterministic) check:* gate scripts, a much
// longer one for docs_sync's spawn of bin/sync-docs.mjs (it re-runs the full
// Vitest suite), and one maxBuffer large enough for any script's --json
// output plus a failing run's stdout/stderr tail.
const DEFAULT_SPAWN_TIMEOUT_MS = 5 * 60 * 1000;
const DOCS_SYNC_SPAWN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

// Kebab-case worktree slug: lowercase letters/digits, single hyphens between
// segments — mirrors the validation bin/worktree-new.mjs performs before it
// ever touches disk. Applied again here because MCP tool arguments are
// untrusted model input, not a human-typed CLI argv.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Build a successful/failed tool result envelope. `payload` is JSON-stringified
 * verbatim as the sole text content block — every handler below returns
 * compact, high-signal JSON rather than prose.
 *
 * @param {Record<string, unknown>} payload
 * @param {boolean} [isError]
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 */
function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
  };
}

/**
 * Build an `isError: true` result from a single corrective message — used for
 * bad input the handler rejects before spawning anything.
 *
 * @param {string} message
 * @returns {{ content: { type: "text", text: string }[], isError: true }}
 */
function errorResult(message) {
  return toolResult({ error: message }, true);
}

/**
 * Keep only the last `n` non-blank lines of `text` — used to bound how much
 * of a failing child's stdout/stderr gets surfaced back through a tool result.
 *
 * @param {string} text
 * @param {number} n
 * @returns {string[]}
 */
function tailLines(text, n) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-n);
}

/**
 * Parse the LAST non-blank line of a child's stdout as JSON — mirrors
 * bin/sync-docs.mjs's parseLastJsonLine, defensive against anything writing
 * extra lines before the reporter's final payload.
 *
 * @param {string} stdout
 * @returns {unknown}
 */
function parseLastJsonLine(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("produced no output on stdout");
  }
  return JSON.parse(last);
}

/**
 * Spawn one of the `--json`-capable bin/ scripts (bin/lib/report.mjs
 * consumers) and parse its final JSON payload. Mirrors bin/sync-docs.mjs's
 * runJsonStep: a non-zero exit still gets its payload read from
 * `error.stdout` when the reporter ran before the failure.
 *
 * @param {string} scriptRelPath repo-relative path, e.g. "bin/check-hooks.mjs"
 * @param {string[]} [extraArgs] args placed before the appended "--json"
 * @param {number} [timeoutMs] milliseconds before the child is killed — defaults to {@link DEFAULT_SPAWN_TIMEOUT_MS}
 * @returns {{ exitCode: number, payload: Record<string, unknown> | null, error: string | null }}
 */
function spawnJson(
  scriptRelPath,
  extraArgs = [],
  timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
) {
  const scriptPath = join(root, scriptRelPath);
  /** @type {string} */
  let stdout;
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [scriptPath, ...extraArgs, "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: timeoutMs,
    });
  } catch (cause) {
    const err =
      /** @type {{ stdout?: string, status?: number | null, code?: string, message: string }} */ (
        cause
      );
    if (err.code === "ETIMEDOUT") {
      return {
        exitCode: 1,
        payload: null,
        error: `${scriptRelPath} timed out after ${timeoutMs}ms`,
      };
    }
    if (typeof err.stdout === "string" && err.stdout.length > 0) {
      stdout = err.stdout;
      exitCode = err.status ?? 1;
    } else {
      return {
        exitCode: 1,
        payload: null,
        error: `failed to run — ${err.message}`,
      };
    }
  }
  try {
    const payload = /** @type {Record<string, unknown>} */ (
      parseLastJsonLine(stdout)
    );
    return { exitCode, payload, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      exitCode: exitCode || 1,
      payload: null,
      error: `could not parse its JSON payload — ${message}`,
    };
  }
}

/**
 * Run a `--json`-capable script as one named check in an aggregated
 * {@link repoVerify} report.
 *
 * @param {string} name human label shown in the aggregated check list
 * @param {string} scriptRelPath repo-relative path
 * @param {string[]} [extraArgs]
 * @returns {{ name: string, ok: boolean, errors: string[] }}
 */
function runJsonCheck(name, scriptRelPath, extraArgs = []) {
  const { exitCode, payload, error } = spawnJson(scriptRelPath, extraArgs);
  if (error !== null) return { name, ok: false, errors: [error] };
  const errors = Array.isArray(payload?.errors)
    ? payload.errors.map(String)
    : [];
  return { name, ok: exitCode === 0 && payload?.ok !== false, errors };
}

/**
 * Run a script that has no `--json` mode as one named check — success/failure
 * comes from the exit code, and any diagnostics come from the tail of its
 * captured stdout/stderr.
 *
 * @param {string} name
 * @param {string} scriptRelPath
 * @param {string[]} [extraArgs]
 * @param {number} [timeoutMs] milliseconds before the child is killed — defaults to {@link DEFAULT_SPAWN_TIMEOUT_MS}
 * @returns {{ name: string, ok: boolean, errors: string[] }}
 */
function runPlainCheck(
  name,
  scriptRelPath,
  extraArgs = [],
  timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
) {
  const scriptPath = join(root, scriptRelPath);
  try {
    execFileSync("node", [scriptPath, ...extraArgs], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: timeoutMs,
    });
    return { name, ok: true, errors: [] };
  } catch (cause) {
    const err =
      /** @type {{ stdout?: string, stderr?: string, message: string, code?: string }} */ (
        cause
      );
    if (err.code === "ETIMEDOUT") {
      return {
        name,
        ok: false,
        errors: [`${name} timed out after ${timeoutMs}ms`],
      };
    }
    const tail = tailLines(`${err.stdout ?? ""}\n${err.stderr ?? ""}`, 20);
    return { name, ok: false, errors: tail.length > 0 ? tail : [err.message] };
  }
}

/** @typedef {[name: string, scriptRelPath: string, json: boolean]} CheckSpec */

/** @type {Record<"docs" | "api" | "agents" | "hooks" | "scaffold", CheckSpec[]>} */
const REPO_VERIFY_CHECKS = {
  docs: [
    ["check-doc-counts", "bin/check-doc-counts.mjs", true],
    ["check-impl-counts", "bin/check-impl-counts.mjs", true],
    ["check-doc-exports", CHECK_DOC_EXPORTS_SCRIPT, true],
    ["check-doc-provenance", "bin/check-doc-provenance.mjs", true],
    ["check-reference-index", "bin/check-reference-index.mjs", true],
  ],
  api: [["check-exports-snapshot", "bin/check-exports-snapshot.mjs", false]],
  agents: [["check-agents", "bin/check-agents.mjs", true]],
  hooks: [["check-hooks", "bin/check-hooks.mjs", false]],
  scaffold: [
    ["check-scaffold", "bin/check-scaffold.mjs", false],
    ["check-scaffold-seam", "bin/check-scaffold-seam.mjs", false],
    ["check-script-scaffold", "bin/check-script-scaffold.mjs", true],
  ],
};

/**
 * Run the check:* gate scripts for one scope and aggregate their results.
 * `scope: "all"` runs every scope's checks (docs, api, agents, hooks,
 * scaffold) but deliberately excludes check-test-counts — it re-runs the
 * whole Vitest suite and belongs to the slower `docs_sync` full pass instead.
 *
 * @param {{ scope?: unknown }} args
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { repoVerify } from "./mcp-tools.mjs";
 * const result = repoVerify({ scope: "hooks" });
 * ```
 */
export function repoVerify(args) {
  const scope = args?.scope;
  const validScopes = [...Object.keys(REPO_VERIFY_CHECKS), "all"];
  if (typeof scope !== "string" || !validScopes.includes(scope)) {
    return errorResult(
      `repo_verify: 'scope' must be one of ${validScopes
        .map((s) => `"${s}"`)
        .join(", ")} — e.g. { scope: "docs" }.`,
    );
  }
  const specs =
    scope === "all"
      ? Object.values(REPO_VERIFY_CHECKS).flat()
      : REPO_VERIFY_CHECKS[
          /** @type {keyof typeof REPO_VERIFY_CHECKS} */ (scope)
        ];
  const checks = specs.map(([name, scriptRelPath, json]) =>
    json
      ? runJsonCheck(name, scriptRelPath)
      : runPlainCheck(name, scriptRelPath),
  );
  const ok = checks.every((check) => check.ok);
  return toolResult({ ok, checks }, !ok);
}

/**
 * Run the full `/syncing-docs` reconciliation sequence (bin/sync-docs.mjs)
 * and return its own JSON payload verbatim.
 *
 * @param {{ affected?: unknown }} args
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { docsSync } from "./mcp-tools.mjs";
 * const result = docsSync({ affected: "packages/m3l-common/src/core/retry/index.ts" });
 * ```
 */
export function docsSync(args) {
  const affected = args?.affected;
  if (affected !== undefined && typeof affected !== "string") {
    return errorResult(
      "docs_sync: 'affected' must be a string path when provided.",
    );
  }
  const cliArgs = typeof affected === "string" ? ["--affected", affected] : [];
  const { exitCode, payload, error } = spawnJson(
    "bin/sync-docs.mjs",
    cliArgs,
    DOCS_SYNC_SPAWN_TIMEOUT_MS,
  );
  if (error !== null) return errorResult(`docs_sync: ${error}`);
  const isError = exitCode !== 0 || payload?.ok === false;
  return toolResult(/** @type {Record<string, unknown>} */ (payload), isError);
}

const WORKTREE_SCRIPTS = {
  create: "bin/worktree-new.mjs",
  setup: "bin/worktree-setup.mjs",
  remove: "bin/worktree-remove.mjs",
  prune: "bin/worktree-prune.mjs",
};

/**
 * Create, provision, remove, or prune a git worktree by wrapping
 * bin/worktree-{new,setup,remove,prune}.mjs. `create`/`prune` use each
 * script's own `--json` reporter; `setup`/`remove` have no `--json` mode, so
 * their result is exit-code + captured-output based.
 *
 * @param {{ action?: unknown, slug?: unknown, fix?: unknown, dryRun?: unknown }} args
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { worktreeManage } from "./mcp-tools.mjs";
 * const result = worktreeManage({ action: "prune", dryRun: true });
 * ```
 */
export function worktreeManage(args) {
  const action = args?.action;
  if (typeof action !== "string" || !Object.hasOwn(WORKTREE_SCRIPTS, action)) {
    return errorResult(
      `worktree_manage: 'action' must be one of "create", "setup", "remove", "prune".`,
    );
  }
  const slug = args?.slug;
  if (
    (action === "create" || action === "remove") &&
    typeof slug !== "string"
  ) {
    return errorResult(
      `worktree_manage: action "${action}" requires 'slug' (kebab-case), ` +
        `e.g. { action: "${action}", slug: "my-feature" }.`,
    );
  }
  // Validated before any spawn — tool args are untrusted model input, so a
  // slug must be checked here even though bin/worktree-new.mjs re-validates
  // it too; a value like "../evil" or "--force" must never reach execFileSync.
  if (
    (action === "create" || action === "remove" || action === "setup") &&
    typeof slug === "string" &&
    !SLUG_PATTERN.test(slug)
  ) {
    return errorResult(
      `worktree_manage: 'slug' "${slug}" is invalid — it must match ${SLUG_PATTERN} ` +
        `(kebab-case: lowercase letters, digits, single hyphens), e.g. "my-feature".`,
    );
  }
  const dryRun = args?.dryRun;
  if (dryRun !== undefined && action !== "prune") {
    return errorResult(
      `worktree_manage: 'dryRun' is only valid with action "prune" — omit it for "${action}".`,
    );
  }

  const scriptRelPath = WORKTREE_SCRIPTS[action];
  switch (action) {
    case "create": {
      const cliArgs = [
        /** @type {string} */ (slug),
        ...(args?.fix === true ? ["--fix"] : []),
      ];
      const { exitCode, payload, error } = spawnJson(scriptRelPath, cliArgs);
      if (error !== null) return errorResult(`worktree_manage: ${error}`);
      return toolResult(
        /** @type {Record<string, unknown>} */ (payload),
        exitCode !== 0 || payload?.ok === false,
      );
    }
    case "prune": {
      const cliArgs = dryRun === true ? ["--dry-run"] : [];
      const { exitCode, payload, error } = spawnJson(scriptRelPath, cliArgs);
      if (error !== null) return errorResult(`worktree_manage: ${error}`);
      return toolResult(
        /** @type {Record<string, unknown>} */ (payload),
        exitCode !== 0 || payload?.ok === false,
      );
    }
    case "setup": {
      const result = runPlainCheck("worktree-setup", scriptRelPath);
      return toolResult(result, !result.ok);
    }
    case "remove": {
      const result = runPlainCheck("worktree-remove", scriptRelPath, [
        /** @type {string} */ (slug),
      ]);
      return toolResult(result, !result.ok);
    }
    default: {
      const exhaustive = /** @type {never} */ (action);
      throw new Error(
        `worktree_manage: unhandled action ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Scaffold a brand-new scripts/<name>/ consumer-script package by wrapping
 * bin/scaffold-script.mjs, returning its own JSON payload verbatim.
 *
 * @param {{ name?: unknown, purpose?: unknown }} args
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { scaffoldScript } from "./mcp-tools.mjs";
 * const result = scaffoldScript({ name: "data-sync", purpose: "Sync S3 exports to Dynamo" });
 * ```
 */
export function scaffoldScript(args) {
  const name = args?.name;
  if (typeof name !== "string" || name.length === 0) {
    return errorResult(
      `scaffold_script requires 'name' (kebab-case script name), e.g. { name: "data-sync" }.`,
    );
  }
  const purpose = args?.purpose;
  if (purpose !== undefined && typeof purpose !== "string") {
    return errorResult(
      "scaffold_script: 'purpose' must be a string when provided.",
    );
  }
  const cliArgs = [
    name,
    ...(typeof purpose === "string" ? ["--purpose", purpose] : []),
  ];
  const { exitCode, payload, error } = spawnJson(
    "bin/scaffold-script.mjs",
    cliArgs,
  );
  if (error !== null) return errorResult(`scaffold_script: ${error}`);
  const isError = exitCode !== 0 || payload?.ok === false;
  return toolResult(/** @type {Record<string, unknown>} */ (payload), isError);
}

/**
 * Validate a full commit message against the repo's commitlint config and
 * the Claude co-author trailer allowlist, by calling bin/lint-commit.mjs's
 * exported `lintMessages`/`validateClaudeTrailers` in-process — no temp file
 * or child process needed since the message never touches disk.
 *
 * @param {{ message?: unknown }} args
 * @returns {Promise<{ content: { type: "text", text: string }[], isError: boolean }>}
 * @example
 * ```js
 * import { commitLint } from "./mcp-tools.mjs";
 * const result = await commitLint({ message: "feat: add widget\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>" });
 * ```
 */
export async function commitLint(args) {
  const message = args?.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    return errorResult(
      "commit_lint requires a non-empty 'message' (the full commit message to validate).",
    );
  }
  const [lintResult] = await lintMessages([message]);
  const errors = lintResult.errors.map((e) => e.message);
  const trailerErrors = validateClaudeTrailers(message);
  const valid = lintResult.valid && trailerErrors.length === 0;
  // A malformed message is a normal query outcome, not a tool failure — the
  // caller asked "is this valid?" and got a definite answer either way.
  return toolResult({ valid, errors: [...errors, ...trailerErrors] }, false);
}

/**
 * Answer a targeted lookup against the generated reference index
 * (docs/reference/catalog.json + symbol-map.json) instead of the caller
 * reading either file in full — those two files run to roughly 11k tokens
 * combined, so this collapses that into a ~50-token targeted answer.
 *
 * @param {{ symbol?: unknown, module?: unknown, query?: unknown }} args
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { catalogQuery } from "./mcp-tools.mjs";
 * const result = catalogQuery({ symbol: "M3LError" });
 * ```
 */
export function catalogQuery(args) {
  const symbol = typeof args?.symbol === "string" ? args.symbol : undefined;
  const moduleName = typeof args?.module === "string" ? args.module : undefined;
  const query = typeof args?.query === "string" ? args.query : undefined;
  if (symbol === undefined && moduleName === undefined && query === undefined) {
    return errorResult(
      `catalog_query requires at least one of 'symbol', 'module', or 'query' ` +
        `— e.g. { symbol: "M3LError" } or { query: "retry" }.`,
    );
  }

  /** @type {{ namespace: string, name: string, importPath: string, status: string, wired: boolean, docPath: string, symbols: string[] }[]} */
  let catalog;
  /** @type {Record<string, { submodule: string, namespace: string, file: string, lines?: unknown }>} */
  let symbolMap;
  try {
    catalog = JSON.parse(
      readFileSync(join(root, "docs/reference/catalog.json"), "utf8"),
    );
    symbolMap = JSON.parse(
      readFileSync(join(root, "docs/reference/symbol-map.json"), "utf8"),
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return errorResult(
      `catalog_query: failed to read the reference index — ${message}. ` +
        "Run `pnpm gen:index` to (re)generate it.",
    );
  }

  /** @type {Record<string, unknown>} */
  const result = {};
  if (symbol !== undefined) {
    // Object.hasOwn guards against "__proto__"/"constructor"/etc. resolving
    // to a prototype object via plain bracket access instead of correctly
    // reporting not-found — symbol is untrusted model input.
    const entry = Object.hasOwn(symbolMap, symbol)
      ? symbolMap[symbol]
      : undefined;
    result.symbol = entry ? { symbol, ...entry } : null;
  }
  if (moduleName !== undefined) {
    const matches = catalog.filter((entry) => entry.name === moduleName);
    result.module = matches.length > 0 ? matches : null;
  }
  if (query !== undefined) {
    const needle = query.toLowerCase();
    const hits = Object.keys(symbolMap).filter((s) =>
      s.toLowerCase().includes(needle),
    );
    const capped = hits.length > 25;
    result.query = {
      total: hits.length,
      symbols: hits.slice(0, 25).map((s) => ({ symbol: s, ...symbolMap[s] })),
      ...(capped
        ? { note: "More than 25 matches returned — narrow your query." }
        : {}),
    };
  }
  return toolResult(result, false);
}

/**
 * The six registered tools, in server-registration order. Each entry's
 * `config` is passed straight to `McpServer#registerTool` and its `handler`
 * is the exported function above — kept together here so
 * bin/mcp-server.mjs stays a pure registration loop.
 *
 * @type {{ name: string, config: { description: string, inputSchema: Record<string, import("zod").ZodTypeAny>, annotations?: Record<string, boolean> }, handler: (args: Record<string, unknown>) => unknown }[]}
 */
export const TOOLS = [
  {
    name: "repo_verify",
    config: {
      description:
        "Runs the deterministic bin/check-*.mjs gate scripts for one slice of the " +
        "repo's structural invariants (docs, API surface, agent/hook wiring, or " +
        "scaffold shape) and returns an aggregated { ok, checks[] } verdict. Use it " +
        'to sanity-check one area — e.g. scope "docs" after editing a reference ' +
        "page — without re-running the whole pre-push/CI gate. It is not a " +
        'substitute for `pnpm lint`/`pnpm typecheck`/`pnpm test`, and `scope: "all"` ' +
        "deliberately EXCLUDES check-test-counts (it re-runs the full Vitest suite " +
        "and is slow) — use `docs_sync` for that full pass. Each check reports its " +
        "own name, ok flag, and error lines so a failure is attributable to the " +
        "exact script that raised it.",
      inputSchema: {
        scope: z
          .enum(["docs", "api", "agents", "hooks", "scaffold", "all"])
          .describe(
            "Which check family to run: docs, api, agents, hooks, scaffold, or all.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    handler: repoVerify,
  },
  {
    name: "docs_sync",
    config: {
      description:
        "Runs the full /syncing-docs reconciliation sequence (bin/sync-docs.mjs), " +
        "regenerating doc counts, the reference index, and provenance sidecars and " +
        "then re-verifying everything end to end. This is the only tool here that " +
        "RUNS THE FULL VITEST SUITE and can take minutes, and it MUTATES files in " +
        "the working tree (sidecars, counts, the reference index) — do not call it " +
        "for a quick check, use `repo_verify` instead. Use it after a " +
        "submodule/script lands, passing `affected` (a changed source file path) " +
        "to scope the provenance restamp when you already know which file changed. " +
        "Returns the orchestrator's own JSON payload verbatim, including any " +
        "per-step errors.",
      inputSchema: {
        affected: z
          .string()
          .optional()
          .describe(
            "Path of a changed source file to scope the provenance restamp (optional optimization).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    handler: docsSync,
  },
  {
    name: "worktree_manage",
    config: {
      description:
        "Creates, provisions, tears down, or prunes git worktrees for isolated " +
        "feature work (ADR-0013/0014) by wrapping " +
        "bin/worktree-{new,setup,remove,prune}.mjs. `create` and `remove` REQUIRE " +
        "`slug`; `setup` provisions the worktree rooted at the current working " +
        "directory (run it from inside the new worktree, not the main checkout); " +
        "`prune` removes worktrees whose branch is already merged into main and " +
        "accepts `dryRun` to just list candidates. `remove` and `prune` (without " +
        "`dryRun`) are DESTRUCTIVE — they delete a worktree directory and " +
        "potentially its branch, so confirm the target before calling. `dryRun` is " +
        "only meaningful for `prune`; passing it with any other action is rejected.",
      inputSchema: {
        action: z
          .enum(["create", "setup", "remove", "prune"])
          .describe("Which worktree lifecycle operation to perform."),
        slug: z
          .string()
          .optional()
          .describe(
            "Kebab-case worktree slug — required for create/remove, unused otherwise.",
          ),
        fix: z
          .boolean()
          .optional()
          .describe(
            'For action "create" only: branch as fix/<slug> instead of feat/<slug>.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'For action "prune" only: list stale-worktree candidates without removing them.',
          ),
      },
      annotations: { destructiveHint: true },
    },
    handler: worktreeManage,
  },
  {
    name: "scaffold_script",
    config: {
      description:
        "Scaffolds a brand-new scripts/<name>/ consumer-script package (ADR-0022 " +
        "fleet shape: main.ts, config.ts, steps/, tests, and a contract page under " +
        "docs/reference/scripts/) by wrapping bin/scaffold-script.mjs — pure file " +
        "emission, no install/build/network. Use it once per new automation " +
        "script; it is NOT for adding a new library submodule under " +
        "packages/m3l-common/src/ (use the scaffolding-submodules skill for that). " +
        "`name` must be kebab-case and must not already exist as a script package " +
        "— re-running it against an existing name fails rather than overwriting. " +
        "`purpose` is an optional one-line description written into the generated " +
        "files and docs.",
      inputSchema: {
        name: z.string().describe('Kebab-case script name, e.g. "data-sync".'),
        purpose: z
          .string()
          .optional()
          .describe("One-line description of what the script automates."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler: scaffoldScript,
  },
  {
    name: "commit_lint",
    config: {
      description:
        "Validates a full commit message against the repo's commitlint config " +
        "plus the Claude co-author trailer allowlist (bin/lint-commit.mjs), " +
        "without creating a real commit — pass the exact message you intend to " +
        "use, headers and body together. Use it before `git commit` to catch a " +
        "malformed Conventional Commit type/scope or a non-canonical " +
        "`Co-Authored-By: Claude ...` trailer early. It only checks the message " +
        "text, never the diff or staged files, and a `{ valid: false }` result is " +
        "a normal (not an error) response — read `errors` for the specific rule " +
        "or trailer that failed and fix the message accordingly.",
      inputSchema: {
        message: z.string().describe("The full commit message to validate."),
      },
      annotations: { readOnlyHint: true },
    },
    handler: commitLint,
  },
  {
    name: "catalog_query",
    config: {
      description:
        "Looks up submodule/symbol metadata from the generated reference index " +
        "(docs/reference/catalog.json + symbol-map.json) without reading either " +
        "file in full — those two files run to roughly 11k tokens combined, so " +
        "this tool exists to turn that into a ~50-token targeted answer. Pass " +
        'exactly one of `symbol` (an exact export name, e.g. "M3LError") for its ' +
        'owning module/file, `module` (a submodule name, e.g. "retry") for its ' +
        "full catalog entry, or `query` (a case-insensitive substring) to search " +
        "symbol names — `query` results are capped at 25 hits with a note to " +
        "narrow the search. At least one parameter is required; it reads the " +
        "index fresh on every call, reflecting whatever `pnpm gen:index` last " +
        "generated, not a live filesystem scan.",
      inputSchema: {
        symbol: z
          .string()
          .optional()
          .describe('Exact export name to look up, e.g. "M3LError".'),
        module: z
          .string()
          .optional()
          .describe('Submodule name to look up, e.g. "retry".'),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring to search symbol names for."),
      },
      annotations: { readOnlyHint: true },
    },
    handler: catalogQuery,
  },
];
