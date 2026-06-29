# Graphical overhaul: m3l-automation presentation

## Context

`@m3l-automation/m3l-common` is a strict-TypeScript, ESM-only, Node 24+
automation/CLI library (Apache-2.0, `monte3l/m3l-automation`). It is technically
mature in structure — 22 documented submodules, a 14-step CI pipeline, a
hub-and-spoke agent model, TDD discipline — but its outward presentation is
entirely plain text. The root README has no badges, no visual identity, no
diagrams; there is no published npm README, no docs site, and no GitHub
community files. It is honestly early: **2 of 22 submodules** (`errors`,
`events`) are implemented at `0.0.0-development`.

This overhaul gives the project a coherent, **matter-of-fact** visual identity —
no marketing, no embellishment, honesty and concision first — grounded in the
subject's own vernacular: the terminal. Direction is **Monokai, dark-mode only**.
Deliverables: redesigned root + npm READMEs, committed SVG assets, GitHub
community/branding files, and a GitHub-Pages docs-site seed under `/docs`.

## Design system (the brief)

Dark-only. Monokai is the literal reference — colors are exact, used the way a
syntax theme uses them (accents carry meaning, not decoration).

**Color tokens**

| Token         | Hex       | Role                              |
| ------------- | --------- | --------------------------------- |
| `--bg`        | `#272822` | page / terminal background        |
| `--bg-raised` | `#2F302A` | panels, code frames               |
| `--border`    | `#3E3D32` | hairlines, frame borders          |
| `--fg`        | `#F8F8F2` | primary text                      |
| `--muted`     | `#75715E` | comments, captions, secondary     |
| `--green`     | `#A6E22E` | functions / "done" / success      |
| `--pink`      | `#F92672` | keywords / breaking / not-started |
| `--blue`      | `#66D9EF` | types / links                     |
| `--orange`    | `#FD971F` | constants / in-progress           |
| `--yellow`    | `#E6DB74` | strings / highlights              |

Accent semantics are reused consistently (e.g. status: `green`=done,
`orange`=in-progress, `pink`/`muted`=not-started) so color encodes truth.

**Type** — IBM Plex Mono for display, wordmark, code, labels, and data; IBM Plex
Sans for body prose. Coherent family pairing, terminal-leaning, not the generic
serif default. (Site loads both as webfonts; SVGs use `ui-monospace, monospace`
with exact Monokai fills, wordmark text outlined to paths for fidelity.)

**Layout** — single readable column; content sits inside recurring **terminal
panes** (titlebar showing a path like `~/m3l-common`, hairline border, Monokai
body). No mac traffic-light dots (embellishment).

**Signature** — the Monokai-syntax **terminal pane** is the one repeated device:
the hero is a real terminal frame showing actual `import` + `M3LScript` usage;
the module map is a `tree`-style listing; status lines use a `›` prompt glyph.
The code shown is real, not mocked — honesty is the aesthetic.

## Deliverables

### 1. SVG assets (`docs/assets/`)

- `m3l-wordmark.svg` — restrained `m3l-common` monospace wordmark, one accent
  rule (`--green`), text outlined to paths. Sits above the hero.
- `m3l-hero.svg` — terminal pane (titlebar `~/m3l-common`, Monokai body)
  rendering the real quick-start snippet from `README.md:36-46`, syntax-colored
  with the exact tokens above. Dark-only, fixed viewBox, scales responsively.
- `favicon.svg` — minimal `m3l` glyph for the docs site.

SVGs must survive GitHub's markdown sanitizer: no scripts, no external font
`@import`, inline fills only.

### 2. Root `README.md` (GitHub repo landing) — restructure

Keep it concise and honest; reuse existing copy, don't inflate it.

- Centered wordmark (`docs/assets/m3l-wordmark.svg`) + hero
  (`docs/assets/m3l-hero.svg`) via `<p align="center">`.
- **Truthful badge row only** (static shields, Monokai-tinted where supported):
  CI status (Actions `ci.yml`), `node >=24`, `ESM only`, `TypeScript strict`,
  `License Apache-2.0`, and an honest status badge (`status: pre-release` /
  `modules 2/22`). **No** npm-version/downloads badges until actually published
  (would mislead at `0.0.0-development`).
- Preserve the existing status banner (`README.md:3-5`) and the
  "Features (target API — not yet implemented)" honesty (`README.md:9-19`).
