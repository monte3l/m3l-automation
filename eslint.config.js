// @ts-check
import { readdirSync } from "node:fs";
import { URL } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import tsdoc from "eslint-plugin-tsdoc";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Generated from the scripts/ directory listing (not hand-maintained) so a
// new script package is automatically covered by the cross-import zone below
// without an eslint.config.js edit.
const scriptPackageNames = readdirSync(new URL("./scripts/", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

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
      // Dynamic-workflow scripts (ADR-0025): the Workflow tool runs the body
      // inside an async function scope with ambient orchestration globals, so
      // the file's top-level `return` is unparseable as a standard ES module.
      // `pnpm check:workflows` is the lint for this surface.
      ".claude/workflows/**",
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
    // `.tsx` widened on for ADR-0067's console-web package (the repo's first
    // JSX source) — every rule below (the .js-extension check, no-any,
    // no-floating-promises, the CommonJS bans, ...) applies equally to
    // browser source, so widening this shared zone's `files` is simpler and
    // less duplicative than re-declaring the same rule block in the new
    // browser-only zone below.
    files: ["**/*.ts", "**/*.tsx"],
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
    // export), or tooling. `.tsx` widened on for packages/m3l-console-web
    // (ADR-0067) — TSDoc, named-exports-only, and the complexity/naming
    // rules apply to a React component exactly as they do to any other
    // shipped module.
    files: [
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx",
      "scripts/*/src/**/*.ts",
    ],
    plugins: { tsdoc, sonarjs },
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

      // Cognitive complexity (ADR-0034): the one dimension cyclomatic
      // `complexity` above does not capture — nesting/branching that reads as
      // hard to follow even when the cyclomatic count stays low. Only this
      // single rule is enabled, not the plugin's full `recommended` preset,
      // to keep the change to the one gap ADR-0015 named as Sonar's residual
      // value. Default threshold (15).
      "sonarjs/cognitive-complexity": "error",

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
    // The library does not log by default and never logs secrets/caller data
    // (CLAUDE.md § Security) — logging is opt-in through `M3LLogger`, which a
    // caller wires to its own sink. A stray `console.*` in library source
    // would bypass that seam (and any redaction it applies) entirely. Scoped
    // to the library only: scripts are CLI entrypoints and legitimately print
    // (progress, prompts, `--dry-run` summaries).
    //
    // The console server is held to the library's standard rather than the
    // scripts': it is a long-running daemon whose only sanctioned output
    // channel is `M3LLogger` (ADR-0070's display-vs-persist rule). A stray
    // `console.*` in `src/` would emit an unstructured, unredacted line
    // outside that seam. `bin/m3l-console-server.mjs` is the process entry
    // and is deliberately not covered — it prints boot/drain failures before
    // and after a logger exists.
    files: [
      "packages/m3l-common/src/**/*.ts",
      "packages/m3l-console-server/src/**/*.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Scripts must never read `process.env` directly — configuration flows
    // through `M3LConfigParameter` and is read from the resolved config
    // (scripts.md / ADR-0022). This is the mechanically-checkable half of that
    // rule; the composition-root / injected-deps guidance stays advisory.
    //
    // `main.ts` is excluded here and gets these same two selectors folded
    // into its own block below instead of being covered by this one. Flat
    // config REPLACES a rule's value entirely for whichever block matching a
    // given file comes last — options are never merged across blocks for the
    // same rule key — so a file matched by two blocks that both set
    // `no-restricted-syntax` would silently lose one block's selectors
    // (found by the toolchain-hardening PR review: this is exactly what was
    // happening to `main.ts` before this split). Every `no-restricted-syntax`
    // block in this file now has non-overlapping `files`/`ignores` for
    // exactly this reason.
    files: ["scripts/*/src/**/*.ts"],
    ignores: ["scripts/*/src/main.ts", "scripts/*/src/config.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Scripts must not read process.env directly — declare config via M3LConfigParameter and read it from the resolved config (scripts.md).",
        },
        {
          // The no-restricted-imports rule below only visits static import /
          // export declarations, so a dynamic `import("pkg")` would bypass
          // the ADR-0029 boundary. Flag any dynamic import of a string
          // literal that is not relative, not a node: builtin, and not the
          // library (or a subpath) — the same allow-set as the static rule.
          // Non-literal arguments (template/variable specifiers) can't be
          // checked statically and are out of scope here.
          selector:
            "ImportExpression[source.type='Literal'][source.value=/^(?!\\.)(?!node:)(?!@m3l-automation\\/m3l-common($|\\/)).+$/]",
          message:
            "Scripts may only dynamically import @m3l-automation/m3l-common (or a subpath), node: builtins, or a relative module — ADR-0029 bans script-local dependencies.",
        },
      ],
    },
  },
  {
    // ADR-0054: a script may be run IN-PROCESS by a host (the m3l CLI today,
    // an agent runtime later) rather than spawned as `dist/main.js`. A
    // `process.exit` on that path does not end "the script" — it kills the
    // host, taking its other in-flight commands, its run-report persistence,
    // and its own exit code with it. The command-module contract therefore
    // resolves an `M3LCommandOutcome` and lets `Core.runScript` /
    // `mapCommandOutcomeToExitCode` drive `process.exitCode` instead.
    //
    // Scoped to EVERY script source file, not just `command.ts`: steps are
    // reachable from both execution paths, so a `command.ts`-only ban would
    // miss the real hazard (a step killing the CLI host).
    //
    // Deliberately `no-restricted-properties`, NOT `no-restricted-syntax`:
    // flat config REPLACES a rule's value for whichever matching block comes
    // last and never merges, and three blocks already set
    // `no-restricted-syntax` for scripts (general / main.ts / config.ts) —
    // see the comment on the first of them. `no-restricted-properties` is set
    // nowhere else in this file, so one block covering every script source
    // carries no overlap risk, exactly as the `no-restricted-imports` block
    // below documents for itself. It also targets `process.exit` without
    // touching the legitimate `process.exitCode = ...` writes the contract
    // depends on (a different property, and an assignment rather than a call).
    files: ["scripts/*/src/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "exit",
          message:
            "Scripts must never call process.exit — in-process (ADR-0054) it takes the host down with it. Resolve an M3LCommandOutcome and let Core.runScript / mapCommandOutcomeToExitCode drive process.exitCode.",
        },
      ],
    },
  },
  {
    // Scripts must never import the AWS SDK directly — all AWS SDK usage is
    // mediated through @m3l-automation/m3l-common/aws (ADR-0027).
    // packages/m3l-common/src/** is intentionally NOT covered by this block:
    // the library itself legitimately imports the SDK. Kept in its own block
    // (not merged with the no-restricted-syntax block above): this rule key
    // isn't set anywhere else for scripts/*/src, so a single block covering
    // every script file including main.ts has no overlap risk.
    files: ["scripts/*/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          // The `process.exit` ban above is a property-access rule, so it
          // cannot see `import { exit } from "node:process"; exit(1)` — and
          // `node:` builtins are explicitly allowed by the pattern list
          // below. Ban that named import specifically; a default
          // `import process from "node:process"` stays legal and is covered
          // by the property rule.
          paths: [
            {
              name: "node:process",
              importNames: ["exit"],
              message:
                "Scripts must never call process.exit — in-process (ADR-0054) it takes the host down with it. Resolve an M3LCommandOutcome and let Core.runScript / mapCommandOutcomeToExitCode drive process.exitCode.",
            },
          ],
          patterns: [
            {
              group: ["@aws-sdk", "@aws-sdk/*", "@aws-sdk/**"],
              allowTypeImports: false,
              message:
                "Scripts must not import @aws-sdk/* directly — use the typed wrappers in @m3l-automation/m3l-common/aws (e.g. M3LLogsInsightsClient). ADR-0027.",
            },
            {
              // Any bare (non-relative) specifier that is neither the
              // library nor a node: builtin — ADR-0029's package.json rule
              // (check:script-deps) governs the declared dependency; this is
              // its source-level backstop, catching a bare import that
              // slipped past a hand-edited manifest. The real `@aws-sdk`
              // scope is excluded so it surfaces only via the more specific
              // message above — but the lookahead is scope-bounded with
              // `($|/)` so a prefix-squat (`@aws-sdk-evil/x`, `@aws-sdkx`)
              // is still banned here rather than slipping past both rules.
              // The library lookahead is bounded the same way so
              // `@m3l-automation/m3l-common-evil` is banned too.
              regex:
                "^(?!\\.)(?!node:)(?!@aws-sdk($|/))(?!@m3l-automation/m3l-common($|/)).+$",
              allowTypeImports: false,
              message:
                "Scripts may only import @m3l-automation/m3l-common (or a subpath) and node: builtins — ADR-0029 bans script-local dependencies; a new capability becomes a library wrapper first.",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0029 boundary, source-level backstop 2: the no-restricted-imports
    // block above only visits BARE (non-relative) specifiers, so a relative
    // reach into a sibling script — `../../other-script/src/x.js` — slips
    // past both the static and dynamic checks there, and past
    // check:script-deps (which only inspects package.json manifests, not
    // import statements). Each script depends only on
    // @m3l-automation/m3l-common; anything shared across scripts belongs in
    // the library, not a relative import of another script's src. One zone
    // per script directory, generated from the scripts/ directory listing
    // (see scriptPackageNames above) so a new script is covered automatically.
    //
    // The prod-not-to-test zone for scripts/*/src (below) is folded into this
    // same block's `zones` array rather than living in its own block: both
    // would otherwise set `import-x/no-restricted-paths` for the same files,
    // and flat config only keeps whichever block matches a file LAST — the
    // exact bug this comment block's zones were originally silently losing to
    // (found by the toolchain-hardening PR review).
    files: ["scripts/*/src/**/*.ts"],
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            ...scriptPackageNames.map((name) => ({
              target: `./scripts/${name}`,
              from: "./scripts",
              except: [name],
              message: `scripts/${name} may not import another script package directly — each script depends only on @m3l-automation/m3l-common (ADR-0029); shared logic belongs in the library.`,
            })),
            {
              // A `target`/`from` containing a glob character is routed
              // through minimatch instead of prefix-containment
              // (eslint-plugin-import-x's no-restricted-paths), and plain
              // `*` never crosses `/` — `./scripts/*/src` matches only the
              // literal shape `scripts/<name>/src` with nothing after it,
              // never a nested file like `scripts/<name>/src/steps/x.ts`.
              // The trailing `/**` is required for the pattern to match any
              // real file (found by the toolchain-hardening PR review; the
              // 13 literal-path zones above are unaffected since `${name}`
              // has no glob characters).
              target: "./scripts/*/src/**",
              from: "./scripts/*/tests/**",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0022 / scripts.md: "`main.ts` is a composition root only … any
    // conditional, loop, or I/O beyond wiring belongs in a step module —
    // reviewers reject business logic here." That was reviewer-checked only
    // until now. Mechanize the shape (not the judgment call of "is this
    // wiring or logic"): no named function declaration other than `main`
    // itself, no top-level function-valued variable (either belongs in
    // steps/), and a line cap generous enough that real composition roots
    // (currently ~50-60 lines each) never come close.
    //
    // Also carries the two general scripts/*/src selectors (process.env ban,
    // dynamic-import ADR-0029 backstop) from the block above, which
    // explicitly `ignores` this file — `main.ts` needs BOTH sets of
    // selectors, and flat config replaces rather than merges a rule's value
    // across blocks, so the union has to live in one block, not two.
    files: ["scripts/*/src/main.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Scripts must not read process.env directly — declare config via M3LConfigParameter and read it from the resolved config (scripts.md).",
        },
        {
          selector:
            "ImportExpression[source.type='Literal'][source.value=/^(?!\\.)(?!node:)(?!@m3l-automation\\/m3l-common($|\\/)).+$/]",
          message:
            "Scripts may only dynamically import @m3l-automation/m3l-common (or a subpath), node: builtins, or a relative module — ADR-0029 bans script-local dependencies.",
        },
        {
          selector: "FunctionDeclaration[id.name!='main']",
          message:
            "main.ts is a composition root — the only named function it may declare is main() itself; move this to a steps/ module (ADR-0022).",
        },
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator[init.type=/^(FunctionExpression|ArrowFunctionExpression)$/]",
          message:
            "main.ts is a composition root — a top-level function-valued variable belongs in a steps/ module, not here (ADR-0022). An inline callback passed directly to script.run(...)/Core.runScript(...) is fine.",
        },
      ],
      "max-lines": [
        "error",
        { max: 200, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // ADR-0042: the m3l CLI's discovery loader may fall back to executing
    // `scripts/*/src/config.ts` via Node's native type-stripping, which
    // cannot run type-directed emit — enum, runtime namespace, decorators,
    // and constructor parameter properties all throw at import time. Ban
    // them here so the fallback path stays universally loadable.
    //
    // config.ts is `ignores`-excluded from the general scripts
    // no-restricted-syntax block above, and this block re-carries that
    // block's two selectors (process.env ban, dynamic-import backstop):
    // flat config replaces — not merges — a rule's value for whichever
    // block matches a file last, so the union must live in one block (the
    // same split main.ts already uses).
    files: ["scripts/*/src/config.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Scripts must not read process.env directly — declare config via M3LConfigParameter and read it from the resolved config (scripts.md).",
        },
        {
          selector:
            "ImportExpression[source.type='Literal'][source.value=/^(?!\\.)(?!node:)(?!@m3l-automation\\/m3l-common($|\\/)).+$/]",
          message:
            "Scripts may only dynamically import @m3l-automation/m3l-common (or a subpath), node: builtins, or a relative module — ADR-0029 bans script-local dependencies.",
        },
        {
          selector: "TSEnumDeclaration",
          message:
            "config.ts must stay executable under Node native type-stripping (ADR-0042 CLI discovery fallback) — enums need type-directed emit; use a const object or union type instead.",
        },
        {
          selector: "TSModuleDeclaration:not([declare=true])",
          message:
            "config.ts must stay executable under Node native type-stripping (ADR-0042 CLI discovery fallback) — runtime namespaces need type-directed emit; use a plain module instead.",
        },
        {
          selector: "Decorator",
          message:
            "config.ts must stay executable under Node native type-stripping (ADR-0042 CLI discovery fallback) — decorators need type-directed emit.",
        },
        {
          selector: "TSParameterProperty",
          message:
            "config.ts must stay executable under Node native type-stripping (ADR-0042 CLI discovery fallback) — constructor parameter properties need type-directed emit; declare the field explicitly.",
        },
      ],
    },
  },
  {
    // The m3l CLI package mirrors the scripts' ADR-0029 dependency boundary:
    // its only runtime dependency is @m3l-automation/m3l-common, so its
    // source may import only the library (or a subpath) and node: builtins.
    // This mechanizes the package's zero-runtime-dependency guarantee
    // (ADR-0042) at source level, the same way check:script-deps guards the
    // scripts' manifests.
    files: ["packages/m3l-cli/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.)(?!node:)(?!@m3l-automation/m3l-common($|/)).+$",
              allowTypeImports: false,
              message:
                "The m3l CLI may only import @m3l-automation/m3l-common (or a subpath) and node: builtins — ADR-0042 keeps it zero-dependency.",
            },
          ],
        },
      ],
    },
  },
  {
    // The console server carries the same source-level dependency boundary as
    // the m3l CLI: @m3l-automation/m3l-common (or a subpath) and node:
    // builtins, nothing else. ADR-0065 chose a hand-rolled node:http router
    // over a routing framework precisely to keep this budget minimal, and
    // recorded adopting one as an explicit fallback rather than a free
    // choice — so the ban names the widening path in its own message.
    files: ["packages/m3l-console-server/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.)(?!node:)(?!@m3l-automation/m3l-common($|/)).+$",
              allowTypeImports: false,
              message:
                "The console server may only import @m3l-automation/m3l-common (or a subpath) and node: builtins — ADR-0065 keeps its dependency budget minimal. Adopting the recorded routing-framework fallback requires widening this zone in the same PR as a dated ADR-0065 Update.",
            },
          ],
        },
      ],
      // ADR-0065's modular monolith, mechanized the ADR-0009 way. Layering,
      // leaf to root:
      //
      //   errors                                (m3l-common + node: only)
      //   config    -> errors
      //   auth      -> errors
      //   lifecycle -> errors, net
      //   store     -> errors                        (persistence; ADR-0069)
      //   stream    -> errors                        (live event fan-out; X4)
      //   http      -> errors, auth, lifecycle, net, stream   (transport; NOT config)
      //   main.ts   -> everything                    (composition root)
      //
      // `net` is the second pure leaf alongside `errors`: loopback address
      // classification is needed by `config` (to validate the requested bind
      // host), by `lifecycle` (to re-assert it against the address actually
      // bound) and by `http` (the Host/Origin rebinding guard). Keeping the
      // predicate in `config` would have forced a `lifecycle -> config` and
      // an `http -> config` edge — the exact edges this table exists to
      // forbid — so it lives in a leaf all three may reach instead.
      //
      // `http` may not import `config` on purpose: transport receives already
      // resolved values from the composition root, so a request handler can
      // never re-read the environment mid-flight. `main.ts` is in no zone's
      // `target`, so it may import anything; it is in no zone's `except`, so
      // nothing may import IT — the composition root stays a sink.
      //
      // `store` (ADR-0069) is deliberately NOT in `http`'s `except`: `http`
      // may import `lifecycle`, so putting persistence there would hand every
      // request handler a direct SQL seam — the exact inverse of ADR-0065's
      // "modules speak only to typed repositories". `/ready` reports store
      // health through a structural probe declared inside `http/routes/`
      // instead, which needs no import and no edge. A later row that genuinely
      // serves store-backed data widens this with its own justification.
      // `store` appears in no other zone's `except` either, so `config`,
      // `auth`, `lifecycle` and `http` all already cannot reach it.
      //
      // `stream` (X4) is the third pure leaf, and its position is the whole
      // reason it is a separate module rather than part of `runs`. It holds
      // the generic `M3LEventStreamHub<TPayload>` — a ring buffer plus
      // subscriber fan-out, with no `node:http` import and no run-specific
      // type. `runs` PUBLISHES into it and `http` SERVES it, so if the buffer
      // lived in `runs`, serving an SSE stream would require an
      // `http -> runs` edge: transport reaching into orchestration, the exact
      // class of edge this table exists to forbid. Keeping it a leaf both
      // modules may reach costs one zone and buys that edge's absence.
      // `http` -> `stream` is the edge that makes SSE serveable (X4 slice 2):
      // `http/stream-writer.ts` subscribes to a stream by id and encodes each
      // payload as an SSE frame. Note the direction — `http` reaches INTO the
      // leaf, and `stream` still reaches nothing but `errors`, so this widening
      // cannot become a back channel from orchestration into transport.
      // `http` still may not import `runs` or `store`.
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/m3l-console-server/src/net",
              from: "./packages/m3l-console-server/src",
              except: ["net"],
              message:
                "console-server: net/ is a layering leaf — it may import @m3l-automation/m3l-common and node: builtins only, never another console-server module (ADR-0065). It holds pure network-address predicates that config/, lifecycle/ and http/ all need.",
            },
            {
              target: "./packages/m3l-console-server/src/errors",
              from: "./packages/m3l-console-server/src",
              except: ["errors"],
              message:
                "console-server: errors/ is the layering leaf — it may import @m3l-automation/m3l-common and node: builtins only, never another console-server module (ADR-0065).",
            },
            {
              target: "./packages/m3l-console-server/src/config",
              from: "./packages/m3l-console-server/src",
              except: ["config", "errors", "net"],
              message:
                "console-server: config/ may import only errors/ and net/ — it stays a leaf so it can be loaded before anything else exists (ADR-0065).",
            },
            {
              target: "./packages/m3l-console-server/src/auth",
              from: "./packages/m3l-console-server/src",
              except: ["auth", "errors"],
              message:
                "console-server: auth/ may import only errors/ (ADR-0065). It receives the resolved operator profile from main.ts rather than reading config itself.",
            },
            {
              target: "./packages/m3l-console-server/src/lifecycle",
              from: "./packages/m3l-console-server/src",
              except: ["lifecycle", "errors", "net"],
              message:
                "console-server: lifecycle/ may import only errors/ and net/ (ADR-0065). Drain timeouts and bind addresses arrive as arguments from main.ts; net/ is what lets the listener re-assert loopback against the address it actually bound.",
            },
            {
              target: "./packages/m3l-console-server/src/store",
              from: "./packages/m3l-console-server/src",
              except: ["store", "errors"],
              message:
                "console-server: store/ may import only errors/ (ADR-0065, ADR-0069). It receives its resolved database path and busy timeout from main.ts rather than reading config itself, and `store/sqlite-driver.ts` is the single module allowed to import node:sqlite — the seam ADR-0069's recorded fallbacks (a packaged sqlite dependency, or a degraded JSONL-only mode) replace.",
            },
            {
              target: "./packages/m3l-console-server/src/stream",
              from: "./packages/m3l-console-server/src",
              except: ["stream", "errors"],
              message:
                "console-server: stream/ is a layering leaf — it may import @m3l-automation/m3l-common, node: builtins and errors/ only (ADR-0065, ADR-0066). It is generic over its payload type and must never import node:http, store/ or runs/: runs/ publishes into it and http/ serves it, so any edge out of stream/ would drag transport and orchestration into each other.",
            },
            {
              target: "./packages/m3l-console-server/src/runs",
              from: "./packages/m3l-console-server/src",
              except: ["runs", "errors", "store", "stream"],
              message:
                "console-server: runs/ may import only errors/, store/, and stream/ (ADR-0065). Configuration arrives as arguments from main.ts; runs/ must never read the environment directly.",
            },
            {
              target: "./packages/m3l-console-server/src/http",
              from: "./packages/m3l-console-server/src",
              except: ["http", "errors", "auth", "lifecycle", "net", "stream"],
              message:
                "console-server: http/ is transport — it may import errors/, auth/, lifecycle/, net/ and stream/, but NOT config/, store/ or runs/ (ADR-0065). Resolved configuration is passed in from main.ts; a handler must never re-read the environment. stream/ is reachable so an SSE route can subscribe to a live event stream by id (ADR-0066) without transport ever importing orchestration.",
            },
            {
              target: "./packages/m3l-console-server/src",
              from: "./packages/m3l-console-server/tests",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    // The repo's first browser/JSX zone (ADR-0067). `packages/m3l-console-web`
    // runs under the DOM, not Node — it gets `globals.browser` instead of the
    // `globals.node` the no-cycle zone below sets for every tsc-only package,
    // and it may not import a `node:` builtin at all (the inverse of the
    // m3l-cli/console-server zones above, which ban everything EXCEPT
    // `node:` and `@m3l-automation/m3l-common`).
    files: [
      "packages/m3l-console-web/src/**/*.{ts,tsx}",
      "packages/m3l-console-web/tests/**/*.{ts,tsx}",
      "packages/m3l-console-web/vitest.setup.ts",
    ],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^node:",
              allowTypeImports: false,
              message:
                "packages/m3l-console-web is browser-target (ADR-0067) — it cannot import a node: builtin.",
            },
          ],
        },
      ],
      // Re-declared (not merged) from the source-design zone above: flat
      // config replaces a rule's value per matching block rather than deep-
      // merging it, so this zone must restate the FULL naming-convention
      // array to keep every other selector's constraint, adding only the
      // "function" selector PascalCase needs for a React component
      // (`export function HealthBanner()`) alongside the camelCase every
      // other function in the workspace already uses.
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "default",
          format: ["camelCase"],
          leadingUnderscore: "allow",
        },
        {
          selector: "function",
          format: ["camelCase", "PascalCase"],
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
        {
          selector: ["objectLiteralProperty", "typeProperty"],
          format: null,
        },
      ],
    },
  },
  {
    // Playwright's config and specs run under Node (via `playwright test`'s
    // own loader), not the browser — the opposite of every other file under
    // packages/m3l-console-web (ADR-0067's X9b Playwright harness). The
    // broader `tests/**` glob in the browser/JSX zone above (browser
    // globals, the node: import ban, the type-aware ruleset) still matches
    // `tests/e2e/**` too since it's a subset path, so this LATER zone resets
    // what that inheritance gets wrong — flat config overrides a rule's
    // value per matching block, later wins, so only what's redeclared here
    // actually changes.
    files: [
      "packages/m3l-console-web/playwright.config.ts",
      "packages/m3l-console-web/tests/e2e/**/*.ts",
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: false },
    },
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
  {
    // `internal/` is private and MUST NOT be re-exported through a public
    // barrel (rules 04 / ADR 0004 — the exports map stays at three entries).
    // Forbid the public entry points from importing it at all.
    //
    // Also carries the library-wide prod-not-to-test zone (production source
    // must never import from tests/ — a src module reaching into tests/ for a
    // fixture or helper is a smell that also breaks tsconfig.build.json's
    // `exclude: ["tests"]` at build time). That zone is duplicated into every
    // block below that partitions packages/m3l-common/src (this one, the aws
    // island, the core zone, and the two single-purpose core/script and
    // internal/ blocks further down) rather than living in one broad block,
    // because flat config replaces — not merges — a rule's value for
    // whichever block matching a file comes last, and every one of those
    // blocks already sets `import-x/no-restricted-paths` for overlapping
    // files (found by the toolchain-hardening PR review).
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
            {
              target: "./packages/m3l-common/src",
              from: "./packages/m3l-common/tests",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
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
    // Zone A: aws/** may import only core/errors, core/prompt, and
    // core/polling (the last widened by ADR-0026 for aws/sqs's internal
    // retry composition, and relied on by ADR-0027's aws/logs-insights for
    // the same reason — core/polling is acyclic w.r.t. aws/*: it depends
    // only on core/events + internal/, nothing in that chain imports aws),
    // plus the single file core/utils/M3LSingleFlight.ts (widened by
    // ADR-0040 for aws/credentials/manager.ts's SSO-login coalescing —
    // deliberately file-scoped, not the whole utils/ subtree, since
    // M3LSingleFlight.ts has zero imports of its own while core/utils as a
    // whole is the mid layer in ADR-0009's diagram), plus the two files
    // core/logging/M3LLogEvent.ts and core/logging/M3LLogEventCategory.ts
    // (widened by ADR-0041 for aws/credentials/manager.ts's injected logger
    // seam — again file-scoped: those two files form a closed, zero-heavy-
    // dependency leaf subgraph, unlike core/logging/index.ts's barrel which
    // pulls in M3LLogger.ts, redact.ts, and the three handler classes).
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
              except: [
                "errors",
                "prompt",
                "polling",
                "utils/M3LSingleFlight.ts",
                "logging/M3LLogEvent.ts",
                "logging/M3LLogEventCategory.ts",
              ],
              message:
                "aws/* may import only core/errors, core/prompt, core/polling, core/utils/M3LSingleFlight.ts, core/logging/M3LLogEvent.ts, and core/logging/M3LLogEventCategory.ts — no other core module (ADR-0009 layering, ADR-0040, ADR-0041).",
            },
            {
              target: "./packages/m3l-common/src",
              from: "./packages/m3l-common/tests",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
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
    //
    // Same block also carries the reverse of Zone A: no core/** module may
    // import aws/** (`core/procedure`, B2/#474 — the engine is documented as
    // "prompt-agnostic" and aws-agnostic, reaching AWS only through an
    // injected dependency bag, never a static import). aws/ is a leaf island
    // that already may not import back into core beyond the Zone A allowlist,
    // so this closes the cycle from the other direction; without it, nothing
    // stops a future core/** module from statically importing @aws-sdk/* via
    // aws/**, which ADR-0027 reserves for aws/ wrappers alone.
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
            {
              target: "./packages/m3l-common/src/core",
              from: "./packages/m3l-common/src/aws",
              message:
                "core/* may not import aws/* — aws/ is a separate island reached only through an injected dependency bag (ADR-0009 layering, ADR-0027).",
            },
            {
              target: "./packages/m3l-common/src",
              from: "./packages/m3l-common/tests",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    // core/script itself has no zone above (it's excluded from Zone B, which
    // protects OTHER core modules against importing it) but still needs the
    // library-wide prod-not-to-test zone — it's the one packages/m3l-common
    // subtree not otherwise covered by the barrel/aws/core blocks.
    files: ["packages/m3l-common/src/core/script/**/*.ts"],
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/m3l-common/src",
              from: "./packages/m3l-common/tests",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    // internal/ is likewise not covered by any of the barrel/aws/core blocks
    // above (it's a sibling of core/ and aws/, not nested under either) and
    // needs the same library-wide prod-not-to-test zone.
    files: ["packages/m3l-common/src/internal/**/*.ts"],
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/m3l-common/src",
              from: "./packages/m3l-common/tests",
              message:
                "Production source must not import from tests/ — move shared fixtures/helpers into src/ if they're needed at runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    // The whole library must stay acyclic (ADR-0035 phase 3, widened repo-wide
    // by A8). core/logging <-> core/diagnostics genuinely depend on each
    // other's *files*: M3LLogger imports serializeErrorChain from
    // diagnostics/format-error.js, while the diagnostics files import the
    // redaction helpers from logging/redact.js. That is a DAG only because the
    // diagnostics side imports the redact module directly — routing it through
    // `../logging/index.js` (the barrel, which re-exports M3LLogger) closes
    // the loop `M3LLogger -> format-error -> logging/index -> M3LLogger`.
    //
    // core/script has the same shape (ADR-0035 phase 4a): `runScript`
    // introduces a core/script -> core/diagnostics edge (the composition
    // root's only permitted cross-module import, ADR-0009 Zone B), which is a
    // DAG only because it imports diagnostics files directly rather than
    // through a barrel that would loop back.
    //
    // core/environment <-> core/utils (via M3LPaths) carried the same failure
    // mode until A8: `environment/index.ts` imported `isNodeError`/
    // `isNonEmptyString` through the `../utils/index.js` barrel, which
    // re-exports M3LPaths, which imports M3LExecutionEnvironment back from
    // `environment/index.ts`. Retargeting that import at
    // `../utils/guards.js` directly (the module the two symbols actually live
    // in, with no imports of its own) broke the loop, so the rule now covers
    // every `.ts` file under the package rather than an allowlist of modules
    // known to be clean — nothing about an import line advertises how
    // load-bearing it is, so the standing invariant is "the whole library is
    // a DAG," not "these three modules happen to be."
    //
    // Widened to scripts/*/src (toolchain-hardening follow-up): a cycle
    // between a script's steps/ modules is the same failure mode and was
    // previously uncovered — the rule's scope is "every module that ships",
    // not "the library specifically".
    files: [
      "packages/m3l-common/src/**/*.ts",
      "scripts/*/src/**/*.ts",
      "packages/m3l-cli/src/**/*.ts",
      "packages/m3l-console-server/src/**/*.ts",
      "packages/m3l-console-web/src/**/*.ts",
      "packages/m3l-console-web/src/**/*.tsx",
    ],
    rules: {
      "import-x/no-cycle": ["error", { maxDepth: Infinity }],
    },
  },
  {
    // Node.js automation scripts (bin/) and Claude Code hooks (.claude/hooks/).
    // Plain ESM .mjs — no TypeScript project service. Enables the rules that
    // caught historical PR findings: empty-catch swallowing, variable shadowing,
    // unused vars, and (via no-undef) missing explicit imports.
    files: [
      "bin/**/*.mjs",
      ".claude/hooks/**/*.mjs",
      "packages/m3l-cli/bin/**/*.mjs",
      "packages/m3l-console-server/bin/**/*.mjs",
    ],
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
    // `.tsx` widened on for packages/m3l-console-web's component tests.
    files: [
      "**/tests/**/*.ts",
      "**/tests/**/*.tsx",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
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
