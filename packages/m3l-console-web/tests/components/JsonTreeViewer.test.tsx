import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { JsonTreeViewer } from "../../src/components/JsonTreeViewer.js";

const NESTED_VALUE = {
  Queues: ["queue-a", "queue-b"],
  Region: "us-east-1",
};

describe("JsonTreeViewer", () => {
  test("renders the root wrapper", () => {
    render(<JsonTreeViewer value={NESTED_VALUE} />);

    expect(screen.getByTestId("json-tree-viewer")).toBeInTheDocument();
  });

  test("renders a nested object/array value: root object node, Queues array node with two leaf children, Region string leaf", () => {
    const { container } = render(<JsonTreeViewer value={NESTED_VALUE} />);

    const root = container.querySelector('[data-testid="json-tree-node-root"]');
    expect(root).toBeInTheDocument();
    expect(root?.tagName.toLowerCase()).toBe("details");

    const queuesNode = container.querySelector(
      '[data-testid="json-tree-node-Queues"]',
    );
    expect(queuesNode).toBeInTheDocument();
    expect(queuesNode?.tagName.toLowerCase()).toBe("details");

    const queueLeafZero = container.querySelector(
      '[data-testid="json-tree-leaf-Queues[0]"]',
    );
    expect(queueLeafZero).toBeInTheDocument();
    expect(queueLeafZero?.textContent).toContain('"queue-a"');

    const queueLeafOne = container.querySelector(
      '[data-testid="json-tree-leaf-Queues[1]"]',
    );
    expect(queueLeafOne).toBeInTheDocument();
    expect(queueLeafOne?.textContent).toContain('"queue-b"');

    const regionLeaf = container.querySelector(
      '[data-testid="json-tree-leaf-Region"]',
    );
    expect(regionLeaf).toBeInTheDocument();
    expect(regionLeaf?.textContent).toContain("Region");
    expect(regionLeaf?.textContent).toContain('"us-east-1"');
  });

  test("a primitive root value renders one leaf node labeled root", () => {
    const { container } = render(<JsonTreeViewer value={42} />);

    const leaf = container.querySelector('[data-testid="json-tree-leaf-root"]');
    expect(leaf).toBeInTheDocument();
    expect(leaf?.textContent).toContain("root");
    expect(leaf?.textContent).toContain("42");
    expect(
      container.querySelector('[data-testid="json-tree-node-root"]'),
    ).not.toBeInTheDocument();
  });

  test("null and undefined leaf values render the literal text null / undefined", () => {
    const { container } = render(
      <JsonTreeViewer value={{ a: null, b: undefined }} />,
    );

    const nullLeaf = container.querySelector(
      '[data-testid="json-tree-leaf-a"]',
    );
    expect(nullLeaf?.textContent).toContain("null");

    const undefinedLeaf = container.querySelector(
      '[data-testid="json-tree-leaf-b"]',
    );
    expect(undefinedLeaf?.textContent).toContain("undefined");
  });

  test("boolean leaf values render via String(value)", () => {
    const { container } = render(<JsonTreeViewer value={{ flag: true }} />);

    const flagLeaf = container.querySelector(
      '[data-testid="json-tree-leaf-flag"]',
    );
    expect(flagLeaf?.textContent).toContain("true");
  });

  describe("collapse/expand", () => {
    test("the root details starts with the open attribute present, clicking its summary removes it, clicking again restores it", () => {
      const { container } = render(<JsonTreeViewer value={NESTED_VALUE} />);

      const root = container.querySelector(
        '[data-testid="json-tree-node-root"]',
      );
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error("root details node not found");
      }
      expect(root).toHaveAttribute("open");

      const summary = root.querySelector("summary");
      expect(summary).not.toBeNull();
      if (summary === null) {
        throw new Error("root summary not found");
      }

      fireEvent.click(summary);
      expect(root).not.toHaveAttribute("open");

      fireEvent.click(summary);
      expect(root).toHaveAttribute("open");
    });

    test("a non-root container node also defaults to open", () => {
      const { container } = render(<JsonTreeViewer value={NESTED_VALUE} />);

      const queuesNode = container.querySelector(
        '[data-testid="json-tree-node-Queues"]',
      );
      expect(queuesNode).toHaveAttribute("open");
    });
  });

  describe("selection callback", () => {
    test("clicking a string leaf's Select button calls onSelect with the exact path and value", () => {
      const onSelect = vi.fn();
      render(<JsonTreeViewer value={NESTED_VALUE} onSelect={onSelect} />);

      fireEvent.click(screen.getByRole("button", { name: "Select Region" }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(["Region"], "us-east-1");
    });

    test("clicking an array-index leaf's Select button calls onSelect with the numeric path segment", () => {
      const onSelect = vi.fn();
      render(<JsonTreeViewer value={NESTED_VALUE} onSelect={onSelect} />);

      fireEvent.click(screen.getByRole("button", { name: "Select Queues[0]" }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(["Queues", 0], "queue-a");
    });

    test("clicking a container node's own Select button calls onSelect with the container's path and full value", () => {
      const onSelect = vi.fn();
      render(<JsonTreeViewer value={NESTED_VALUE} onSelect={onSelect} />);

      fireEvent.click(screen.getByRole("button", { name: "Select Queues" }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(["Queues"], NESTED_VALUE.Queues);
    });

    test("selecting the root container calls onSelect with an empty path and the whole value", () => {
      const onSelect = vi.fn();
      render(<JsonTreeViewer value={NESTED_VALUE} onSelect={onSelect} />);

      fireEvent.click(screen.getByRole("button", { name: "Select root" }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith([], NESTED_VALUE);
    });

    test("clicking a Select button nested inside a container's summary does not also collapse/expand that container", () => {
      const onSelect = vi.fn();
      const { container } = render(
        <JsonTreeViewer value={NESTED_VALUE} onSelect={onSelect} />,
      );

      const queuesNode = container.querySelector(
        '[data-testid="json-tree-node-Queues"]',
      );
      expect(queuesNode).toHaveAttribute("open");

      fireEvent.click(screen.getByRole("button", { name: "Select Queues" }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(queuesNode).toHaveAttribute("open");
    });

    test("when onSelect is omitted, no Select button renders anywhere", () => {
      render(<JsonTreeViewer value={NESTED_VALUE} />);

      const selectButtons = screen
        .queryAllByRole("button")
        .filter((button) =>
          (button.getAttribute("aria-label") ?? "").startsWith("Select"),
        );
      expect(selectButtons).toHaveLength(0);
    });
  });
});
