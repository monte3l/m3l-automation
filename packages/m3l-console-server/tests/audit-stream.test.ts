/**
 * Tests for src/audit/stream.ts and src/audit/port.ts — the append-only
 * human-action audit stream (m3l-console-server X7, slice 3, ADR-0070).
 *
 * `createHumanActionAuditStream` wraps `Core.M3LAppendOnlyStream`, projects
 * each record, and — unlike `runs/audit.ts`'s deliberately never-throwing
 * run-LIFECYCLE sink — fails loudly: an unauditable human action is refused,
 * so `record()` REJECTS with `ERR_CONSOLE_AUDIT_WRITE_FAILED`.
 *
 * Real temp directories via `node:fs`/`node:os` are used throughout (not a
 * mocked `node:fs`): what reaches the persisted BYTES is the behavior under
 * test, and a mocked filesystem could only ever return what this file already
 * asserted. Same idiom as `tests/runs-catalog.test.ts` — the fs functions are
 * imported by NAME rather than through an `fs.` namespace object, which is
 * what `eslint.config.js`'s unit-test fs-mutation ban targets.
 *
 * The defining assertion of this slice lives here in its byte-level form: a
 * record built from a parameters object carrying a recognisable secret is
 * written through the stream, the segment bytes are read back, and the secret
 * appears nowhere in them. `tests/audit-record.test.ts` proves the same
 * property at the type level.
 *
 * RED: `../src/audit/stream.js` and `../src/audit/port.js` do not exist yet —
 * every import below is expected to fail to resolve until the implementer
 * lands the module.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LOperatorProfile } from "../src/auth/identity.js";
import { humanActionRecordFrom } from "../src/audit/record.js";
import type { M3LHumanActionRecord } from "../src/audit/record.js";
import type { M3LHumanActionAuditPort } from "../src/audit/port.js";
import { createHumanActionAuditStream } from "../src/audit/stream.js";

/** A recognisable secret planted in a parameter VALUE; it must never reach disk. */
const SECRET_VALUE = "shibboleth-9f2c-parameter-value-must-not-leak";

/** A declared operator email — `identity.ts:29` promises it is never logged. */
const OPERATOR_EMAIL = "ada@example.invalid";

/** An operator who declared an email, so both identity assertions are live. */
const OPERATOR: M3LOperatorProfile = { name: "ada", email: OPERATOR_EMAIL };

/** The temp root each test's stream directory lives under. */
let root: string;

/** The directory handed to the stream under test; created on first append. */
let auditDirectory: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "m3l-audit-stream-"));
  auditDirectory = join(root, "audit");
});

afterEach(() => {
  // The unwritable-directory case leaves `root` at 0o500; restore write
  // permission first or the recursive removal fails on its own children.
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

/** Builds a record through the public builder, overridable field by field. */
function buildRecord(
  overrides: Partial<Parameters<typeof humanActionRecordFrom>[0]> = {},
): M3LHumanActionRecord {
  return humanActionRecordFrom({
    atMs: 1_700_000_000_000,
    operator: OPERATOR,
    correlationId: "corr-1",
    action: "run.launch",
    target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
    parameters: { queueUrl: "https://sqs.example.invalid/q" },
    parameterRefs: [],
    posture: "confirmed",
    outcome: "allowed",
    detail: { attempt: 1 },
    ...overrides,
  });
}

/**
 * Reads every byte the stream has written under `auditDirectory`, across all
 * of its `<YYYY-MM-DD>-<NNNN>.jsonl` segments, as one string. The whole point
 * of the leak assertions is to search what is actually ON DISK, so this
 * deliberately does not parse.
 *
 * The directory may legitimately not exist: record validation now runs before
 * any filesystem contact, so a refused record is rejected before
 * `Core.M3LAppendOnlyStream` ever calls `mkdir`. A missing directory is a
 * stronger guarantee than an empty one — "nothing reached the segment" — and
 * must not be treated as a defect. Only ENOENT is swallowed; any other error
 * (e.g. EACCES) propagates so that a silent permissions failure cannot make
 * leak assertions vacuously pass.
 */
function readAllSegmentBytes(): string {
  let entries: string[];
  try {
    entries = readdirSync(auditDirectory);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
  return entries
    .sort((left, right) => left.localeCompare(right))
    .map((name) => readFileSync(join(auditDirectory, name), "utf8"))
    .join("");
}

/** Parses every JSONL line the stream has written, in append order. */
function readAllEntries(): unknown[] {
  return readAllSegmentBytes()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe("M3LHumanActionAuditPort — the contract shape", () => {
  test("record is async and returns Promise<void>", () => {
    expectTypeOf<M3LHumanActionAuditPort["record"]>()
      .parameter(0)
      .toEqualTypeOf<M3LHumanActionRecord>();
    expectTypeOf<M3LHumanActionAuditPort["record"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
  });

  test("createHumanActionAuditStream returns exactly that port", () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    expectTypeOf(port).toEqualTypeOf<M3LHumanActionAuditPort>();
  });
});

describe("createHumanActionAuditStream — the happy path", () => {
  test("appends one JSONL line per recorded action", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    await port.record(buildRecord({ correlationId: "corr-1" }));
    await port.record(
      buildRecord({ correlationId: "corr-2", action: "run.cancel" }),
    );

    const entries = readAllEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      correlationId: "corr-1",
      action: "run.launch",
    });
    expect(entries[1]).toMatchObject({
      correlationId: "corr-2",
      action: "run.cancel",
    });
  });

  test("round-trips every declared field unchanged", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });
    const record = buildRecord({
      parameters: { queueUrl: "https://sqs.example.invalid/q", retries: 3 },
      detail: { attempt: 1, reason: "operator requested", forced: false },
    });

    await port.record(record);

    expect(readAllEntries()[0]).toEqual({
      atMs: record.atMs,
      operator: "ada",
      operatorEmailDeclared: true,
      correlationId: "corr-1",
      action: "run.launch",
      target: { kind: "script", id: "script-1", scriptName: "sqs-etl" },
      parameterNames: ["queueUrl", "retries"],
      parameterRefs: [],
      posture: "confirmed",
      outcome: "allowed",
      detail: { attempt: 1, reason: "operator requested", forced: false },
    });
  });

  test("creates the stream directory on the first append, not at construction", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    expect(readdirSync(root)).toEqual([]);

    await port.record(buildRecord());

    expect(readdirSync(auditDirectory).length).toBeGreaterThan(0);
  });

  test("appends never rewrite an earlier line", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    await port.record(buildRecord({ correlationId: "first" }));
    const afterFirst = readAllSegmentBytes();
    await port.record(buildRecord({ correlationId: "second" }));

    expect(readAllSegmentBytes().startsWith(afterFirst)).toBe(true);
  });
});

