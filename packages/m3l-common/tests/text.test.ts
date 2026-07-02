/**
 * Tests for core/text submodule (RED phase — implementation does not exist yet).
 *
 * Contract source: docs/reference/core/text.md + the frozen type/registry
 * contract supplied for this change set.
 *
 * Exports under test (12): M3LTextExtractorRegistry, M3LPlainTextExtractor,
 *   M3LPdfTextExtractor, M3LDocxTextExtractor, M3LXlsxTextExtractor,
 *   M3LEmailTextExtractor, M3LZipTextExtractor, ZIP_DEPTH_SYMBOL,
 *   M3LTextExtractor (interface), M3LTextExtractionOptions,
 *   M3LTextExtractionResult, M3LTextExtractionError.
 *
 * Fixture strategy: every happy path uses a REAL committed fixture under
 *   tests/fixtures/text/ parsed by the REAL backing library — txt, eml
 *   (plain + html), zip (flat/nested/deep-chain), docx, xlsx, pdf. No format
 *   is mocked for its happy path. The absent-library and lazy-load paths use
 *   vi.doMock on the backing package (the libs ARE installed, so absence can
 *   only be simulated by mocking the dynamic import to reject).
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import AdmZip from "adm-zip";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { M3LError } from "../src/core/errors/index.js";

import {
  M3LDocxTextExtractor,
  M3LEmailTextExtractor,
  M3LPdfTextExtractor,
  M3LPlainTextExtractor,
  M3LTextExtractionError,
  M3LTextExtractorRegistry,
  M3LXlsxTextExtractor,
  M3LZipTextExtractor,
  ZIP_DEPTH_SYMBOL,
} from "../src/core/text/index.js";

import type {
  M3LTextExtractionOptions,
  M3LTextExtractionResult,
  M3LTextExtractor,
} from "../src/core/text/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/text/", import.meta.url));
const fixture = (name: string): string => path.join(FIXTURE_DIR, name);

const MIME = {
  txt: "text/plain",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  eml: "message/rfc822",
  zip: "application/zip",
} as const;

// ---------------------------------------------------------------------------
// Type-level contracts (the type IS the contract)
// ---------------------------------------------------------------------------
describe("type contracts", () => {
  test("M3LTextExtractionResult has string text, boolean truncated, optional numeric pages", () => {
    // Result fields are readonly, and toMatchObjectType compares mutability,
    // so the expected shape must mark them readonly too.
    expectTypeOf<M3LTextExtractionResult>().toMatchObjectType<{
      readonly text: string;
      readonly truncated: boolean;
    }>();
    expectTypeOf<M3LTextExtractionResult["text"]>().toEqualTypeOf<string>();
    expectTypeOf<
      M3LTextExtractionResult["truncated"]
    >().toEqualTypeOf<boolean>();
    // pages is optional and numeric where present.
    expectTypeOf<M3LTextExtractionResult["pages"]>().toEqualTypeOf<
      number | undefined
    >();
  });

  test("M3LTextExtractor declares readonly mimeTypes/extensions and an async extract", () => {
    expectTypeOf<M3LTextExtractor["mimeTypes"]>().toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf<M3LTextExtractor["extensions"]>().toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf<
      M3LTextExtractor["extract"]
    >().returns.resolves.toEqualTypeOf<M3LTextExtractionResult>();
  });

  test("extract accepts an optional options argument", () => {
    expectTypeOf<M3LTextExtractor["extract"]>()
      .parameter(0)
      .toEqualTypeOf<string>();
    expectTypeOf<M3LTextExtractor["extract"]>()
      .parameter(1)
      .toEqualTypeOf<M3LTextExtractionOptions | undefined>();
  });

  test("ZIP_DEPTH_SYMBOL is a symbol used as an OPTIONAL object KEY on the options", () => {
    expectTypeOf(ZIP_DEPTH_SYMBOL).toEqualTypeOf<typeof ZIP_DEPTH_SYMBOL>();
    // Used as a computed key carrying an optional number — not a named field.
    expectTypeOf<
      M3LTextExtractionOptions[typeof ZIP_DEPTH_SYMBOL]
    >().toEqualTypeOf<number | undefined>();
    const opts: M3LTextExtractionOptions = { [ZIP_DEPTH_SYMBOL]: 1 };
    expect(typeof ZIP_DEPTH_SYMBOL).toBe("symbol");
    expect(opts[ZIP_DEPTH_SYMBOL]).toBe(1);
  });

  test("the public size/breadth caps are optional numeric fields on the options", () => {
    // maxEntries / maxTotalBytes are the two public caps guarding the ZIP
    // extractor against breadth and size attacks — both optional numbers.
    expectTypeOf<M3LTextExtractionOptions["maxEntries"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<M3LTextExtractionOptions["maxTotalBytes"]>().toEqualTypeOf<
      number | undefined
    >();
    // A legal options literal setting both caps type-checks.
    const opts: M3LTextExtractionOptions = {
      maxEntries: 100,
      maxTotalBytes: 1_000_000,
    };
    expect(opts.maxEntries).toBe(100);
    expect(opts.maxTotalBytes).toBe(1_000_000);
  });

  test("every concrete extractor satisfies the M3LTextExtractor interface", () => {
    expectTypeOf<M3LPlainTextExtractor>().toExtend<M3LTextExtractor>();
    expectTypeOf<M3LPdfTextExtractor>().toExtend<M3LTextExtractor>();
    expectTypeOf<M3LDocxTextExtractor>().toExtend<M3LTextExtractor>();
    expectTypeOf<M3LXlsxTextExtractor>().toExtend<M3LTextExtractor>();
    expectTypeOf<M3LEmailTextExtractor>().toExtend<M3LTextExtractor>();
    expectTypeOf<M3LZipTextExtractor>().toExtend<M3LTextExtractor>();
  });
});

// ---------------------------------------------------------------------------
// M3LTextExtractionError
// ---------------------------------------------------------------------------
describe("M3LTextExtractionError", () => {
  test("is an M3LError subclass carrying message, code and cause", () => {
    const cause = new Error("underlying");
    const e = new M3LTextExtractionError("extraction failed", {
      code: "ERR_TEXT_EXTRACTION",
      cause,
    });
    expect(e).toBeInstanceOf(M3LError);
    expect(e).toBeInstanceOf(M3LTextExtractionError);
    expect(e.message).toBe("extraction failed");
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("M3LTextExtractionError");
  });

  test("tolerates a non-Error cause per the M3LErrorOptions unknown-tolerant contract", () => {
    // `cause` is typed `unknown` (M3LErrorOptions), so a bare string is accepted.
    const e = new M3LTextExtractionError("boom", {
      code: "ERR_TEXT_EXTRACTION",
      cause: "a bare string cause",
    });
    expect(e.cause).toBe("a bare string cause");
  });
});

// ---------------------------------------------------------------------------
// M3LPlainTextExtractor — core, Node fs, no optional lib (C5)
// ---------------------------------------------------------------------------
describe("M3LPlainTextExtractor", () => {
  test("declares text/plain and .txt support", () => {
    const ex = new M3LPlainTextExtractor();
    expect(ex.mimeTypes).toContain(MIME.txt);
    expect(ex.extensions).toContain(".txt");
  });

  test("extracts a real .txt file into the uniform result shape", async () => {
    const ex = new M3LPlainTextExtractor();
    const result = await ex.extract(fixture("sample.txt"));
    expect(result.text).toContain("Hello plain text world.");
    expect(result.text).toContain("Second line.");
    expect(result.truncated).toBe(false);
    // A plain text file exposes no page count.
    expect(result.pages).toBeUndefined();
  });

  test("wraps a read failure as M3LTextExtractionError chaining the fs cause", async () => {
    const ex = new M3LPlainTextExtractor();
    let thrown: unknown;
    try {
      await ex.extract(fixture("does-not-exist.txt"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    expect((thrown as M3LTextExtractionError).cause).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Registry construction + registration
// ---------------------------------------------------------------------------
describe("M3LTextExtractorRegistry construction", () => {
  test("defaults to a single M3LPlainTextExtractor when no argument is passed", async () => {
    const registry = new M3LTextExtractorRegistry();
    // The default registry can extract plain text out of the box.
    const result = await registry.extract(MIME.txt, fixture("sample.txt"));
    expect(result.text).toContain("Hello plain text world.");
  });

  test("with an explicit array registers only those extractors and adds NO default", async () => {
    // An empty registry has no PlainText fallback, so a .txt lookup fails.
    const registry = new M3LTextExtractorRegistry([]);
    let thrown: unknown;
    try {
      await registry.extract(MIME.txt, fixture("sample.txt"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
  });

  test("register() appends an extractor so it becomes usable", async () => {
    const registry = new M3LTextExtractorRegistry([]);
    registry.register(new M3LPlainTextExtractor());
    const result = await registry.extract(MIME.txt, fixture("sample.txt"));
    expect(result.text).toContain("Hello plain text world.");
  });
});

// ---------------------------------------------------------------------------
// Registry dispatch: C1 MIME-first, C2 extension fallback, C3 first-wins
// ---------------------------------------------------------------------------
describe("M3LTextExtractorRegistry dispatch", () => {
  test("C1 dispatches by MIME type to the first matching extractor", async () => {
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    const result = await registry.extract(MIME.txt, fixture("sample.txt"));
    expect(result.text).toContain("Hello plain text world.");
  });

  test("C2 falls back to file extension when no MIME type matches", async () => {
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    // Unknown/octet-stream MIME → extension ".txt" drives the dispatch.
    const result = await registry.extract(
      "application/octet-stream",
      fixture("sample.txt"),
    );
    expect(result.text).toContain("Hello plain text world.");
  });

  test("C3 first-registered wins when two extractors support the same format", async () => {
    const marker: M3LTextExtractionResult = {
      text: "FROM-FIRST-EXTRACTOR",
      truncated: false,
    };
    const firstExtract = vi.fn().mockResolvedValue(marker);
    const first: M3LTextExtractor = {
      mimeTypes: [MIME.txt],
      extensions: [".txt"],
      extract: firstExtract,
    };
    const secondExtract = vi.fn().mockResolvedValue({
      text: "FROM-SECOND-EXTRACTOR",
      truncated: false,
    } satisfies M3LTextExtractionResult);
    const second: M3LTextExtractor = {
      mimeTypes: [MIME.txt],
      extensions: [".txt"],
      extract: secondExtract,
    };
    const registry = new M3LTextExtractorRegistry([first, second]);
    const result = await registry.extract(MIME.txt, fixture("sample.txt"));
    expect(result.text).toBe("FROM-FIRST-EXTRACTOR");
    expect(firstExtract).toHaveBeenCalledTimes(1);
    expect(secondExtract).not.toHaveBeenCalled();
  });

  test("throws M3LTextExtractionError naming the unsupported MIME type and extension", async () => {
    const registry = new M3LTextExtractorRegistry([]);
    let thrown: unknown;
    try {
      await registry.extract("application/x-unknown", "/tmp/file.weird");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    const message = (thrown as M3LTextExtractionError).message;
    expect(message).toContain("application/x-unknown");
    expect(message).toContain(".weird");
  });
});

// ---------------------------------------------------------------------------
// Optional extractors — happy paths against REAL fixtures + REAL libs
// ---------------------------------------------------------------------------
describe("M3LPdfTextExtractor (real unpdf + real fixture)", () => {
  test("declares application/pdf and .pdf support", () => {
    const ex = new M3LPdfTextExtractor();
    expect(ex.mimeTypes).toContain(MIME.pdf);
    expect(ex.extensions).toContain(".pdf");
  });

  test("C4 extracts PDF text AND a page count (pages present for PDF)", async () => {
    const ex = new M3LPdfTextExtractor();
    const result = await ex.extract(fixture("sample.pdf"));
    expect(result.text).toContain("Hello PDF text.");
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(1);
  });
});

describe("M3LDocxTextExtractor (real mammoth + real fixture)", () => {
  test("declares the DOCX MIME type and .docx support", () => {
    const ex = new M3LDocxTextExtractor();
    expect(ex.mimeTypes).toContain(MIME.docx);
    expect(ex.extensions).toContain(".docx");
  });

  test("extracts DOCX raw text into the uniform result shape", async () => {
    const ex = new M3LDocxTextExtractor();
    const result = await ex.extract(fixture("sample.docx"));
    expect(result.text).toContain("Hello DOCX paragraph.");
    expect(result.truncated).toBe(false);
  });
});

describe("M3LXlsxTextExtractor (real read-excel-file + real fixture)", () => {
  test("declares the XLSX MIME type and .xlsx support", () => {
    const ex = new M3LXlsxTextExtractor();
    expect(ex.mimeTypes).toContain(MIME.xlsx);
    expect(ex.extensions).toContain(".xlsx");
  });

  test("extracts spreadsheet cell text (headers + values)", async () => {
    const ex = new M3LXlsxTextExtractor();
    const result = await ex.extract(fixture("sample.xlsx"));
    expect(result.text).toContain("Name");
    expect(result.text).toContain("Value");
    expect(result.text).toContain("Alpha");
    expect(result.text).toContain("42");
    expect(result.truncated).toBe(false);
  });
});

describe("M3LEmailTextExtractor (real mailparser + cheerio + real fixture)", () => {
  test("declares message/rfc822 and .eml support", () => {
    const ex = new M3LEmailTextExtractor();
    expect(ex.mimeTypes).toContain(MIME.eml);
    expect(ex.extensions).toContain(".eml");
  });

  test("extracts headers and the plain-text body", async () => {
    const ex = new M3LEmailTextExtractor();
    const result = await ex.extract(fixture("sample.eml"));
    expect(result.text).toContain("Test Email Subject");
    expect(result.text).toContain("This is the plain text body of the email.");
    expect(result.truncated).toBe(false);
  });

  test("converts an HTML body to text via cheerio", async () => {
    const ex = new M3LEmailTextExtractor();
    const result = await ex.extract(fixture("sample-html.eml"));
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("HTML");
    // HTML tags must not leak into the extracted text.
    expect(result.text).not.toContain("<p>");
    expect(result.text).not.toContain("<body>");
  });
});

// ---------------------------------------------------------------------------
// M3LZipTextExtractor — recursion (C13) + depth cap (C14)
// ---------------------------------------------------------------------------
describe("M3LZipTextExtractor (real adm-zip + real fixtures)", () => {
  test("declares application/zip and .zip support", () => {
    const ex = new M3LZipTextExtractor();
    expect(ex.mimeTypes).toContain(MIME.zip);
    expect(ex.extensions).toContain(".zip");
  });

  test("C13 extracts text entries and re-dispatches nested entries through the registry", async () => {
    // A registry with plain-text + zip lets nested .zip entries recurse.
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    registry.register(new M3LZipTextExtractor(registry));
    const result = await registry.extract(MIME.zip, fixture("nested.zip"));
    // top-level .txt entry
    expect(result.text).toContain("Top level text.");
    // entry from the nested child.zip (depth 1 → under the default cap of 2)
    expect(result.text).toContain("Deeply nested text.");
    expect(result.truncated).toBe(false);
  });

  test("C14 stops recursion at the default depth cap of 2", async () => {
    // deep-chain.zip: outer → level1.zip → level2.zip → buried.txt (3 zip levels).
    // With the default cap of 2, the innermost buried.txt is NOT reached.
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    registry.register(new M3LZipTextExtractor(registry));
    const result = await registry.extract(MIME.zip, fixture("deep-chain.zip"));
    expect(result.text).not.toContain("Buried beyond the cap.");
  });

  test("C14 an under-cap depth passed via ZIP_DEPTH_SYMBOL still recurses one level", async () => {
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    const zipExtractor = new M3LZipTextExtractor(registry);
    registry.register(zipExtractor);
    // Starting one below the cap: the flat top entries extract; a single nested
    // level is still permitted before the cap trips.
    const result = await zipExtractor.extract(fixture("nested.zip"), {
      [ZIP_DEPTH_SYMBOL]: 1,
    });
    expect(result.text).toContain("Top level text.");
  });

  test("at the cap, ZIP_DEPTH_SYMBOL prevents further recursion", async () => {
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    const zipExtractor = new M3LZipTextExtractor(registry);
    registry.register(zipExtractor);
    // Already at the cap (2): the nested child.zip must not be descended into.
    const result = await zipExtractor.extract(fixture("nested.zip"), {
      [ZIP_DEPTH_SYMBOL]: 2,
    });
    expect(result.text).toContain("Top level text.");
    expect(result.text).not.toContain("Deeply nested text.");
  });

  test("S1 a hostile large-negative ZIP_DEPTH_SYMBOL is clamped to 0 and cannot deepen recursion past the cap", async () => {
    // deep-chain.zip: outer -> level1.zip -> level2.zip -> buried.txt (3 zip
    // levels). Before the clamp, a large negative starting depth defeated the
    // `depth + 1 >= cap` guard (each +1 stayed far below the cap), recursing
    // arbitrarily deep and reaching buried.txt. The clamp coerces it to 0, so
    // extraction behaves exactly like a default depth-0 start and stops at the cap.
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    registry.register(new M3LZipTextExtractor(registry));
    const result = await registry.extract(MIME.zip, fixture("deep-chain.zip"), {
      [ZIP_DEPTH_SYMBOL]: -1_000_000,
    });
    expect(result.text).not.toContain("Buried beyond the cap.");
    expect(result.truncated).toBe(false);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "S1 a non-finite ZIP_DEPTH_SYMBOL (%s) is treated as depth 0 — no throw, no over-recursion",
    async (_label, hostileDepth) => {
      // A non-finite value takes the `Number.isFinite(raw)` false branch -> 0.
      // It must neither throw nor descend past the cap into buried.txt.
      const registry = new M3LTextExtractorRegistry([
        new M3LPlainTextExtractor(),
      ]);
      registry.register(new M3LZipTextExtractor(registry));
      const result = await registry.extract(
        MIME.zip,
        fixture("deep-chain.zip"),
        { [ZIP_DEPTH_SYMBOL]: hostileDepth },
      );
      expect(result.text).not.toContain("Buried beyond the cap.");
      expect(result.truncated).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Corrupt-fixture failure paths — the REAL backing library throws, exercising
// the statically-imported extractor's `catch` (no vi.resetModules). Each must
// wrap the raw library error as M3LTextExtractionError with a chained cause.
// ---------------------------------------------------------------------------
describe("optional extractor failure paths (corrupt real fixtures)", () => {
  test("M3LPdfTextExtractor wraps a corrupt PDF as M3LTextExtractionError chaining the cause", async () => {
    const ex = new M3LPdfTextExtractor();
    let thrown: unknown;
    try {
      await ex.extract(fixture("corrupt.pdf"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    expect((thrown as M3LTextExtractionError).message).toContain("corrupt.pdf");
    const cause = (thrown as M3LTextExtractionError).cause;
    expect(cause).toBeDefined();
    // The raw library failure is chained, not the wrapper itself.
    expect(cause).not.toBe(thrown);
  });

  test("M3LDocxTextExtractor wraps a corrupt DOCX as M3LTextExtractionError chaining the cause", async () => {
    const ex = new M3LDocxTextExtractor();
    let thrown: unknown;
    try {
      await ex.extract(fixture("corrupt.docx"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    expect((thrown as M3LTextExtractionError).message).toContain(
      "corrupt.docx",
    );
    const cause = (thrown as M3LTextExtractionError).cause;
    expect(cause).toBeDefined();
    expect(cause).not.toBe(thrown);
  });

  test("M3LXlsxTextExtractor wraps a corrupt XLSX as M3LTextExtractionError chaining the cause", async () => {
    const ex = new M3LXlsxTextExtractor();
    let thrown: unknown;
    try {
      await ex.extract(fixture("corrupt.xlsx"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    expect((thrown as M3LTextExtractionError).message).toContain(
      "corrupt.xlsx",
    );
    const cause = (thrown as M3LTextExtractionError).cause;
    expect(cause).toBeDefined();
    expect(cause).not.toBe(thrown);
  });

  test("M3LZipTextExtractor wraps a corrupt ZIP as M3LTextExtractionError chaining the cause", async () => {
    const ex = new M3LZipTextExtractor();
    let thrown: unknown;
    try {
      await ex.extract(fixture("corrupt.zip"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    expect((thrown as M3LTextExtractionError).message).toContain("corrupt.zip");
    const cause = (thrown as M3LTextExtractionError).cause;
    expect(cause).toBeDefined();
    expect(cause).not.toBe(thrown);
  });
});

// ---------------------------------------------------------------------------
// Edge branches — email header shapes + XLSX cell types/multi-sheet
// ---------------------------------------------------------------------------
describe("M3LEmailTextExtractor header edge branches", () => {
  test("renders multiple To: header lines (an address ARRAY) as a comma-joined To header", async () => {
    const ex = new M3LEmailTextExtractor();
    const result = await ex.extract(fixture("multi-to.eml"));
    // Two separate To: lines parse to an address array -> joined with ", ".
    expect(result.text).toContain("To: bob@example.com, carol@example.com");
    // The plain-text body path is still exercised here.
    expect(result.text).toContain("Body for multiple recipient lines.");
  });

  test("omits the To header entirely when the message has no To address", async () => {
    const ex = new M3LEmailTextExtractor();
    const result = await ex.extract(fixture("no-to.eml"));
    // No To: header -> toHeader returns undefined -> filtered out.
    expect(result.text).not.toContain("To:");
    // Missing From/Subject headers are likewise absent (their undefined branch).
    expect(result.text).not.toContain("From:");
    expect(result.text).toContain("Body with no To header.");
  });

  test("emits no header lines and an empty body when subject/from/to and both bodies are absent", async () => {
    const ex = new M3LEmailTextExtractor();
    const result = await ex.extract(fixture("no-headers.eml"));
    // Every header ternary takes its undefined branch; neither the HTML nor the
    // plain-text body is present, so the body falls back to "".
    expect(result.text).not.toContain("Subject:");
    expect(result.text).not.toContain("From:");
    expect(result.text).not.toContain("To:");
    // Only the header/body separator remains -> the trimmed result is empty.
    expect(result.text.trim()).toBe("");
    expect(result.truncated).toBe(false);
  });
});

describe("M3LXlsxTextExtractor cell-type and multi-sheet branches", () => {
  test("renders heterogeneous cell types across multiple sheets", async () => {
    const ex = new M3LXlsxTextExtractor();
    const result = await ex.extract(fixture("multi-sheet.xlsx"));
    // Sheet 1 header + a row exercising string / number / boolean / Date / empty.
    expect(result.text).toContain("Row1");
    expect(result.text).toContain("7");
    expect(result.text).toContain("true"); // boolean cell -> String(true)
    expect(result.text).toContain("2023-01-01T00:00:00.000Z"); // Date -> ISO
    // A second sheet is joined in, proving per-sheet iteration.
    expect(result.text).toContain("SheetTwoCell");
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M3LZipTextExtractor entry-handling branches — directory skip, unsupported
// nested entry (registry can't handle -> skipped), and the no-registry path.
// ---------------------------------------------------------------------------
describe("M3LZipTextExtractor entry-handling branches", () => {
  test("skips directory entries and unsupported nested entries, keeping text entries", async () => {
    // mixed.zip: subdir/ (directory), readme.txt (text), payload.dat (no
    // extractor handles .dat). With a registry present, the .dat re-dispatch
    // fails and is silently skipped; the directory contributes nothing.
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    registry.register(new M3LZipTextExtractor(registry));
    const result = await registry.extract(MIME.zip, fixture("mixed.zip"));
    expect(result.text).toContain("Mixed archive text entry.");
    // The unsupported binary entry's raw bytes must not leak into the output.
    expect(result.text).not.toContain("payload.dat");
    expect(result.truncated).toBe(false);
  });

  test("MF1 a corrupt NESTED archive entry surfaces (rejects) instead of being silently skipped", async () => {
    // broken-nested.zip: ok.txt (text) + broken.zip (garbage bytes, NOT a valid
    // archive). The nested broken.zip is re-dispatched to the ZIP extractor,
    // adm-zip throws -> wrapped as ERR_TEXT_EXTRACTION. That is a REAL failure,
    // not "no extractor supports this entry" (ERR_TEXT_EXTRACTION_UNSUPPORTED),
    // so #dispatchEntry must RE-THROW it and the top-level extract must REJECT
    // rather than resolve with a partial result that just drops the broken entry.
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    registry.register(new M3LZipTextExtractor(registry));

    let thrown: unknown;
    try {
      await registry.extract(MIME.zip, fixture("broken-nested.zip"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LTextExtractionError);
    // The genuine nested failure (a corrupt entry) is chained, not swallowed.
    expect((thrown as M3LTextExtractionError).cause).toBeDefined();
  });

  test("a registry-less extractor decodes direct .txt entries and never recurses", async () => {
    // No registry -> the #registry === undefined branch: text entries extract,
    // any non-text entry is skipped (no re-dispatch).
    const ex = new M3LZipTextExtractor();
    const result = await ex.extract(fixture("mixed.zip"));
    expect(result.text).toContain("Mixed archive text entry.");
    expect(result.text).not.toContain("payload.dat");
    expect(result.truncated).toBe(false);
  });

  test("a registry-less extractor on a nested archive extracts the top .txt but does not descend", async () => {
    // nested.zip: top.txt + child.zip. Without a registry the child.zip cannot
    // be re-dispatched, so only the top-level text entry survives.
    const ex = new M3LZipTextExtractor();
    const result = await ex.extract(fixture("nested.zip"));
    expect(result.text).toContain("Top level text.");
    expect(result.text).not.toContain("Deeply nested text.");
  });
});

// ---------------------------------------------------------------------------
// Lazy loading (C6/C7) + absent-library path (C9–C12, C15)
//
// These use vi.doMock on the backing package + vi.resetModules so each mock is
// scoped, then dynamically re-import the module under test. The libs ARE
// installed, so "absent" can only be simulated by making the dynamic import
// reject with a module-not-found error.
// ---------------------------------------------------------------------------
describe("lazy loading and absent-library behavior", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("unpdf");
    vi.doUnmock("mammoth");
    vi.doUnmock("read-excel-file/node");
    vi.doUnmock("mailparser");
    vi.doUnmock("cheerio");
    vi.doUnmock("adm-zip");
    vi.resetModules();
  });

  test("C6/C7 constructing + registering an optional extractor does NOT import its lib until extract() runs", async () => {
    const importSpy = vi.fn(() => {
      throw new Error("unpdf should not be imported yet");
    });
    vi.doMock("unpdf", importSpy);

    const mod = await import("../src/core/text/index.js");
    const registry = new mod.M3LTextExtractorRegistry([]);
    registry.register(new mod.M3LPdfTextExtractor());
    // No extract() has run — the backing lib must not have been imported.
    expect(importSpy).not.toHaveBeenCalled();
  });

  test("C9–C12 a missing PDF peer dep surfaces as M3LTextExtractionError naming unpdf, chaining the cause", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package 'unpdf'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    // Reject the dynamic import to simulate the peer dep being absent.
    vi.doMock("unpdf", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/core/text/index.js");
    // Under vi.resetModules() the dynamic graph owns its OWN copy of the errors
    // module, so instanceof must use M3LError from that SAME graph — the
    // statically imported one at the top of the file belongs to a different graph.
    const { M3LError: GraphM3LError } =
      await import("../src/core/errors/index.js");
    const ex = new mod.M3LPdfTextExtractor();

    let thrown: unknown;
    try {
      await ex.extract(fixture("sample.pdf"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LTextExtractionError);
    expect(thrown).toBeInstanceOf(GraphM3LError);
    // C10: names the missing peer dependency.
    expect(
      (thrown as InstanceType<typeof mod.M3LTextExtractionError>).message,
    ).toContain("unpdf");
    // C11/C12: the raw absent-dependency failure is chained via `cause`, not
    // leaked bare. vitest intercepts a throwing doMock factory and rejects the
    // dynamic import() with ITS OWN wrapper Error, so we can't assert object
    // identity (toBe) against `moduleNotFound`; instead we verify the contract:
    // `cause` is a defined Error reflecting the module-load failure, and it is
    // NOT the M3LTextExtractionError itself (i.e. the underlying cause is chained).
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect((cause as Error).message).toMatch(/mock|unpdf|Cannot find/i);
  });

  test("C15 a missing DOCX peer dep also surfaces as a wrapped M3LTextExtractionError chaining the cause", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package 'mammoth'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    vi.doMock("mammoth", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/core/text/index.js");
    const ex = new mod.M3LDocxTextExtractor();

    let thrown: unknown;
    try {
      await ex.extract(fixture("sample.docx"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LTextExtractionError);
    expect(
      (thrown as InstanceType<typeof mod.M3LTextExtractionError>).message,
    ).toContain("mammoth");
    // See the PDF case above: a throwing vi.doMock factory is intercepted by
    // vitest, which rejects the dynamic import() with its own wrapper Error, so
    // exact object identity against `moduleNotFound` is impossible. Verify the
    // contract instead — the underlying module-load failure IS chained via
    // `cause` (a defined Error distinct from the wrapper itself).
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect((cause as Error).message).toMatch(/mock|mammoth|Cannot find/i);
  });

  test("a missing XLSX peer dep surfaces as M3LTextExtractionError naming read-excel-file, chaining the cause", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package 'read-excel-file'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    // The loader imports the `/node` subpath, so THAT is the specifier to mock.
    vi.doMock("read-excel-file/node", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/core/text/index.js");
    const ex = new mod.M3LXlsxTextExtractor();

    let thrown: unknown;
    try {
      await ex.extract(fixture("sample.xlsx"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LTextExtractionError);
    expect(
      (thrown as InstanceType<typeof mod.M3LTextExtractionError>).message,
    ).toContain("read-excel-file");
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect((cause as Error).message).toMatch(
      /mock|read-excel-file|Cannot find/i,
    );
  });

  test("a missing mailparser peer dep surfaces as M3LTextExtractionError naming mailparser, chaining the cause", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package 'mailparser'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    vi.doMock("mailparser", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/core/text/index.js");
    const ex = new mod.M3LEmailTextExtractor();

    let thrown: unknown;
    try {
      await ex.extract(fixture("sample.eml"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LTextExtractionError);
    expect(
      (thrown as InstanceType<typeof mod.M3LTextExtractionError>).message,
    ).toContain("mailparser");
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect((cause as Error).message).toMatch(/mock|mailparser|Cannot find/i);
  });

  test("a missing cheerio peer dep surfaces as M3LTextExtractionError naming cheerio, chaining the cause", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package 'cheerio'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    // mailparser stays installed; only cheerio is absent, so the loader reaches
    // loadCheerio() and fails there.
    vi.doMock("cheerio", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/core/text/index.js");
    const ex = new mod.M3LEmailTextExtractor();

    let thrown: unknown;
    try {
      await ex.extract(fixture("sample.eml"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LTextExtractionError);
    expect(
      (thrown as InstanceType<typeof mod.M3LTextExtractionError>).message,
    ).toContain("cheerio");
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect((cause as Error).message).toMatch(/mock|cheerio|Cannot find/i);
  });

  test("a missing adm-zip peer dep surfaces as M3LTextExtractionError naming adm-zip, chaining the cause", async () => {
    const moduleNotFound = Object.assign(
      new Error("Cannot find package 'adm-zip'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    vi.doMock("adm-zip", () => {
      throw moduleNotFound;
    });

    const mod = await import("../src/core/text/index.js");
    const ex = new mod.M3LZipTextExtractor();

    let thrown: unknown;
    try {
      await ex.extract(fixture("flat.zip"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(mod.M3LTextExtractionError);
    expect(
      (thrown as InstanceType<typeof mod.M3LTextExtractionError>).message,
    ).toContain("adm-zip");
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBe(thrown);
    expect((cause as Error).message).toMatch(/mock|adm-zip|Cannot find/i);
  });
});

// ---------------------------------------------------------------------------
// M3LZipTextExtractor breadth & size caps — maxEntries + maxTotalBytes.
//
// These fixtures are built at RUNTIME with adm-zip into a per-suite temp dir
// (mkdtemp) and torn down in afterAll: a breadth fixture with N sibling text
// entries, a size fixture pairing a tiny entry with a ~1 MB one, a nested
// parent wrapping a many-entry child.zip, and a small in-budget zip. Building
// them in-test keeps the cap logic verifiable without committing large or
// count-specific binary fixtures.
// ---------------------------------------------------------------------------
describe("M3LZipTextExtractor breadth & size caps", () => {
  let capDir: string;
  let breadthZip: string;
  let sizeZip: string;
  let nestedParentZip: string;
  let smallZip: string;

  beforeEach(() => {
    vi.resetModules();
  });

  afterAll(async () => {
    await rm(capDir, { recursive: true, force: true });
  });

  // Build every fixture once up-front; each test picks the one it needs.
  // (An async top-level build keeps the fixtures deterministic and off the
  // committed tree.)
  beforeEach(async () => {
    if (capDir !== undefined) return;
    capDir = await mkdtemp(path.join(tmpdir(), "m3l-zip-caps-"));

    // Breadth fixture: 5 sibling .txt entries, each with a unique marker.
    const breadth = new AdmZip();
    for (let i = 1; i <= 5; i++) {
      breadth.addFile(
        `entry-${String(i)}.txt`,
        Buffer.from(`MARKER-${String(i)}`),
      );
    }
    breadthZip = path.join(capDir, "breadth.zip");
    breadth.writeZip(breadthZip);

    // Size fixture: a few-byte small.txt + a ~1 MB big.txt.
    const size = new AdmZip();
    size.addFile("small.txt", Buffer.from("SMALL-OK"));
    size.addFile("big.txt", Buffer.alloc(1_000_000, 0x61));
    sizeZip = path.join(capDir, "size.zip");
    size.writeZip(sizeZip);

    // Small in-budget fixture: 2 tiny entries, comfortably under any default.
    const small = new AdmZip();
    small.addFile("a.txt", Buffer.from("SMALL-A"));
    small.addFile("b.txt", Buffer.from("SMALL-B"));
    smallZip = path.join(capDir, "small.zip");
    small.writeZip(smallZip);

    // Nested fixture: a parent zip wrapping a 5-entry child.zip. With a low
    // maxEntries the NESTED layer truncates, and that truncation propagates up.
    const child = new AdmZip();
    for (let i = 1; i <= 5; i++) {
      child.addFile(`c-${String(i)}.txt`, Buffer.from(`CHILD-${String(i)}`));
    }
    const parent = new AdmZip();
    parent.addFile("child.zip", child.toBuffer());
    nestedParentZip = path.join(capDir, "nested-parent.zip");
    parent.writeZip(nestedParentZip);
  });

  test("maxEntries trips on direct extract — stops early and marks truncated", async () => {
    // 5 text entries, cap of 2: only the first 2 are processed, so the 5th
    // entry's marker never appears and the result is flagged truncated.
    const ex = new M3LZipTextExtractor();
    const result = await ex.extract(breadthZip, { maxEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("MARKER-5");
  });

  test("maxEntries is forwarded through registry.extract() to the extractor", async () => {
    // Same cap, but driven through the registry — proves the options object is
    // threaded from registry.extract() into the ZIP extractor unchanged.
    const registry = new M3LTextExtractorRegistry([]);
    registry.register(new M3LZipTextExtractor(registry));
    const result = await registry.extract(MIME.zip, breadthZip, {
      maxEntries: 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("MARKER-5");
  });

  test("maxEntries not tripped — every entry present and truncated is false", async () => {
    // No cap: all 5 entries extract and nothing is cut short.
    const ex = new M3LZipTextExtractor();
    const result = await ex.extract(breadthZip);
    expect(result.text).toContain("MARKER-1");
    expect(result.text).toContain("MARKER-5");
    expect(result.truncated).toBe(false);
  });

  test("maxTotalBytes trips — the oversized entry is skipped before decompression", async () => {
    // Budget of 1000 bytes: small.txt fits and is decoded, but big.txt's
    // declared ~1 MB size exceeds the remaining budget so it is skipped WITHOUT
    // being materialized, and the result is truncated.
    const ex = new M3LZipTextExtractor();
    const result = await ex.extract(sizeZip, { maxTotalBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("SMALL-OK");
    // The 1 MB payload is a run of "a"s — none of it may leak into the output.
    expect(result.text).not.toContain("aaaaaaaaaa");
  });

  test("maxTotalBytes not tripped — both entries present and truncated is false", async () => {
    // No budget cap: both the small and the ~1 MB entry decode fully.
    const ex = new M3LZipTextExtractor();
    const result = await ex.extract(sizeZip);
    expect(result.text).toContain("SMALL-OK");
    expect(result.text).toContain("aaaaaaaaaa");
    expect(result.truncated).toBe(false);
  });

  test("nested truncation propagates — a capped child layer truncates the parent", async () => {
    // Parent wraps a 5-entry child.zip. With a registry that can recurse and a
    // maxEntries of 2, the NESTED extraction truncates, and that flag bubbles
    // up so the parent result is truncated too.
    const registry = new M3LTextExtractorRegistry([
      new M3LPlainTextExtractor(),
    ]);
    registry.register(new M3LZipTextExtractor(registry));
    const result = await registry.extract(MIME.zip, nestedParentZip, {
      maxEntries: 2,
    });
    expect(result.truncated).toBe(true);
  });

  test.each([
    ["negative maxEntries", { maxEntries: -5 }],
    ["NaN maxEntries", { maxEntries: Number.NaN }],
    ["Infinity maxTotalBytes", { maxTotalBytes: Number.POSITIVE_INFINITY }],
    ["zero maxTotalBytes", { maxTotalBytes: 0 }],
  ])(
    "hostile options (%s) are coerced to a safe default — no throw, in-budget zip fully extracted",
    async (_label, hostile: M3LTextExtractionOptions) => {
      // A negative/NaN/Infinity/zero cap fails the clamp's finite-and->=1 test
      // and falls back to the safe default (validation-boundary lenience), so a
      // small in-budget archive extracts fully and is never marked truncated.
      const ex = new M3LZipTextExtractor();
      const result = await ex.extract(smallZip, hostile);
      expect(result.text).toContain("SMALL-A");
      expect(result.text).toContain("SMALL-B");
      expect(result.truncated).toBe(false);
    },
  );
});
