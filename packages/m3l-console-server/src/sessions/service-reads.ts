/**
 * `sessions/service-reads` — the READ-ONLY slice of the X6 workbench-sessions
 * service: a session's persisted binding trail, and (X7d) one step's stored
 * output artifact.
 *
 * **Why its own file.** `sessions/service.ts` sits near `check:file-budget`'s
 * 25,000-char ceiling, and X7d adds surface to it twice. These two methods
 * also genuinely belong together: neither writes anything, both are pure
 * lookups guarded by session ownership, and both are what an operator's
 * drill-down UI reads (X11).
 *
 * **Why it declares its own options type rather than importing
 * `CreateSessionServiceOptions`.** `service.ts` imports THIS module to
 * assemble the service, so importing its types back would be a cycle — and
 * `bin/check-eslint-zones.mjs` asserts a `no-cycle` guard that does not
 * distinguish a type-only edge. {@link SessionReadDependencies} is the narrow
 * subset these two methods actually use; the full options object satisfies it
 * structurally, and `service.ts` passing it is the compile-time proof.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingRecord,
  M3LSessionStepRecord,
} from "../store/sessions-repository.js";

import type { M3LSessionArtifactStore } from "./artifacts.js";
import { decodeArtifactRef } from "./artifacts.js";

/**
 * One step, redacted for a LIST response: every `M3LSessionStepRecord` field
 * except `resultRef`, plus `hasResult`.
 *
 * **Why `resultRef` is dropped.** It is the step's ENCODED artifact
 * reference — for an inline artifact (`sessions/artifacts.ts`'s
 * `encodeArtifactRef`/{@link M3LSessionArtifactRef}) it literally embeds the
 * resolved VALUE, so it must never appear in a step LIST response. The
 * sanctioned read path for a step's value is the existing
 * `GET .../steps/:stepId/artifact` route, served by
 * {@link SessionReadMethods.readStepArtifact} on this same interface — this
 * mirrors the "no resolved VALUE" boundary {@link SessionReadMethods.listBindingsForSession}'s
 * own TSDoc already describes for bindings, just for a field that (unlike
 * bindings) genuinely has a column to redact.
 *
 * **The redaction is enforced by the TYPE, not just by convention.** An
 * `Omit` of `resultRef` alone still permits a value that happens to carry a
 * `resultRef` property to be assignable — the "no raw `resultRef` reaches
 * this type" invariant would otherwise live only in {@link toStepSummary}'s
 * implementation. The trailing `never`-typed `resultRef` field below closes
 * that gap: no value with a present `resultRef` can satisfy this type,
 * mirroring `store/sessions-repository-types.ts`'s
 * `M3LSessionDecisionRecord` pending variant's own `never`-typed `answer`
 * field.
 *
 * @example
 * ```ts
 * declare const summary: M3LSessionStepSummary;
 * summary.hasResult; // true once the step has a recorded output
 * ```
 */
export type M3LSessionStepSummary = Omit<M3LSessionStepRecord, "resultRef"> & {
  /** `true` when the step has a recorded output artifact. */
  readonly hasResult: boolean;
  /** Never present — see this type's own TSDoc for why the redaction is type-enforced. */
  readonly resultRef?: never;
};

/**
 * The dependencies the read-only service methods need — the narrow subset of
 * `service.ts`'s `CreateSessionServiceOptions` these two methods touch.
 *
 * @example
 * ```ts
 * declare const dependencies: SessionReadDependencies;
 * dependencies.sessionsRepository.getSession("session-1");
 * ```
 */
export interface SessionReadDependencies {
  /** The workbench-sessions repository. */
  readonly sessionsRepository: M3LConsoleSessionsRepository;
  /** The step-output artifact store. */
  readonly artifactStore: M3LSessionArtifactStore;
}

/**
 * The read-only method set {@link buildSessionReadMethods} returns.
 *
 * @example
 * ```ts
 * declare const reads: SessionReadMethods;
 * reads.listBindingsForSession("session-1");
 * ```
 */
