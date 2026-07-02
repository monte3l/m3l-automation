/**
 * Core namespace — the application framework plus cross-cutting utilities.
 *
 * Public submodules (documented under `docs/reference/core/`) are re-exported
 * here as they are implemented: `script`, `config`, `environment`, `errors`,
 * `events`, `logging`, `prompt`, `importers`, `exporters`, `files`, `json`,
 * `text`, `storage`, `utils`, `network`, `polling`, `analysis`, `messaging`,
 * `security`.
 *
 * Each submodule lives in its own directory with a barrel `index.ts` and is
 * surfaced through this namespace — the package `exports` map stays at three
 * entries (`.`, `./core`, `./aws`), so submodules are reached via the namespace,
 * not via per-module subpaths.
 *
 * @packageDocumentation
 */

export * from "./analysis/index.js";
export * from "./config/index.js";
export * from "./environment/index.js";
export * from "./errors/index.js";
export * from "./events/index.js";
export * from "./json/index.js";
export * from "./messaging/index.js";
export * from "./prompt/index.js";
export * from "./security/index.js";
export * from "./utils/index.js";
