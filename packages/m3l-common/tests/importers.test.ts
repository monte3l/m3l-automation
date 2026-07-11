/**
 * Tests for core/importers submodule (RED phase — nothing implemented yet).
 *
 * Contract source: docs/reference/core/importers.md (13 exported symbols):
 *   M3LFileImporter, M3LListImporter, M3LListImporterEvents,
 *   M3LListImporterResult, M3LCSVListImporter, M3LCSVListImporterOptions,
 *   M3LCSVFormatAdapter, M3LCSVAdapterFactory, M3LJSONFileImporter,
 *   M3LJSONListImporter, M3LJSONListImporterOptions, M3LFileListImporter,
 *   M3LTextFileImporter.
 *
 * Imported via the namespace barrel (`Core`) — importers is surfaced through
 * `Core`, not a new `exports` subpath.
 *
 * =============================================================================
 * BINDING DECISIONS (hub-resolved; summarized here so implementer + reviewers
 * see the same contract this file was written against). Full source:
 * scratchpad `importers-binding-decisions.md`.
 * =============================================================================
 *
 * 1. Error class — NO new error subclass. Reuse `M3LError` with importer
 *    codes: `ERR_IMPORT_SOURCE` (unreadable/missing/no-source/undetectable
 *    format), `ERR_IMPORT_PARSE` (malformed source-level parse failure),
 *    `ERR_IMPORT_VALIDATION` (reserved, not normally thrown — see #4).
 *    Reused `M3LJSONFormatDetectionError` from core/json is NOT re-wrapped.
 *
 * 2. `source: string | Buffer`. Path string -> streamed; Buffer -> in-memory.
 *    Both must yield identical items. `options.filePath` is an OPTIONAL
 *    default source; per-call `source` overrides it. Neither supplied ->
 *    `M3LError` code `ERR_IMPORT_SOURCE`.
 *
 * 3. Bad RECORD (bad row/failed validator/failed transformer) -> emit
 *    `import:error` with `{ error, index }`, skip, continue; good items are
 *    still returned/yielded. SOURCE-level failure (unreadable file,
 *    undetectable format, no source) -> reject/throw `M3LError`.
 *
 * 4. CSV row validator is `(row) => boolean`; falsy -> `import:error`
 *    (code `ERR_IMPORT_VALIDATION` in the payload's error), skip, no throw.
 *
 * 5. CSV pipeline order (HARD): column mapping -> default values ->
 *    row validator -> row transformer, per row, in that exact order.
 *
 * 6. `M3LListImporterResult<TItem>` = `{ items: readonly TItem[];
 *    errors: readonly { index: number; error: unknown }[]; durationMs: number }`.
 *
 * 7. `M3LListImporterEvents<TItem>` — exactly 5 keys:
 *    `import:started` -> `{ source: string }`
 *    `import:item` -> `{ item: TItem; index: number }`
 *    `import:progress` -> `{ processed: number; total?: number }`
 *    `import:error` -> `{ error: unknown; index?: number }`
 *    `import:completed` -> `{ processed: number; durationMs: number }`
 *    Cadence of `import:progress` is NOT pinned — only presence is asserted.
 *
 * 8. Whole-file importers, `read(source: string | Buffer)`:
 *    `M3LFileImporter.read -> Promise<Buffer>` (raw bytes);
 *    `M3LTextFileImporter.read -> Promise<string>` (UTF-8 text);
 *    `M3LJSONFileImporter.read<T = unknown> -> Promise<T>` (whole-doc parse);
 *    `M3LFileListImporter.read(sources: readonly (string | Buffer)[]) ->
 *    Promise<readonly Buffer[]>` (raw bytes per source, in order — finalized
 *    element type: `Buffer`, mirroring `M3LFileImporter`). These do NOT
 *    implement `M3LListImporter` and share no base class.
 *
 * 9. CSV adapter/factory — minimal, constructible only:
 *    `M3LCSVFormatAdapter` — constructible, usable as an options adapter.
 *    `M3LCSVAdapterFactory` — constructible, `.create(config)` returns an
 *    `M3LCSVFormatAdapter`.
 *
 * 10. JSON detection: `M3LJSONListImporterOptions.detectionDepth?:
 *     M3LJSONDetectionDepth` (default `"standard"`); dispatch reuses
 *     `M3LJSONFormatDetector`; `fieldPath` extraction reuses
 *     `M3LJSONFieldExtractor` / `navigateFieldPath` semantics (missing
 *     segment -> undefined; a digit-only segment indexes into an array,
 *     and stays an object-key lookup on a plain object).
 *
 * REVIEW-FIX LOCK-INS (added after the implementer's fix pass):
 * 11. A throwing `rowValidator`/`rowTransformer` (CSV) is a bad-RECORD skip,
 *     not a source-level abort (MF1): `import()` still resolves with the good
 *     rows, `importStream()` still yields the good items without rejecting,
 *     and the failing row surfaces via `import:error` carrying an `M3LError`.
 * 12. `M3LCSVFormatAdapter`'s `columnMapping` TARGET (output) key is checked
 *     against the dangerous-key set at CONSTRUCTION time (SF1): `__proto__`,
 *     `constructor`, `prototype` throw `M3LError` code `ERR_IMPORT_VALIDATION`
 *     synchronously from the constructor, not lazily from `.map()`.
 * 13. The JSON no-`fieldPath` passthrough screens the record's OWN keys for
 *     the same dangerous-key set (SF2): a record carrying a genuine own
 *     `__proto__`/`constructor`/`prototype` key (e.g. from
 *     `JSON.parse('{"__proto__":...}')`, which creates a real own property)
 *     is a bad-record skip (`import:error`), not passed through as-is.
 * 14. `import:completed.durationMs` is a real, non-negative `number` on the
 *     streaming path too (SF4) — cadence/exact value is not pinned, only
 *     `typeof === "number" && >= 0`.
 * 15. A file-path JSON source whose format detection fails (the reused
 *     `M3LJSONFormatDetector.detect` rejects) propagates that rejection
 *     UNWRAPPED — the caller sees `M3LJSONFormatDetectionError` directly, not
 *     a generic importer `M3LError` (locks binding decision #1's "do not
 *     re-wrap the reused detector error").
 *
 * FINAL CONSISTENCY-FIX LOCK-INS (added after a further implementer fix pass):
 * 16. (A) The JSON `fieldPath` branch is also screened for dangerous own-keys,
 *     symmetric to the no-`fieldPath` passthrough (SF2): both branches route
 *     their produced item through the same final `hasDangerousOwnKey` check
 *     right before reporting success, so a `fieldPath` that resolves to a
 *     nested object carrying an own `__proto__`/`constructor`/`prototype` key
 *     is a bad-record skip (`import:error`) too.
 * 17. (B) The CSV no-`columnMapping` passthrough is screened by the same
 *     `hasDangerousOwnKey` backstop: a raw CSV header named `constructor` or
 *     `prototype` (unmapped, so it survives verbatim as an own key on the
 *     emitted row) is a bad-record skip. `__proto__` is excluded from this
 *     one test because `csv-parse`'s own header handling does not let it
 *     survive as an own key in the first place — it is covered structurally
 *     by #12/#16 instead, not by this passthrough path.
 * 18. (C) The CSV row-validator failure's `M3LError.context` no longer
 *     embeds the row content — it carries `{ index }` only, matching the
 *     `TSDoc` note that "the row's own content is never embedded ... or
 *     attached as structured context."
 * 19. (D) A structurally malformed CSV row that `csv-parse`'s
 *     `skip_records_with_error` skips is wrapped in an `M3LError` (code
 *     `ERR_IMPORT_VALIDATION`, `cause` chaining the raw third-party
 *     `CsvError`) before reaching `import:error` — never the raw `CsvError`
 *     itself, keeping every `import:error`/`errors[]` entry within the
 *     `M3LError` hierarchy.
 */

