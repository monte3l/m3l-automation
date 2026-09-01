/**
 * `flow/load` — the I/O half of the `m3l flow` definition format: listing the
 * workspace's flows and reading one into a validated definition.
 *
 * Every judgement about a document's content belongs to `flow/validate`; this
 * module only resolves paths, reads bytes (through
 * `Core.M3LYAMLConfigProvider`, never a YAML parser directly) and classifies
 * the two failures that are about the *file* rather than its content: the flow
 * does not exist, or it could not be read at all.
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";
import { suggestNames } from "../cli/suggest.js";
import { validateFlowDefinition } from "./validate.js";
import type { M3LCliFlowValidationContext } from "./validate.js";
import type { M3LCliFlowDefinition } from "./types.js";

/**
 * The only extension a flow definition may carry. Single-valued on purpose:
 * every extension {@link listFlows} reports must be one {@link
 * loadFlowDefinition} can actually resolve, or a suggestion would name a flow
 * that then fails to load.
 */
const FLOW_EXTENSION = ".yaml";

/**
 * Resolves the workspace's flows directory:
 * `<workspaceRoot>/data/config/flows`.
 *
 * @param workspaceRoot - The resolved workspace root.
 * @returns The flows directory's absolute path.
 */
function flowsDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, "data", "config", "flows");
}

/**
 * Lists the workspace's flow names — every `<name>.yaml` in
 * `data/config/flows`, extension stripped, sorted by name.
 *
 * Deliberately does not read or parse a single listed file: listing is a
 * suggestion pool and a `m3l flow list` surface, so one malformed definition
 * must not make every other flow unlistable.
 *
 * @param workspaceRoot - The resolved workspace root.
 * @returns The flow names, sorted; `[]` when the flows directory does not
 *   exist or holds no `.yaml` file.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_READ_FAILED` when the
 *   directory exists but cannot be listed (a permission failure, chained as
 *   `cause`) — an unreadable directory is a machine-side fault, not an empty
 *   one.
 *
 * @example
 * ```ts
 * const names = listFlows("/repo");
 * // ["dlq-reconcile", "nightly-export"]
 * ```
 */
export function listFlows(workspaceRoot: string): readonly string[] {
  const directory = flowsDirectory(workspaceRoot);
  if (!existsSync(directory)) {
    return [];
  }

  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_FLOW_READ_FAILED",
      `failed to list flow definitions in '${directory}'`,
      { cause },
    );
  }

  return entries
    .filter(
      (entry) =>
        entry.length > FLOW_EXTENSION.length && entry.endsWith(FLOW_EXTENSION),
    )
    .map((entry) => entry.slice(0, entry.length - FLOW_EXTENSION.length))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Reads `filePath` as a YAML mapping and projects it back to a plain record
 * carrying every key the document declares — not just the keys the format
 * knows — so `flow/validate` can reject an unrecognized one.
 *
 * `Object.fromEntries` defines own data properties, so a key that somehow
 * reached here could not reassign the result's prototype; in practice
 * `Core.M3LYAMLConfigProvider` has already rejected every dangerous top-level
 * key at construction, which is why that rejection is caught and re-thrown
 * below rather than pre-empted.
 *
 * @param filePath - The flow file's absolute path.
 * @returns The document's top-level keys and raw values.
 * @throws {@link M3LCliError} coded `ERR_CLI_FLOW_INVALID` when the cause is
 *   an authoring fault — malformed YAML ({@link Core.M3LConfigParseError}) or
 *   a prototype-pollution key ({@link Core.M3LUnsafeConfigKeyError}); coded
 *   `ERR_CLI_FLOW_READ_FAILED` for anything else (e.g. `EACCES`/`EIO`
 *   reading the file), since that is a fault in the machine, not the
 *   definition.
 */
function readFlowRecord(filePath: string): Record<string, unknown> {
  try {
    const provider = new Core.M3LYAMLConfigProvider(filePath);
    return Object.fromEntries(
      provider.rawKeys().map((key) => [key, provider.getRawValue(key)]),
    );
  } catch (cause) {
    const isAuthoringFault =
      cause instanceof Core.M3LConfigParseError ||
      cause instanceof Core.M3LUnsafeConfigKeyError;
    throw new M3LCliError(
      isAuthoringFault ? "ERR_CLI_FLOW_INVALID" : "ERR_CLI_FLOW_READ_FAILED",
      `failed to read flow definition '${filePath}'`,
      { cause },
    );
  }
}

/**
 * Loads, reads and validates the flow named `name` from
 * `<workspaceRoot>/data/config/flows/<name>.yaml`.
 *
 * Existence is settled FIRST, and settled against {@link listFlows} rather
 * than a direct path probe. Two reasons: `Core.M3LYAMLConfigProvider` treats a
 * missing file as an empty mapping, so without an existence check a misspelled
 * flow would surface as a definition complaining about a missing `steps` key
 * instead of as an unknown flow with suggestions; and resolving `name` through
 * the listing means only an already-listed filename stem can ever reach
 * `join`, so no `name` can address a file outside the flows directory.
 *
 * @param workspaceRoot - The resolved workspace root.
 * @param name - The flow's name (its filename stem).
 * @param context - The injected script knowledge the definition is validated
 *   against.
 * @returns The validated flow definition.
 * @throws {@link M3LCliError} coded `ERR_CLI_UNKNOWN_FLOW` when no
 *   `<name>.yaml` exists, carrying near-miss `suggestions` from the flows
 *   that do; coded `ERR_CLI_FLOW_INVALID` when the file is malformed YAML or
 *   contains a prototype-pollution key, or when its content breaks a format
 *   rule; coded `ERR_CLI_FLOW_READ_FAILED` when the file exists but could not
 *   be read at all (a machine-side fault, chained as `cause`).
 *
 * @example
 * ```ts
 * const definition = loadFlowDefinition("/repo", "dlq-reconcile", {
 *   parametersByScript: new Map([["json-etl", ["input", "output"]]]),
 * });
 * ```
 */
export function loadFlowDefinition(
  workspaceRoot: string,
  name: string,
  context: M3LCliFlowValidationContext,
): M3LCliFlowDefinition {
  const available = listFlows(workspaceRoot);
  if (!available.includes(name)) {
    throw new M3LCliError(
      "ERR_CLI_UNKNOWN_FLOW",
      `unknown flow '${name}' — no '${name}${FLOW_EXTENSION}' in '${flowsDirectory(workspaceRoot)}'`,
      { suggestions: suggestNames(name, available) },
    );
  }

  const filePath = join(
    flowsDirectory(workspaceRoot),
    `${name}${FLOW_EXTENSION}`,
  );
  return validateFlowDefinition(readFlowRecord(filePath), name, context);
}
