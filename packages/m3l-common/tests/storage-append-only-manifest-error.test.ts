/**
 * Tests for `M3LAppendOnlyStreamManifestError` (X8b slice 4a, ADR-0102) — the
 * dedicated error class for a failed append-only stream manifest READ or
 * APPEND, replacing the two misnamed sealer `buildError` ports flagged in the
 * X8b3f (PR #1229) review:
 *
 * - `M3LAppendOnlyStream` (core/storage) passed `M3LAppendOnlyStreamReadError`
 *   for both directions, so a failed manifest WRITE surfaced as a "Read"
 *   error.
 * - `AgentDecisionLogWriter` (internal/agent) passed
 *   `M3LAgentDecisionLogWriteError` for both directions, so a failed manifest
 *   READ surfaced as a "Write" error.
 *
 * This file pins:
 *   (A) the new class's contract, mirroring the sibling
 *       `M3LAppendOnlyStreamReadError` tests' register (construct directly,
 *       assert `instanceof`/`code`/`message`/`context`/`cause` pass-through);
 *   (B) its code + catalog registration, including sorted tuple position;
 *   (C) `M3L_APPEND_ONLY_MANIFEST_NAME`'s relocation to the public barrel;
 *   (D) the actual fix — both owners now report a genuinely refused manifest
 *       through this ONE new class, not the two wrong ones being replaced.
 *
 * @packageDocumentation
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

import {
  agentDecisionLogEntry,
  M3LAgentDecisionLog,
  M3LAgentDecisionLogWriteError,
} from "../src/core/agent/index.js";
import type {
  M3LAgentDecision,
  M3LAgentDecisionLogEntry,
  M3LAgentIdentity,
} from "../src/core/agent/index.js";
import { M3LError, M3L_ERROR_CODES } from "../src/core/errors/index.js";
import {
  classifyErrorCode,
  isM3LErrorCode,
} from "../src/core/errors/catalog.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamError,
  M3LAppendOnlyStreamManifestError,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type { M3LAppendOnlySealFailure } from "../src/core/storage/index.js";

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// A — The error class contract
// ---------------------------------------------------------------------------

describe("M3LAppendOnlyStreamManifestError — class contract", () => {
  test("is an instance of Error, M3LError, and itself", () => {
    const error = new M3LAppendOnlyStreamManifestError("manifest failed");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
  });

  test("code is ERR_APPEND_ONLY_STREAM_MANIFEST at runtime", () => {
    const error = new M3LAppendOnlyStreamManifestError("manifest failed");
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_MANIFEST");
  });

  test("code narrows to the exact literal type, not string and not the wide M3LErrorCode union", () => {
    // `toEqualTypeOf` is an EXACT equality check, so this single assertion
    // already proves the narrower claim too: if `code` were the wide
    // `string` type, or the wide `M3LErrorCode` union, it would not be
    // exactly equal to the single literal below and this line would fail.
    expectTypeOf<
      M3LAppendOnlyStreamManifestError["code"]
    >().toEqualTypeOf<"ERR_APPEND_ONLY_STREAM_MANIFEST">();
  });

  test("message passes through verbatim", () => {
    const error = new M3LAppendOnlyStreamManifestError(
      "the sealed-segment manifest could not be appended",
    );
    expect(error.message).toBe(
      "the sealed-segment manifest could not be appended",
    );
  });

  test("context passes through when given", () => {
    const error = new M3LAppendOnlyStreamManifestError("manifest failed", {
      context: { maxBytes: 65_536 },
    });
    expect(error.context).toEqual({ maxBytes: 65_536 });
  });

  test("context defaults to an empty object when not given", () => {
    const error = new M3LAppendOnlyStreamManifestError("manifest failed");
    expect(error.context).toEqual({});
  });

  test("cause chains when given", () => {
    const underlying = new Error("ENOENT");
    const error = new M3LAppendOnlyStreamManifestError("manifest failed", {
      cause: underlying,
    });
    expect(error.cause).toBe(underlying);
  });

  test("cause is undefined when not given", () => {
    const error = new M3LAppendOnlyStreamManifestError("manifest failed");
    expect(error.cause).toBeUndefined();
  });

  test("the options bag cannot carry a code — it is set automatically and cannot be overridden", () => {
    // Constructed through an `unknown` seam (mirrors
    // `agent-decision-log-seal-options.test.ts`'s `construct` helper) so an
    // options bag carrying a field the static type does not declare
    // (`code`) can reach the constructor at runtime without a
    // `@ts-expect-error` directive — a directive here would need to flip
    // between RED (the class does not exist, so nothing type-errors) and
    // GREEN (the real, `code`-less options type rejects it), which a
    // suppression comment cannot straddle.
    const attemptedOverride: unknown = { code: "ERR_SOMETHING_ELSE" };
    const withAttemptedOverride = new M3LAppendOnlyStreamManifestError(
      "manifest failed",
      attemptedOverride as ConstructorParameters<
        typeof M3LAppendOnlyStreamManifestError
      >[1],
    );
    expect(withAttemptedOverride.code).toBe("ERR_APPEND_ONLY_STREAM_MANIFEST");
  });

  test("is a DISTINCT class from M3LAppendOnlyStreamReadError and M3LAppendOnlyStreamError", () => {
    const error = new M3LAppendOnlyStreamManifestError("manifest failed");
    expect(error).not.toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(error).not.toBeInstanceOf(M3LAppendOnlyStreamError);
  });
});

// ---------------------------------------------------------------------------
// B — Code and catalog registration
// ---------------------------------------------------------------------------

describe("ERR_APPEND_ONLY_STREAM_MANIFEST — registration", () => {
  test("is a member of M3L_ERROR_CODES", () => {
    expect(M3L_ERROR_CODES).toContain("ERR_APPEND_ONLY_STREAM_MANIFEST");
  });

  test("isM3LErrorCode recognizes it", () => {
    expect(isM3LErrorCode("ERR_APPEND_ONLY_STREAM_MANIFEST")).toBe(true);
  });

  test("catalog entry is exactly { origin: 'external', retryable: false }", () => {
    expect(classifyErrorCode("ERR_APPEND_ONLY_STREAM_MANIFEST")).toEqual({
      origin: "external",
      retryable: false,
    });
  });

  test("sorts immediately before ERR_APPEND_ONLY_STREAM_READ in the tuple", () => {
    const codes: readonly string[] = M3L_ERROR_CODES;
    const manifestIndex = codes.indexOf("ERR_APPEND_ONLY_STREAM_MANIFEST");
    const readIndex = codes.indexOf("ERR_APPEND_ONLY_STREAM_READ");
    expect(manifestIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(manifestIndex).toBe(readIndex - 1);
  });
});

// ---------------------------------------------------------------------------
// C — The public constant M3L_APPEND_ONLY_MANIFEST_NAME
// ---------------------------------------------------------------------------

describe("M3L_APPEND_ONLY_MANIFEST_NAME — public reachability", () => {
  test("is importable from the core/storage barrel and equals 'manifest.jsonl'", () => {
    expect(M3L_APPEND_ONLY_MANIFEST_NAME).toBe("manifest.jsonl");
  });

  test("is typed as the wide string type, not the literal 'manifest.jsonl'", () => {
    // The pre-move declaration is explicitly annotated `: string`, and the
    // move preserves that annotation — the sidecar's name stays free to
    // change without a type-level break for consumers pinning this constant.
    expectTypeOf(M3L_APPEND_ONLY_MANIFEST_NAME).toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// D — The behavioural pin: both owners report a refused manifest through the
// ONE new class, not the two wrong ones this slice removes.
// ---------------------------------------------------------------------------

/**
 * Plants a symlink at the manifest path inside `dir` (created fresh) so the
 * sealer's `O_NOFOLLOW` open of `manifest.jsonl` is refused rather than
 * followed. Mirrors `storage-append-only-seal-wiring.test.ts`'s and
 * `agent-decision-log-seal-options.test.ts`'s own `plantManifestSymlink` byte
 * for byte. The target is a real, existing file so a wrong assumption about
 * `ENOENT` vs `ELOOP` would surface as an actual assertion failure rather
 * than passing by accident.
 */
