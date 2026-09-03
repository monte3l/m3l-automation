/**
 * `sessions/service-bindings` — X7d's standalone binding selection: an
 * operator picks a value out of a prior step's recorded output and names it,
 * without launching anything.
 *
 * `addStep` has always created bindings, but only as a side effect of
 * launching a run (`resolveAndPersistBindings` in `sessions/service.ts`).
 * That is the wrong shape for a drill-down UI, where selecting a value and
 * deciding what to do with it are separate operator acts, possibly minutes
 * apart. This module is the server surface for the first of them.
 *
 * **Scope boundary with X11.** This is the SERVER seam only. The JSON tree
 * viewer, the pre-filled next operation and the decision prompts remain
 * X11's, along with its Playwright acceptance — nothing here builds any of
 * them.
 *
 * The validation is not a second implementation: {@link selectBinding}
 * resolves through `launch-parameters.ts`'s `resolveBindingValue`, the same
 * function the inline `addStep` path uses, so a reference that would be
 * rejected there is rejected identically here.
 *
 * Declares its own narrow dependency type rather than importing
 * `service.ts`'s, for the reason `service-reads.ts` gives: `service.ts`
 * imports THIS module, and `check:zones`' no-cycle guard does not
 * distinguish a type-only edge.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingRecord,
} from "../store/sessions-repository.js";

import type { M3LSessionArtifactStore } from "./artifacts.js";
import type { M3LSessionAddStepBinding } from "./launch-parameters.js";
import { resolveBindingValue } from "./launch-parameters.js";

/**
 * The dependencies binding selection needs — the narrow subset of
 * `service.ts`'s `CreateSessionServiceOptions` this module touches.
 *
 * @example
 * ```ts
 * declare const dependencies: SessionBindingDependencies;
 * dependencies.newId();
 * ```
 */
export interface SessionBindingDependencies {
  /** The workbench-sessions repository. */
  readonly sessionsRepository: M3LConsoleSessionsRepository;
  /** The step-output artifact store the reference is resolved against. */
  readonly artifactStore: M3LSessionArtifactStore;
  /** Generates the new binding's id. */
  readonly newId: () => string;
  /** The current time, in epoch milliseconds — injected for determinism. */
  readonly nowMs: () => number;
}

/**
 * The binding-selection method set {@link buildSessionBindingMethods}
 * returns.
 *
 * @example
 * ```ts
 * declare const bindings: SessionBindingMethods;
 * bindings.selectBinding("session-1", {
 *   reference: "step-1.output.Queues[0]",
 *   expectedType: "string",
 *   multiSelect: false,
 *   parameterName: "queueUrl",
 * });
 * ```
 */
export interface SessionBindingMethods {
  /**
   * Records an operator's selection of `binding`'s referenced value as a
   * named binding on `sessionId` (X7d).
   *
   * The reference is RESOLVED before anything is persisted — against the
   * referenced step's real recorded output, through the same
   * `resolveBindingValue` the inline `addStep` path uses. A binding that
   * points at a step with no output yet, or whose value does not match its
   * declared `expectedType`/`multiSelect`, is refused rather than stored: a
   * binding trail whose entries were never resolvable would be worse than
   * no trail.
   *
   * The resolved VALUE is deliberately not returned and not stored — only
   * the reference is. `console_session_bindings` has no value column, and
   * adding one would put arbitrary step output into a table whose whole
   * purpose is to record what an operator pointed at (ADR-0070's
   * display-vs-persist split). A caller that wants the value reads it
   * through the step-artifact route.
   *
   * `binding.parameterName` is persisted alongside the reference (X11 slice
   * 1, issue #559): it is the launch-parameter name the resolved value binds
   * to, so a session reload/resume can pre-fill it without the operator
   * re-selecting.
   *
   * @param sessionId - The session to record the binding on.
   * @param binding - The selection: reference, expected shape, and name.
   * @returns The persisted {@link M3LSessionBindingRecord}.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_NOT_FOUND"`
   *   when `sessionId` names no session.
   * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_SESSION_CLOSED"`
   *   when the session is not `open` — a closed session takes no new
   *   bindings, exactly as it takes no new steps.
   * @throws {@link M3LConsoleError} with code
   *   `"ERR_CONSOLE_SESSION_STEP_NOT_FOUND"` when the reference names an
   *   ordinal with no step in this session, or
   *   `"ERR_CONSOLE_SESSION_REFERENCE_INVALID"` when it is malformed, names a
   *   step with no recorded result, or resolves to a value of the wrong
   *   shape — all propagated unchanged from `resolveBindingValue`.
   */
  selectBinding(
    sessionId: string,
    binding: M3LSessionAddStepBinding,
  ): Promise<M3LSessionBindingRecord>;
}

/**
 * Throws unless `sessionId` names an OPEN session.
 *
 * A local copy of `service.ts`'s two guards rather than a shared import, for
 * the cycle reason in this module's header. Both are one repository read, and
 * `tests/sessions-service-bindings.test.ts` drives them through the public
 * method — a divergence would fail there.
 */
function assertSessionOpen(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
): void {
  const session = sessionsRepository.getSession(sessionId);
  if (session === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
      `no session found with id "${sessionId}"`,
    );
  }
  if (session.status !== "open") {
    throw new M3LConsoleError(
      "ERR_CONSOLE_SESSION_CLOSED",
      `session "${sessionId}" is not open`,
    );
  }
}

/**
 * Reads back a just-inserted binding, throwing a genuine internal defect if
 * it is somehow absent — mirrors `service.ts`'s own `requireStep`.
 */
function requireBinding(
  sessionsRepository: M3LConsoleSessionsRepository,
  sessionId: string,
  bindingId: string,
): M3LSessionBindingRecord {
  const record = sessionsRepository
    .listBindingsForSession(sessionId)
    .find((candidate) => candidate.id === bindingId);
  if (record === undefined) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `binding "${bindingId}" vanished immediately after insert`,
    );
  }
  return record;
}

/**
 * Builds the binding-selection slice of the session service.
 *
 * @param dependencies - See {@link SessionBindingDependencies}.
 * @returns The binding methods, spread into the service by
 *   `createSessionService`.
 *
 * @example
 * ```ts
 * import { buildSessionBindingMethods } from "@m3l-automation/m3l-console-server/sessions/service-bindings.js";
 *
 * declare const dependencies: SessionBindingDependencies;
 * const bindings = buildSessionBindingMethods(dependencies);
 * ```
 */
export function buildSessionBindingMethods(
  dependencies: SessionBindingDependencies,
): SessionBindingMethods {
  const { sessionsRepository, artifactStore, newId, nowMs } = dependencies;

  return {
    async selectBinding(
      sessionId: string,
      binding: M3LSessionAddStepBinding,
    ): Promise<M3LSessionBindingRecord> {
      assertSessionOpen(sessionsRepository, sessionId);
      // Resolve FIRST. Persisting a reference that cannot be resolved would
      // put an entry in the operator's binding trail that never pointed at
      // anything.
      await resolveBindingValue(
        sessionsRepository,
        artifactStore,
        sessionId,
        binding,
      );
      const id = newId();
      sessionsRepository.insertBinding({
        id,
        sessionId,
        reference: binding.reference,
        expectedType: binding.expectedType,
        multiSelect: binding.multiSelect,
        createdAtMs: nowMs(),
        parameterName: binding.parameterName,
      });
      return requireBinding(sessionsRepository, sessionId, id);
    },
  };
}
