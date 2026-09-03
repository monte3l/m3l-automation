import type { ReactElement } from "react";

import type { M3LTreePathSegment } from "../internal/step-reference.js";

/** Props accepted by {@link JsonTreeViewer}. */
export interface JsonTreeViewerProps {
  /** The JSON-shaped value to render as an expandable/collapsible tree. */
  readonly value: unknown;
  /**
   * Called with the path segments walked from the root and the value found
   * there when a node's Select button is clicked. Omit to render the tree
   * read-only — no Select button renders anywhere.
   */
  readonly onSelect?: (
    path: readonly M3LTreePathSegment[],
    value: unknown,
  ) => void;
}

/** One `[segment, value]` pair produced while walking a container node's children. */
type M3LTreeEntry = readonly [M3LTreePathSegment, unknown];

/** Optional selection callback threaded through every recursive node render. */
type M3LTreeSelectHandler =
  ((path: readonly M3LTreePathSegment[], value: unknown) => void) | undefined;

/**
 * Formats `path` as the node's caller-facing label: `"root"` for the empty
 * path; otherwise every segment joined in order, a string segment appending
 * `.name` and a number segment appending `[n]` (no separating dot), with the
 * leading dot of the whole joined string stripped.
 */
function formatPathLabel(path: readonly M3LTreePathSegment[]): string {
  if (path.length === 0) {
    return "root";
  }
  const joined = path.reduce<string>(
    (accumulated, segment) =>
      typeof segment === "number"
        ? `${accumulated}[${segment}]`
        : `${accumulated}.${segment}`,
    "",
  );
  return joined.startsWith(".") ? joined.slice(1) : joined;
}

/** True for a plain object or a non-null array — every other value renders as a leaf. */
function isContainerValue(
  value: unknown,
): value is Record<string, unknown> | readonly unknown[] {
  return typeof value === "object" && value !== null;
}

/**
 * Formats a leaf value's displayed text: a string renders JSON-quoted,
 * `null`/`undefined` render as those literal words, everything else
 * (numbers, booleans) via `String(value)`.
 */
function formatLeafValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // `isContainerValue` already filters every object/array out before
  // `JsonTreeNode` reaches this branch, so only string/number/boolean ever
  // land here in practice — `JSON.stringify` is a safe, non-throwing
  // fallback for any other typeof rather than `String`, which would render
  // a bare object as `"[object Object]"`.
  return JSON.stringify(value);
}

/**
 * Builds the `[segment, value]` entries a container node recurses into — an
 * array yields numeric index segments, a plain object yields its own
 * enumerable string-keyed properties.
 */
function containerEntries(
  value: Record<string, unknown> | readonly unknown[],
): readonly M3LTreeEntry[] {
  if (Array.isArray(value)) {
    return value.map((item, index): M3LTreeEntry => [index, item]);
  }
  return Object.entries(value);
}

/**
 * Renders the Select button shared by every node shape (container or leaf),
 * only when a selection handler was supplied. `stopPropagation` keeps a
 * click on this button — when nested inside a container's `<summary>` —
 * from also triggering the browser's native `<details>` toggle.
 */
function JsonTreeSelectButton({
  label,
  path,
  value,
  onSelect,
}: {
  readonly label: string;
  readonly path: readonly M3LTreePathSegment[];
  readonly value: unknown;
  readonly onSelect: M3LTreeSelectHandler;
}): ReactElement | null {
  if (!onSelect) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={`Select ${label}`}
      data-testid={`json-tree-select-${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(path, value);
      }}
    >
      Select
    </button>
  );
}

/** Props threaded through every recursive {@link JsonTreeNode} call. */
interface JsonTreeNodeProps {
  readonly path: readonly M3LTreePathSegment[];
  readonly value: unknown;
  readonly onSelect: M3LTreeSelectHandler;
}

/**
 * Recursively renders one node of the tree: a container node as a
 * default-open `<details>`/`<summary>` disclosure wrapping a `<ul>` of its
 * children, or a leaf value as a `<span>`. The `open` attribute is set once
 * on render and never re-driven by React state — clicking a `<summary>`
 * toggles it through the browser's native `<details>` behavior.
 */
function JsonTreeNode({
  path,
  value,
  onSelect,
}: JsonTreeNodeProps): ReactElement {
  const label = formatPathLabel(path);

  if (isContainerValue(value)) {
    const entries = containerEntries(value);
    return (
      <details open data-testid={`json-tree-node-${label}`}>
        <summary>
          {label} ({entries.length})
          <JsonTreeSelectButton
            label={label}
            path={path}
            value={value}
            onSelect={onSelect}
          />
        </summary>
        <ul>
          {entries.map(([segment, childValue]) => {
            const childPath = [...path, segment];
            const childLabel = formatPathLabel(childPath);
            return (
              <li key={childLabel}>
                <JsonTreeNode
                  path={childPath}
                  value={childValue}
                  onSelect={onSelect}
                />
              </li>
            );
          })}
        </ul>
      </details>
    );
  }

  return (
    <>
      <span data-testid={`json-tree-leaf-${label}`}>
        {label}: {formatLeafValue(value)}
      </span>
      <JsonTreeSelectButton
        label={label}
        path={path}
        value={value}
        onSelect={onSelect}
      />
    </>
  );
}

/**
 * Renders `value` as an expandable/collapsible JSON tree, hand-rolled on
 * native `<details>`/`<summary>` disclosure with no external tree/disclosure
 * dependency. Every container node (a plain object or a non-null array)
 * starts expanded; leaf values (string, number, boolean, `null`,
 * `undefined`) render as a single labeled span. Pass `onSelect` to render a
 * "Select" button on every node — container or leaf — that reports the
 * clicked node's path (empty for the root) and value.
 *
 * @example
 * ```tsx
 * import { JsonTreeViewer } from "@m3l-automation/m3l-console-web/components/JsonTreeViewer.js";
 *
 * <JsonTreeViewer
 *   value={{ Region: "us-east-1" }}
 *   onSelect={(path, value) => {
 *     console.log(path, value);
 *   }}
 * />;
 * ```
 */
export function JsonTreeViewer(props: JsonTreeViewerProps): ReactElement {
  return (
    <div data-testid="json-tree-viewer">
      <JsonTreeNode path={[]} value={props.value} onSelect={props.onSelect} />
    </div>
  );
}