import * as fs from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { FileHandle } from "node:fs/promises";

// Make the 'node:fs/promises' module configurable so vi.spyOn can intercept
// individual functions (ESM namespace objects are non-writable by default).
// Mirrors the pattern in tests/json.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  return { ...actual };
});

import { Core } from "../src/index.js";

import type {
  M3LCSVListImporterOptions,
  M3LFileImporter,
  M3LFileListImporter,
  M3LImportStreamSummary,
  M3LJSONListImporterOptions,
  M3LListImporter,
  M3LListImporterEvents,
  M3LListImporterResult,
  M3LTextFileImporter,
} from "../src/core/importers/index.js";

// =============================================================================
// Shared fixtures
// =============================================================================

interface UserRow {
  readonly id: string;
  readonly name: string;
}

const CSV_HEADER = "id,name";
const CSV_ROWS = ["1,Ada", "2,Grace"];
const CSV_CONTENT = [CSV_HEADER, ...CSV_ROWS].join("\n");

const JSON_ARRAY_CONTENT = JSON.stringify([
  { id: 1, name: "Ada", metadata: { author: "Lovelace" } },
  { id: 2, name: "Grace", metadata: { author: "Hopper" } },
]);

const JSONL_CONTENT = [
  JSON.stringify({ id: 1, name: "Ada", metadata: { author: "Lovelace" } }),
  JSON.stringify({ id: 2, name: "Grace", metadata: { author: "Hopper" } }),
].join("\n");

/**
 * The minimal slice of `FileHandle` that the reused `M3LJSONFormatDetector`
 * actually calls. The real `FileHandle.read`/`.stat` signatures are
 * overloaded and return the full Node `Stats` shape, which a minimal fake
 * cannot structurally satisfy — this narrower interface lets the fake object
 * literal itself be fully typed (no `any`), with a single justified cast at
 * the point where it stands in for the real `FileHandle`.
 */
interface FakeJSONFileHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

/**
 * Builds a fake `FileHandle` backed by `content`, typed via
 * {@link FakeJSONFileHandle} so `vi.spyOn(fs, "open").mockImplementation`
 * returns a safely-typed value (no `any` widening). `read` copies bytes from
 * `content` starting at `position`, up to `length`, into the caller-supplied
 * buffer, mirroring the real `FileHandle.read` contract used by the reused
 * `M3LJSONFormatDetector`.
 */
function fakeJSONFileHandle(content: string): FileHandle {
  const source = Buffer.from(content, "utf8");
  const handle: FakeJSONFileHandle = {
    read: (buffer, offset, length, position) => {
      const slice = source.subarray(position, position + length);
      slice.copy(buffer, offset);
      return Promise.resolve({ bytesRead: slice.length, buffer });
    },
    stat: () => Promise.resolve({ size: source.length }),
    close: () => Promise.resolve(),
  };
  // Cast through `unknown`: the fake intentionally implements only the three
  // FileHandle members the reused M3LJSONFormatDetector actually calls.
  return handle as unknown as FileHandle;
}

/**
 * Builds a fake `FileHandle` whose `read()` rejects with `readError`,
 * simulating a post-`open()` read failure inside `M3LJSONFormatDetector`
 * (e.g. a raw `EIO`). Used to prove the detector's own rejection
 * (`M3LJSONFormatDetectionError`) propagates out of `M3LJSONListImporter`
 * unwrapped, per binding decision #1.
 */
