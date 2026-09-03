// Pure derivation for bin/check-no-docker.mjs. Nothing here reads a
// filesystem or shells out — the CLI wrapper collects tracked paths and file
// contents and hands them to the scan functions below, mirroring
// bin/lib/control-char-scan.mjs's shape so this stays exercisable in tests
// without touching disk.
//
// Why this gate exists. ADR-0091 bans Docker and Dockerfiles project-wide in
// favor of Podman + Containerfile + a `podman kube play` pod manifest, on
// standards-purity, licensing, and rootless/daemonless security grounds. A
// stance recorded only in an ADR is easy to violate by accident — a
// copy-pasted `docker build` in a new workflow step, a Dockerfile dropped
// back in by a dependency's scaffold, a stray `docker-compose.yml` from an
// old branch — with nothing to catch it before it lands on `main`. This gate
// is the enforcement half of that ADR.
//
// Scope is deliberately narrow: FILENAMES that are unambiguously Docker
// artifacts, and COMMAND INVOCATIONS in the files that actually execute
// things (CI workflows, npm scripts, bin/ scripts, lefthook lanes) — not a
// prose ban. `docs/adr/**`, `docs/logs/**`, and `docs/plans/archive/**` are
// the historical record of what Docker-era X12 actually shipped and are
// allowlisted outright; `docker.io/` is a registry hostname (Podman still
// pulls Docker Hub images), not the banned tool, and is allowlisted wherever
// it appears. This gate's own source and test necessarily discuss the banned
// terms and are self-exempt.

/** Directory prefixes exempt from every check in this module — the historical
 * record of Docker-era decisions and artifacts, not a living spec. */
export const ALLOWLIST_DIR_PREFIXES = [
  "docs/adr/",
  "docs/logs/",
  "docs/plans/archive/",
];

/** This gate's own source and test — necessarily full of the banned terms. */
export const SELF_EXEMPT_PATHS = new Set([
  "bin/check-no-docker.mjs",
  "bin/lib/docker-ban-scan.mjs",
  "bin/tests/docker-ban-scan.test.ts",
]);

/** Path prefixes/exact names whose CONTENT is scanned for a `docker` command
 * invocation. Everything else in the repo may mention the word freely (in
 * prose, comments, ADRs) — only files that actually execute commands are
 * scanned for actually invoking the banned tool. */
export const INVOCATION_SCAN_PREFIXES = [".github/workflows/", "bin/"];
export const INVOCATION_SCAN_EXACT = new Set(["lefthook.yml"]);

const BANNED_FILENAME_PATTERNS = [
  { re: /^dockerfile$/i, label: "Dockerfile" },
  { re: /\.dockerfile$/i, label: "*.dockerfile" },
  { re: /^\.dockerignore$/i, label: ".dockerignore" },
  { re: /^docker-compose\.ya?ml$/i, label: "docker-compose.y*ml" },
];

/** `docker` or `docker-compose` as a standalone, LOWERCASE token — an actual
 * shell invocation, never Docker.io/a `docker.io` registry reference, and
 * never this gate's own name (`check:no-docker`, `bin/check-no-docker.mjs`,
 * "no-docker" in a comment) or English prose. Deliberately case-SENSITIVE:
 * every real invocation of the `docker` binary is lowercase (it is a shell
 * command, not a sentence), while every false positive found in this gate's
 * own dry run was capitalized prose ("Docker artifacts", "Docker-API-shaped
 * daemon", "Docker as the build engine") or the compound identifier
 * "no-docker" this very gate is named after. The negative lookbehind excludes
 * `docker` embedded in a hyphenated/colon-joined compound word (`no-docker`,
 * `check:no-docker`) — no real invocation is ever spelled that way; a real one
 * is always preceded by whitespace, a shell operator, a quote, or nothing. */
const INVOCATION_RE = /(?<![\w:-])docker(?:-compose)?\b(?!\.io)/g;

/**
 * True when `path` sits under an allowlisted historical-record directory.
 *
 * @param {string} path repo-relative, forward-slash separated
 * @returns {boolean}
 */
