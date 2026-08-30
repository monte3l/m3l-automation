/**
 * `runs/descriptors` — `createScriptCatalog`, the console server's script
 * catalog: an uncached list of every launchable script (`runs/catalog.ts`)
 * plus a per-script `describe` that loads and caches a script's declared
 * config parameters and aggregates their declared operations.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

import { listScriptSummaries, readScriptSummary } from "./catalog.js";
import type { M3LScriptSummary } from "./catalog.js";
import type { RunExecutionMode } from "../store/runs-repository.js";

/**
 * A launchable script's full detail, as returned by
 * `GET /api/v1/scripts/:name`: its {@link M3LScriptSummary} fields plus its
 * declared config parameters and the operations aggregated from them.
 *
 * @example
 * ```ts
 * const detail: M3LScriptDetail = {
 *   name: "sqs-etl",
 *   description: "Extracts data from SQS.",
 *   hasCommandModule: false,
 *   executionMode: "spawn",
 *   parameters: [],
 *   operations: [],
 * };
 * ```
 */
export interface M3LScriptDetail {
  /** The script's kebab-case directory name. */
  readonly name: string;
  /** The script's `package.json` description; see {@link M3LScriptSummary.description}. */
  readonly description: string;
  /** Whether `<scriptDir>/dist/command.js` exists. */
  readonly hasCommandModule: boolean;
  /** The script's execution mode. */
  readonly executionMode: RunExecutionMode;
  /** The script's declared config parameters, verbatim from the loader. */
  readonly parameters: readonly Core.M3LConfigParameterDescriptor[];
  /**
   * The operations declared across `parameters`, de-duplicated by name in
   * first-seen order. `[]` when no parameter declares an operation.
   */
  readonly operations: readonly Core.M3LConfigOperationDescriptor[];
}

/**
 * Constructor options for {@link createScriptCatalog}.
 *
 * @example
 * ```ts
 * const options: M3LScriptCatalogOptions = { scriptsRoot: "/opt/scripts" };
 * ```
 */
export interface M3LScriptCatalogOptions {
  /** The run governor's configured scripts root. */
  readonly scriptsRoot: string;
  /**
   * Injectable descriptor loader; defaults to a wrapper around
   * `Core.loadScriptConfigDescriptors` that busts Node's ESM registry cache
   * (see {@link createScriptCatalog}'s TSDoc for why). Tests inject a stub.
   *
   * @param scriptDirectory - The script's root directory.
   * @param mtimeMs - The resolved config module's mtime, in milliseconds, as
   *   returned by `statSync` — `NaN` when the file vanished between
   *   resolution and stat. Passed through so the default loader's
   *   cache-busting importer can key on it; an injected stub is free to
   *   ignore it.
   */
  readonly loadDescriptors?: (
    scriptDirectory: string,
    mtimeMs: number,
  ) => Promise<readonly Core.M3LConfigParameterDescriptor[]>;
}

/**
 * The console server's script catalog: an uncached `list()` plus a
 * cached-per-mtime `describe()`.
 *
 * @example
 * ```ts
 * declare const catalog: M3LScriptCatalog;
 * const summaries = catalog.list();
 * const detail = await catalog.describe("sqs-etl");
 * ```
 */
export interface M3LScriptCatalog {
  /** Lists every launchable script, ascending by name. Never cached. */
  list(): readonly M3LScriptSummary[];
  /** Describes a single launchable script's parameters and operations. */
  describe(name: string): Promise<M3LScriptDetail>;
}

/** One cached descriptor load, keyed by script name in {@link createScriptCatalog}'s closure. */
interface M3LDescriptorCacheEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly parameters: readonly Core.M3LConfigParameterDescriptor[];
}

/**
 * Aggregates the operations declared across `parameters`, de-duplicated by
 * name in first-seen order — the first parameter to declare a given
 * operation name wins; a later parameter re-declaring the same name is
 * dropped, not merged.
 */
function aggregateOperations(
  parameters: readonly Core.M3LConfigParameterDescriptor[],
): readonly Core.M3LConfigOperationDescriptor[] {
  const seen = new Set<string>();
  const operations: Core.M3LConfigOperationDescriptor[] = [];
  for (const parameter of parameters) {
    for (const operation of parameter.operations) {
      if (!seen.has(operation.name)) {
        seen.add(operation.name);
        operations.push(operation);
      }
    }
  }
  return operations;
}