function fakeFailingJSONFileHandle(readError: unknown): FileHandle {
  const handle: FakeJSONFileHandle = {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- readError is typed `unknown` to allow testing the fs-error channel un-normalized, mirroring tests/json.test.ts's fakeFailingHandle
    read: () => Promise.reject(readError),
    stat: () => Promise.resolve({ size: 0 }),
    close: () => Promise.resolve(),
  };
  return handle as unknown as FileHandle;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// M3LCSVListImporter
// =============================================================================
describe("M3LCSVListImporter", () => {
  describe("import() — batch", () => {
    test("parses a CSV buffer into typed rows", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(result.items).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
    });

    test("a file-path source and an equivalent Buffer source yield identical items", async () => {
      const readFileMock = vi
        .spyOn(fs, "readFile")
        .mockResolvedValue(CSV_CONTENT);

      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const fromPath = await importer.import("/fixtures/users.csv");
      const fromBuffer = await importer.import(
        Buffer.from(CSV_CONTENT, "utf8"),
      );

      expect(fromPath.items).toEqual(fromBuffer.items);
      readFileMock.mockRestore();
    });

    test("options.filePath is used as the default source when import() is called with no argument", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(CSV_CONTENT);

      const importer = new Core.M3LCSVListImporter<UserRow>({
        filePath: "/fixtures/users.csv",
      });
      const result = await importer.import();

      expect(result.items).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
    });

    test("a per-call source overrides options.filePath", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({
        filePath: "/fixtures/other.csv",
      });
      const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(result.items).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
    });

    test("rejects with M3LError code ERR_IMPORT_SOURCE when neither options.filePath nor a per-call source is supplied", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});

      const thrown: unknown = await importer.import().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
        "ERR_IMPORT_SOURCE",
      );
    });

    test("rejects with M3LError code ERR_IMPORT_SOURCE for a missing file, chaining the fs error as cause", async () => {
      const fsError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockRejectedValue(fsError);

      const importer = new Core.M3LCSVListImporter<UserRow>({});
      let thrown: unknown;
      try {
        await importer.import("/fixtures/does-not-exist.csv");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
        "ERR_IMPORT_SOURCE",
      );
      expect((thrown as InstanceType<typeof Core.M3LError>).cause).toBe(
        fsError,
      );
    });

    test("a bad row is skipped, reported via import:error, and good rows are still returned", async () => {
      const malformedContent = [
        CSV_HEADER,
        "1,Ada",
        "not,a,valid,row,shape",
        "2,Grace",
      ].join("\n");

      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowValidator: (row) =>
          typeof row["id"] === "string" && typeof row["name"] === "string",
      });

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const result = await importer.import(
        Buffer.from(malformedContent, "utf8"),
      );

      expect(result.items).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
      expect(errorPayloads.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("importStream() — streaming", () => {
    test("yields items one at a time from a Buffer source", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const seen: UserRow[] = [];
      for await (const row of importer.importStream(
        Buffer.from(CSV_CONTENT, "utf8"),
      )) {
        seen.push(row);
      }
      expect(seen).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
    });

    test("a file-path source and an equivalent Buffer source stream identical items", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(CSV_CONTENT);

      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const fromPath: UserRow[] = [];
      for await (const row of importer.importStream("/fixtures/users.csv")) {
        fromPath.push(row);
      }
      const fromBuffer: UserRow[] = [];
      for await (const row of importer.importStream(
        Buffer.from(CSV_CONTENT, "utf8"),
      )) {
        fromBuffer.push(row);
      }

      expect(fromPath).toEqual(fromBuffer);
    });

    test("rejects (throws out of the generator) with M3LError ERR_IMPORT_SOURCE when no source is available", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});

      const consume = async (): Promise<void> => {
        for await (const _row of importer.importStream()) {
          // draining is enough to trigger the source resolution failure
        }
      };

      await expect(consume()).rejects.toBeInstanceOf(Core.M3LError);
    });

    test("the generator's return value reports processed/skipped/durationMs counts, good rows still yielded (F6)", async () => {
      const malformedContent = [
        CSV_HEADER,
        "1,Ada",
        "not,a,valid,row,shape",
        "2,Grace",
      ].join("\n");

      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowValidator: (row) =>
          typeof row["id"] === "string" && typeof row["name"] === "string",
      });

      const stream = importer.importStream(
        Buffer.from(malformedContent, "utf8"),
      );
      const yielded: UserRow[] = [];
      let step = await stream.next();
      while (step.done === false) {
        yielded.push(step.value);
        step = await stream.next();
      }
      if (step.done !== true) {
        throw new Error("importStream did not complete");
      }
      const summary: M3LImportStreamSummary = step.value;

      expect(yielded).toEqual([
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
      ]);
      expect(summary.skipped).toBe(1);
      expect(summary.processed).toBe(yielded.length + summary.skipped);
      expect(typeof summary.durationMs).toBe("number");
    });
  });

  describe("pipeline order — column mapping -> defaults -> validator -> transformer", () => {
    test("each row passes through the four stages in the documented order", async () => {
      const stageLog: string[][] = [];

      const importer = new Core.M3LCSVListImporter<{
        readonly id: string;
        readonly name: string;
        readonly status: string;
      }>({
        columnMapping: { id: "id", name: "name" },
        defaultValues: { status: "pending" },
        rowValidator: (row) => {
          const order: string[] = ["mapping+defaults-seen"];
          // The validator must see the mapped + defaulted row: both the
          // mapped columns and the default value are already present.
          const hasMapped =
            typeof row["id"] === "string" && typeof row["name"] === "string";
          const hasDefault = row["status"] === "pending";
          if (hasMapped && hasDefault) order.push("validator-passed");
          stageLog.push(order);
          return hasMapped && hasDefault;
        },
        rowTransformer: (row) => {
          // The transformer must see the already-validated, mapped+defaulted
          // row and runs last — its output is what ends up in `items`.
          stageLog.push(["transformer-ran"]);
          return { ...row, status: "confirmed" } as {
            readonly id: string;
            readonly name: string;
            readonly status: string;
          };
        },
      });

      const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(result.items).toEqual([
        { id: "1", name: "Ada", status: "confirmed" },
        { id: "2", name: "Grace", status: "confirmed" },
      ]);
      // Per-row order: validator observation before transformer observation.
      for (let i = 0; i < CSV_ROWS.length; i += 1) {
        const validatorEntry = stageLog[i * 2];
        const transformerEntry = stageLog[i * 2 + 1];
        expect(validatorEntry).toContain("validator-passed");
        expect(transformerEntry).toEqual(["transformer-ran"]);
      }
    });

    test("a falsy row validator result skips the row via import:error (ERR_IMPORT_VALIDATION), does not throw", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowValidator: (row) => row["name"] !== "Grace",
      });

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(result.items).toEqual([{ id: "1", name: "Ada" }]);
      expect(errorPayloads).toHaveLength(1);
      // (C) The error's context no longer embeds the row content — index only.
      const validationError = errorPayloads[0]?.error as
        InstanceType<typeof Core.M3LError> | undefined;
      expect(validationError?.context["row"]).toBeUndefined();
    });
  });

  describe("no-columnMapping passthrough rejects dangerous headers (B)", () => {
    test.each(["constructor", "prototype"])(
      "a header named %j survives verbatim as an own key and is skipped via import:error; clean rows still come through",
      async (dangerousHeader) => {
        const content = [`id,${dangerousHeader}`, "1,x", "2,y"].join("\n");

        const importer = new Core.M3LCSVListImporter<Record<string, string>>(
          {},
        );
        const errorPayloads: { error: unknown; index?: number }[] = [];
        importer.on("import:error", (payload) => {
          errorPayloads.push(payload);
        });

        const result = await importer.import(Buffer.from(content, "utf8"));

        // Both rows carry the dangerous header as an own key, so both are
        // skipped — no clean row exists in this header-poisoned fixture; the
        // "clean rows still come through" guarantee is instead proven by
        // mixing in one row from a second, unpoisoned source below.
        expect(result.items).toEqual([]);
        expect(errorPayloads).toHaveLength(2);
        for (const payload of errorPayloads) {
          expect(payload.error).toBeInstanceOf(Core.M3LError);
        }

        // A separate, unpoisoned CSV source proves the guard is targeted at
        // the dangerous header, not a wholesale rejection of the importer.
        const cleanResult = await importer.import(
          Buffer.from(CSV_CONTENT, "utf8"),
        );
        expect(cleanResult.items).toEqual([
          { id: "1", name: "Ada" },
          { id: "2", name: "Grace" },
        ]);
      },
    );
  });

  describe("malformed CSV rows surface as M3LError, not a raw CsvError (D)", () => {
    test("a structurally malformed row (wrong field count) is skipped via import:error carrying an M3LError, good rows still returned", async () => {
      const malformedContent = [
        CSV_HEADER,
        "1,Ada",
        "2,Grace,extra-field",
        "3,Eve",
      ].join("\n");

      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const result = await importer.import(
        Buffer.from(malformedContent, "utf8"),
      );

      expect(result.items).toEqual([
        { id: "1", name: "Ada" },
        { id: "3", name: "Eve" },
      ]);
      expect(errorPayloads.length).toBeGreaterThanOrEqual(1);
      for (const payload of errorPayloads) {
        expect(payload.error).toBeInstanceOf(Core.M3LError);
        expect((payload.error as InstanceType<typeof Core.M3LError>).code).toBe(
          "ERR_IMPORT_VALIDATION",
        );
      }
    });
  });

  describe("throwing pipeline callbacks are bad-record skips, not import aborts (MF1 regression guard)", () => {
    test("import() resolves with the good rows when rowTransformer throws on one row", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowTransformer: (row) => {
          if (row["name"] === "Grace") {
            throw new Error("transformer boom");
          }
          return row as unknown as UserRow;
        },
      });

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(result.items).toEqual([{ id: "1", name: "Ada" }]);
      expect(errorPayloads).toHaveLength(1);
      expect(errorPayloads[0]?.error).toBeInstanceOf(Core.M3LError);
    });

    test("import() resolves with the good rows when rowValidator throws on one row", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowValidator: (row) => {
          if (row["name"] === "Grace") {
            throw new Error("validator boom");
          }
          return true;
        },
      });

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(result.items).toEqual([{ id: "1", name: "Ada" }]);
      expect(errorPayloads).toHaveLength(1);
      expect(errorPayloads[0]?.error).toBeInstanceOf(Core.M3LError);
    });

    test("importStream() does not reject and still yields the good items when rowTransformer throws on one row", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowTransformer: (row) => {
          if (row["name"] === "Grace") {
            throw new Error("transformer boom (stream)");
          }
          return row as unknown as UserRow;
        },
      });

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const seen: UserRow[] = [];
      for await (const row of importer.importStream(
        Buffer.from(CSV_CONTENT, "utf8"),
      )) {
        seen.push(row);
      }

      expect(seen).toEqual([{ id: "1", name: "Ada" }]);
      expect(errorPayloads).toHaveLength(1);
      expect(errorPayloads[0]?.error).toBeInstanceOf(Core.M3LError);
    });

    test("importStream() does not reject and still yields the good items when rowValidator throws on one row", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({
        rowValidator: (row) => {
          if (row["name"] === "Grace") {
            throw new Error("validator boom (stream)");
          }
          return true;
        },
      });

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const seen: UserRow[] = [];
      for await (const row of importer.importStream(
        Buffer.from(CSV_CONTENT, "utf8"),
      )) {
        seen.push(row);
      }

      expect(seen).toEqual([{ id: "1", name: "Ada" }]);
      expect(errorPayloads).toHaveLength(1);
      expect(errorPayloads[0]?.error).toBeInstanceOf(Core.M3LError);
    });
  });

  describe("events", () => {
    test("import:started fires before any import:item, and import:completed fires last", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const order: string[] = [];

      importer.on("import:started", () => {
        order.push("started");
      });
      importer.on("import:item", () => {
        order.push("item");
      });
      importer.on("import:completed", () => {
        order.push("completed");
      });

      await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(order[0]).toBe("started");
      expect(order.at(-1)).toBe("completed");
      expect(order.filter((e) => e === "item")).toHaveLength(2);
    });

    test("import:progress fires at least once during a batch import (cadence not pinned)", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const progressPayloads: unknown[] = [];

      importer.on("import:progress", (payload) => {
        progressPayloads.push(payload);
      });

      await importer.import(Buffer.from(CSV_CONTENT, "utf8"));

      expect(progressPayloads.length).toBeGreaterThanOrEqual(1);
    });

    test("importStream() emits import:completed with a real, non-negative durationMs (SF4)", async () => {
      const importer = new Core.M3LCSVListImporter<UserRow>({});
      let completedPayload:
        { processed: number; durationMs: number } | undefined;

      importer.on("import:completed", (payload) => {
        completedPayload = payload;
      });

      const seen: UserRow[] = [];
      for await (const row of importer.importStream(
        Buffer.from(CSV_CONTENT, "utf8"),
      )) {
        seen.push(row);
      }

      expect(seen).toHaveLength(2);
      expect(completedPayload).toBeDefined();
      expect(typeof completedPayload?.durationMs).toBe("number");
      expect(completedPayload?.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("handler isolation — a throwing import:item handler does not prevent a second handler from running", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const importer = new Core.M3LCSVListImporter<UserRow>({});
      const secondHandlerLog: number[] = [];

      importer.on("import:item", () => {
        throw new Error("first handler boom");
      });
      importer.on("import:item", (payload) => {
        secondHandlerLog.push(payload.index);
      });

      await expect(
        importer.import(Buffer.from(CSV_CONTENT, "utf8")),
      ).resolves.toBeDefined();
      expect(secondHandlerLog).toEqual([0, 1]);
    });
  });

  describe("M3LCSVListImporter type-level contract", () => {
    test("implements M3LListImporter<TItem>", () => {
      expectTypeOf<Core.M3LCSVListImporter<UserRow>>().toMatchTypeOf<
        M3LListImporter<UserRow>
      >();
    });
  });
});