describe("createHumanActionAuditStream — no parameter VALUE reaches the bytes", () => {
  // THE defining assertion of X7 slice 3, in its byte-level form. The type
  // level cannot prove this alone: a `detail` entry is a string, so only
  // reading back what was actually persisted shows the value was dropped
  // rather than merely renamed.
  test("a secret-bearing parameter value appears nowhere in the segment bytes", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    await port.record(
      buildRecord({
        parameters: {
          queueUrl: "https://sqs.example.invalid/q",
          apiToken: SECRET_VALUE,
        },
      }),
    );

    const bytes = readAllSegmentBytes();
    expect(bytes).not.toContain(SECRET_VALUE);
    expect(bytes).toContain("apiToken");
    expect(bytes).toContain("queueUrl");
  });

  test("a secret nested deep inside a parameter value also never reaches disk", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    await port.record(
      buildRecord({
        parameters: { credentials: { nested: { deeper: [SECRET_VALUE] } } },
      }),
    );

    const bytes = readAllSegmentBytes();
    expect(bytes).not.toContain(SECRET_VALUE);
    expect(bytes).toContain("credentials");
  });

  test("a value-bearing key smuggled past the type system is projected away", async () => {
    // A caller reaching the port through an `as` cast (or plain JS) can plant
    // an own key the interface forbids. The stream projects before writing, so
    // the smuggled key must not survive to the segment.
    const port = createHumanActionAuditStream({ directory: auditDirectory });
    const smuggled = {
      ...buildRecord(),
      parameters: { apiToken: SECRET_VALUE },
    } as unknown as M3LHumanActionRecord;

    await port.record(smuggled);

    const bytes = readAllSegmentBytes();
    expect(bytes).not.toContain(SECRET_VALUE);
    expect(bytes).not.toContain('"parameters"');
  });

  test("an inherited Object.prototype.toJSON cannot forge the persisted line", async () => {
    // `Object.freeze` does not stop an inherited `toJSON` rewriting the bytes
    // a record serializes to. Restore the prototype in `finally` — leaking it
    // would corrupt every later test in the process.
    const port = createHumanActionAuditStream({ directory: auditDirectory });
    const prototype = Object.prototype as unknown as {
      toJSON?: () => unknown;
    };

    try {
      prototype.toJSON = () => ({ forged: SECRET_VALUE });
      await port.record(buildRecord());
    } finally {
      delete prototype.toJSON;
    }

    const bytes = readAllSegmentBytes();
    expect(bytes).not.toContain(SECRET_VALUE);
    expect(bytes).not.toContain("forged");
    expect(readAllEntries()[0]).toMatchObject({
      operator: "ada",
      correlationId: "corr-1",
    });
  });
});

