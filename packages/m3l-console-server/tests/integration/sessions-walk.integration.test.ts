/**
 * Integration test for the X6 workbench-sessions module's full acceptance
 * walk (ADR-0068, issue #554): create a session, add a step whose real
 * output is persisted, add a second step whose bindings resolve real values
 * out of the first step's output (both a single-value and a `multiSelect`
 * array reference), raise and answer a decision, close the session — THEN
 * close the underlying store connection entirely and open a FRESH
 * `openConsoleStore` connection against the same on-disk `location`, reopen
 * the session through that fresh connection, and confirm the original step
 * references still resolve through it — proving ADR-0068's "resumable"
 * contract survives genuine on-disk durability across a real close/reopen
 * connection cycle, not merely in-memory service-object continuity within one
 * still-open connection.
 *
 * This is the server-side half of the canonical SQS drill-down scenario
 * (list queues -> dump -> select a value -> bind into the next operation ->
 * decide -> close/reopen -> still resolvable) X11's Playwright suite later
 * exercises end-to-end through the UI.
 *
 * Real collaborators throughout, mirroring `store.integration.test.ts` and
 * `sessions-artifacts.integration.test.ts`'s own real-temp-dir pattern: a
 * real `openConsoleStore` (file-backed SQLite, migrated) supplies the real
 * `M3LConsoleSessionsRepository` via its `.sessions` field, and a real
 * `createSessionArtifactStore` supplies the real
 * `M3LSessionArtifactStore` — both wired into the real `createSessionService`.
 * Only the run launcher is a fake (there is no real script runner in this
 * test), mirroring `sessions-service.test.ts`'s own `launcher.launch` fake.
 * The connection-reopen idiom itself mirrors
 * `store.integration.test.ts`'s "re-opening an existing store" test:
 * `store.close()` then a second `openConsoleStore({ location })` call
 * against the SAME path, proving a fresh connection reads back what a prior,
 * now-closed connection wrote.
 *
 * **Deviation from a literal "drive it through `handleRunEvent`" reading:**
 * the real `handleRunEnded` (`src/sessions/service.ts`) persists ONLY
 * `{ outcome, exitCode }` as a finishing step's artifact payload — there is
 * no channel today for an actual script's rich JSON result to reach that
 * event. To exercise the reference grammar's dotted/bracket-index paths (an
 * array field and a nested object field), step 1's result is instead
 * persisted through the SAME two real, unmocked collaborators
 * `handleRunEnded` itself uses (`artifactStore.put` +
 * `sessionsRepository.finishStep`) — real filesystem I/O, real repository
 * write, just without routing through the fixed-shape `run.ended` event.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { M3LConsoleSessionsConfig } from "../../src/config/sessions.js";
import { createSessionArtifactStore } from "../../src/sessions/artifacts.js";
import { encodeArtifactRef } from "../../src/sessions/artifact-codec.js";
import type { M3LSessionRunLauncherPort } from "../../src/sessions/ports.js";
import { createSessionService } from "../../src/sessions/service.js";
import type { M3LSessionService } from "../../src/sessions/service.js";
import { openConsoleStore } from "../../src/store/store.js";
import type { M3LConsoleStore } from "../../src/store/store.js";

/** A small, deterministic cap fixture — mirrors `sessions-artifacts.integration.test.ts`'s own CONFIG shape. */
const SESSIONS_CONFIG: M3LConsoleSessionsConfig = {
  artifactInlineMaxBytes: 50,
  artifactMaxBytes: 5_000,
  sessionTotalMaxBytes: 100_000,
  openSessionsMax: 10,
};