// =============================================================================
// M3LJSONListImporter
// =============================================================================
describe("M3LJSONListImporter", () => {
  describe("format dispatch", () => {
    test("imports a JSON-array Buffer via the JSON-array branch", async () => {
      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});
      const result = await importer.import(
        Buffer.from(JSON_ARRAY_CONTENT, "utf8"),
      );

      expect(result.items).toEqual([
        { id: 1, name: "Ada", metadata: { author: "Lovelace" } },
        { id: 2, name: "Grace", metadata: { author: "Hopper" } },
      ]);
    });

    test("imports a JSONL Buffer via the line-by-line branch", async () => {
      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});
      const result = await importer.import(Buffer.from(JSONL_CONTENT, "utf8"));

      expect(result.items).toEqual([
        { id: 1, name: "Ada", metadata: { author: "Lovelace" } },
        { id: 2, name: "Grace", metadata: { author: "Hopper" } },
      ]);
    });

    test("a file-path JSON-array source and an equivalent Buffer source yield identical items", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON_ARRAY_CONTENT);
      vi.spyOn(fs, "open").mockImplementation(() =>
        Promise.resolve(fakeJSONFileHandle(JSON_ARRAY_CONTENT)),
      );

      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});
      const fromPath = await importer.import("/fixtures/records.json");
      const fromBuffer = await importer.import(
        Buffer.from(JSON_ARRAY_CONTENT, "utf8"),
      );

      expect(fromPath.items).toEqual(fromBuffer.items);
    });

    test("rejects with M3LError when the format cannot be detected (undetectable content)", async () => {
      const importer = new Core.M3LJSONListImporter<unknown>({});

      const thrown: unknown = await importer
        .import(Buffer.from("not json and not jsonl at all", "utf8"))
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect(["ERR_IMPORT_SOURCE", "ERR_IMPORT_PARSE"]).toContain(
        (thrown as InstanceType<typeof Core.M3LError>).code,
      );
    });

    test("rejects with M3LError ERR_IMPORT_SOURCE when neither options.filePath nor a per-call source is supplied", async () => {
      const importer = new Core.M3LJSONListImporter<unknown>({});

      const thrown: unknown = await importer.import().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
        "ERR_IMPORT_SOURCE",
      );
    });

    test("a malformed JSON-array document rejects with M3LError code ERR_IMPORT_PARSE", async () => {
      const importer = new Core.M3LJSONListImporter<unknown>({});

      const thrown: unknown = await importer
        .import(Buffer.from("[{ this is not valid JSON", "utf8"))
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
        "ERR_IMPORT_PARSE",
      );
    });

    test("a bad JSONL line is skipped via import:error, good lines are still returned", async () => {
      const withBadLine = [
        JSON.stringify({ id: 1, name: "Ada" }),
        "{ not valid json",
        JSON.stringify({ id: 2, name: "Grace" }),
      ].join("\n");

      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});

      const errorPayloads: { error: unknown; index?: number }[] = [];
      importer.on("import:error", (payload) => {
        errorPayloads.push(payload);
      });

      const result = await importer.import(Buffer.from(withBadLine, "utf8"));

      expect(result.items).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ]);
      expect(errorPayloads.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("importStream() — streaming", () => {
    test("streams JSONL items one at a time", async () => {
      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});
      const seen: { readonly id: number; readonly name: string }[] = [];
      for await (const item of importer.importStream(
        Buffer.from(JSONL_CONTENT, "utf8"),
      )) {
        seen.push(item);
      }
      expect(seen).toEqual([
        { id: 1, name: "Ada", metadata: { author: "Lovelace" } },
        { id: 2, name: "Grace", metadata: { author: "Hopper" } },
      ]);
    });

    test("the generator's return value reports processed/skipped/durationMs counts, good lines still yielded (F6)", async () => {
      const withBadLine = [
        JSON.stringify({ id: 1, name: "Ada" }),
        "{ not valid json",
        JSON.stringify({ id: 2, name: "Grace" }),
      ].join("\n");

      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});

      const stream = importer.importStream(Buffer.from(withBadLine, "utf8"));
      const yielded: { readonly id: number; readonly name: string }[] = [];
      let step = await stream.next();
      while (step.done === false) {
        yielded.push(step.value);
        step = await stream.next();
      }
      if (step.done !== true) {
        throw new Error("importStream did not complete");
      }
      const summary: M3LImportStreamSummary = step.value;

      expect(yielded).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ]);
      expect(summary.skipped).toBe(1);
      expect(summary.processed).toBe(yielded.length + summary.skipped);
      expect(typeof summary.durationMs).toBe("number");
    });
  });

  describe("fieldPath extraction (reuses M3LJSONFieldExtractor / navigateFieldPath)", () => {
    test("extracts a nested field via dot-notation fieldPath", async () => {
      const importer = new Core.M3LJSONListImporter<string>({
        fieldPath: "metadata.author",
      });
      const result = await importer.import(
        Buffer.from(JSON_ARRAY_CONTENT, "utf8"),
      );

      expect(result.items).toEqual(["Lovelace", "Hopper"]);
    });

    test("a missing fieldPath segment resolves to undefined for that item (not a thrown error)", async () => {
      const importer = new Core.M3LJSONListImporter<unknown>({
        fieldPath: "metadata.missingField",
      });
      const result = await importer.import(
        Buffer.from(JSON_ARRAY_CONTENT, "utf8"),
      );

      expect(result.items).toEqual([undefined, undefined]);
    });

    test("a digit fieldPath segment indexes into an array", async () => {
      const arrayContent = JSON.stringify([{ items: ["x", "y"] }]);
      const firstIndexImporter = new Core.M3LJSONListImporter<unknown>({
        fieldPath: "items.0",
      });
      const firstResult = await firstIndexImporter.import(
        Buffer.from(arrayContent, "utf8"),
      );

      expect(firstResult.items).toEqual(["x"]);

      const secondIndexImporter = new Core.M3LJSONListImporter<unknown>({
        fieldPath: "items.1",
      });
      const secondResult = await secondIndexImporter.import(
        Buffer.from(arrayContent, "utf8"),
      );

      expect(secondResult.items).toEqual(["y"]);
    });

    describe("fieldPath branch also screens dangerous own-keys (A)", () => {
      test.each(["__proto__", "constructor"])(
        "a fieldPath landing on a nested object with a genuine own %j key is skipped via import:error, a clean record at the same path still comes through",
        async (dangerousKey) => {
          const poisonedLine = JSON.parse(
            `{"metadata":{"${dangerousKey}":{"x":1},"a":1},"id":"poisoned"}`,
          ) as Record<string, unknown>;
          const poisonedMetadata = poisonedLine["metadata"];
          // Confirms the fixture's fieldPath TARGET itself carries a genuine
          // own dangerous key — otherwise this test would prove nothing.
          expect(
            typeof poisonedMetadata === "object" && poisonedMetadata !== null
              ? Object.keys(poisonedMetadata)
              : [],
          ).toContain(dangerousKey);

          const withBadLine = [
            JSON.stringify({ metadata: { a: 1 }, id: "ok-1" }),
            JSON.stringify(poisonedLine),
            JSON.stringify({ metadata: { a: 2 }, id: "ok-2" }),
          ].join("\n");

          const importer = new Core.M3LJSONListImporter<unknown>({
            fieldPath: "metadata",
          });
          const errorPayloads: { error: unknown; index?: number }[] = [];
          importer.on("import:error", (payload) => {
            errorPayloads.push(payload);
          });

          const result = await importer.import(
            Buffer.from(withBadLine, "utf8"),
          );

          expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
          expect(errorPayloads).toHaveLength(1);
          expect(errorPayloads[0]?.error).toBeInstanceOf(Core.M3LError);
        },
      );
    });
  });

  describe("no-fieldPath passthrough sanitizes dangerous own-keys (SF2)", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "a JSONL record with a genuine own %j key is skipped via import:error, clean records still come through",
      async (dangerousKey) => {
        const poisoned = JSON.parse(
          `{"${dangerousKey}":{"x":1},"id":"poisoned"}`,
        ) as Record<string, unknown>;
        // Confirms the fixture actually carries a genuine OWN dangerous key
        // (JSON.parse, unlike an object literal, creates a real own property
        // for a `"__proto__"` string key) — otherwise this test would prove
        // nothing.
        expect(Object.keys(poisoned)).toContain(dangerousKey);

        const withBadLine = [
          JSON.stringify({ id: "ok-1" }),
          JSON.stringify(poisoned),
          JSON.stringify({ id: "ok-2" }),
        ].join("\n");

        const importer = new Core.M3LJSONListImporter<{ id: string }>({});
        const errorPayloads: { error: unknown; index?: number }[] = [];
        importer.on("import:error", (payload) => {
          errorPayloads.push(payload);
        });

        const result = await importer.import(Buffer.from(withBadLine, "utf8"));

        expect(result.items).toEqual([{ id: "ok-1" }, { id: "ok-2" }]);
        expect(errorPayloads).toHaveLength(1);
        expect(errorPayloads[0]?.error).toBeInstanceOf(Core.M3LError);
      },
    );
  });

  describe("streaming import:completed.durationMs (SF4)", () => {
    test("importStream() emits import:completed with a real, non-negative durationMs", async () => {
      const importer = new Core.M3LJSONListImporter<{
        readonly id: number;
        readonly name: string;
      }>({});
      let completedPayload:
        { processed: number; durationMs: number } | undefined;

      importer.on("import:completed", (payload) => {
        completedPayload = payload;
      });

      const seen: unknown[] = [];
      for await (const item of importer.importStream(
        Buffer.from(JSONL_CONTENT, "utf8"),
      )) {
        seen.push(item);
      }

      expect(seen).toHaveLength(2);
      expect(completedPayload).toBeDefined();
      expect(typeof completedPayload?.durationMs).toBe("number");
      expect(completedPayload?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("file-path format-detection failure propagates unwrapped (code-review #4)", () => {
    test("import() surfaces the reused detector's M3LJSONFormatDetectionError directly, not re-wrapped", async () => {
      const readError = Object.assign(new Error("EIO: i/o error, read"), {
        code: "EIO",
      });
      // readSourceBytes() reads the source before format detection runs, so
      // that read must succeed for the (mocked) detector failure to be what
      // actually surfaces.
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON_ARRAY_CONTENT);
      vi.spyOn(fs, "open").mockImplementation(() =>
        Promise.resolve(fakeFailingJSONFileHandle(readError)),
      );

      const importer = new Core.M3LJSONListImporter<unknown>({});

      const thrown: unknown = await importer
        .import("/fixtures/unreadable.json")
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Core.M3LJSONFormatDetectionError);
      expect(thrown).toBeInstanceOf(Core.M3LError);
      // Not re-wrapped: the detector's own error code, not an importer code.
      expect((thrown as InstanceType<typeof Core.M3LError>).code).not.toBe(
        "ERR_IMPORT_SOURCE",
      );
      expect((thrown as InstanceType<typeof Core.M3LError>).cause).toBe(
        readError,
      );
    });

    test("importStream() surfaces the reused detector's M3LJSONFormatDetectionError directly, not re-wrapped", async () => {
      const readError = Object.assign(new Error("EIO: i/o error, read"), {
        code: "EIO",
      });
      // readSourceBytes() reads the source before format detection runs, so
      // that read must succeed for the (mocked) detector failure to be what
      // actually surfaces.
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON_ARRAY_CONTENT);
      vi.spyOn(fs, "open").mockImplementation(() =>
        Promise.resolve(fakeFailingJSONFileHandle(readError)),
      );

      const importer = new Core.M3LJSONListImporter<unknown>({});

      const consume = async (): Promise<void> => {
        for await (const _item of importer.importStream(
          "/fixtures/unreadable.json",
        )) {
          // draining is enough to trigger the detection failure
        }
      };

      await expect(consume()).rejects.toBeInstanceOf(
        Core.M3LJSONFormatDetectionError,
      );
    });
  });

  describe("detectionDepth option", () => {
    test("options.detectionDepth is accepted and forwarded to format detection", async () => {
      const importer = new Core.M3LJSONListImporter<unknown>({
        detectionDepth: "deep",
      });
      const result = await importer.import(
        Buffer.from(JSON_ARRAY_CONTENT, "utf8"),
      );

      expect(result.items).toHaveLength(2);
    });
  });

  describe("M3LJSONListImporter type-level contract", () => {
    test("implements M3LListImporter<TItem>", () => {
      expectTypeOf<Core.M3LJSONListImporter<{ id: number }>>().toMatchTypeOf<
        M3LListImporter<{ id: number }>
      >();
    });
  });
});