export function isAllowlisted(path) {
  return ALLOWLIST_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Scan tracked paths for a banned Docker-artifact filename. Reports the
 * exact path and which pattern it matched, so the finding is fixable without
 * re-deriving why the name is banned.
 *
 * @param {string[]} paths tracked, repo-relative paths
 * @returns {string[]} one finding per banned filename, empty when clean
 * @example
 * ```js
 * scanFilenames(["packages/m3l-console-server/Dockerfile", "README.md"]);
 * // ['packages/m3l-console-server/Dockerfile is a banned Docker artifact ...']
 * ```
 */
export function scanFilenames(paths) {
  /** @type {string[]} */
  const findings = [];

  for (const path of paths) {
    if (isAllowlisted(path)) continue;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const hit = BANNED_FILENAME_PATTERNS.find((p) => p.re.test(base));
    if (!hit) continue;
    findings.push(
      `${path} is a banned Docker artifact filename (matches "${hit.label}") — ` +
        "ADR-0091 bans Docker/Dockerfiles project-wide; use a Containerfile " +
        "and, for a runnable pod, a `podman kube play` Kube-YAML manifest " +
        "instead. Historical artifacts belong under docs/logs/** or " +
        "docs/plans/archive/**, never live in the tree.",
    );
  }

  return findings;
}

/**
 * Scan raw file content for a `docker`/`docker compose`/`docker-compose`
 * invocation. Used for files that are not JSON (workflows, `bin/**`,
 * `lefthook.yml`) — content is checked verbatim, since these files exist to
 * run commands, not to hold prose.
 *
 * @param {{ path: string, content: string }[]} files
 * @returns {string[]} one finding per offending file, empty when clean
 */
export function scanRawInvocations(files) {
  /** @type {string[]} */
  const findings = [];

  for (const { path, content } of files) {
    if (isAllowlisted(path) || SELF_EXEMPT_PATHS.has(path)) continue;
    const matches = content.match(INVOCATION_RE);
    if (!matches || matches.length === 0) continue;
    findings.push(
      `${path} invokes the banned \`${matches[0]}\` command (${matches.length} ` +
        "occurrence(s)) — ADR-0091 bans Docker/Docker Compose project-wide; " +
        "use `podman`/`podman build`/`podman kube play` instead. A " +
        "`docker.io/` image reference is fine (it names a registry " +
        "hostname, not the tool) and is not flagged.",
    );
  }

  return findings;
}

/**
 * Scan `package.json`-shaped content for a `docker`/`docker-compose`
 * invocation inside its `scripts` block specifically — the rest of a
 * `package.json` (description, keywords, dependency names) is prose/config,
 * not something this gate polices.
 *
 * @param {{ path: string, content: string }[]} files
 * @returns {string[]} one finding per offending SCRIPT (a file with two
 *   banned scripts produces two findings, naming each one), so the fix is
 *   never left to be re-derived; a file that fails to parse as JSON is
 *   reported as a single error finding instead, never silently skipped
 */
export function scanPackageJsonScripts(files) {
  /** @type {string[]} */
  const findings = [];

  for (const { path, content } of files) {
    if (isAllowlisted(path)) continue;

    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      findings.push(
        `${path} could not be parsed as JSON while scanning for a banned ` +
          `Docker invocation in its "scripts" block ` +
          `(${cause instanceof Error ? cause.message : String(cause)}). ` +
          "Not skipping silently — fix the JSON or the file goes unscanned.",
      );
      continue;
    }

    const scripts =
      parsed !== null && typeof parsed === "object"
        ? /** @type {Record<string, unknown>} */ (parsed).scripts
        : undefined;
    if (
      scripts === undefined ||
      typeof scripts !== "object" ||
      scripts === null
    )
      continue;

    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== "string") continue;
      const matches = value.match(INVOCATION_RE);
      if (!matches || matches.length === 0) continue;
      findings.push(
        `${path}'s "scripts.${name}" invokes the banned \`${matches[0]}\` ` +
          "command — ADR-0091 bans Docker/Docker Compose project-wide; use " +
          "`podman`/`podman build`/`podman kube play` instead.",
      );
    }
  }

  return findings;
}