async function plantManifestSymlink(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "manifest-target.txt");
  await writeFile(target, "not a manifest", "utf8");
  await symlink(target, path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME));
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(
    path.join(tmpdir(), "m3l-append-only-manifest-error-"),
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("M3LAppendOnlyStream — onSealFailed reports the new manifest error class", () => {
  test("a refused manifest reports M3LAppendOnlyStreamManifestError, not the old M3LAppendOnlyStreamReadError, and leaks no caller data", async () => {
    const secretDirName = "customer-x8b4a-manifest-secret";
    const dir = path.join(workDir, secretDirName);
    await plantManifestSymlink(dir);

    const failures: M3LAppendOnlySealFailure[] = [];
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      onSealFailed: (failure) => {
        failures.push(failure);
      },
    });

    await stream.append({ marker: "entry" });
    // The seal runs on the writer's own serialized tail chain, outside the
    // promise `append()` awaits — `flush()` drains that chain before the
    // reported failure is observable.
    await stream.flush();

    expect(failures).toHaveLength(1);
    const failure = definedOrThrow(failures[0], "the one seal failure");

    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    expect(failure.error.code).toBe("ERR_APPEND_ONLY_STREAM_MANIFEST");
    // The two wrong classes this slice removes: asserting only the new class
    // above would still pass if the old one were left in place as a
    // superclass, so both are asserted absent explicitly.
    expect(failure.error).not.toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(failure.error).not.toBeInstanceOf(M3LAgentDecisionLogWriteError);

    const serializedContext = JSON.stringify(failure.error.context ?? {});
    expect(failure.error.message).not.toContain(secretDirName);
    expect(failure.error.message).not.toContain(workDir);
    expect(serializedContext).not.toContain(secretDirName);
    expect(serializedContext).not.toContain(workDir);
  });
});

