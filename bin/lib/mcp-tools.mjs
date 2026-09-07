// Tool definitions + handlers for the in-repo MCP server (ADR-0096, replacing
// ADR-0030 Phase 5's original seven-tool CLI-wrapper design). Every handler
// is a plain exported function so it can be smoke-tested by importing this
// module directly, with no MCP client/transport involved.
// bin/mcp-server.mjs is the only consumer of `TOOLS` — it stays a thin
// registration loop so all the actual behavior lives here, testable.
//
// Every tool here is a read-only lookup over this repo's own committed or
// generated metadata (the ADR corpus, work logs, the command catalog, the
// hooks reference, the reference index) or an in-process string validation
// (commit_lint) — none spawns a child process. That is a deliberate
// consequence of ADR-0096: the original server's `execFileSync`-based tools
// carried a `cwd`-pinning bug (silently operating on the wrong worktree after
// a mid-session `EnterWorktree`), no cancellation, head-of-line blocking on
// the server's single-threaded event loop, and discarded child stderr — all
// of which a pure `readFileSync` tool cannot exhibit, so none of that
// machinery survived the rebuild.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { lintMessages, validateClaudeTrailers } from "../lint-commit.mjs";
import { root } from "./reference-index.mjs";
import { parseAdrEntry } from "./adr-index.mjs";
import { LOGS_DIR as LOGS_DIR_REL } from "./logs-index.mjs";
import { COMMAND_CATALOG } from "./command-catalog.mjs";

const ADR_DIR_REL = "docs/adr";
const HOOKS_REFERENCE_PATH_REL = "docs/contributing/hooks-reference.md";

/**
 * Build a successful/failed tool result envelope. `payload` is JSON-stringified
 * as the text content block, and — when `isError` is false — also returned
 * verbatim as `structuredContent` for a client that consumes the typed
 * result instead of re-parsing a string (every tool below declares an
 * `outputSchema` the SDK validates this against).
 *
 * @param {Record<string, unknown>} payload
 * @param {boolean} [isError]
 * @returns {{ content: { type: "text", text: string }[], structuredContent?: Record<string, unknown>, isError: boolean }}
 */
function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? {} : { structuredContent: payload }),
    isError,
  };
}

/**
 * Build an `isError: true` result from a single corrective message — used for
 * bad input the handler rejects before doing any work.
 *
 * @param {string} message
 * @returns {{ content: { type: "text", text: string }[], isError: true }}
 */
function errorResult(message) {
  return toolResult({ error: message }, true);
}

/**
 * Resolve the repo root a read-only query tool should read from: ask the
 * connected client for its current MCP roots — the protocol's own answer to
 * "what tree am I working in," refreshable across a mid-session directory
 * switch (`EnterWorktree`) that this already-running server process cannot
 * otherwise observe — and fall back to this module's own load-time
 * {@link root} when the client doesn't declare the `roots` capability, the
 * request fails, or returns nothing usable. Called once per tool call (never
 * cached) so a switch mid-session is picked up on the very next call.
 *
 * The blast radius of ever falling back here is a stale *read*, never a
 * wrong-tree write — every tool this resolves for is read-only — so a client
 * with no `roots` support (most, as of this writing) degrades to exactly the
 * original server's behavior rather than erroring.
 *
 * @param {{ server: { getClientCapabilities(): { roots?: unknown } | undefined, listRoots(): Promise<{ roots?: { uri: string }[] }> } }} mcpServer
 * @returns {Promise<string>}
 */
export async function resolveRepoRoot(mcpServer) {
  try {
    if (!mcpServer.server.getClientCapabilities()?.roots) return root;
    const { roots } = await mcpServer.server.listRoots();
    const first = roots?.[0]?.uri;
    if (typeof first === "string" && first.startsWith("file://")) {
      return fileURLToPath(first);
    }
  } catch (cause) {
    // The client declared the capability but the request itself failed (no
    // handler registered, a transport error) — fall back rather than error
    // the tool call over a discovery affordance failing. Logged to stderr
    // (never stdout — that's the JSON-RPC transport, see bin/mcp-server.mjs)
    // so a wiring bug here is at least observable, not a silent, permanent
    // degradation to the static root with zero trace.
    console.error(
      "resolveRepoRoot: roots lookup failed, falling back to static root:",
      cause,
    );
  }
  return root;
}

