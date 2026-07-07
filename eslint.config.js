// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import tsdoc from "eslint-plugin-tsdoc";
import globals from "globals";

export default tseslint.config(
  {
    // Generated / vendored output is never linted.
    // bin/**  and .claude/hooks/** are intentionally NOT ignored (see block below).
    // .claude/agents|skills|rules contain only docs; hooks are the only code there.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".claude/agents/**",
      ".claude/skills/**",
      ".claude/rules/**",
      // Nested worktrees are independent checkouts of other branches; linting
      // them from the main tree reports on (and can't resolve) foreign code.
      ".claude/worktrees/**",
      // Local session buffers written by the remember plugin; gitignored and
      // outside every tsconfig, so type-checked linting can't resolve them.
      ".remember/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    files: ["**/*.ts"],
    linterOptions: {
      // Stale eslint-disable directives are always a bug: they either never
      // suppressed anything or the underlying finding was fixed, leaving
      // noise that misleads reviewers. Treating them as errors closes the
      // gap where a pre-existing directive survives undetected across edits.
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver()],
    },
    rules: {
      // --- ESM correctness: the #1 documented gotcha ---------------------
      // Relative imports MUST carry the `.js` extension; tsc does not add it
      // and Node will not resolve without it. See docs/contributing/*.
      "import-x/extensions": [
        "error",
        "ignorePackages",
        { js: "always", ts: "never", tsx: "never" },
      ],

      // --- Strictness: no `any` in the public API (rules 01, coding-standards) ---
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // --- Style / design (rules 03, coding-standards) -------------------
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],

      // --- ESM only: ban CommonJS constructs -----------------------------
      "no-restricted-globals": [
        "error",
        { name: "__dirname", message: "CommonJS only; this package is ESM." },
        { name: "__filename", message: "CommonJS only; this package is ESM." },
        { name: "require", message: "CommonJS only; this package is ESM." },
      ],
      "import-x/no-commonjs": "error",

      // Workspace packages resolve via dist/, which doesn't exist pre-build.
      // TypeScript (pnpm typecheck) is the authoritative resolver for these
      // imports, so suppressing the ESLint check here is safe.
      "import-x/no-unresolved": ["error", { ignore: ["^@m3l-automation/"] }],
    },
  },
  {
    // Source-only design rules (rules 01, 03). Scoped to shipped source so the
    // checks never trip on tests, config (vitest.config.ts uses a default
    // export), or tooling.
    files: ["packages/*/src/**/*.ts", "scripts/*/src/**/*.ts"],
    plugins: { tsdoc },
    rules: {
      // TSDoc must be well-formed on shipped source (rules 01: documentation).
      // Warn-first: surfaces malformed doc comments without blocking the
      // scaffold; promote to "error" once the API has real TSDoc to protect.
      "tsdoc/syntax": "warn",

      // Named exports only — keeps the package tree-shakeable (rules 01/04).
      "import-x/no-default-export": "error",

      // Explicit return/param types on the exported surface (style-guide §
      // Public-API typing). Inference is allowed inside a function body; only
      // the module boundary must be spelled out.
      "@typescript-eslint/explicit-module-boundary-types": "error",

      // Refactoring / immutability: never reassign a parameter or mutate its
      // properties — create a new value instead (style-guide § Immutability).
      "no-param-reassign": ["error", { props: true }],

      // Naming conventions (style-guide § Naming). Deliberately conservative:
      // identifiers we own are constrained, but property-like names are left
      // unchecked because they mirror external shapes (JSON fields, env keys
      // such as M3L_DEPLOYMENT_MODE) the compiler cannot rename.
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "default",
          format: ["camelCase"],
          leadingUnderscore: "allow",
        },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allow",
        },
        {
          selector: "parameter",
          format: ["camelCase"],
          leadingUnderscore: "allow",
        },
        { selector: "typeLike", format: ["PascalCase"] },
        { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
        { selector: "import", format: ["camelCase", "PascalCase"] },
        // External-facing shapes: do not constrain property names.
        {
          selector: ["objectLiteralProperty", "typeProperty"],
          format: null,
        },
      ],

      // Keep units small and shallow (rules 01: "small enough to describe in
      // one sentence", limited nesting, reduced complexity).
      complexity: ["error", 10],
      "max-depth": ["error", 3],
      "max-lines-per-function": [
        "error",
        { max: 60, skipBlankLines: true, skipComments: true },
      ],

      // Named constants over magic values (rules 01). TS-aware variant handles
      // enums / type indexes; the common literals stay allowed.
      "no-magic-numbers": "off",
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: [-1, 0, 1],
          ignoreArrayIndexes: true,
          ignoreEnums: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    // Scripts must never read `process.env` directly — configuration flows
    // through `M3LConfigParameter` and is read from the resolved config
    // (scripts.md / ADR-0022). This is the mechanically-checkable half of that
    // rule; the composition-root / injected-deps guidance stays advisory.
    files: ["scripts/*/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Scripts must not read process.env directly — declare config via M3LConfigParameter and read it from the resolved config (scripts.md).",
        },
      ],
    },
  },
  {
    // `internal/` is private and MUST NOT be re-exported through a public
    // barrel (rules 04 / ADR 0004 — the exports map stays at three entries).
    // Forbid the public entry points from importing it at all.
    files: [
      "packages/m3l-common/src/index.ts",
      "packages/m3l-common/src/core/index.ts",
      "packages/m3l-common/src/aws/index.ts",
    ],
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/m3l-common/src",
              from: "./packages/m3l-common/src/internal",
              message:
                "internal/ is private; never re-export it through a public barrel (ADR 0004).",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0009 dependency-direction zones (deepen-first WS-G). The module
    // layering, from leaf outward:
    //   leaf:  core/errors, core/events, core/security, core/prompt (no core deps)
    //   mid:   core/utils -> analysis/config/json/exporters/network/polling/...
    //          -> core/{logging, importers, files}
    //   root:  core/script (composition root; imports many core modules; nothing
    //          imports it)
    //   aws/**: a separate island depending only on core/errors + core/prompt
    // These path-based zones encode the real, acyclic graph. `no-restricted-paths`
    // is NOT type-aware, so core/script's type-only imports from aws/ and its
    // lazy `await import()` AWS-provisioning seam are intentionally left
    // unrestricted here — they are compile-erased / runtime-only and create no
    // static core -> aws cycle. The public barrels (core/index.ts, aws/index.ts)
    // are excluded because they legitimately re-export every submodule (including
    // core/script); the internal/-sealing block above owns the barrels.
    //
    // Zone A: aws/** may import only core/errors and core/prompt.
    files: ["packages/m3l-common/src/aws/**/*.ts"],
    ignores: ["packages/m3l-common/src/aws/index.ts"],
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/m3l-common/src/aws",
              from: "./packages/m3l-common/src/core",
              // `except` paths are relative to `from` (core).
              except: ["errors", "prompt"],
              message:
                "aws/* may import only core/errors and core/prompt — no other core module (ADR-0009 layering).",
            },
          ],
        },
      ],
    },
  },
  {
    // Zone B: core/script is the composition root — no OTHER core module may
    // import it. Scoped to core/** but excluding core/script itself (its own
    // intra-module imports are legitimate) and the core barrel (which re-exports
    // it). See the ADR-0009 layering comment above.
    files: ["packages/m3l-common/src/core/**/*.ts"],
    ignores: [
      "packages/m3l-common/src/core/script/**",
      "packages/m3l-common/src/core/index.ts",
    ],
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/m3l-common/src/core",
              from: "./packages/m3l-common/src/core/script",
              message:
                "core/script is the composition root; no other core module may import it (ADR-0009 layering).",
            },
          ],
        },
      ],
    },
  },
  {
    // Node.js automation scripts (bin/) and Claude Code hooks (.claude/hooks/).
    // Plain ESM .mjs — no TypeScript project service. Enables the rules that
    // caught historical PR findings: empty-catch swallowing, variable shadowing,
    // unused vars, and (via no-undef) missing explicit imports.
    files: ["bin/**/*.mjs", ".claude/hooks/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
      globals: globals.node,
    },
    rules: {
      // Catch empty catch blocks (silent error swallowing).
      "no-empty": ["error", { allowEmptyCatch: false }],
      // Catch variable shadowing (the #20 `raw` parameter shadowing).
      "no-shadow": "error",
      // No type info available — defer to the standard rule.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // devDependencies are expected in bin scripts and hooks.
      "import-x/no-extraneous-dependencies": "off",
      // node: protocol imports resolve fine at runtime; skip the resolver check.
      "import-x/no-unresolved": "off",
    },
  },
  {
    // Tests may use devDependencies and relax a few rules.
    // The no-restricted-syntax entry bans real filesystem mutations — these make
    // "unit" tests CI-green only when the live tree happens to match expectations
    // (the #25 smell: mkdtempSync/writeFileSync against /tmp in pure unit tests).
    // Read-only methods tests legitimately vi.spyOn (existsSync, readdirSync,
    // accessSync) are NOT banned. Use vi.spyOn(fs, method) for everything else.
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "import-x/no-extraneous-dependencies": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(fs|fsp|fsPromises)$/][callee.property.name=/^(mkdtempSync|mkdirSync|writeFileSync|appendFileSync|rmSync|unlinkSync|rmdirSync|mkdtemp|mkdir|writeFile|appendFile|rm|unlink|rmdir)$/]",
          message:
            "Mutating filesystem calls are banned in unit tests. Use vi.spyOn(fs, method) or vi.mock('node:fs') instead.",
        },
        {
          selector:
            "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message:
            "Bare fetch() in unit tests makes real network calls. Use vi.spyOn or mock the collaborator.",
        },
      ],
    },
  },
  {
    // bin/tests/*.test.ts imports from .mjs scripts that have no TypeScript
    // declarations — TypeScript infers their exports as `any`. Disable the
    // no-unsafe-* rules here so tests remain writable without casts throughout.
    files: ["bin/tests/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // Config files at the repo root are not part of a tsconfig project.
    files: ["*.js", "*.config.js", "*.config.ts"],
    languageOptions: {
      parserOptions: { projectService: false },
    },
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // False positive: `typescript-eslint`'s default export also carries a
      // `configs` named export; the default-member access here is intentional.
      "import-x/no-named-as-default-member": "off",
    },
  },
);
