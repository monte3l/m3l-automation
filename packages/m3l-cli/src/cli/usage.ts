/**
 * `cli/usage` — the hand-written `m3l` usage text.
 *
 * Its own module rather than a function in `main.ts`: the text is pure
 * presentation with no dispatch logic, it grows every time a command or a
 * reserved flag is added, and `main.ts` is the file closest to
 * `check:file-budget`'s 25,000-byte source ceiling.
 *
 * @packageDocumentation
 */

import type { M3LCliOutput } from "./output.js";

/**
 * Prints the hand-written usage text (`parseArgs` generates none).
 *
 * @param output - The writer facade to render through.
 *
 * @example
 * ```ts
 * import { printUsage } from "./usage.js";
 *
 * printUsage(output);
 * ```
 */
export function printUsage(output: M3LCliOutput): void {
  output.info("Usage: m3l <command> [options]");
  output.info("");
  output.info("Commands:");
  output.info("  list                       List every scripts/* package");
  output.info(
    "  inspect <script>           Show a script's declared parameters",
  );
  output.info(
    "  run <script> -- [args...]  Run a script, forwarding args after '--' verbatim",
  );
  output.info(
    "  doctor                     Run environment/workspace health checks",
  );
  output.info(
    "  presets <script>           List a script's declared preset files",
  );
  output.info("  history                    Show the recorded run history");
  output.info(
    "  new <name> [options]       Scaffold a new scripts/<name>/ package",
  );
  output.info(
    "  wizard                     Interactively build and run a script",
  );
  output.info(
    "  completion <shell>         Print a bash/zsh/fish completion script",
  );
  output.info("  help                       Show this help message");
  output.info("  <script> [--param value ...] [-- args...]");
  output.info(
    "                             Run any discovered scripts/* package,",
  );
  output.info(
    "                             translating its declared parameters into flags",
  );
  output.info("");
  output.info("Flags:");
  output.info("  --json             Machine-readable output");
  output.info("  --in-process       Run in this process instead of spawning");
  output.info(
    "  --env-file <path>  Load this env file in the spawned script (default ./.env)",
  );
  output.info("  --no-env-file      Load no env file at all");
  output.info("  --version          Print the CLI version");
  output.info("  -h, --help         Show this help message");
}