// =============================================================================
// Whole-file importers
// =============================================================================
describe("M3LFileImporter", () => {
  test("read() returns the raw bytes of a Buffer source as-is", async () => {
    const importer = new Core.M3LFileImporter();
    const source = Buffer.from("raw bytes", "utf8");
    const result = await importer.read(source);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.equals(source)).toBe(true);
  });

  test("read() returns the raw bytes of a file-path source", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      Buffer.from("file bytes", "utf8"),
    );
    const importer = new Core.M3LFileImporter();
    const result = await importer.read("/fixtures/anything.bin");
    expect(result.equals(Buffer.from("file bytes", "utf8"))).toBe(true);
  });

  test("read() rejects with M3LError code ERR_IMPORT_SOURCE for a missing file, chaining the fs error", async () => {
    const fsError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(fsError);
    const importer = new Core.M3LFileImporter();

    let thrown: unknown;
    try {
      await importer.read("/fixtures/does-not-exist.bin");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
      "ERR_IMPORT_SOURCE",
    );
    expect((thrown as InstanceType<typeof Core.M3LError>).cause).toBe(fsError);
  });

  describe("type-level contract", () => {
    test("read() returns Promise<Buffer>", () => {
      expectTypeOf<M3LFileImporter["read"]>().returns.toEqualTypeOf<
        Promise<Buffer>
      >();
    });
  });
});

