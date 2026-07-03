/**
 * Tests for core/files submodule (RED phase — module not yet implemented).
 *
 * Contract source: docs/reference/core/files.md plus the locked public
 * surface supplied for this change set (9 named exports).
 *
 * Exports under test (9): M3LFileCopier, M3LFileCopyError (classes);
 *   M3L_FILE_COPIER_DEFAULTS (const, `as const`); getDefaultSubdirForPathType
 *   (fn); M3LFileCopierOptions, M3LFileCopyResult, M3LFileCopySkipReason,
 *   M3LFileCopyReport, M3LFileCopyReportSummary (types).
 *
 * The result-union members, the `paths`/`prompt` ports, and `registerFile`'s
 * options are INLINE/INTERNAL — no named port/member types are imported;
 * fakes are injected as plain object literals relying on structural typing.
 *
 * Ambiguity resolved: the contract's injected `prompt` port shape
 * (`confirm(message, options?): Promise<boolean>`) differs from the real
 * `M3LPrompt.confirm` (which takes a config object), but per the locked
 * surface the copier accepts ANY object matching the port structurally, so a
 * plain fake `{ confirm: async () => boolean }` is used throughout and never
 * the real `M3LPrompt`.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

import { M3LError } from "../src/core/errors/index.js";
import {
  getDefaultSubdirForPathType,
  M3L_FILE_COPIER_DEFAULTS,
  M3LFileCopier,
  M3LFileCopyError,
} from "../src/core/files/index.js";
import type {
  M3LFileCopierOptions,
  M3LFileCopyReport,
  M3LFileCopyReportSummary,
  M3LFileCopyResult,
  M3LFileCopySkipReason,
} from "../src/core/files/index.js";
import type { M3LPathType } from "../src/core/utils/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A fake paths port pinning the output dir to a fixed test directory. */
function fakePaths(outDir: string): { getOutputDir(): string } {
  return { getOutputDir: () => outDir };
}

/** Ensures the parent directory of `destinationPath` exists. */
async function ensureParentDir(destinationPath: string): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true });
}

/** A fake prompt port that always resolves to `answer`, counting calls. */
function fakePrompt(answer: boolean): {
  confirm: (
    message: string,
    options?: { default?: boolean },
  ) => Promise<boolean>;
  callCount: () => number;
} {
  let calls = 0;
  return {
    confirm: (): Promise<boolean> => {
      calls += 1;
      return Promise.resolve(answer);
    },
    callCount: () => calls,
  };
}

const ALL_SKIP_REASONS: readonly M3LFileCopySkipReason[] = [
  "size-too-large",
  "already-exists",
  "source-unreadable",
  "declined-by-prompt",
];