/**
 * Cap a match list at `limit`, appending a narrowing note when truncated —
 * the same shape `catalog_query`'s `query` branch already used, now shared
 * by every list-returning tool below.
 *
 * @template T
 * @param {T[]} matches
 * @param {number} limit
 * @returns {{ total: number, results: T[], note?: string }}
 */
function capResults(matches, limit = 25) {
  const capped = matches.length > limit;
  return {
    total: matches.length,
    results: matches.slice(0, limit),
    ...(capped
      ? { note: `More than ${limit} matches returned — narrow your query.` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// adr_query
// ---------------------------------------------------------------------------

/**
 * Parse every ADR file under `docs/adr/` via the same {@link parseAdrEntry}
 * the generator/checker gates use — reusing it means an id lookup returns
 * exactly the status/relations/reviewBy the corpus's own tooling considers
 * authoritative, with no second parser to drift from it.
 *
 * @param {string} repoRoot
 * @returns {{ number: number, title: string, filename: string, statusText: string, reviewBy?: string }[]}
 */
function loadAdrEntries(repoRoot) {
  const dir = join(repoRoot, ADR_DIR_REL);
  return readdirSync(dir)
    .map((filename) =>
      parseAdrEntry(filename, readFileSync(join(dir, filename), "utf8")),
    )
    .filter((entry) => entry !== null)
    .sort((a, b) => a.number - b.number);
}

/**
 * Look up ADR(s) by exact number, status, or a case-insensitive title
 * substring — the demand-ranked query this repo's own transcripts showed the
 * most sessions (46) reaching for `docs/adr/**` in full to answer.
 *
 * @param {{ id?: unknown, status?: unknown, query?: unknown }} args
 * @param {{ root?: string }} [options]
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { adrQuery } from "./mcp-tools.mjs";
 * const result = adrQuery({ id: "0030" });
 * ```
 */
export function adrQuery(args, options = {}) {
  const id = typeof args?.id === "string" ? args.id : undefined;
  const status = typeof args?.status === "string" ? args.status : undefined;
  const query = typeof args?.query === "string" ? args.query : undefined;
  if (id === undefined && status === undefined && query === undefined) {
    return errorResult(
      `adr_query requires at least one of 'id', 'status', or 'query' — ` +
        `e.g. { id: "0030" } or { query: "worktree" }.`,
    );
  }
  const repoRoot = options.root ?? root;
  /** @type {ReturnType<typeof loadAdrEntries>} */
  let entries;
  try {
    entries = loadAdrEntries(repoRoot);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return errorResult(
      `adr_query: failed to read the ADR corpus — ${message}.`,
    );
  }

  const toRow = (entry) => ({
    id: String(entry.number).padStart(4, "0"),
    title: entry.title,
    status: entry.statusText,
    ...(entry.reviewBy ? { reviewBy: entry.reviewBy } : {}),
  });

  if (id !== undefined) {
    const padded = id.padStart(4, "0");
    const match = entries.find(
      (entry) => String(entry.number).padStart(4, "0") === padded,
    );
    return toolResult({
      results: match ? [toRow(match)] : [],
      total: match ? 1 : 0,
    });
  }

  let matches = entries;
  if (status !== undefined) {
    const needle = status.toLowerCase();
    matches = matches.filter(
      (entry) => entry.statusText.toLowerCase() === needle,
    );
  }
  if (query !== undefined) {
    const needle = query.toLowerCase();
    matches = matches.filter((entry) =>
      entry.title.toLowerCase().includes(needle),
    );
  }
  return toolResult(capResults(matches.map(toRow)));
}

// ---------------------------------------------------------------------------
// logs_query
// ---------------------------------------------------------------------------

/** A work log's title line, e.g. `# Work log — retry (2026-06-29)`. */
const LOG_TITLE_RE = /^#\s+(.+?)\s*$/m;

/**
 * List every work log's date/filename/title — the corpus a transcript scan
 * found the second-most sessions (41) reading in full with no lookup path.
 * Reads only each file's own title line, not its body, so a broad query
 * stays cheap even across the whole corpus (159 files at the time of
 * writing).
 *
 * @param {string} repoRoot
 * @returns {{ date: string, file: string, title: string }[]}
 */
function loadLogEntries(repoRoot) {
  const dir = join(repoRoot, LOGS_DIR_REL);
  const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})-/;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((file) => {
      const dateMatch = FILENAME_DATE_RE.exec(file);
      const content = readFileSync(join(dir, file), "utf8");
      const titleMatch = LOG_TITLE_RE.exec(content);
      return {
        date: dateMatch?.[1] ?? "",
        file,
        title: titleMatch?.[1] ?? file,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Look up work log(s) by exact date or a case-insensitive title-substring
 * topic search.
 *
 * @param {{ date?: unknown, topic?: unknown, limit?: unknown }} args
 * @param {{ root?: string }} [options]
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { logsQuery } from "./mcp-tools.mjs";
 * const result = logsQuery({ topic: "worktree" });
 * ```
 */
export function logsQuery(args, options = {}) {
  const date = typeof args?.date === "string" ? args.date : undefined;
  const topic = typeof args?.topic === "string" ? args.topic : undefined;
  const rawLimit = args?.limit;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== "number" ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1)
  ) {
    return errorResult(
      `logs_query: 'limit' must be a positive integer when provided, got ${JSON.stringify(rawLimit)}.`,
    );
  }
  const limit = rawLimit ?? 25;
  if (date === undefined && topic === undefined) {
    return errorResult(
      `logs_query requires at least one of 'date' or 'topic' — e.g. ` +
        `{ topic: "worktree" } or { date: "2026-09-07" }.`,
    );
  }
  const repoRoot = options.root ?? root;
  /** @type {ReturnType<typeof loadLogEntries>} */
  let entries;
  try {
    entries = loadLogEntries(repoRoot);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return errorResult(
      `logs_query: failed to read the work-log corpus — ${message}.`,
    );
  }

  let matches = entries;
  if (date !== undefined) {
    matches = matches.filter((entry) => entry.date === date);
  }
  if (topic !== undefined) {
    const needle = topic.toLowerCase();
    matches = matches.filter((entry) =>
      entry.title.toLowerCase().includes(needle),
    );
  }
  return toolResult(capResults(matches, limit));
}

// ---------------------------------------------------------------------------
// commands_query
// ---------------------------------------------------------------------------

/**
 * Look up `package.json` script(s) by exact name or a case-insensitive
 * substring over name + description — the demand-ranked query for "which
 * `pnpm` script does X" across the catalog's 111 entries.
 *
 * @param {{ name?: unknown, query?: unknown }} args
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { commandsQuery } from "./mcp-tools.mjs";
 * const result = commandsQuery({ query: "worktree" });
 * ```
 */
export function commandsQuery(args) {
  const name = typeof args?.name === "string" ? args.name : undefined;
  const query = typeof args?.query === "string" ? args.query : undefined;
  if (name === undefined && query === undefined) {
    return errorResult(
      `commands_query requires at least one of 'name' or 'query' — e.g. ` +
        `{ name: "verify" } or { query: "worktree" }.`,
    );
  }
  if (name !== undefined) {
    const match = COMMAND_CATALOG.find((entry) => entry.name === name);
    return toolResult({ results: match ? [match] : [], total: match ? 1 : 0 });
  }
  const needle = /** @type {string} */ (query).toLowerCase();
  const matches = COMMAND_CATALOG.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle),
  );
  return toolResult(capResults(matches));
}

// ---------------------------------------------------------------------------
// hooks_query
// ---------------------------------------------------------------------------

/**
 * Parse `docs/contributing/hooks-reference.md`'s inventory table into one
 * row per (event, hook) with its Purpose and Mode cells — a sibling parser
 * to `bin/check-hooks.mjs`'s `parseHooksReferenceTable`, which deliberately
 * discards those two columns (it only needs `if:`-glob parity, not a
 * queryable purpose). Not shared with that gate: its contract is validation-
 * focused and pinned by its own tests, and duplicating the ~10-line
 * escaped-pipe cell split here is cheaper than coupling a query tool to a
 * gate's row shape.
 *
 * @param {string} markdown
 * @returns {{ event: string, hook: string, purpose: string, mode: string }[]}
 */
function parseHooksTable(markdown) {
  const ESCAPED_PIPE = "\u0000PIPE\u0000";
  /** @type {{ event: string, hook: string, purpose: string, mode: string }[]} */
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/\\\|/g, ESCAPED_PIPE)
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replaceAll(ESCAPED_PIPE, "|"));
    if (cells.length < 5) continue;
    const [event, , hookCell, purpose, mode] = cells;
    if (event === "Event" || /^-+$/.test(event.replace(/\s/g, ""))) continue;
    const hookMatch = hookCell.match(/^`([\w.-]+\.mjs)`$/);
    if (hookMatch === null) continue;
    rows.push({ event, hook: hookMatch[1], purpose, mode });
  }
  return rows;
}

/**
 * Look up hook(s) by exact filename, event name, or a case-insensitive
 * substring over the Purpose column — the demand-ranked query for "what does
 * hook X do" / "what fires on event Y" across the 27-row inventory.
 *
 * @param {{ name?: unknown, event?: unknown, query?: unknown }} args
 * @param {{ root?: string }} [options]
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { hooksQuery } from "./mcp-tools.mjs";
 * const result = hooksQuery({ event: "SessionStart" });
 * ```
 */
export function hooksQuery(args, options = {}) {
  const name = typeof args?.name === "string" ? args.name : undefined;
  const event = typeof args?.event === "string" ? args.event : undefined;
  const query = typeof args?.query === "string" ? args.query : undefined;
  if (name === undefined && event === undefined && query === undefined) {
    return errorResult(
      `hooks_query requires at least one of 'name', 'event', or 'query' — ` +
        `e.g. { name: "guard-branch-isolation.mjs" } or { event: "SessionStart" }.`,
    );
  }
  const repoRoot = options.root ?? root;
  /** @type {ReturnType<typeof parseHooksTable>} */
  let rows;
  try {
    const markdown = readFileSync(
      join(repoRoot, HOOKS_REFERENCE_PATH_REL),
      "utf8",
    );
    rows = parseHooksTable(markdown);
    // A non-empty file that yields zero parsed rows means the table's shape
    // drifted out from under this parser (a re-flowed column, a changed
    // escape convention) — that's a parse failure, not a legitimate "the
    // hooks reference is empty" answer, and must not present as one.
    if (rows.length === 0 && markdown.includes("|")) {
      throw new Error(
        "parsed zero rows from a non-empty file — its table format may have changed",
      );
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return errorResult(
      `hooks_query: failed to read the hooks reference — ${message}.`,
    );
  }

  let matches = rows;
  if (name !== undefined) {
    matches = matches.filter((row) => row.hook === name);
  }
  if (event !== undefined) {
    matches = matches.filter((row) => row.event === event);
  }
  if (query !== undefined) {
    const needle = query.toLowerCase();
    matches = matches.filter((row) =>
      row.purpose.toLowerCase().includes(needle),
    );
  }
  return toolResult(capResults(matches));
}

// ---------------------------------------------------------------------------
// catalog_query (kept from the original server — ADR-0096 Decision)
// ---------------------------------------------------------------------------

/**
 * Answer a targeted lookup against the generated reference index
 * (docs/reference/catalog.json + symbol-map.json) instead of the caller
 * reading either file in full — those two files run to roughly 41k tokens
 * combined as of this rebuild (measured; the original "~11k" estimate was
 * stale by about 4x), so this collapses that into a targeted answer.
 *
 * @param {{ symbol?: unknown, module?: unknown, query?: unknown }} args
 * @param {{ root?: string }} [options]
 * @returns {{ content: { type: "text", text: string }[], isError: boolean }}
 * @example
 * ```js
 * import { catalogQuery } from "./mcp-tools.mjs";
 * const result = catalogQuery({ symbol: "M3LError" });
 * ```
 */
export function catalogQuery(args, options = {}) {
  const symbol = typeof args?.symbol === "string" ? args.symbol : undefined;
  const moduleName = typeof args?.module === "string" ? args.module : undefined;
  const query = typeof args?.query === "string" ? args.query : undefined;
  if (symbol === undefined && moduleName === undefined && query === undefined) {
    return errorResult(
      `catalog_query requires at least one of 'symbol', 'module', or 'query' ` +
        `— e.g. { symbol: "M3LError" } or { query: "retry" }.`,
    );
  }

  const repoRoot = options.root ?? root;
  /** @type {{ namespace: string, name: string, importPath: string, status: string, wired: boolean, docPath: string, symbols: string[] }[]} */
  let catalog;
  /** @type {Record<string, { submodule: string, namespace: string, file: string, lines?: unknown }>} */
  let symbolMap;
  try {
    catalog = JSON.parse(
      readFileSync(join(repoRoot, "docs/reference/catalog.json"), "utf8"),
    );
    symbolMap = JSON.parse(
      readFileSync(join(repoRoot, "docs/reference/symbol-map.json"), "utf8"),
    );
    // A syntactically-valid-but-wrong-shape generated file (e.g. gen:index
    // regressing to emit an object instead of an array) must fail with this
    // function's own actionable message, not an unrelated TypeError from the
    // shape-dependent code below that this try block doesn't otherwise cover.
    if (
      !Array.isArray(catalog) ||
      typeof symbolMap !== "object" ||
      symbolMap === null
    ) {
      throw new Error("reference index has an unexpected shape");
    }
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
    const { total, results, note } = capResults(
      hits.map((s) => ({ symbol: s, ...symbolMap[s] })),
    );
    result.query = { total, symbols: results, ...(note ? { note } : {}) };
  }
  return toolResult(result, false);
}

// ---------------------------------------------------------------------------
// commit_lint (kept from the original server — ADR-0096 Decision)
// ---------------------------------------------------------------------------

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
 * const result = await commitLint({ message: "feat: add widget\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" });
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

// ---------------------------------------------------------------------------
// TOOLS
// ---------------------------------------------------------------------------

/** A `{name, description}` pair — commands_query's/catalog symbol entry shape. */
const NAME_DESCRIPTION_SHAPE = { name: z.string(), description: z.string() };

/**
 * The six registered tools, in server-registration order. Each entry's
 * `config` is passed straight to `McpServer#registerTool` and its `handler`
 * is the exported function above — kept together here so
 * bin/mcp-server.mjs stays a pure registration loop. `needsRoot` tells the
 * registration loop whether to resolve {@link resolveRepoRoot} before
 * calling the handler — `false` for `commands_query` (reads only the
 * in-memory `COMMAND_CATALOG`) and `commit_lint` (validates a string
 * in-process), the two tools that never read a repo file.
 *
 * @type {{ name: string, needsRoot: boolean, config: { title: string, description: string, inputSchema: Record<string, import("zod").ZodTypeAny>, outputSchema: Record<string, import("zod").ZodTypeAny>, annotations: Record<string, boolean> }, handler: (args: Record<string, unknown>, options?: { root?: string }) => unknown }[]}
 */
export const TOOLS = [
  {
    name: "adr_query",
    needsRoot: true,
    config: {
      title: "Query the ADR corpus",
      description:
        'Looks up architecture decision record(s) by exact number (e.g. "0030"), ' +
        'by exact Status (e.g. "Accepted", "Partially-superseded" — case-' +
        "insensitive), or by a case-insensitive substring search over ADR titles, " +
        'without reading any file under docs/adr/ in full. Use it to answer "which ' +
        'ADR governs X" or "is ADR NNNN still Accepted" — this repo\'s own session ' +
        "transcripts show this corpus is the single most frequently fully-read " +
        "artifact in the repo. Pass exactly one of `id`, `status`, or `query`; an " +
        "`id` lookup returns at most one ADR with its Relations-derived reviewBy " +
        "date when present, while `status`/`query` return a capped list of " +
        "matches. It reads the ADR files fresh on every call, reflecting whatever " +
        "is on disk right now — not a cached snapshot.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Exact ADR number, e.g. "0030" (leading zeros optional).'),
        status: z
          .string()
          .optional()
          .describe('Exact Status value, e.g. "Accepted" (case-insensitive).'),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring to search ADR titles for."),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            reviewBy: z.string().optional(),
          }),
        ),
        total: z.number(),
        note: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: adrQuery,
  },
  {
    name: "logs_query",
    needsRoot: true,
    config: {
      title: "Query the work-log corpus",
      description:
        'Looks up work log(s) under docs/logs/ by exact date ("YYYY-MM-DD") or a ' +
        "case-insensitive substring search over log titles, without reading any " +
        "log file in full — this repo's own transcripts show the work-log corpus " +
        "is the second most frequently fully-read artifact in the repo. Returns " +
        "each match's date, filename, and title only (never the log body) so a " +
        "broad topic search stays cheap; read the specific file yourself once " +
        "you've found the one you want. Pass at least one of `date` or `topic`; " +
        "`limit` (default 25) caps the returned matches.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('Exact log date, e.g. "2026-09-07".'),
        topic: z
          .string()
          .optional()
          .describe("Case-insensitive substring to search log titles for."),
        limit: z
          .number()
          .optional()
          .describe("Maximum matches to return (default 25)."),
      },
      outputSchema: {
        results: z.array(
          z.object({ date: z.string(), file: z.string(), title: z.string() }),
        ),
        total: z.number(),
        note: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: logsQuery,
  },
  {
    name: "commands_query",
    needsRoot: false,
    config: {
      title: "Query the pnpm command catalog",
      description:
        'Looks up `pnpm` script(s) by exact name (e.g. "verify") or a case-' +
        "insensitive substring search over script names and descriptions, " +
        "across all 111 entries in package.json's scripts block — use it to " +
        'answer "which pnpm script does X" instead of reading package.json\'s ' +
        "scripts block or bin/lib/command-catalog.mjs in full. Pass at least one " +
        "of `name` or `query`. The catalog is a hand-authored, structurally-gated " +
        "companion to package.json (check:command-catalog fails on any mismatch), " +
        "not a live filesystem scan.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe('Exact package.json script name, e.g. "verify".'),
        query: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to search script names/descriptions for.",
          ),
      },
      outputSchema: {
        results: z.array(z.object(NAME_DESCRIPTION_SHAPE)),
        total: z.number(),
        note: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: commandsQuery,
  },
  {
    name: "hooks_query",
    needsRoot: true,
    config: {
      title: "Query the Claude Code hooks reference",
      description:
        "Looks up wired-hook row(s) from docs/contributing/hooks-reference.md's " +
        '27-row inventory by exact hook filename (e.g. "guard-branch-isolation.mjs"), ' +
        'exact event name (e.g. "SessionStart"), or a case-insensitive substring ' +
        "search over each row's Purpose text — use it to answer \"what does hook X " +
        'do" or "what fires on event Y" instead of reading the reference page in ' +
        "full. Pass at least one of `name`, `event`, or `query`.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe('Exact hook filename, e.g. "guard-branch-isolation.mjs".'),
        event: z
          .string()
          .optional()
          .describe('Exact lifecycle event name, e.g. "SessionStart".'),
        query: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to search each row's Purpose text for.",
          ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            event: z.string(),
            hook: z.string(),
            purpose: z.string(),
            mode: z.string(),
          }),
        ),
        total: z.number(),
        note: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: hooksQuery,
  },
  {
    name: "catalog_query",
    needsRoot: true,
    config: {
      title: "Query the generated symbol/module index",
      description:
        "Looks up submodule/symbol metadata from the generated reference index " +
        "(docs/reference/catalog.json + symbol-map.json) without reading either " +
        "file in full — those two files run to roughly 41k tokens combined as of " +
        "this rebuild, so this tool exists to turn that into a targeted answer. " +
        'Pass exactly one of `symbol` (an exact export name, e.g. "M3LError") for its ' +
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
      outputSchema: {
        symbol: z
          .object({
            symbol: z.string(),
            submodule: z.string(),
            namespace: z.string(),
            file: z.string(),
            lines: z.string().optional(),
          })
          .nullable()
          .optional(),
        module: z
          .array(
            z.object({
              namespace: z.string(),
              name: z.string(),
              importPath: z.string(),
              status: z.string(),
              wired: z.boolean(),
              docPath: z.string(),
              symbols: z.array(z.string()),
            }),
          )
          .nullable()
          .optional(),
        query: z
          .object({
            total: z.number(),
            symbols: z.array(
              z.object({
                symbol: z.string(),
                submodule: z.string(),
                namespace: z.string(),
                file: z.string(),
              }),
            ),
            note: z.string().optional(),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: catalogQuery,
  },
  {
    name: "commit_lint",
    needsRoot: false,
    config: {
      title: "Validate a commit message",
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
      outputSchema: {
        valid: z.boolean(),
        errors: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: commitLint,
  },
];
