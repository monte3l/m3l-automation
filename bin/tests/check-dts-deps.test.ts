import { describe, expect, test } from "vitest";
import {
  declaresTypes,
  extractDtsSpecifiers,
  findUndeclaredDtsDeps,
  packageNameFromSpecifier,
  requiredDeclarations,
  stripBlockComments,
  stripComments,
  typesPackageFor,
} from "../../bin/check-dts-deps.mjs";

describe("stripComments", () => {
  test("removes a TSDoc block, including any import inside an @example", () => {
    const source = [
      "/**",
      " * @example",
      ' * import { X } from "@m3l-automation/m3l-common/aws";',
      " */",
      'export declare const y: import("./local.js").Y;',
    ].join("\n");
    expect(stripComments(source)).not.toContain("m3l-common/aws");
  });

  test("removes a line comment", () => {
    expect(stripComments('const a = 1; // from "pkg"')).toBe("const a = 1; ");
  });

  test("a // sequence inside a block comment does not end the block early", () => {
    const source = '/* http://example.com\n from "leaked" */\nreal';
    expect(stripComments(source).trim()).toBe("real");
  });

  test("leaves code without comments untouched", () => {
    const source = 'import type { A } from "pkg";';
    expect(stripComments(source)).toBe(source);
  });
});

describe("stripBlockComments", () => {
  test("removes a TSDoc block but preserves a triple-slash directive", () => {
    const source = ["/** @example x */", '/// <reference types="node" />'].join(
      "\n",
    );
    expect(stripBlockComments(source).trim()).toBe(
      '/// <reference types="node" />',
    );
  });

  test("a triple-slash directive quoted inside a TSDoc block is still removed", () => {
    const source = '/**\n * /// <reference types="ghost" />\n */';
    expect(stripBlockComments(source).trim()).toBe("");
  });
});

describe("extractDtsSpecifiers", () => {
  test("picks up a type-only import", () => {
    expect(
      extractDtsSpecifiers('import type { Database } from "better-sqlite3";'),
    ).toEqual(["better-sqlite3"]);
  });

  test("picks up a namespace import", () => {
    expect(
      extractDtsSpecifiers('import * as BetterSqlite3 from "better-sqlite3";'),
    ).toEqual(["better-sqlite3"]);
  });

  test("picks up a re-export", () => {
    expect(extractDtsSpecifiers('export { A } from "@scope/pkg";')).toEqual([
      "@scope/pkg",
    ]);
  });

  test("picks up an inline import() type reference", () => {
    expect(
      extractDtsSpecifiers(
        'export declare const db: import("better-sqlite3").Database;',
      ),
    ).toEqual(["better-sqlite3"]);
  });

  test("picks up a triple-slash types reference", () => {
    expect(extractDtsSpecifiers('/// <reference types="node" />')).toEqual([
      "node",
    ]);
  });

  test("drops relative specifiers", () => {
    expect(
      extractDtsSpecifiers(
        'export { A } from "./a.js";\nexport { B } from "../b/index.js";',
      ),
    ).toEqual([]);
  });

  test("drops node: builtins", () => {
    expect(
      extractDtsSpecifiers('import type { Readable } from "node:stream";'),
    ).toEqual([]);
  });

  test("ignores a specifier that only appears inside a TSDoc @example", () => {
    const source = [
      "/**",
      " * @example",
      ' * import { M3LSigningError } from "@m3l-automation/m3l-common/aws";',
      " */",
      "export declare class M3LSigningError extends Error {}",
    ].join("\n");
    expect(extractDtsSpecifiers(source)).toEqual([]);
  });

  test("deduplicates and sorts", () => {
    const source = [
      'import type { A } from "zeta";',
      'import type { B } from "alpha";',
      'export type { A } from "zeta";',
    ].join("\n");
    expect(extractDtsSpecifiers(source)).toEqual(["alpha", "zeta"]);
  });
});

describe("packageNameFromSpecifier", () => {
  test("unscoped root specifier is the package name", () => {
    expect(packageNameFromSpecifier("better-sqlite3")).toBe("better-sqlite3");
  });

  test("unscoped deep import reduces to the package name", () => {
    expect(packageNameFromSpecifier("csv-parse/sync")).toBe("csv-parse");
  });

  test("scoped root specifier keeps both segments", () => {
    expect(packageNameFromSpecifier("@aws-sdk/client-s3")).toBe(
      "@aws-sdk/client-s3",
    );
  });

  test("scoped deep import reduces to the two-segment package name", () => {
    expect(packageNameFromSpecifier("@m3l-automation/m3l-common/core")).toBe(
      "@m3l-automation/m3l-common",
    );
  });
});

describe("typesPackageFor", () => {
  test("unscoped package maps to @types/<name>", () => {
    expect(typesPackageFor("better-sqlite3")).toBe("@types/better-sqlite3");
  });

  test("scoped package applies the DefinitelyTyped __ mangling", () => {
    expect(typesPackageFor("@aws-sdk/client-s3")).toBe(
      "@types/aws-sdk__client-s3",
    );
  });

  test("an @types package is already its own counterpart", () => {
    expect(typesPackageFor("@types/node")).toBe("@types/node");
  });
});

