/**
 * `sessions/service-flow-export` — the `exportFlow` slice of the X6
 * workbench-sessions service, wiring the X13 session-flow-export module's
 * write path (`./flow-export-writer.js`'s `exportSessionFlow`) into
 * {@link M3LSessionService} (issue #561, PR 5/6, Round B).
 *
 * **Why its own file.** Mirrors `sessions/service-reads.ts`'s own rationale:
 * `service.ts` imports this module to assemble the service, so importing its
 * types back would be a `service.ts` to this-file to `service.ts` cycle —
 * and `bin/check-eslint-zones.mjs`'s `no-cycle` guard does not distinguish a
 * type-only edge from a value one.
 *
 * **Why it declares its own dependency type rather than importing
 * `CreateSessionServiceOptions`.** {@link SessionFlowExportDependencies} is
 * the narrow subset `exportFlow` actually needs; the full options object
 * satisfies it structurally, and `service.ts` passing it straight through is
 * the compile-time proof.
 *
 * This is a THIN delegation only: composing the flow document and writing it
 * to disk is entirely `exportSessionFlow`'s job (Round A). This module's own
 * contribution is supplying the injected clock and threading
 * `flowsDirectory` through.
 *
 * @packageDocumentation
 */

import { exportSessionFlow } from "./flow-export-writer.js";
import type { M3LSessionFlowWriteResult } from "./flow-export-writer.js";
import type { M3LSessionFlowExportRequest } from "./flow-export.js";
import type { M3LSessionScriptCatalogPort } from "./ports.js";
import type { M3LConsoleSessionsRepository } from "../store/sessions-repository-types.js";

/**
 * The dependencies {@link buildSessionFlowExportMethods} needs — the narrow
 * subset of `service.ts`'s `CreateSessionServiceOptions` this slice touches.
 *
 * @example
 * ```ts
 * declare const dependencies: SessionFlowExportDependencies;
 * dependencies.sessionsRepository.getSession("session-1");
 * ```
 */
export interface SessionFlowExportDependencies {
  /** The workbench-sessions repository — read-only from this slice's perspective. */
  readonly sessionsRepository: M3LConsoleSessionsRepository;
  /** The script catalog used to screen exported parameter keys for secrecy. */
  readonly scripts: M3LSessionScriptCatalogPort;
  /** The directory the rendered flow document is written into. */
  readonly flowsDirectory: string;
}

/**
 * The `exportFlow` method set {@link buildSessionFlowExportMethods} returns.
 *
 * @example
 * ```ts
 * declare const methods: SessionFlowExportMethods;
 * methods.exportFlow("session-1", { name: "dlq-reconcile" });
 * ```
 */
export interface SessionFlowExportMethods {
  /**
   * Composes `sessionId`'s recorded steps into a flow document and writes it
   * to `<flowsDirectory>/<request.name>.yaml` — a thin delegation to
   * `flow-export-writer.ts`'s `exportSessionFlow`, supplying the injected
   * clock and `dependencies.flowsDirectory`.
   *
   * @param sessionId - The session to export.
   * @param request - The caller's requested flow name/description, plus an
   *   optional `overwrite` flag.
   * @returns The composed result plus the written path.
   * @throws Whatever {@link "./flow-export-writer.js".exportSessionFlow}
   *   throws, unchanged.
   */
  exportFlow(
    sessionId: string,
    request: M3LSessionFlowExportRequest & { readonly overwrite?: boolean },
  ): Promise<M3LSessionFlowWriteResult>;
}

/**
 * Builds the `exportFlow` slice of the session service.
 *
 * @param dependencies - See {@link SessionFlowExportDependencies}.
 * @returns The `exportFlow` method, spread into the service by
 *   `createSessionService`.
 *
 * @example
 * ```ts
 * import { buildSessionFlowExportMethods } from "@m3l-automation/m3l-console-server/sessions/service-flow-export.js";
 *
 * declare const dependencies: Parameters<typeof buildSessionFlowExportMethods>[0];
 * const flowExport = buildSessionFlowExportMethods(dependencies);
 * flowExport.exportFlow("session-1", { name: "dlq-reconcile" });
 * ```
 */
export function buildSessionFlowExportMethods(
  dependencies: SessionFlowExportDependencies,
): SessionFlowExportMethods {
  return {
    exportFlow(
      sessionId: string,
      request: M3LSessionFlowExportRequest & { readonly overwrite?: boolean },
    ): Promise<M3LSessionFlowWriteResult> {
      return exportSessionFlow(
        {
          sessionsRepository: dependencies.sessionsRepository,
          scripts: dependencies.scripts,
          now: () => new Date(),
        },
        dependencies.flowsDirectory,
        sessionId,
        request,
      );
    },
  };
}
