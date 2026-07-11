import { Core } from "@m3l-automation/m3l-common";

/** A single parsed `name=path` extraction spec. */
interface FieldSpec {
  readonly name: string;
  readonly path: string;
}

/**
 * Parses a `fields` entry (`"name=path"`) into its name and path, splitting
 * on the first `=` only (a path may itself never contain `=`, but this keeps
 * the split unambiguous either way).
 *
 * @param spec - The raw `name=path` entry.
 * @returns The parsed `{ name, path }` pair.
 */
function parseFieldSpec(spec: string): FieldSpec {
  const separatorIndex = spec.indexOf("=");
  if (separatorIndex < 0) {
    return { name: spec, path: spec };
  }
  return {
    name: spec.slice(0, separatorIndex),
    path: spec.slice(separatorIndex + 1),
  };
}

/**
 * Collapses a field's extracted matches into the single value stored under
 * `multiValue: "join"`: no match yields `undefined`, a single match is
 * unwrapped, and more than one match is kept as the array of matches.
 *
 * @param matches - Every value `Core.extractAll` found for one field's path.
 * @returns The collapsed field value.
 */
function joinMatches(matches: readonly unknown[]): unknown {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches;
}

/**
 * Builds the cartesian product of every field's match list, so
 * `multiValue: "explode"` fans a record out into one output record per
 * combination, in document order. A field with no matches contributes a
 * single `undefined` slot rather than dropping the whole record.
 *
 * @param fieldMatches - Every field's ordered `(name, matches)` pair.
 * @returns One flat record per combination, in `fieldMatches` order.
 */
function explodeMatches(
  fieldMatches: readonly {
    readonly name: string;
    readonly matches: readonly unknown[];
  }[],
): Record<string, unknown>[] {
  let combinations: Record<string, unknown>[] = [{}];
  for (const { name, matches } of fieldMatches) {
    const values = matches.length === 0 ? [undefined] : matches;
    const next: Record<string, unknown>[] = [];
    for (const combination of combinations) {
      for (const value of values) {
        next.push({ ...combination, [name]: value });
      }
    }
    combinations = next;
  }
  return combinations;
}

/**
 * Maps each record through its `fields` extraction specs into an ordered
 * flat record (keys in `fields` order), collapsing or fanning out a
 * wildcard multi-match per `multiValue`.
 *
 * @param opts - The source records, the `name=path` extraction specs (in
 *   output-column order), the multi-match collapse strategy, and an optional
 *   logger.
 * @returns An async generator yielding one flat record per input record
 *   (`"join"`), or one per match combination (`"explode"`).
 *
 * @example
 * ```typescript
 * import { extractFields } from "./extract-fields.js";
 *
 * async function* oneRecord(): AsyncGenerator<unknown> {
 *   yield { metadata: { id: 1 } };
 * }
 *
 * for await (const row of extractFields({
 *   records: oneRecord(),
 *   fields: ["id=metadata.id"],
 *   multiValue: "join",
 * })) {
 *   // { id: 1 }
 * }
 * ```
 */
export async function* extractFields(opts: {
  readonly records: AsyncIterable<unknown>;
  readonly fields: readonly string[];
  readonly multiValue: "join" | "explode";
}): AsyncGenerator<Record<string, unknown>> {
  const specs = opts.fields.map(parseFieldSpec);

  for await (const record of opts.records) {
    const fieldMatches = specs.map((spec) => ({
      name: spec.name,
      matches: Core.extractAll(record, spec.path),
    }));

    if (opts.multiValue === "explode") {
      yield* explodeMatches(fieldMatches);
      continue;
    }

    const joined: Record<string, unknown> = {};
    for (const { name, matches } of fieldMatches) {
      joined[name] = joinMatches(matches);
    }
    yield joined;
  }
}