describe("createHumanActionAuditStream — the operator's email never reaches the bytes", () => {
  test("a declared email persists as the flag only, never as the address", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    await port.record(buildRecord({ operator: OPERATOR }));

    const bytes = readAllSegmentBytes();
    expect(bytes).not.toContain(OPERATOR_EMAIL);
    expect(bytes).not.toContain("example.invalid");
    expect(readAllEntries()[0]).toMatchObject({
      operator: "ada",
      operatorEmailDeclared: true,
    });
  });

  test("an undeclared email persists the flag as false", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });

    await port.record(
      buildRecord({ operator: { name: "grace", email: undefined } }),
    );

    expect(readAllEntries()[0]).toMatchObject({
      operator: "grace",
      operatorEmailDeclared: false,
    });
  });
});

describe("createHumanActionAuditStream — an unwritable trail is refused loudly", () => {
  // The deliberate inverse of `runs/audit.ts`'s "Never throws" run-lifecycle
  // sink (`src/runs/audit.ts:99`): ADR-0070 refuses an action it cannot audit.
  // Provoked with a REAL unwritable parent directory rather than a mock, so
  // the assertion is against the operating system's own EACCES rather than a
  // rejection this file invented. Root ignores the mode bits entirely.
  const skipAsRoot = process.getuid?.() === 0;

  test.skipIf(skipAsRoot)(
    "record() rejects with ERR_CONSOLE_AUDIT_WRITE_FAILED when the segment cannot be written",
    async () => {
      const port = createHumanActionAuditStream({ directory: auditDirectory });
      chmodSync(root, 0o500);

      let thrown: unknown;
      try {
        await port.record(buildRecord());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_AUDIT_WRITE_FAILED",
      );
    },
  );

  test.skipIf(skipAsRoot)(
    "chains the underlying stream failure as `cause`",
    async () => {
      const port = createHumanActionAuditStream({ directory: auditDirectory });
      chmodSync(root, 0o500);

      let thrown: unknown;
      try {
        await port.record(buildRecord());
      } catch (error) {
        thrown = error;
      }

      const cause = (thrown as M3LConsoleError).cause;
      expect(cause).toBeInstanceOf(Core.M3LAppendOnlyStreamError);
    },
  );

  test.skipIf(skipAsRoot)(
    "the refusal message never echoes the record's own fields",
    async () => {
      const port = createHumanActionAuditStream({ directory: auditDirectory });
      chmodSync(root, 0o500);

      let thrown: unknown;
      try {
        await port.record(
          buildRecord({
            parameters: { apiToken: SECRET_VALUE },
            operator: OPERATOR,
          }),
        );
      } catch (error) {
        thrown = error;
      }

      const message = (thrown as M3LConsoleError).message;
      expect(message).not.toContain(SECRET_VALUE);
      expect(message).not.toContain(OPERATOR_EMAIL);
    },
  );

  test.skipIf(skipAsRoot)(
    "a failed record leaves no partial segment behind and the port stays usable",
    async () => {
      const port = createHumanActionAuditStream({ directory: auditDirectory });
      chmodSync(root, 0o500);

      await expect(port.record(buildRecord())).rejects.toBeInstanceOf(
        M3LConsoleError,
      );

      chmodSync(root, 0o700);
      await port.record(buildRecord({ correlationId: "after-recovery" }));

      const entries = readAllEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ correlationId: "after-recovery" });
    },
  );
});

describe("createHumanActionAuditStream — rejects a malformed directory option", () => {
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
  ])("rejects %s as a directory", (_label, directory) => {
    // `Core.M3LAppendOnlyStream` validates its own options at construction
    // (`ERR_INVALID_ARGUMENT`); this only pins that the wrapper does not
    // swallow that rejection into a silently no-op port.
    expect(() => createHumanActionAuditStream({ directory })).toThrow();
  });
});

describe("the port distinguishes a refused RECORD from an unwritable TRAIL", () => {
  // Both reach the caller through `record()`, and slice 5 classifies on the
  // code alone: a caller type violation (or an `inline` ADR-0068 ref, which
  // carries the parameter VALUE) is a non-retryable 4xx, while an unwritable
  // segment is the retryable 503 this file already pins above. One code for
  // both renders the first as "try again in a moment", which is false.
  test("a record the projection refuses rejects with ERR_CONSOLE_AUDIT_RECORD_INVALID", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });
    const poisoned = {
      ...buildRecord(),
      detail: { nested: { pw: SECRET_VALUE } },
    } as unknown as M3LHumanActionRecord;

    let thrown: unknown;
    try {
      await port.record(poisoned);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_AUDIT_RECORD_INVALID",
    );
    expect(readAllEntries()).toHaveLength(0);
  });

  test("an inline ADR-0068 ref rejects with the same caller-fault code", async () => {
    const port = createHumanActionAuditStream({ directory: auditDirectory });
    const inlineRef = JSON.stringify({ kind: "inline", value: SECRET_VALUE });

    let thrown: unknown;
    try {
      await port.record(buildRecord({ parameterRefs: [inlineRef] }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_AUDIT_RECORD_INVALID",
    );
    expect(readAllEntries()).toHaveLength(0);
  });
});