describe("M3LTextFileImporter", () => {
  test("read() returns decoded UTF-8 text from a Buffer source", async () => {
    const importer = new Core.M3LTextFileImporter();
    const result = await importer.read(Buffer.from("hello world", "utf8"));
    expect(result).toBe("hello world");
  });

  test("read() returns decoded UTF-8 text from a file-path source", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue("text file content");
    const importer = new Core.M3LTextFileImporter();
    const result = await importer.read("/fixtures/notes.txt");
    expect(result).toBe("text file content");
  });

  test("read() rejects with M3LError code ERR_IMPORT_SOURCE for a missing file", async () => {
    const fsError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(fsError);
    const importer = new Core.M3LTextFileImporter();

    const thrown: unknown = await importer
      .read("/fixtures/missing.txt")
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
      "ERR_IMPORT_SOURCE",
    );
  });

  describe("type-level contract", () => {
    test("read() returns Promise<string>", () => {
      expectTypeOf<M3LTextFileImporter["read"]>().returns.toEqualTypeOf<
        Promise<string>
      >();
    });
  });
});

describe("M3LJSONFileImporter", () => {
  test("read() parses a whole JSON document from a Buffer source", async () => {
    const importer = new Core.M3LJSONFileImporter();
    const result = await importer.read<{ id: number; name: string }[]>(
      Buffer.from(JSON_ARRAY_CONTENT, "utf8"),
    );
    expect(result).toEqual([
      { id: 1, name: "Ada", metadata: { author: "Lovelace" } },
      { id: 2, name: "Grace", metadata: { author: "Hopper" } },
    ]);
  });

  test("read() parses a whole JSON document from a file-path source", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON_ARRAY_CONTENT);
    const importer = new Core.M3LJSONFileImporter();
    const result = await importer.read("/fixtures/records.json");
    expect(result).toEqual([
      { id: 1, name: "Ada", metadata: { author: "Lovelace" } },
      { id: 2, name: "Grace", metadata: { author: "Hopper" } },
    ]);
  });

  test("read() rejects with M3LError code ERR_IMPORT_PARSE for malformed JSON", async () => {
    const importer = new Core.M3LJSONFileImporter();

    const thrown: unknown = await importer
      .read(Buffer.from("{ not valid json", "utf8"))
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
      "ERR_IMPORT_PARSE",
    );
  });

  test("read() rejects with M3LError code ERR_IMPORT_SOURCE for a missing file", async () => {
    const fsError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(fsError);
    const importer = new Core.M3LJSONFileImporter();

    const thrown: unknown = await importer
      .read("/fixtures/missing.json")
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
      "ERR_IMPORT_SOURCE",
    );
  });
});