- Tighten sections: What it is → Status → Requirements → Install → Quick start
  (links to the hero's real code) → Namespaces table (`README.md:48-63`) →
  Documentation (link to the docs site) → License.
- Add a one-line link to the docs site once Pages is enabled.

### 3. npm package README — `packages/m3l-common/README.md` (NEW)

The published artifact (semantic-release publishes this package); `homepage`
already points at its `#readme` but the file does not exist. Concise variant of
the root README. **Asset `src` must be absolute** raw URLs
(`https://raw.githubusercontent.com/monte3l/m3l-automation/main/docs/assets/...`)
— relative paths break on npmjs.com.

### 4. GitHub community/branding files (matter-of-fact, public-OSS)

- `.github/CONTRIBUTING.md` — thin pointer to existing `docs/contributing/*`
  (don't duplicate); summarize the Conventional-Commits + lefthook + CI gate
  flow already documented.
- `.github/SECURITY.md` — supported versions + private reporting channel
  (GitHub Security Advisories); note the CI secret-scan / dependency-review
  posture factually.
- `.github/CODE_OF_CONDUCT.md` — Contributor Covenant, contact = repo owner.
- `.github/ISSUE_TEMPLATE/` — `bug_report.md` + `feature_request.md` + minimal
  `config.yml`. Plain, no emoji-heavy boilerplate.
- `package.json` (both root and `packages/m3l-common`): add `keywords` +
  `author`. **Do not** touch `version` (tool-owned) or the `exports` map.

All new markdown must pass `pnpm lint:md` (rumdl) and `pnpm format:check`
(prettier). `.github/pull_request_template.md` already exists — leave it.

### 5. Docs-site seed — GitHub Pages from `/docs`

Self-contained, dark-only Monokai terminal theme; the seed of a docs site that
grows over time (not a marketing page).

- `docs/index.html` — single page: terminal-pane hero (wordmark + real
  snippet), one-paragraph "what it is", honest **status panel** (2/22, the
  implemented `errors`/`events` highlighted, rest as roadmap from
  `docs/implementation-status.md`), a `tree`-style **module map** of the 22
  submodules (Core ×19 + AWS ×3) with status-colored glyphs, install block,
  and a links section into the existing `docs/` reference/guides/ADRs.
- `docs/assets/site.css` — design tokens above as CSS custom properties;
  responsive to mobile; visible keyboard focus; `prefers-reduced-motion`
  respected (cursor blink only, and disabled under reduced-motion).
- Reuse `docs/assets/*.svg` from deliverable 1.
- Content is sourced from real docs (`implementation-status.md`,
  `m3l-common-architecture.md` §1 module map) — no invented capabilities.
- Pages itself is enabled in repo Settings (manual, one-time; called out in
  verification — not a file change).

Motion budget: a single blinking cursor in the hero; nothing else. Matches
"no embellishment."

## Out of scope

- No `version`/`dist/`/`exports`-map edits (tool-owned / semver events).
- No conversion of existing `docs/*.md` ASCII diagrams (the site re-renders the
  module map; source docs stay as-is).
- No light mode.

## Verification

1. **SVG render** — open each SVG in a browser (dark bg) and confirm Monokai
   fills; paste the README into GitHub's preview (or push to a branch) to verify
   the sanitizer keeps the images and `<p align>` centering.
2. **README links/assets** — confirm relative asset paths resolve on the repo
   page and absolute raw URLs resolve in the npm README (test the raw URL in a
   browser).
3. **Docs site** — open `docs/index.html` locally; check hero, status panel
   colors match token semantics, module map lists exactly 22 modules with
   correct done/in-progress/not-started glyphs, responsive at ~375px width,
   keyboard focus visible, reduced-motion disables the cursor blink.
4. **Quality gates** — `pnpm format` then `pnpm format:check`, `pnpm lint:md`
   must pass on all new markdown. Run `pnpm check:doc-counts` to confirm the
   doc-count guard still passes (we add files, not reference pages).
5. **Honesty pass** — re-read every new line of copy against "2 of 22, early
   development": no claim implies a module is usable that isn't.
6. **Pages** — after merge, enable Settings → Pages → branch `main` `/docs`;
   confirm the published URL loads dark and renders identically.

## Build order (hub-and-spoke)

Per the repo's operating model, the hub dispatches; it does not hand-write these
files itself. Suggested spoke sequence: (a) assets + tokens, (b) root + npm
READMEs, (c) docs-site seed, (d) community files, then (e) `docs-consistency-reviewer`
for the doc-count/link/honesty audit before any PR.