/** A fake run launcher: every launch immediately reports `"running"` — mirrors `sessions-service.test.ts`'s own default `createFakeLauncher`. There is no real script runner in this test. */
function createFakeLauncher(): M3LSessionRunLauncherPort {
  let counter = 0;
  return {
    launch(request) {
      counter += 1;
      return {
        id: `run-${String(counter)}`,
        scriptName: request.body.scriptName,
        status: "running",
        dryRun: request.body.dryRun,
        executionMode: "spawn",
      };
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "m3l-console-sessions-walk-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sessions walk — create, bind, decide, close, reopen through a FRESH store connection, still resolvable", () => {
  test("the full acceptance walk survives closing the store connection entirely and reopening a fresh one at the same location", async () => {
    const location = join(dir, "sessions.sqlite");
    let store: M3LConsoleStore = openConsoleStore({ location });
    const artifactStore = createSessionArtifactStore({
      root: join(dir, "artifacts"),
      config: SESSIONS_CONFIG,
    });
    const launcher = createFakeLauncher();
    let idCounter = 0;
    const clock = { ms: 1_000 };

    /** Builds a service bound to whichever `store` connection is currently open — rebuilt after the mid-test reconnect. */
    function buildService(): M3LSessionService {
      return createSessionService({
        sessionsRepository: store.sessions,
        artifactStore,
        launcher,
        openSessionsMax: SESSIONS_CONFIG.openSessionsMax,
        newId: () => `id-${String(idCounter++)}`,
        nowMs: () => clock.ms,
      });
    }

    let service = buildService();

    try {
      // 1. Create a session.
      const session = service.createSession("alice", "corr-walk-1");
      expect(session.status).toBe("open");

      // 2. Add step 1 and record its real output — an array field
      // (`queues`) and a nested object field (each queue entry) — through
      // the store's real artifact-persistence collaborators. See this
      // file's headline TSDoc for why this bypasses `handleRunEvent`'s
      // fixed-shape `run.ended` payload.
      const step1Result = await service.addStep(session.id, {
        operation: "scripts/sqs-list-queues",
        bindings: [],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-walk-1",
      });
      const step1Output = {
        queues: [{ name: "q1" }, { name: "q2" }],
      };
      const step1Ref = await artifactStore.put(
        session.id,
        step1Result.step.id,
        step1Output,
        0,
      );
      const finishedStep1 = store.sessions.finishStep(step1Result.step.id, {
        outcome: "success",
        endedAtMs: clock.ms,
        resultRef: encodeArtifactRef(step1Ref),
      });
      expect(finishedStep1).toBe(true);

      // 3. Add step 2 with a single-value binding (a dotted + bracket-index
      // path) and a `multiSelect` array binding, both resolving out of step
      // 1's real persisted output.
      const singleBinding = {
        reference: "step-1.output.queues[0].name",
        expectedType: "string" as const,
        multiSelect: false,
        parameterName: "queueName",
      };
      const multiBinding = {
        reference: "step-1.output.queues",
        expectedType: "object" as const,
        multiSelect: true,
        parameterName: "allQueues",
      };
      const step2Result = await service.addStep(session.id, {
        operation: "scripts/sqs-dump-queue",
        bindings: [singleBinding, multiBinding],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-walk-2",
      });

      expect(launcher).toBeDefined();
      const step2Parameters = step2Result.step.parameters as Record<
        string,
        string
      >;
      expect(step2Parameters["queueName"]).toBe("q1");
      expect(JSON.parse(step2Parameters["allQueues"] ?? "null")).toEqual(
        step1Output.queues,
      );

      // 4. listBindingsForSession returns both persisted bindings.
      const bindingsAfterStep2 = service.listBindingsForSession(session.id);
      expect(bindingsAfterStep2).toHaveLength(2);
      const persistedSingle = bindingsAfterStep2.find(
        (row) => row.reference === singleBinding.reference,
      );
      expect(persistedSingle).toMatchObject({
        sessionId: session.id,
        reference: singleBinding.reference,
        expectedType: "string",
        multiSelect: false,
      });
      const persistedMulti = bindingsAfterStep2.find(
        (row) => row.reference === multiBinding.reference,
      );
      expect(persistedMulti).toMatchObject({
        sessionId: session.id,
        reference: multiBinding.reference,
        expectedType: "object",
        multiSelect: true,
      });

      // 5. Raise a decision on step 2, answer it, confirm the round-trip.
      const decision = service.raiseDecision(
        session.id,
        step2Result.step.id,
        "proceed with queue q1?",
        ["yes", "no"],
      );
      expect(decision.status).toBe("pending");
      const decisionApplied = service.answerDecision(decision.id, "yes");
      expect(decisionApplied).toBe(true);
      const answeredDecision = service
        .listDecisionsForSession(session.id)
        .find((row) => row.id === decision.id);
      expect(answeredDecision).toMatchObject({
        status: "answered",
        answer: "yes",
      });

      // 6. Close the session — still through the ORIGINAL connection.
      expect(service.closeSession(session.id)).toBe(true);
      expect(service.getSession(session.id)?.status).toBe("closed");

      // --- Close this connection ENTIRELY, then open a FRESH connection
      // against the SAME on-disk `location` (mirrors
      // `store.integration.test.ts`'s own "re-opening an existing store"
      // idiom). Every remaining step below runs through the fresh
      // connection's own `M3LConsoleSessionsRepository` — proving real
      // on-disk durability, not merely that the same in-memory service
      // object still remembers what it wrote. ---
      store.close();
      store = openConsoleStore({ location });
      service = buildService();

      // 7. Reopen the session through the FRESH connection — the row
      // written by the original, now-closed connection is read back and
      // transitioned by a service that has never seen it in memory before.
      expect(service.reopenSession(session.id)).toBe(true);
      expect(service.getSession(session.id)?.status).toBe("open");

      // 8. The original step-1 output still resolves correctly through the
      // FRESH connection: a third addStep referencing it again succeeds and
      // resolves to the same value as before the close/reopen-connection
      // cycle — artifact/reference durability survives a genuine
      // disconnect, not just staying alive in one long-lived process.
      const step3Result = await service.addStep(session.id, {
        operation: "scripts/sqs-dump-queue",
        bindings: [singleBinding],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-walk-3",
      });
      const step3Parameters = step3Result.step.parameters as Record<
        string,
        string
      >;
      expect(step3Parameters["queueName"]).toBe("q1");

      // 9. listBindingsForSession, through the fresh connection, still
      // reports all three bindings persisted across both connections.
      const bindingsAfterReopen = service.listBindingsForSession(session.id);
      expect(bindingsAfterReopen).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});
