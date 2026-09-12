import { Core } from "@m3l-automation/m3l-common";

import type {
  AnalysisDeps,
  AnalysisGatherer,
  AnalysisQueryRequest,
  AnalysisRow,
  RunbookPreset,
} from "../../src/steps/preset.js";
import { createEvidence } from "../../src/steps/preset.js";

/** A gatherer double that records every request and replays queued responses. */
export interface FakeGatherer extends AnalysisGatherer {
  /** Every request the procedure made, in order. */
  readonly requests: AnalysisQueryRequest[];
  /** Queues the rows the next unmatched query resolves with. */
  push(rows: readonly AnalysisRow[]): void;
}

/**
 * Builds a gatherer double. Responses are replayed in queue order; an
 * exhausted queue resolves empty, which is what a "no evidence" path needs.
 */
export function fakeGatherer(
  ...queued: readonly (readonly AnalysisRow[])[]
): FakeGatherer {
  const responses = [...queued];
  const requests: AnalysisQueryRequest[] = [];
  return {
    requests,
    push(rows) {
      responses.push(rows);
    },
    query(request) {
      requests.push(request);
      return Promise.resolve(responses.shift() ?? []);
    },
  };
}

/** A minimal analysable preset: entry query, correlation, signature, no cases. */
export function basePreset(
  overrides: Partial<RunbookPreset> = {},
): RunbookPreset {
  return {
    alarm: "example-alarm",
    title: "Example alarm",
    unsupported: undefined,
    entry: {
      logGroups: ["/example/entry"],
      query: "fields @message | filter level = '%LEVEL%'",
      limit: undefined,
    },
    severityLadder: [],
    severityPlaceholder: undefined,
    window: { leadMinutes: 5, lagMinutes: 15 },
    authorizer: undefined,
    correlation: {
      field: "@message",
      pattern: "id=([\\w-]+)",
      label: "correlation id",
    },
    trace: [],
    signature: {
      field: "@message",
      pattern: undefined,
      levelField: undefined,
      serviceField: undefined,
    },
    cases: [],
    escalateTo: "example-owning-team",
    followUps: [],
    todos: [],
    ...overrides,
  };
}

/** Builds the `deps` bag a procedure run needs, around a gatherer double. */
export function runDeps(
  preset: RunbookPreset,
  gatherer: AnalysisGatherer,
  overrides: Partial<AnalysisDeps> = {},
): AnalysisDeps {
  return {
    preset,
    gatherer,
    logger: new Core.M3LLogger([]),
    prompt: new Core.M3LPrompt(),
    interactive: false,
    maxDepth: 4,
    evidence: createEvidence(),
    ...overrides,
  };
}