describe("M3LFileListImporter", () => {
  test("read() reads several sources and returns their raw contents in order", async () => {
    const importer = new Core.M3LFileListImporter();
    const sources = [
      Buffer.from("first", "utf8"),
      Buffer.from("second", "utf8"),
    ];
    const result = await importer.read(sources);

    expect(result).toHaveLength(2);
    expect((result[0] as Buffer).equals(Buffer.from("first", "utf8"))).toBe(
      true,
    );
    expect((result[1] as Buffer).equals(Buffer.from("second", "utf8"))).toBe(
      true,
    );
  });

  test("read() supports a mix of file-path and Buffer sources", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(
      Buffer.from("from disk", "utf8"),
    );
    const importer = new Core.M3LFileListImporter();
    const result = await importer.read([
      "/fixtures/on-disk.bin",
      Buffer.from("in memory", "utf8"),
    ]);

    expect((result[0] as Buffer).equals(Buffer.from("from disk", "utf8"))).toBe(
      true,
    );
    expect((result[1] as Buffer).equals(Buffer.from("in memory", "utf8"))).toBe(
      true,
    );
  });

  test("read() rejects with M3LError code ERR_IMPORT_SOURCE when one source is unreadable", async () => {
    const fsError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(fsError);
    const importer = new Core.M3LFileListImporter();

    const thrown: unknown = await importer
      .read(["/fixtures/missing.bin"])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
      "ERR_IMPORT_SOURCE",
    );
  });

  describe("type-level contract", () => {
    test("read() accepts readonly (string | Buffer)[] and returns Promise<readonly Buffer[]>", () => {
      expectTypeOf<M3LFileListImporter["read"]>()
        .parameter(0)
        .toEqualTypeOf<readonly (string | Buffer)[]>();
      expectTypeOf<M3LFileListImporter["read"]>().returns.toEqualTypeOf<
        Promise<readonly Buffer[]>
      >();
    });
  });
});