let sourceDir: string;
let outDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(path.join(tmpdir(), "m3l-files-src-"));
  outDir = await mkdtemp(path.join(tmpdir(), "m3l-files-out-"));
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------
describe("type contracts", () => {
  test("M3LFileCopySkipReason is exactly the 4-literal union", () => {
    expectTypeOf<M3LFileCopySkipReason>().toEqualTypeOf<
      | "size-too-large"
      | "already-exists"
      | "source-unreadable"
      | "declined-by-prompt"
    >();
  });

  test("M3LFileCopyResult discriminates on `skipped`: copied arm has size/destination, no reason", () => {
    expectTypeOf<
      Extract<M3LFileCopyResult, { skipped: false }>
    >().toMatchObjectType<{
      readonly skipped: false;
      readonly source: string;
      readonly destination: string;
      readonly size: number;
      readonly timestamp: string;
    }>();
    expectTypeOf<
      Extract<M3LFileCopyResult, { skipped: false }>
    >().not.toHaveProperty("reason");
  });

  test("M3LFileCopyResult discriminates on `skipped`: skipped arm has reason, no size", () => {
    expectTypeOf<
      Extract<M3LFileCopyResult, { skipped: true }>
    >().toMatchObjectType<{
      readonly skipped: true;
      readonly source: string;
      readonly destination: string;
      readonly reason: M3LFileCopySkipReason;
      readonly timestamp: string;
    }>();
    expectTypeOf<
      Extract<M3LFileCopyResult, { skipped: true }>
    >().not.toHaveProperty("size");
  });

  test("getDefaultSubdirForPathType's parameter type is exactly M3LPathType", () => {
    expectTypeOf<typeof getDefaultSubdirForPathType>()
      .parameter(0)
      .toEqualTypeOf<M3LPathType>();
    expectTypeOf<
      typeof getDefaultSubdirForPathType
    >().returns.toEqualTypeOf<string>();
  });

  test("finalizeRegisteredFiles returns Promise<M3LFileCopyReport>", () => {
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    expectTypeOf(copier.finalizeRegisteredFiles()).toEqualTypeOf<
      Promise<M3LFileCopyReport>
    >();
  });

  test("M3L_FILE_COPIER_DEFAULTS fields are literal-narrowed via `as const`", () => {
    expectTypeOf(M3L_FILE_COPIER_DEFAULTS.overwrite).toEqualTypeOf<false>();
    expectTypeOf(M3L_FILE_COPIER_DEFAULTS.writeManifest).toEqualTypeOf<false>();
    expectTypeOf(
      M3L_FILE_COPIER_DEFAULTS.manifestFileName,
    ).toEqualTypeOf<"manifest.json">();
  });

  test("M3LFileCopyReportSummary has the documented fields", () => {
    expectTypeOf<M3LFileCopyReportSummary>().toMatchObjectType<{
      readonly totalRegistered: number;
      readonly copied: number;
      readonly skipped: number;
      readonly skippedByReason: Readonly<Record<M3LFileCopySkipReason, number>>;
      readonly totalBytesCopied: number;
    }>();
  });

  test("M3LFileCopierOptions accepts the documented optional fields", () => {
    const options: M3LFileCopierOptions = {
      maxFileSizeBytes: 1024,
      overwrite: true,
      largeFilePromptThresholdBytes: 2048,
      writeManifest: true,
      manifestFileName: "custom.json",
      paths: fakePaths(outDir),
      prompt: fakePrompt(true),
    };
    expect(options.overwrite).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3L_FILE_COPIER_DEFAULTS
// ---------------------------------------------------------------------------
describe("M3L_FILE_COPIER_DEFAULTS", () => {
  test("deep-equals the documented default option values", () => {
    expect(M3L_FILE_COPIER_DEFAULTS).toEqual({
      maxFileSizeBytes: undefined,
      overwrite: false,
      largeFilePromptThresholdBytes: undefined,
      writeManifest: false,
      manifestFileName: "manifest.json",
    });
  });
});

// ---------------------------------------------------------------------------
// getDefaultSubdirForPathType
// ---------------------------------------------------------------------------
describe("getDefaultSubdirForPathType", () => {
  test("'input' pluralizes to 'inputs'", () => {
    expect(getDefaultSubdirForPathType("input")).toBe("inputs");
  });

  test.each<M3LPathType>(["output", "data", "config", "cache"])(
    "%s returns a non-empty string",
    (pathType) => {
      const subdir = getDefaultSubdirForPathType(pathType);
      expect(typeof subdir).toBe("string");
      expect(subdir.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Constructor guards
// ---------------------------------------------------------------------------
describe("M3LFileCopier constructor guards", () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "maxFileSizeBytes=%p throws M3LFileCopyError (an M3LError)",
    (value) => {
      let thrown: unknown;
      try {
        new M3LFileCopier({
          paths: fakePaths(outDir),
          maxFileSizeBytes: value,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFileCopyError);
      expect(thrown).toBeInstanceOf(M3LError);
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "largeFilePromptThresholdBytes=%p throws M3LFileCopyError (an M3LError)",
    (value) => {
      let thrown: unknown;
      try {
        new M3LFileCopier({
          paths: fakePaths(outDir),
          largeFilePromptThresholdBytes: value,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFileCopyError);
      expect(thrown).toBeInstanceOf(M3LError);
    },
  );

  test("valid positive integer options construct fine", () => {
    expect(
      () =>
        new M3LFileCopier({
          paths: fakePaths(outDir),
          maxFileSizeBytes: 1024,
          largeFilePromptThresholdBytes: 2048,
        }),
    ).not.toThrow();
  });

  test("no options at all constructs fine (all defaults apply)", () => {
    expect(() => new M3LFileCopier()).not.toThrow();
  });

  test.each(["../escape.json", "a/../../x.json"])(
    "manifestFileName=%p (absolute or containing a '..' segment) throws M3LFileCopyError",
    (manifestFileName) => {
      let thrown: unknown;
      try {
        new M3LFileCopier({
          paths: fakePaths(outDir),
          writeManifest: true,
          manifestFileName,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFileCopyError);
      expect(thrown).toBeInstanceOf(M3LError);
    },
  );

  test("an absolute manifestFileName throws M3LFileCopyError", () => {
    const absoluteManifestName = path.join(outDir, "escape.json");
    let thrown: unknown;
    try {
      new M3LFileCopier({
        paths: fakePaths(outDir),
        writeManifest: true,
        manifestFileName: absoluteManifestName,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFileCopyError);
    expect(thrown).toBeInstanceOf(M3LError);
  });
});

// ---------------------------------------------------------------------------
// Registration is queued (no I/O at registration time)
// ---------------------------------------------------------------------------
describe("registerFile", () => {
  test("does no I/O — registering a nonexistent path does not throw", () => {
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    expect(() =>
      copier.registerFile(path.join(sourceDir, "does-not-exist.txt"), {
        subdir: "inputs",
      }),
    ).not.toThrow();
  });

  test("results preserve registration order", async () => {
    const fileA = path.join(sourceDir, "a.txt");
    const fileB = path.join(sourceDir, "b.txt");
    const fileC = path.join(sourceDir, "c.txt");
    await writeFile(fileA, Buffer.from("A"));
    await writeFile(fileB, Buffer.from("BB"));
    await writeFile(fileC, Buffer.from("CCC"));

    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(fileA, { subdir: "inputs" });
    copier.registerFile(fileB, { subdir: "inputs" });
    copier.registerFile(fileC, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    expect(report.results).toHaveLength(3);
    expect(report.results[0]?.source).toBe(fileA);
    expect(report.results[1]?.source).toBe(fileB);
    expect(report.results[2]?.source).toBe(fileC);
  });

  test.each(["../escape", "a/../../x"])(
    "subdir=%p (a '..'-escaping segment) throws M3LFileCopyError",
    (subdir) => {
      const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
      const source = path.join(sourceDir, "whatever.txt");
      let thrown: unknown;
      try {
        copier.registerFile(source, { subdir });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LFileCopyError);
      expect(thrown).toBeInstanceOf(M3LError);
    },
  );

  test("an absolute subdir throws M3LFileCopyError", () => {
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    const source = path.join(sourceDir, "whatever.txt");
    const absoluteSubdir = path.join(outDir, "escape");
    let thrown: unknown;
    try {
      copier.registerFile(source, { subdir: absoluteSubdir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFileCopyError);
    expect(thrown).toBeInstanceOf(M3LError);
  });

  test("a legitimate nested subdir (no '..', not absolute) is accepted and copies fine", async () => {
    const source = path.join(sourceDir, "nested-ok.txt");
    await writeFile(source, Buffer.from("nested ok"));

    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(source, { subdir: path.join("a", "b") });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({ skipped: false });
    const written = await readFile(
      path.join(outDir, "a", "b", "nested-ok.txt"),
    );
    expect(written.toString()).toBe("nested ok");
  });
});

// ---------------------------------------------------------------------------
// Happy path — copy
// ---------------------------------------------------------------------------
describe("copy happy path", () => {
  test("copies a file to outDir/subdir/basename with the correct result shape and bytes on disk", async () => {
    const source = path.join(sourceDir, "report.csv");
    const content = Buffer.from("id,value\n1,42\n");
    await writeFile(source, content);

    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    const expectedDestination = path.join(outDir, "inputs", "report.csv");
    const result = report.results[0];
    expect(result).toMatchObject({
      skipped: false,
      source,
      destination: expectedDestination,
      size: content.length,
    });
    if (result?.skipped === false) {
      expect(() => new Date(result.timestamp)).not.toThrow();
      expect(Number.isNaN(new Date(result.timestamp).getTime())).toBe(false);
    } else {
      throw new Error("expected a copied (non-skipped) result");
    }

    const written = await readFile(expectedDestination);
    expect(written.equals(content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Size skip
// ---------------------------------------------------------------------------
describe("maxFileSizeBytes", () => {
  test("a source STRICTLY over the limit is skipped 'size-too-large' with no bytes written", async () => {
    const source = path.join(sourceDir, "big.bin");
    await writeFile(source, Buffer.alloc(101));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      maxFileSizeBytes: 100,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "size-too-large",
    });
    await expect(
      stat(path.join(outDir, "inputs", "big.bin")),
    ).rejects.toThrow();
  });

  test("a source EXACTLY at the limit is copied (boundary is '>' not '>=')", async () => {
    const source = path.join(sourceDir, "exact.bin");
    await writeFile(source, Buffer.alloc(100));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      maxFileSizeBytes: 100,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({ skipped: false, size: 100 });
  });
});

// ---------------------------------------------------------------------------
// Overwrite behavior
// ---------------------------------------------------------------------------
describe("overwrite", () => {
  test("disabled (default): pre-existing destination is skipped 'already-exists', bytes unchanged", async () => {
    const source = path.join(sourceDir, "dup.txt");
    await writeFile(source, Buffer.from("NEW CONTENT"));

    // Pre-create the destination directly so it exists before finalize runs.
    const destination = path.join(outDir, "inputs", "dup.txt");
    await ensureParentDir(destination);
    await writeFile(destination, Buffer.from("OLD CONTENT"));

    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();
    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "already-exists",
    });
    const stillThere = await readFile(destination);
    expect(stillThere.toString()).toBe("OLD CONTENT");
  });

  test("enabled: pre-existing destination is replaced and reported as copied", async () => {
    const source = path.join(sourceDir, "dup2.txt");
    await writeFile(source, Buffer.from("NEW CONTENT"));
    const destination = path.join(outDir, "inputs", "dup2.txt");
    await ensureParentDir(destination);
    await writeFile(destination, Buffer.from("OLD CONTENT"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      overwrite: true,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({ skipped: false });
    const written = await readFile(destination);
    expect(written.toString()).toBe("NEW CONTENT");
  });
});

// ---------------------------------------------------------------------------
// Source unreadable — recorded, not thrown; batch continues
// ---------------------------------------------------------------------------
describe("source-unreadable", () => {
  test("a missing source is recorded as skipped and the batch continues to copy the good file", async () => {
    const goodSource = path.join(sourceDir, "good.txt");
    await writeFile(goodSource, Buffer.from("ok"));
    const missingSource = path.join(sourceDir, "missing.txt");

    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(goodSource, { subdir: "inputs" });
    copier.registerFile(missingSource, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    expect(report.results).toHaveLength(2);
    expect(report.results[0]).toMatchObject({ skipped: false });
    expect(report.results[1]).toMatchObject({
      skipped: true,
      reason: "source-unreadable",
    });
  });
});

// ---------------------------------------------------------------------------
// A skipped-only batch never creates its destination subdirectory (S3): the
// subdir mkdir is deferred to immediately before the actual copy, so a
// batch whose only entry is skipped must not litter the output tree with an
// empty subdirectory.
// ---------------------------------------------------------------------------
describe("skipped files leave no empty destination subdir", () => {
  test("a missing source (source-unreadable) creates no subdir", async () => {
    const missingSource = path.join(sourceDir, "ghost.txt");
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(missingSource, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "source-unreadable",
    });
    await expect(stat(path.join(outDir, "inputs"))).rejects.toThrow();
  });

  test("an oversized source (size-too-large) creates no subdir", async () => {
    const source = path.join(sourceDir, "toobig.bin");
    await writeFile(source, Buffer.alloc(101));
    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      maxFileSizeBytes: 100,
    });
    copier.registerFile(source, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "size-too-large",
    });
    await expect(stat(path.join(outDir, "inputs"))).rejects.toThrow();
  });

  test("a declined prompt (declined-by-prompt) creates no subdir", async () => {
    const source = path.join(sourceDir, "declined.bin");
    await writeFile(source, Buffer.alloc(101));
    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      largeFilePromptThresholdBytes: 100,
      prompt: fakePrompt(false),
    });
    copier.registerFile(source, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "declined-by-prompt",
    });
    await expect(stat(path.join(outDir, "inputs"))).rejects.toThrow();
  });

  test("contrast: a copied file DOES create its destination subdir", async () => {
    const source = path.join(sourceDir, "copies-fine.txt");
    await writeFile(source, Buffer.from("ok"));
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    copier.registerFile(source, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    expect(report.results[0]).toMatchObject({ skipped: false });
    await expect(stat(path.join(outDir, "inputs"))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Large-file prompt
// ---------------------------------------------------------------------------
describe("largeFilePromptThresholdBytes prompt gating", () => {
  test("prompt is not consulted when threshold is unset", async () => {
    const source = path.join(sourceDir, "large.bin");
    await writeFile(source, Buffer.alloc(10_000));
    const prompt = fakePrompt(true);

    const copier = new M3LFileCopier({ paths: fakePaths(outDir), prompt });
    copier.registerFile(source, { subdir: "inputs" });
    await copier.finalizeRegisteredFiles();

    expect(prompt.callCount()).toBe(0);
  });

  test("prompt is not consulted for a sub-threshold file", async () => {
    const source = path.join(sourceDir, "small.bin");
    await writeFile(source, Buffer.alloc(10));
    const prompt = fakePrompt(true);

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      largeFilePromptThresholdBytes: 100,
      prompt,
    });
    copier.registerFile(source, { subdir: "inputs" });
    await copier.finalizeRegisteredFiles();

    expect(prompt.callCount()).toBe(0);
  });

  test("prompt fires exactly once when the source strictly exceeds the threshold", async () => {
    const source = path.join(sourceDir, "over.bin");
    await writeFile(source, Buffer.alloc(101));
    const prompt = fakePrompt(true);

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      largeFilePromptThresholdBytes: 100,
      prompt,
    });
    copier.registerFile(source, { subdir: "inputs" });
    await copier.finalizeRegisteredFiles();

    expect(prompt.callCount()).toBe(1);
  });

  test("accept (confirm resolves true) results in a copy", async () => {
    const source = path.join(sourceDir, "accept.bin");
    await writeFile(source, Buffer.alloc(101));
    const prompt = fakePrompt(true);

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      largeFilePromptThresholdBytes: 100,
      prompt,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({ skipped: false });
  });

  test("decline (confirm resolves false) results in a skip with no bytes written", async () => {
    const source = path.join(sourceDir, "decline.bin");
    await writeFile(source, Buffer.alloc(101));
    const prompt = fakePrompt(false);

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      largeFilePromptThresholdBytes: 100,
      prompt,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "declined-by-prompt",
    });
    await expect(
      stat(path.join(outDir, "inputs", "decline.bin")),
    ).rejects.toThrow();
  });

  test("size-skip pre-empts the prompt: a file over BOTH caps is skipped 'size-too-large' and confirm is never called", async () => {
    const source = path.join(sourceDir, "both-over.bin");
    await writeFile(source, Buffer.alloc(201));
    const prompt = fakePrompt(true);

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      maxFileSizeBytes: 100,
      largeFilePromptThresholdBytes: 150,
      prompt,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results[0]).toMatchObject({
      skipped: true,
      reason: "size-too-large",
    });
    expect(prompt.callCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
describe("manifest", () => {
  test("writeManifest:true writes JSON at outDir/manifestFileName deep-equal to the returned report", async () => {
    const source = path.join(sourceDir, "manifest-me.txt");
    await writeFile(source, Buffer.from("hi"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      writeManifest: true,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    const manifestPath = path.join(outDir, "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toEqual(report);
  });

  test("a custom manifestFileName is honored", async () => {
    const source = path.join(sourceDir, "custom-manifest.txt");
    await writeFile(source, Buffer.from("hi"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      writeManifest: true,
      manifestFileName: "custom.json",
    });
    copier.registerFile(source, { subdir: "inputs" });
    await copier.finalizeRegisteredFiles();

    await expect(stat(path.join(outDir, "custom.json"))).resolves.toBeDefined();
  });

  test("writeManifest:false writes no manifest file", async () => {
    const source = path.join(sourceDir, "no-manifest.txt");
    await writeFile(source, Buffer.from("hi"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      writeManifest: false,
    });
    copier.registerFile(source, { subdir: "inputs" });
    await copier.finalizeRegisteredFiles();

    await expect(stat(path.join(outDir, "manifest.json"))).rejects.toThrow();
  });

  test("the manifest is not itself included as a result entry", async () => {
    const source = path.join(sourceDir, "self-check.txt");
    await writeFile(source, Buffer.from("hi"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      writeManifest: true,
    });
    copier.registerFile(source, { subdir: "inputs" });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results).toHaveLength(1);
    const destinations = report.results.map((r) => r.destination);
    expect(destinations).not.toContain(path.join(outDir, "manifest.json"));
  });
});

// ---------------------------------------------------------------------------
// Summary math
// ---------------------------------------------------------------------------
describe("summary math", () => {
  test("totals reconcile across a mixed batch of copies and every skip reason", async () => {
    // maxFileSizeBytes=200, largeFilePromptThresholdBytes=100: `good` (10B) is
    // under both caps and copies untouched; `tooBig` (201B) exceeds the size
    // cap and is skipped before the prompt is ever consulted; `declined`
    // (151B) passes the size gate (<=200) but exceeds the prompt threshold
    // (>100), so the prompt fires and (returning false) it is declined.
    const good = path.join(sourceDir, "good-sum.txt");
    await writeFile(good, Buffer.alloc(10));
    const tooBig = path.join(sourceDir, "toobig-sum.bin");
    await writeFile(tooBig, Buffer.alloc(201));
    const missing = path.join(sourceDir, "missing-sum.txt");
    const declined = path.join(sourceDir, "declined-sum.bin");
    await writeFile(declined, Buffer.alloc(151));
    const preexistingDup = path.join(sourceDir, "dup-sum.txt");
    await writeFile(preexistingDup, Buffer.from("new"));
    const dupDestination = path.join(outDir, "inputs", "dup-sum.txt");
    await ensureParentDir(dupDestination);
    await writeFile(dupDestination, Buffer.from("old"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      maxFileSizeBytes: 200,
      largeFilePromptThresholdBytes: 100,
      prompt: fakePrompt(false),
    });
    copier.registerFile(good, { subdir: "inputs" });
    copier.registerFile(tooBig, { subdir: "inputs" });
    copier.registerFile(missing, { subdir: "inputs" });
    copier.registerFile(declined, { subdir: "inputs" });
    copier.registerFile(preexistingDup, { subdir: "inputs" });

    const report = await copier.finalizeRegisteredFiles();
    const { summary } = report;

    expect(summary.totalRegistered).toBe(report.results.length);
    expect(summary.totalRegistered).toBe(5);
    expect(summary.copied).toBe(1);
    expect(summary.skipped).toBe(4);
    expect(summary.copied + summary.skipped).toBe(summary.totalRegistered);
    expect(summary.totalBytesCopied).toBe(10);

    const reasonSum = Object.values(summary.skippedByReason).reduce(
      (a, b) => a + b,
      0,
    );
    expect(reasonSum).toBe(summary.skipped);
    for (const reason of ALL_SKIP_REASONS) {
      expect(summary.skippedByReason).toHaveProperty(reason);
    }
    expect(summary.skippedByReason["size-too-large"]).toBe(1);
    expect(summary.skippedByReason["source-unreadable"]).toBe(1);
    expect(summary.skippedByReason["declined-by-prompt"]).toBe(1);
    expect(summary.skippedByReason["already-exists"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty batch
// ---------------------------------------------------------------------------
describe("empty batch", () => {
  test("finalizing with nothing registered yields empty results and a zeroed summary", async () => {
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    const report = await copier.finalizeRegisteredFiles();

    expect(report.results).toEqual([]);
    expect(report.summary).toEqual({
      totalRegistered: 0,
      copied: 0,
      skipped: 0,
      skippedByReason: {
        "size-too-large": 0,
        "already-exists": 0,
        "source-unreadable": 0,
        "declined-by-prompt": 0,
      },
      totalBytesCopied: 0,
    });
  });

  test("no manifest is written for an empty batch unless writeManifest is set", async () => {
    const copier = new M3LFileCopier({ paths: fakePaths(outDir) });
    await copier.finalizeRegisteredFiles();
    await expect(stat(path.join(outDir, "manifest.json"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Batch-fatal failures
// ---------------------------------------------------------------------------
describe("batch-fatal I/O failures", () => {
  test("finalizeRegisteredFiles rejects with M3LFileCopyError chaining the raw fs cause when the output dir cannot be created", async () => {
    // Point getOutputDir() at a path whose PARENT is a regular FILE, so mkdir
    // fails with ENOTDIR — a genuine infrastructural failure, not a per-file
    // skip condition.
    const parentIsFile = path.join(sourceDir, "not-a-directory");
    await writeFile(parentIsFile, Buffer.from("i am a file, not a dir"));
    const impossibleOutDir = path.join(parentIsFile, "output");

    const source = path.join(sourceDir, "irrelevant.txt");
    await writeFile(source, Buffer.from("data"));

    const copier = new M3LFileCopier({ paths: fakePaths(impossibleOutDir) });
    copier.registerFile(source, { subdir: "inputs" });

    let thrown: unknown;
    try {
      await copier.finalizeRegisteredFiles();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFileCopyError);
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LFileCopyError).cause).toBeDefined();
  });

  test("finalizeRegisteredFiles rejects with M3LFileCopyError chaining the raw fs cause when the manifest write fails (EISDIR)", async () => {
    // Pre-create a DIRECTORY at the manifest's target path (not a file), so
    // `writeFile` fails with EISDIR — a genuine infrastructural failure, not
    // a per-file skip condition. A `..`/absolute manifestFileName is not used
    // here since that is now rejected at construction time by the M3 guard.
    await mkdir(path.join(outDir, "manifest.json"));

    const source = path.join(sourceDir, "manifest-fatal.txt");
    await writeFile(source, Buffer.from("data"));

    const copier = new M3LFileCopier({
      paths: fakePaths(outDir),
      writeManifest: true,
    });
    copier.registerFile(source, { subdir: "inputs" });

    let thrown: unknown;
    try {
      await copier.finalizeRegisteredFiles();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LFileCopyError);
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LFileCopyError).cause).toBeDefined();
  });
});
