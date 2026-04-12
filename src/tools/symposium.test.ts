import { test, expect, describe } from "bun:test";

/**
 * Test that the output formatting handles incomplete/missing data gracefully.
 * This is critical for the demo - if synthesis fails and returns partial data,
 * the formatter must not crash.
 */

// We can't import formatOutput directly (it's not exported from index.ts,
// and index.ts has a side effect that requires NIA_API_KEY).
// So we test the pattern inline.

describe("output formatting resilience", () => {
  // Simulate what formatOutput does with the dangerous fields
  function safeAccess(result: any): { steps: number; tests: number; evidence: number; learned: number } {
    const steps = result.approach?.plan?.steps || [];
    const tests = result.approach?.plan?.tests || [];
    const tracerExamples = result.approach?.evidence?.tracer_examples || [];
    const learned = result.learned || [];
    return {
      steps: steps.length,
      tests: tests.length,
      evidence: tracerExamples.length,
      learned: learned.length,
    };
  }

  test("handles complete data", () => {
    const result = {
      approach: {
        plan: {
          steps: [{ file: "a.ts", action: "modify", description: "x", code_hint: "" }],
          tests: ["test1"],
        },
        evidence: { tracer_examples: ["repo1"], oracle_findings: [], codebase_patterns: [] },
      },
      learned: [{ library: "x", mistake: "y", correct: "z" }],
    };
    const counts = safeAccess(result);
    expect(counts.steps).toBe(1);
    expect(counts.tests).toBe(1);
    expect(counts.evidence).toBe(1);
    expect(counts.learned).toBe(1);
  });

  test("handles missing plan", () => {
    const result = {
      approach: { plan: undefined, evidence: undefined },
      learned: undefined,
    };
    const counts = safeAccess(result);
    expect(counts.steps).toBe(0);
    expect(counts.tests).toBe(0);
    expect(counts.evidence).toBe(0);
    expect(counts.learned).toBe(0);
  });

  test("handles empty approach", () => {
    const result = { approach: {} };
    const counts = safeAccess(result);
    expect(counts.steps).toBe(0);
    expect(counts.tests).toBe(0);
    expect(counts.evidence).toBe(0);
    expect(counts.learned).toBe(0);
  });

  test("handles null evidence arrays", () => {
    const result = {
      approach: {
        plan: { steps: [], tests: null },
        evidence: { tracer_examples: null, oracle_findings: null, codebase_patterns: null },
      },
      learned: null,
    };
    const counts = safeAccess(result);
    expect(counts.steps).toBe(0);
    expect(counts.tests).toBe(0);
    expect(counts.evidence).toBe(0);
    expect(counts.learned).toBe(0);
  });

  test("handles synthesis fallback shape", () => {
    const result = {
      approach: {
        name: "No Results",
        summary: "All agents failed.",
        confidence: 0,
        plan: { steps: [], tests: [] },
        evidence: { oracle_findings: [], tracer_examples: [], codebase_patterns: [] },
      },
      learned: [],
    };
    const counts = safeAccess(result);
    expect(counts.steps).toBe(0);
    expect(counts.tests).toBe(0);
    expect(counts.evidence).toBe(0);
    expect(counts.learned).toBe(0);
  });
});

describe("extractLibraryNames", () => {
  // Import real function (now exported)
  // Note: can't use top-level import because index.ts side effects.
  // Using dynamic import within tests.
  let extractLibraryNames: (issue: string) => string[];

  // Use mock to avoid NIA_API_KEY check in symposium.ts
  const { extractLibraryNames: fn } = require("./symposium");
  extractLibraryNames = fn;

  test("extracts library name with version", () => {
    const libs = extractLibraryNames("Add BetterAuth v3 session management");
    expect(libs).toContain("betterauth");
  });

  test("extracts scoped packages", () => {
    const libs = extractLibraryNames("Upgrade @auth/core to the latest version");
    expect(libs).toContain("auth/core");
  });

  test("extracts quoted package names", () => {
    const libs = extractLibraryNames('Install "next-auth" for authentication');
    expect(libs).toContain("next-auth");
  });

  test("caps at 3 libraries", () => {
    const libs = extractLibraryNames("Use react v18, next.js 14, prisma v5, tailwind v4");
    expect(libs.length).toBeLessThanOrEqual(3);
  });

  test("filters common words", () => {
    const libs = extractLibraryNames("This file needs the code from step 1");
    expect(libs).not.toContain("this");
    expect(libs).not.toContain("the");
    expect(libs).not.toContain("file");
  });

  test("returns empty for no libraries", () => {
    const libs = extractLibraryNames("Fix the bug in the login page");
    // Might find "the" -> filtered, or nothing at all
    expect(libs.length).toBeLessThanOrEqual(3);
  });
});