export interface SessionReadMethods {
  /**
   * Lists every binding persisted for `sessionId` via a prior `addStep` call.
   *
   * @param sessionId - The owning session's id.
   * @returns The session's binding rows, created-ascending.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   */
  listBindingsForSession(sessionId: string): readonly M3LSessionBindingRecord[];
  /**
   * Lists every step recorded for `sessionId`, ordinal-ascending, with each
   * step's `resultRef` redacted to a `hasResult` boolean (X11) — see
   * {@link M3LSessionStepSummary} for why.
   *
   * @param sessionId - The owning session's id.
   * @returns The session's step summaries, ordinal-ascending.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   */
  listStepsForSession(sessionId: string): readonly M3LSessionStepSummary[];
  /**
   * Resolves one step's recorded output artifact back to its value (X7d).
   *
   * Delegates the whole trust question to
   * {@link M3LSessionArtifactStore.readArtifact}, which re-verifies the
   * reference's shape, its size cap and — for a file-backed artifact — its
   * SHA-256 digest on EVERY read. This method adds only the ownership guard:
   * a step is readable through the session that owns it, never through
   * another.
   *
   * @param sessionId - The owning session's id.
   * @param stepId - The step whose output to read.
   * @returns The artifact's value.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_STEP_NOT_FOUND"` when `stepId` names no step, when
   *   it names a step belonging to a DIFFERENT session (indistinguishable
   *   from "not found" — the error never reveals which session owns it), or
   *   when the step has no recorded result yet.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"` or
   *   `"ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"`, propagated unchanged from
   *   `decodeArtifactRef`/`readArtifact`.
   */
  readStepArtifact(sessionId: string, stepId: string): Promise<unknown>;
}

/**
 * Throws `ERR_CONSOLE_SESSION_NOT_FOUND` when `sessionId` names no session.
 *
 * A local copy of `service.ts`'s own guard rather than a shared import, for
 * the cycle reason in this module's header. It is two lines over one
 * repository call, and `tests/sessions-service.test.ts` drives both copies
 * through the same public methods — a divergence would fail there.
 */
function assertSessionExists(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
): void {
  if (sessionsRepository.getSession(sessionId) === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      `no session found with id "${sessionId}"`,
    );
  }
}

/**
 * Redacts one step record for a LIST response — see
 * {@link M3LSessionStepSummary} for why `resultRef` cannot survive.
 */
function toStepSummary(step: M3LSessionStepRecord): M3LSessionStepSummary {
  const { resultRef, ...rest } = step;
  return { ...rest, hasResult: resultRef !== undefined };
}

/**
 * Reads `stepId`'s encoded `resultRef`, having first confirmed the step
 * exists AND belongs to `sessionId`.
 *
 * The ownership check and the "not found" check raise the SAME error with
 * the same message on purpose: a caller probing step ids must not be able to
 * learn that an id exists under some other session, which a distinguishable
 * response would tell them. Mirrors `service.ts`'s `raiseDecision`.
 */
function requireResultRef(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
  stepId: string,
): string {
  const step = sessionsRepository.getStep(stepId);
  if (step === undefined || step.sessionId !== sessionId) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
      `no step found with id "${stepId}"`,
    );
  }
  if (step.resultRef === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
      `step "${stepId}" has no recorded output yet`,
    );
  }
  return step.resultRef;
}

/**
 * Builds the read-only slice of the session service.
 *
 * @param dependencies - See {@link SessionReadDependencies}.
 * @returns The read-only methods, spread into the service by
 *   `createSessionService`.
 *
 * @example
 * ```ts
 * import { buildSessionReadMethods } from "@m3l-automation/m3l-console-server/sessions/service-reads.js";
 *
 * declare const dependencies: SessionReadDependencies;
 * const reads = buildSessionReadMethods(dependencies);
 * ```
 */
export function buildSessionReadMethods(
  dependencies: SessionReadDependencies,
): SessionReadMethods {
  const { sessionsRepository, artifactStore } = dependencies;

  return {
    listBindingsForSession(
      sessionId: string,
    ): readonly M3LSessionBindingRecord[] {
      assertSessionExists(sessionsRepository, sessionId);
      return sessionsRepository.listBindingsForSession(sessionId);
    },
    listStepsForSession(sessionId: string): readonly M3LSessionStepSummary[] {
      assertSessionExists(sessionsRepository, sessionId);
      return sessionsRepository
        .listStepsForSession(sessionId)
        .map(toStepSummary);
    },
    readStepArtifact(sessionId: string, stepId: string): Promise<unknown> {
      assertSessionExists(sessionsRepository, sessionId);
      const resultRef = requireResultRef(sessionsRepository, sessionId, stepId);
      return artifactStore.readArtifact(decodeArtifactRef(resultRef));
    },
  };
}
