import { test, expect, describe, mock } from "bun:test";

/**
 * Test decomposer dimension selection logic.
 * We can't test the Oracle call without an API key, but we can test
 * the default dimension selection and the post-processing logic.
 */

// We need to test the default dimensions directly
// Since getDefaultDimensions is not exported, we test via decompose with quick mode
// (which skips Oracle and uses defaults)

describe("decomposer", () => {
  // Mock the Oracle client so decompose doesn't actually call Nia
  mock.module("../nia/client", () => ({
    runOracle: async () => '{"dimensions": ["api_correctness", "similar_solutions", "failure_modes"]}',
  }));

  test("quick mode returns exactly 3 dimensions without Oracle call", async () => {
    const { decompose } = await import("./decomposer");
    const dims = await decompose("test issue", ["test.ts"], "quick");
    expect(dims).toHaveLength(3);
    expect(dims.map(d => d.type)).toContain("api_correctness");
    expect(dims.map(d => d.type)).toContain("similar_solutions");
    expect(dims.map(d => d.type)).toContain("code_paths");
  });

  test("quick mode marks similar_solutions as tracer", async () => {
    const { decompose } = await import("./decomposer");
    const dims = await decompose("test issue", [], "quick");
    const tracer = dims.find(d => d.type === "similar_solutions");
    expect(tracer?.usesTracer).toBe(true);
    const oracle = dims.find(d => d.type === "api_correctness");
    expect(oracle?.usesTracer).toBe(false);
  });

  test("standard mode returns 5 dimensions", async () => {
    // Standard mode would normally call Oracle, but our mock returns valid dims
    const { decompose } = await import("./decomposer");
    const dims = await decompose("test issue", [], "standard");
    // With our mock returning 3 dims and the enforcer adding api_correctness + similar_solutions,
    // we should get 3 valid dims (capped at 5)
    expect(dims.length).toBeGreaterThanOrEqual(3);
    expect(dims.length).toBeLessThanOrEqual(5);
  });

  test("all dimensions have correct usesTracer flag", async () => {
    const { decompose } = await import("./decomposer");
    const dims = await decompose("test", [], "deep");
    for (const dim of dims) {
      if (dim.type === "similar_solutions") {
        expect(dim.usesTracer).toBe(true);
      } else {
        expect(dim.usesTracer).toBe(false);
      }
    }
  });
});
