# 0023. Re-affirm the external code-index MCP deferral on new grounds

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Enrico Lionello

## Context and problem statement

[ADR-0012](./0012-defer-external-code-index-mcp.md) deferred adding an external
code-indexing MCP server (Serena, codebase-memory-mcp, claude-context) in favour
of the already-enabled `typescript-lsp@claude-plugins-official` plugin plus the
generated `docs/reference/catalog.json` / `symbol-map.json` artifacts. Its
central driver was that **"the codebase is currently small: only 5 of 22
submodules are implemented,"** with an explicit revisit trigger: _"Revisit
if/when the remaining 17 modules land and agent grep cost becomes material."_

That trigger has now half-fired, so the decision is due for a documented
revisit rather than silent drift:

- **All 22 submodules have landed.** The "5 of 22 / 17 empty `symbols[]`"
  premise is stale — `docs/reference/catalog.json` enumerates 22 modules, each
  with populated symbols, and `docs/reference/symbol-map.json` holds 261 public
  symbols.
- **The repo crossed ~51k LOC of tracked TypeScript** (217 files) and is on a
  ~100k-LOC trajectory once the planned W2–W4 consumer fleet (12 more scripts)
  and the gated D4/D5 modules land — i.e. approaching the scale at which an
  index MCP is conventionally argued to pay off.
- **The candidate landscape shifted.** Serena is no longer Python-only for the
  navigation use case — it now supports TypeScript via LSP backends. But the
  counter-force strengthened too: Claude Code gained **native LSP** integration,
  and this repo already runs the `typescript-lsp` plugin
  (`.claude/settings.json`).

The question ADR-0012 told us to revisit: **now that the module-count half of
the trigger has fired, should an external code-index MCP be adopted?**

## Decision drivers

- **Minimal, uniform toolchain** (ADR-0001): the stack is strictly
  Node/pnpm/ESM; a Python/`uv` server for Serena reintroduces the cross-language
  setup step ADR-0012 rejected.
- **Native LSP already delivers symbol navigation**: go-to-definition,
  find-references, and hover are covered by the enabled `typescript-lsp` plugin.
- **The generated catalog auto-grew to cover the growth**: the
  `catalog.json` / `symbol-map.json` pair now provides the O(1) symbol→file
  lookup ADR-0012 designed for, across all 22 modules, gated by `check:index`.
- **Architecture suppresses cross-cutting grep cost**: isolated submodules,
  independent script packages, per-module `docs/reference` spec pages, and
  scoped hub-and-spoke Explore briefs mean agents rarely sweep the whole tree.
- **Cost of a live server is unchanged**: process management, `npx`/`uvx` at
  session start, and index staleness versus committed, CI-verified artifacts.

## Considered options

1. **Adopt Serena now** — TypeScript-capable via LSP backends, run as an
   external `uvx` process. Adds a Python/`uv` dev-environment toolchain
   (ADR-0001 friction) and overlaps three layers already in place (native LSP,
   the catalog, and grep).
2. **Adopt a Node-only indexer now** (ADR-0012's option 2, e.g.
   codebase-memory-mcp) — keeps the toolchain uniform, but offers keyword search
   over file contents, the least added capability over what native LSP + the
   populated catalog already deliver.
3. **Re-affirm the deferral with a rewritten trigger** — record that the
   original "codebase too small" rationale is dead, but the deferral survives on
   new grounds, and replace the now-fired trigger with one tied to observed
   friction rather than a module count.

## Decision

We chose **option 3 — re-affirm the deferral on new grounds**. The original
"codebase too small" rationale no longer holds, but the need it was weighed
against is still covered without an external indexer: native LSP handles typed
symbol navigation, the generated catalog/symbol-map handles cross-module
symbol→file lookup, and the module topology keeps whole-tree grep sweeps rare.
Adopting Serena (option 1) would reintroduce the exact cross-language toolchain
cost ADR-0012 rejected, for marginal value over three existing layers; a
Node-only indexer (option 2) adds keyword search that the typed catalog already
subsumes.

**Rewritten revisit trigger:** the W2–W4 consumer fleet has landed **and**
spokes exhibit observed grep/context friction that the populated
`catalog.json` / `symbol-map.json` cannot answer. When that gate opens, the
candidates re-rank at that time — Serena (now TS-mature) versus a Node-only
indexer, weighed against ADR-0001's toolchain ethos.

## Consequences

- **Positive:**
  - The Node/pnpm/ESM toolchain stays uniform; no server process, port, or
    cross-language setup is added.
  - The deferral now rests on a durable, accurate rationale (native LSP + the
    fully populated catalog) instead of an obsolete module count.
  - The revisit trigger is tied to observable friction, so a future revisit is
    evidence-driven rather than premature.
- **Negative / trade-offs:**
  - If whole-tree semantic search does become material during the fleet build,
    it will surface as agent friction before an indexer is in place — accepted,
    because the trigger is designed to catch exactly that.
  - ADR-0012's body keeps its stale "5 of 22" framing (ADRs are immutable); this
    ADR is the corrective record.
- **Semver impact:** none — tooling and documentation only; no change to the
  public API.

## Links

- Related: [ADR-0012](./0012-defer-external-code-index-mcp.md) (the decision this
  re-affirms), [ADR-0001](./0001-toolchain-choices.md) (toolchain ethos),
  `.claude/settings.json` (`typescript-lsp` plugin),
  `docs/reference/catalog.json`, `docs/reference/symbol-map.json`,
  `docs/plans/IMPLEMENTATION.md` (P2 gated table).
- Evidence gathered 2026-07-11: [Serena](https://github.com/oraios/serena),
  [Serena 2026 guide](https://mcp.directory/blog/serena-mcp-complete-guide-2026),
  [LSP with Claude Code at scale](https://www.mindstudio.ai/blog/language-server-protocol-lsp-claude-code-large-codebases),
  [Claude Code native LSP (HN)](https://news.ycombinator.com/item?id=46355165).