// =============================================================================
// CSV adapter / factory
// =============================================================================
describe("M3LCSVFormatAdapter", () => {
  test("is constructible", () => {
    expect(
      () =>
        new Core.M3LCSVFormatAdapter({
          columnMapping: { id: "id", name: "name" },
        }),
    ).not.toThrow();
  });

  test("is usable as the adapter field of M3LCSVListImporterOptions", async () => {
    const adapter = new Core.M3LCSVFormatAdapter({
      columnMapping: { id: "id", name: "name" },
    });
    const importer = new Core.M3LCSVListImporter<UserRow>({ adapter });

    const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));
    expect(result.items).toEqual([
      { id: "1", name: "Ada" },
      { id: "2", name: "Grace" },
    ]);
  });

  describe("dangerous columnMapping target-key guard (SF1)", () => {
    test.each(["__proto__", "constructor", "prototype"])(
      "throws M3LError code ERR_IMPORT_VALIDATION at construction when a columnMapping target key is %j",
      (dangerousKey) => {
        let thrown: unknown;
        try {
          new Core.M3LCSVFormatAdapter({
            columnMapping: { id: dangerousKey },
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Core.M3LError);
        expect((thrown as InstanceType<typeof Core.M3LError>).code).toBe(
          "ERR_IMPORT_VALIDATION",
        );
      },
    );
  });
});

describe("M3LCSVAdapterFactory", () => {
  test("is constructible", () => {
    expect(() => new Core.M3LCSVAdapterFactory()).not.toThrow();
  });

  test("create() yields an M3LCSVFormatAdapter usable as an options adapter", async () => {
    const factory = new Core.M3LCSVAdapterFactory();
    const adapter = factory.create({
      columnMapping: { id: "id", name: "name" },
    });

    const importer = new Core.M3LCSVListImporter<UserRow>({ adapter });
    const result = await importer.import(Buffer.from(CSV_CONTENT, "utf8"));
    expect(result.items).toEqual([
      { id: "1", name: "Ada" },
      { id: "2", name: "Grace" },
    ]);
  });
});

// =============================================================================
// Type-level contract — M3LListImporter / M3LListImporterEvents / M3LListImporterResult
// =============================================================================
describe("M3LListImporter<TItem> generic contract", () => {
  test("import() returns Promise<M3LListImporterResult<TItem>>", () => {
    expectTypeOf<
      M3LListImporter<{ id: number }>["import"]
    >().returns.toEqualTypeOf<Promise<M3LListImporterResult<{ id: number }>>>();
  });

  test("importStream() returns AsyncGenerator<TItem, M3LImportStreamSummary, void> (F6)", () => {
    expectTypeOf<
      M3LListImporter<{ id: number }>["importStream"]
    >().returns.toEqualTypeOf<
      AsyncGenerator<{ id: number }, M3LImportStreamSummary, void>
    >();
  });
});

// =============================================================================
// Type-level contract — M3LImportStreamSummary (F6)
// =============================================================================
describe("M3LImportStreamSummary type-level contract (F6)", () => {
  test("has readonly processed, skipped, and durationMs number fields", () => {
    expectTypeOf<M3LImportStreamSummary>().toEqualTypeOf<{
      readonly processed: number;
      readonly skipped: number;
      readonly durationMs: number;
    }>();
  });
});

describe("M3LListImporterEvents<TItem> type-level contract", () => {
  test("has exactly the 5 documented import:* keys", () => {
    expectTypeOf<keyof M3LListImporterEvents<{ id: number }>>().toEqualTypeOf<
      | "import:started"
      | "import:item"
      | "import:progress"
      | "import:error"
      | "import:completed"
    >();
  });

  test("import:item payload carries TItem", () => {
    expectTypeOf<
      M3LListImporterEvents<{ id: number }>["import:item"]
    >().toMatchTypeOf<{ item: { id: number }; index: number }>();
  });

  test("import:progress and import:completed payloads carry a numeric processed count", () => {
    expectTypeOf<
      M3LListImporterEvents<{ id: number }>["import:progress"]
    >().toMatchTypeOf<{ processed: number }>();
    expectTypeOf<
      M3LListImporterEvents<{ id: number }>["import:completed"]
    >().toMatchTypeOf<{ processed: number }>();
  });
});

describe("M3LListImporterResult<TItem> type-level contract", () => {
  test("items is a readonly array of TItem", () => {
    expectTypeOf<
      M3LListImporterResult<{ id: number }>["items"]
    >().toEqualTypeOf<readonly { id: number }[]>();
  });
});

// =============================================================================
// Options types — minimal shape assertions (kept loose; only pinned fields)
// =============================================================================
describe("M3LCSVListImporterOptions type-level contract", () => {
  test("filePath is an optional string", () => {
    expectTypeOf<M3LCSVListImporterOptions<unknown>>().toHaveProperty(
      "filePath",
    );
  });
});

describe("M3LJSONListImporterOptions type-level contract", () => {
  test("fieldPath and detectionDepth are optional fields", () => {
    expectTypeOf<M3LJSONListImporterOptions<unknown>>().toHaveProperty(
      "fieldPath",
    );
    expectTypeOf<M3LJSONListImporterOptions<unknown>>().toHaveProperty(
      "detectionDepth",
    );
  });
});