/**
 * Resolves a script's config module's mtime, in milliseconds.
 *
 * Returns `NaN` when `statSync` throws (the file vanished between the
 * caller's own `resolveConfigModulePath` call and this one) — `NaN !== NaN`
 * under `===`, so a value derived this way can never register as a cache
 * hit against any other value, including a second `NaN` from a later call.
 * That forces the cache to treat the entry as permanently stale, letting the
 * subsequent load surface the real (now-missing-file) failure instead of
 * masking it behind a stale cached result.
 */
function statMtimeMsOrNaN(modulePath: string): number {
  try {
    return fs.statSync(modulePath).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

/**
 * Resolves a script's config module path, mapping a missing module to
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` — the narrow race where the module
 * vanished between `readScriptSummary`'s own internal resolution and this
 * one. Any other thrown value propagates unchanged for the caller's own
 * outer catch to handle.
 */
function resolveModulePathOrNotFound(name: string, scriptDir: string): string {
  try {
    return Core.resolveConfigModulePath(scriptDir).path;
  } catch (cause) {
    if (
      cause instanceof Core.M3LError &&
      cause.code === "ERR_CONFIG_MODULE_NOT_FOUND"
    ) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
        `no launchable script named '${name}'`,
        { cause, context: { name, scriptDir } },
      );
    }
    throw cause;
  }
}

/**
 * Loads (or serves from cache) a script's declared config parameters,
 * keyed on `name` in `cache`. A hit requires both the resolved config
 * module path and its mtime to be unchanged since the last load. On a MISS,
 * `mtimeMs` is forwarded to `loadDescriptors` as its second argument so the
 * default loader (see {@link createDefaultLoadDescriptors}) can bust Node's
 * ESM registry cache — see {@link createScriptCatalog}'s TSDoc for why a
 * cache miss here does NOT by itself guarantee a fresh result without that.
 */
async function loadCachedParameters(
  name: string,
  scriptDir: string,
  loadDescriptors: (
    scriptDirectory: string,
    mtimeMs: number,
  ) => Promise<readonly Core.M3LConfigParameterDescriptor[]>,
  cache: Map<string, M3LDescriptorCacheEntry>,
): Promise<readonly Core.M3LConfigParameterDescriptor[]> {
  const modulePath = resolveModulePathOrNotFound(name, scriptDir);
  const mtimeMs = statMtimeMsOrNaN(modulePath);
  const cached = cache.get(name);
  const parameters =
    cached !== undefined &&
    cached.path === modulePath &&
    cached.mtimeMs === mtimeMs
      ? cached.parameters
      : await loadDescriptors(scriptDir, mtimeMs);

  cache.set(name, { path: modulePath, mtimeMs, parameters });
  return parameters;
}

/**
 * Monotonically increasing token handed out to {@link cacheBustToken} for
 * every non-finite mtime — deliberately module-scoped rather than
 * per-catalog: the ESM registry it defeats is itself process-global, so one
 * global counter is enough to guarantee every non-finite-mtime import gets a
 * distinct cache-busting token for the life of the process, regardless of
 * how many {@link createScriptCatalog} instances are constructed.
 */
let nonFiniteMtimeToken = 0;

/**
 * Builds the query value the default loader appends to a config module's
 * `file://` specifier to defeat Node's ESM registry memoization (see
 * {@link createDefaultLoadDescriptors}).
 *
 * A finite `mtimeMs` is used verbatim: the same mtime means the same file
 * contents (barring a same-mtime edit, an existing accepted gap — see the
 * cache's own TSDoc), so re-using the token is correct and keeps the ESM
 * registry from growing an entry per `describe()` call rather than per
 * distinct mtime.
 *
 * A non-finite `mtimeMs` (the `statSync`-threw `NaN` path — see
 * {@link statMtimeMsOrNaN}) instead draws the next value from
 * {@link nonFiniteMtimeToken}: `NaN` carries no information about *which*
 * vanish this is, so a literal `"NaN"` token would collapse every such call
 * onto one memoized `?mtime=NaN` URL — the exact bug this function exists to
 * avoid. A monotonic counter guarantees distinctness instead.
 */
function cacheBustToken(mtimeMs: number): string {
  return Number.isFinite(mtimeMs)
    ? String(mtimeMs)
    : String(nonFiniteMtimeToken++);
}

/**
 * The default `loadDescriptors` {@link createScriptCatalog} uses when the
 * caller does not inject one: wraps `Core.loadScriptConfigDescriptors`,
 * supplying its own importer (Core's own injection seam, added for exactly
 * this reason) that appends a `?mtime=` cache-busting query — built via
 * {@link cacheBustToken} — to the resolved module's specifier before
 * delegating to a real dynamic `import()`.
 *
 * Without this, Node's ESM module registry memoizes by resolved URL for the
 * whole process lifetime, so a cache MISS on a changed mtime would still
 * hand back the very first module namespace ever imported for that path —
 * silently reverting any remediation (e.g. flipping a parameter's
 * `isSecret`) applied by a rebuild, with no server restart able to detect it
 * from outside. See `docs/reference/console.md`'s known-limits section for
 * the accepted cost: every distinct mtime leaves a permanent entry in the
 * ESM registry, since an imported module can never be unloaded.
 */
