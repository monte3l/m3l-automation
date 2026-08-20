/**
 * `internal/procedure/graph` — build-time cycle detection over the step
 * graph, per `docs/reference/core/procedure.md` § Cycle detection.
 *
 * Nodes are step ids. Edges are of two kinds: the implicit sequential edge
 * from every step but the last to its successor (contributed unconditionally,
 * because the engine advances on `"continue"` and nothing proves a step
 * never returns it), and one explicit edge per `jumpsTo` entry — excluded
 * when the declaring step carries `loop`, since that annotation acknowledges
 * the back edge is deliberate. Detection is an iterative, explicit-stack,
 * three-colour depth-first search, so a hand-generated graph of thousands of
 * steps cannot overflow the native call stack.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

/** The minimal step shape {@link findProcedureCycles} needs to build the graph. */
export interface ProcedureGraphStep {
  readonly id: string;
  /** Declared jump targets, in declared order. Absent means none. */
  readonly jumpsTo: readonly string[];
  /** Whether this step carries a `loop` annotation, excluding its `jumpsTo` edges from the graph. */
  readonly hasLoop: boolean;
}

/** Undiscovered. */
const WHITE = 0;
/** On the current DFS stack. */
const GREY = 1;
/** Fully explored. */
const BLACK = 2;

type NodeColor = typeof WHITE | typeof GREY | typeof BLACK;

/** One iterative-DFS stack frame: the node, and how far its successor list has been consumed. */
interface DfsFrame {
  readonly node: string;
  index: number;
}

/** This step's own `jumpsTo` targets, in declared order, filtered to steps that actually exist. */
function explicitEdgesFor(
  step: ProcedureGraphStep,
  knownIds: ReadonlySet<string>,
): readonly string[] {
  if (step.hasLoop) return [];
  return step.jumpsTo.filter((target) => knownIds.has(target));
}

/**
 * Builds the fixed-order successor list for every step: the implicit
 * sequential edge to the next declared step (when one exists), followed by
 * this step's own `jumpsTo` targets in declared order — omitted entirely when
 * the step carries `loop`, and filtered to targets that are actually declared
 * steps (a dangling target is `ERR_PROCEDURE_INVALID_JUMP_TARGET`'s concern,
 * reported separately; it contributes no edge here).
 */
function buildSuccessors(
  steps: readonly ProcedureGraphStep[],
  knownIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const successors = new Map<string, string[]>();
  for (const [index, step] of steps.entries()) {
    const next = steps[index + 1];
    const implicit = next !== undefined ? [next.id] : [];
    successors.set(step.id, [...implicit, ...explicitEdgesFor(step, knownIds)]);
  }
  return successors;
}

/**
 * Rotates a cycle's unique node list (no repeated closing node) to start at
 * its lexicographically smallest id, so the same cycle discovered via two
 * distinct routes — and therefore recorded starting at a different node —
 * dedupes to the same key.
 */
function canonicalRotationKey(cycle: readonly string[]): string {
  const smallest = cycle.reduce((a, b) => (b < a ? b : a));
  const bestIndex = cycle.indexOf(smallest);
  return [...cycle.slice(bestIndex), ...cycle.slice(0, bestIndex)].join(" ");
}

/** Records a back edge (grey re-entry) as a cycle, deduped by its canonical rotation. */
function recordCycle(
  path: readonly string[],
  next: string,
  cyclesByKey: Map<string, readonly string[]>,
): void {
  const startIndex = path.indexOf(next);
  const cycle = [...path.slice(startIndex), next];
  const key = canonicalRotationKey(cycle.slice(0, -1));
  if (!cyclesByKey.has(key)) cyclesByKey.set(key, cycle);
}

/** Pops the fully-explored top frame, marking its node black. */
function popFrame(
  stack: DfsFrame[],
  path: string[],
  color: Map<string, NodeColor>,
  frame: DfsFrame,
): void {
  color.set(frame.node, BLACK);
  path.pop();
  stack.pop();
}

/**
 * Consumes one successor at `succs[frameIndex]`: recording a cycle,
 * descending into the successor, or skipping an already-explored one.
 * Returns the frame's incremented index for the caller to store — this
 * function never mutates the caller's frame object directly. Takes the
 * already-resolved `succs` list rather than re-deriving it from a node id,
 * since {@link walkFrom} has already fetched it once to bounds-check
 * `frameIndex` before calling this.
 */
function advanceFrame(
  stack: DfsFrame[],
  path: string[],
  color: Map<string, NodeColor>,
  cyclesByKey: Map<string, readonly string[]>,
  succs: readonly string[],
  frameIndex: number,
): number {
  const next = succs[frameIndex];
  const advancedIndex = frameIndex + 1;
  if (next === undefined) return advancedIndex;

  const nextColor = color.get(next);
  if (nextColor === GREY) {
    recordCycle(path, next, cyclesByKey);
  } else if (nextColor === WHITE) {
    color.set(next, GREY);
    path.push(next);
    stack.push({ node: next, index: 0 });
  }
  // nextColor === BLACK: already fully explored, not a back edge.
  return advancedIndex;
}

/**
 * Runs one iterative, explicit-stack DFS from `start`, recording every back
 * edge (a grey re-entry) as a cycle into `cyclesByKey`, keyed by
 * {@link canonicalRotationKey} so the same cycle found twice — e.g. via two
 * `jumpsTo` entries naming the same back-edge target — is recorded once.
 */
function walkFrom(
  start: string,
  successors: ReadonlyMap<string, readonly string[]>,
  color: Map<string, NodeColor>,
  cyclesByKey: Map<string, readonly string[]>,
): void {
  const stack: DfsFrame[] = [{ node: start, index: 0 }];
  const path: string[] = [start];
  color.set(start, GREY);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    const succs = successors.get(frame.node) ?? [];

    if (frame.index >= succs.length) {
      popFrame(stack, path, color, frame);
      continue;
    }

    frame.index = advanceFrame(
      stack,
      path,
      color,
      cyclesByKey,
      succs,
      frame.index,
    );
  }
}

/**
 * Finds every cycle in the step graph. Successor order is fixed (implicit
 * next, then `jumpsTo` in declared order) and DFS roots are visited in
 * declaration order, so the same definition always reports the same cycles
 * in the same order across independent builds.
 *
 * @param steps - The declared step list, in declaration order.
 * @returns Each distinct cycle's node path, first node repeated last.
 */
export function findProcedureCycles(
  steps: readonly ProcedureGraphStep[],
): readonly (readonly string[])[] {
  const knownIds = new Set(steps.map((step) => step.id));
  const successors = buildSuccessors(steps, knownIds);

  const color = new Map<string, NodeColor>();
  for (const step of steps) color.set(step.id, WHITE);

  const cyclesByKey = new Map<string, readonly string[]>();
  for (const start of steps) {
    if (color.get(start.id) !== WHITE) continue;
    walkFrom(start.id, successors, color, cyclesByKey);
  }

  return [...cyclesByKey.values()];
}
