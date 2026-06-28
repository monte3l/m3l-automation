import { expect, test } from "vitest";

import * as m3l from "../src/index.js";

test("public barrel exposes the Core and AWS namespaces", () => {
  expect(m3l).toHaveProperty("Core");
  expect(m3l).toHaveProperty("AWS");
});

test("the Core and AWS namespaces are objects", () => {
  expect(typeof m3l.Core).toBe("object");
  expect(typeof m3l.AWS).toBe("object");
});
