/**
 * `sessions/flow-export-writer` — `exportSessionFlow`, the X13
 * session-flow-export module's I/O layer (issue #561, PR 5/6).
 *
 * `sessions/flow-export.ts`'s `buildSessionFlowExport` is a pure domain
 * composition: it reads the session store and the script catalog and
 * returns a rendered YAML string, but it never touches the filesystem. This
 * module is the thin write-side wrapper around it — the same
 * compose-then-persist split `sessions/artifacts.ts` draws between its own
 * pure encode/decode helpers and `put`/`readArtifact`'s actual I/O. Keeping
 * the split means `buildSessionFlowExport`'s tests never need a real
 * filesystem, while this module's tests exercise a real `mkdtemp` sandbox
 * for exactly the parts that touch one.
 *
 * Built entirely on the `sessions` zone's own allowance (`sessions`,
 * `errors`, `store`), same as `flow-export.ts` itself.
 *
 * @packageDocumentation
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { M3LConsoleError } from "../errors/console-error.js";
import { errnoCodeOf } from "../errors/errno.js";

import type {
  M3LSessionFlowExportRequest,
  M3LSessionFlowExportResult,
  SessionFlowExportDependencies,
} from "./flow-export.js";
import { buildSessionFlowExport } from "./flow-export.js";

/**
 * The result of a successful {@link exportSessionFlow} call: everything
 * {@link M3LSessionFlowExportResult} carries, plus the absolute path the
 * flow document was written to.
 *
 * @example
 * ```ts
 * const result: M3LSessionFlowWriteResult = {
 *   name: "dlq-reconcile",
 *   yaml: "name: dlq-reconcile\nsteps: []\n",
 *   steps: [],
 *   decisionsDropped: 0,
 *   path: "/data/config/flows/dlq-reconcile.yaml",
 * };
 * ```
 */
export interface M3LSessionFlowWriteResult extends M3LSessionFlowExportResult {
  /** The absolute path the rendered flow document was written to. */
  readonly path: string;
}

/**
 * Composes `sessionId`'s recorded steps into a flow document (via
 * {@link buildSessionFlowExport}) and writes it to
 * `<flowsDirectory>/<request.name>.yaml`.
 *
 * Composition runs FIRST: when `buildSessionFlowExport` throws — an empty
 * session, a secret parameter, an invalid name — the failure propagates
 * unchanged and nothing is written to disk. Only once composition succeeds
 * does this function create `flowsDirectory` (recursively, if needed) and
 * write the file.
 *
 * The write is exclusive-create (`"wx"`) by default, so a caller cannot
 * silently clobber an existing flow file. Passing `request.overwrite: true`
 * switches the write to replace (`"w"`) instead. An `EEXIST` from the
 * exclusive-create path is reported as {@link M3LConsoleError}
 * `"ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS"`, chaining the original error as
 * `cause`; the pre-existing file is left untouched. Any other `mkdir`/write
 * failure is reported as `"ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID"`.
 *
 * @param dependencies - The repository and script catalog `buildSessionFlowExport` reads from.
 * @param flowsDirectory - The directory the flow document is written into (see `config/paths.ts`'s `resolveFlowsDirectory`).
 * @param sessionId - The session to export.
 * @param request - The caller's requested flow name/description, plus an optional `overwrite` flag.
 * @returns The composed {@link M3LSessionFlowExportResult} plus the written `path`.
 * @throws Whatever {@link buildSessionFlowExport} throws, unchanged, when composition fails.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS` — when the target file already exists and `request.overwrite` is not `true`.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID` — for any other directory-creation or write failure.
 *
 * @example
 * ```ts
 * import { exportSessionFlow } from "@m3l-automation/m3l-console-server/sessions/flow-export-writer";
 *
 * const result = await exportSessionFlow(
 *   { sessionsRepository, scripts, now: () => new Date() },
 *   "/data/config/flows",
 *   "session-1",
 *   { name: "dlq-reconcile" },
 * );
 * ```
 */
export async function exportSessionFlow(
  dependencies: SessionFlowExportDependencies,
  flowsDirectory: string,
  sessionId: string,
  request: M3LSessionFlowExportRequest & { readonly overwrite?: boolean },
): Promise<M3LSessionFlowWriteResult> {
  const result = await buildSessionFlowExport(dependencies, sessionId, request);

  const targetPath = join(flowsDirectory, `${result.name}.yaml`);
  const flag = request.overwrite === true ? "w" : "wx";

  try {
    await mkdir(flowsDirectory, { recursive: true });
    await writeFile(targetPath, result.yaml, { encoding: "utf8", flag });
  } catch (cause) {
    if (errnoCodeOf(cause) === "EEXIST") {
      throw new M3LConsoleError(
        "ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS",
        `a flow file already exists at "${targetPath}"`,
        { cause },
      );
    }
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID",
      `failed to write flow export to "${targetPath}"`,
      { cause },
    );
  }

  return { ...result, path: targetPath };
}