async function createDefaultLoadDescriptors(
  scriptDirectory: string,
  mtimeMs: number,
): Promise<readonly Core.M3LConfigParameterDescriptor[]> {
  const token = cacheBustToken(mtimeMs);
  return Core.loadScriptConfigDescriptors(
    scriptDirectory,
    async (specifier: string): Promise<unknown> =>
      import(`${specifier}?mtime=${token}`) as Promise<unknown>,
  );
}

/**
 * Builds a {@link M3LScriptCatalog} over `options.scriptsRoot`.
 *
 * `list()` delegates straight to `listScriptSummaries` and is deliberately
 * uncached — enumerating a handful of directories is cheap, and caching it
 * would hide a script that was just scaffolded.
 *
 * `describe(name)` resolves and validates `name` via `readScriptSummary`
 * (propagating its `"ERR_CONSOLE_BAD_REQUEST"` /
 * `"ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"` unchanged), then loads the script's
 * declared config parameters through `options.loadDescriptors`, caching the
 * result per script name keyed on BOTH the resolved config module's path
 * and its mtime — a cache hit requires both to be unchanged, since a freshly
 * built `dist/config.js` overtaking a stale `src/config.ts` changes the
 * resolved path even when a naive mtime-only cache would see no difference.
 * A MISS does not by itself guarantee a fresh result: the default loader
 * (see {@link createDefaultLoadDescriptors}) must also defeat Node's ESM
 * registry memoization, or a rebuilt module can still resolve to the first
 * namespace ever imported for that path — see its own TSDoc.
 *
 * @param options - See {@link M3LScriptCatalogOptions}.
 * @returns The wired {@link M3LScriptCatalog}.
 * @throws {@link M3LConsoleError} — see {@link M3LScriptCatalog.describe}'s
 *   own TSDoc for `describe`'s full error-mapping table.
 *
 * @example
 * ```ts
 * import { createScriptCatalog } from "@m3l-automation/m3l-console-server/runs/descriptors.js";
 *
 * const catalog = createScriptCatalog({ scriptsRoot: "/opt/scripts" });
 * const detail = await catalog.describe("sqs-etl");
 * ```
 */
export function createScriptCatalog(
  options: M3LScriptCatalogOptions,
): M3LScriptCatalog {
  const { scriptsRoot } = options;
  const loadDescriptors =
    options.loadDescriptors ?? createDefaultLoadDescriptors;
  const cache = new Map<string, M3LDescriptorCacheEntry>();

  return {
    list(): readonly M3LScriptSummary[] {
      return listScriptSummaries(scriptsRoot);
    },

    async describe(name: string): Promise<M3LScriptDetail> {
      const summary = readScriptSummary(name, scriptsRoot);
      const scriptDir = path.join(scriptsRoot, name);

      try {
        const parameters = await loadCachedParameters(
          name,
          scriptDir,
          loadDescriptors,
          cache,
        );

        return {
          name: summary.name,
          description: summary.description,
          hasCommandModule: summary.hasCommandModule,
          executionMode: summary.executionMode,
          parameters,
          operations: aggregateOperations(parameters),
        };
      } catch (cause) {
        if (cause instanceof M3LConsoleError) {
          throw cause;
        }
        // Core.loadScriptConfigDescriptors calls resolveConfigModulePath a
        // SECOND time internally, deliberately outside its own try/catch
        // (see its TSDoc), so ERR_CONFIG_MODULE_NOT_FOUND from that second
        // window propagates here as a bare Core.M3LError rather than an
        // M3LConsoleError. It maps to the same caller-facing 404 as
        // resolveModulePathOrNotFound's own first-window race (Fix D) —
        // every other Core.M3LError code falls through to the generic 500
        // below.
        if (
          cause instanceof Core.M3LError &&
          cause.code === "ERR_CONFIG_MODULE_NOT_FOUND"
        ) {
          throw new M3LConsoleError(
            "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
            `no launchable script named '${name}'`,
            { cause, context: { name, scriptDir } },
          );
        }
        throw new M3LConsoleError(
          "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
          `failed to introspect script '${name}'`,
          { cause, context: { name, scriptDir } },
        );
      }
    },
  };
}