describe("declaresTypes", () => {
  test("top-level types field counts", () => {
    expect(declaresTypes({ types: "./index.d.ts" })).toBe(true);
  });

  test("legacy typings field counts", () => {
    expect(declaresTypes({ typings: "./index.d.ts" })).toBe(true);
  });

  test("a types condition nested in an exports map counts", () => {
    expect(
      declaresTypes({
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      }),
    ).toBe(true);
  });

  test("a types condition inside an exports array form counts", () => {
    expect(
      declaresTypes({ exports: { ".": [{ types: "./index.d.ts" }] } }),
    ).toBe(true);
  });

  test("better-sqlite3's real shape — main + exports, no types anywhere", () => {
    expect(
      declaresTypes({
        main: "lib/index.js",
        exports: { ".": "./lib/index.js", "./package.json": "./package.json" },
      }),
    ).toBe(false);
  });

  test("a non-string types field does not count", () => {
    expect(declaresTypes({ types: true })).toBe(false);
  });
});

describe("requiredDeclarations", () => {
  test("a package shipping its own types requires only itself", () => {
    expect(requiredDeclarations("@aws-sdk/client-s3", true)).toEqual([
      { name: "@aws-sdk/client-s3", isTypesCounterpart: false },
    ]);
  });

  test("a package shipping no types also requires its @types counterpart", () => {
    expect(requiredDeclarations("better-sqlite3", false)).toEqual([
      { name: "better-sqlite3", isTypesCounterpart: false },
      { name: "@types/better-sqlite3", isTypesCounterpart: true },
    ]);
  });
});

describe("findUndeclaredDtsDeps", () => {
  const sqliteImport = {
    file: "packages/m3l-common/dist/core/storage/types.d.ts",
    specifier: "better-sqlite3",
    packageName: "better-sqlite3",
    shipsOwnTypes: false,
  };

  test("the #798 shape — types counterpart in devDependencies only", () => {
    const violations = findUndeclaredDtsDeps([sqliteImport], {
      name: "@m3l-automation/m3l-common",
      dependencies: { "better-sqlite3": "13.0.3" },
      devDependencies: { "@types/better-sqlite3": "^9.6.0" },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.missing).toBe("@types/better-sqlite3");
    expect(violations[0]?.file).toBe(
      "packages/m3l-common/dist/core/storage/types.d.ts",
    );
    expect(violations[0]?.reason).toContain("declared only in devDependencies");
  });

  test("the #798 fix — types counterpart promoted to dependencies", () => {
    expect(
      findUndeclaredDtsDeps([sqliteImport], {
        name: "@m3l-automation/m3l-common",
        dependencies: {
          "better-sqlite3": "13.0.3",
          "@types/better-sqlite3": "9.6.0",
        },
      }),
    ).toEqual([]);
  });

  test("an entirely undeclared package is reported as not declared at all", () => {
    const violations = findUndeclaredDtsDeps(
      [
        {
          file: "packages/m3l-common/dist/core/x.d.ts",
          specifier: "ghost",
          packageName: "ghost",
          shipsOwnTypes: true,
        },
      ],
      { name: "@m3l-automation/m3l-common", dependencies: {} },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.missing).toBe("ghost");
    expect(violations[0]?.reason).toContain("not declared at all");
  });

  test("a peerDependency satisfies the requirement — an optional peer is installed by whoever uses the type", () => {
    expect(
      findUndeclaredDtsDeps(
        [
          {
            file: "packages/m3l-common/dist/core/text/x.d.ts",
            specifier: "unpdf",
            packageName: "unpdf",
            shipsOwnTypes: true,
          },
        ],
        {
          name: "@m3l-automation/m3l-common",
          peerDependencies: { unpdf: "^1.6.2" },
        },
      ),
    ).toEqual([]);
  });

  test("a self-reference through the exports map is never a violation", () => {
    expect(
      findUndeclaredDtsDeps(
        [
          {
            file: "packages/m3l-common/dist/aws/index.d.ts",
            specifier: "@m3l-automation/m3l-common/core",
            packageName: "@m3l-automation/m3l-common",
            shipsOwnTypes: true,
          },
        ],
        { name: "@m3l-automation/m3l-common", dependencies: {} },
      ),
    ).toEqual([]);
  });

  test("a deep import is satisfied by the package-root declaration", () => {
    expect(
      findUndeclaredDtsDeps(
        [
          {
            file: "packages/m3l-common/dist/core/importers/x.d.ts",
            specifier: "csv-parse/sync",
            packageName: "csv-parse",
            shipsOwnTypes: true,
          },
        ],
        {
          name: "@m3l-automation/m3l-common",
          dependencies: { "csv-parse": "7.0.2" },
        },
      ),
    ).toEqual([]);
  });

  test("the same missing name across many files is reported once per specifier", () => {
    const imports = ["a.d.ts", "b.d.ts", "c.d.ts"].map((file) => ({
      ...sqliteImport,
      file,
    }));
    const violations = findUndeclaredDtsDeps(imports, {
      name: "@m3l-automation/m3l-common",
      dependencies: { "better-sqlite3": "13.0.3" },
      devDependencies: { "@types/better-sqlite3": "^9.6.0" },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("a.d.ts");
  });

  test("violations are sorted by file, then by missing name", () => {
    const violations = findUndeclaredDtsDeps(
      [
        {
          file: "z.d.ts",
          specifier: "zeta",
          packageName: "zeta",
          shipsOwnTypes: true,
        },
        {
          file: "a.d.ts",
          specifier: "alpha",
          packageName: "alpha",
          shipsOwnTypes: true,
        },
      ],
      { name: "@m3l-automation/m3l-common", dependencies: {} },
    );
    expect(violations.map((v) => v.file)).toEqual(["a.d.ts", "z.d.ts"]);
  });

  test("an empty import set is vacuously clean", () => {
    expect(findUndeclaredDtsDeps([], { name: "pkg" })).toEqual([]);
  });
});