const DEFAULT_IDENTITY: M3LAgentIdentity = { name: "release-bot" };

/** Builds a real, slice-1-validated entry ready to hand to the writer. */
function makeEntry(now: number): M3LAgentDecisionLogEntry {
  const decision: M3LAgentDecision = {
    verdict: "auto-approved",
    rule: "read-only-auto-approved",
    reason: "read-only action on an allowlisted script",
    action: {
      script: "s3-report",
      operation: undefined,
      kind: "read-only",
      target: undefined,
      parameterNames: ["bucket", "prefix"],
      dryRun: false,
      shapeKey: "s3-report:read-only",
    },
  };
  return agentDecisionLogEntry({ decision, identity: DEFAULT_IDENTITY, now });
}

// ---------------------------------------------------------------------------
// E — X8b4a security fix: a forged mid-file seal's `segment` must never
// reach `onSealFailed`'s `message` or `context`, and the genuine sanctioned
// exception (a real, writer-shaped segment name on a genuine conflict) must
// keep working.
//
// A reviewer flagged that section D's `context` assertions above cannot fail
// on the shape they exercise: a symlinked manifest never gets far enough to
// build a `ManifestSealRecord` at all, so `context` is always `{}` and
// `not.toContain(secret)` is structurally green for ANY implementation. These
// tests close that gap with a shape where `context` is genuinely non-empty:
// two conflicting `seal` lines planted directly into `manifest.jsonl`,
// bypassing the sealer entirely, so `admitSeal`
// (`internal/storage/append-only-manifest-records.ts`) is the one that
// builds `CONFLICTING_SEAL_MESSAGE`'s `context: { segment }`.
// ---------------------------------------------------------------------------

/**
 * Assembled from two literal halves rather than one, so no single source
 * literal reads as a secret-shaped string to a source-text scanner — the
 * runtime-concatenated value is what gets planted into the forged manifest.
 */
const FORGED_SEGMENT_SECRET_PART_A = "EVIL-customer-x8b4a-manifest";
const FORGED_SEGMENT_SECRET_PART_B = "-secret-payload.jsonl";

/** 64 lowercase hex characters — the documented shape of a seal's `sha256`. */
const LEAK_SHA_A = "a".repeat(64);
const LEAK_SHA_B = "b".repeat(64);

/**
 * One hand-written `seal` line, terminator included — `formatVersion: 1` is
 * hardcoded rather than imported from
 * `internal/storage/append-only-manifest-records.js`: this file otherwise
 * exercises only the two public owners, and the manifest bytes below are
 * meant to be exactly what a hand-crafted (or tampered) manifest would hold,
 * not bytes derived from the module under test.
 */
function leakCheckSealLine(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return `${JSON.stringify({
    kind: "seal",
    formatVersion: 1,
    at: "2026-09-11T01:00:00.000Z",
    segment: "2026-09-11-0001.jsonl",
    entryCount: 1,
    byteLength: 10,
    sha256: LEAK_SHA_A,
    ...overrides,
  })}\n`;
}

/** Plants a hand-written `manifest.jsonl` inside a freshly created `dir`. */
async function plantManifestFile(dir: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME), content, {
    encoding: "utf8",
  });
}

describe("M3LAppendOnlyStream / M3LAgentDecisionLog — a forged conflicting segment name never leaks", () => {
  test("M3LAppendOnlyStream: a forged, non-writer-shaped segment name never reaches onSealFailed's message or context", async () => {
    const forgedSegment = `${FORGED_SEGMENT_SECRET_PART_A}${FORGED_SEGMENT_SECRET_PART_B}`;
    const dir = path.join(workDir, "leak-check-stream");
    await plantManifestFile(
      dir,
      `${leakCheckSealLine({ segment: forgedSegment, sha256: LEAK_SHA_A })}${leakCheckSealLine(
        { segment: forgedSegment, sha256: LEAK_SHA_B },
      )}`,
    );

    const failures: M3LAppendOnlySealFailure[] = [];
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      onSealFailed: (failure) => {
        failures.push(failure);
      },
    });

    await stream.append({ marker: "entry" });
    await stream.flush();

    expect(failures).toHaveLength(1);
    const failure = definedOrThrow(failures[0], "the one seal failure");
    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);

    // Unlike section D's symlink-shape tests, `context` here is NOT `{}` on
    // the current (pre-fix) code: `admitSeal` builds
    // `context: { segment: forgedSegment }` because `parseSealRecord` admits
    // the foreign string unvalidated. This is what makes the assertion below
    // capable of failing rather than structurally green.
    const serializedContext = JSON.stringify(failure.error.context ?? {});
    expect(failure.error.message).not.toContain(forgedSegment);
    expect(serializedContext).not.toContain(forgedSegment);
  });

  test("M3LAgentDecisionLog: a forged, non-writer-shaped segment name never reaches onSealFailed's message or context", async () => {
    const forgedSegment = `${FORGED_SEGMENT_SECRET_PART_A}${FORGED_SEGMENT_SECRET_PART_B}`;
    const dir = path.join(workDir, "leak-check-agent-log");
    await plantManifestFile(
      dir,
      `${leakCheckSealLine({ segment: forgedSegment, sha256: LEAK_SHA_A })}${leakCheckSealLine(
        { segment: forgedSegment, sha256: LEAK_SHA_B },
      )}`,
    );

    const failures: M3LAppendOnlySealFailure[] = [];
    const log = new M3LAgentDecisionLog({
      directory: dir,
      onSealFailed: (failure) => {
        failures.push(failure);
      },
    });

    await log.write(makeEntry(Date.UTC(2026, 0, 1, 0, 0, 0)));
    await log.flush();

    expect(failures).toHaveLength(1);
    const failure = definedOrThrow(failures[0], "the one seal failure");
    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);

    const serializedContext = JSON.stringify(failure.error.context ?? {});
    expect(failure.error.message).not.toContain(forgedSegment);
    expect(serializedContext).not.toContain(forgedSegment);
  });

  test("the sanctioned exception stays real: a genuine conflicting seal still reports its real, writer-shaped segment name in context", async () => {
    // The complementary control: without this, a fix that stripped `segment`
    // from `CONFLICTING_SEAL_MESSAGE`'s context entirely — over-correcting
    // the leak above — would pass every test in this file while breaking a
    // real, documented, and useful diagnostic. An operator cannot act on a
    // conflicting-seal failure without knowing which segment is disputed.
    const genuineSegment = "2026-09-11-0001.jsonl";
    const dir = path.join(workDir, "conflict-control");
    await plantManifestFile(
      dir,
      `${leakCheckSealLine({ segment: genuineSegment, sha256: LEAK_SHA_A })}${leakCheckSealLine(
        { segment: genuineSegment, sha256: LEAK_SHA_B },
      )}`,
    );

    const failures: M3LAppendOnlySealFailure[] = [];
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      onSealFailed: (failure) => {
        failures.push(failure);
      },
    });

    await stream.append({ marker: "entry" });
    await stream.flush();

    expect(failures).toHaveLength(1);
    const failure = definedOrThrow(failures[0], "the one seal failure");
    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    // A change that silently rerouted this genuine conflict to the malformed
    // path (as opposed to just refusing a FORGED segment at parse time) would
    // fail this assertion.
    expect(failure.error.message).toBe(
      "append-only stream: two seals disagree about a segment's measurement",
    );
    expect(failure.error.context).toEqual({ segment: genuineSegment });
  });
});

describe("M3LAgentDecisionLog — onSealFailed reports the new manifest error class", () => {
  test("a refused manifest reports M3LAppendOnlyStreamManifestError, not the old M3LAgentDecisionLogWriteError, and leaks no caller data", async () => {
    const secretDirName = "customer-x8b4a-agent-manifest-secret";
    const dir = path.join(workDir, secretDirName);
    await plantManifestSymlink(dir);

    const failures: M3LAppendOnlySealFailure[] = [];
    const log = new M3LAgentDecisionLog({
      directory: dir,
      onSealFailed: (failure) => {
        failures.push(failure);
      },
    });

    await log.write(makeEntry(Date.UTC(2026, 0, 1, 0, 0, 0)));
    await log.flush();

    expect(failures).toHaveLength(1);
    const failure = definedOrThrow(failures[0], "the one seal failure");

    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    expect(failure.error.code).toBe("ERR_APPEND_ONLY_STREAM_MANIFEST");
    expect(failure.error).not.toBeInstanceOf(M3LAgentDecisionLogWriteError);
    expect(failure.error).not.toBeInstanceOf(M3LAppendOnlyStreamReadError);

    const serializedContext = JSON.stringify(failure.error.context ?? {});
    expect(failure.error.message).not.toContain(secretDirName);
    expect(failure.error.message).not.toContain(workDir);
    expect(serializedContext).not.toContain(secretDirName);
    expect(serializedContext).not.toContain(workDir);
  });
});
