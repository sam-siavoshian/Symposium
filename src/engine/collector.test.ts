import { test, expect, describe } from "bun:test";
import { collectFindings } from "./collector";
import type { Finding } from "../nia/types";

describe("collectFindings", () => {
  const mockFindings: Finding[] = [
    {
      dimension: "api_correctness",
      source: "oracle",
      content: "The BetterAuth v3 API requires a baseURL parameter. This is a significant change from v2 where baseURL was optional. The createAuth function signature changed.",
      isNovel: true,
      library: "betterauth",
      version: "3.x",
    },
    {
      dimension: "similar_solutions",
      source: "tracer",
      content: "Found 3 repos using BetterAuth v3 correctly with the new baseURL parameter and session API changes.",
      isNovel: false,
      evidence: {
        source: "tracer",
        repos: ["user/repo1", "user/repo2", "user/repo3"],
      },
    },
    {
      dimension: "code_paths",
      source: "oracle",
      content: "Entry point is auth.ts -> session handler -> middleware chain. The auth module exports createAuth which is called in server.ts.",
      isNovel: false,
    },
    {
      dimension: "existing_patterns",
      source: "oracle",
      content: "The codebase uses middleware pattern for all auth flows. Error handling follows try/catch with custom AuthError class.",
      isNovel: false,
    },
  ];

  test("separates oracle and tracer findings", () => {
    const result = collectFindings(mockFindings);
    expect(result.oracle).toHaveLength(3);
    expect(result.tracer).toHaveLength(1);
    expect(result.all).toHaveLength(4);
  });

  test("generates oracle summaries with dimension labels", () => {
    const result = collectFindings(mockFindings);
    expect(result.oracleSummaries).toHaveLength(3);
    expect(result.oracleSummaries[0]).toContain("[api_correctness]");
    expect(result.oracleSummaries[1]).toContain("[code_paths]");
  });

  test("generates tracer examples with repo info", () => {
    const result = collectFindings(mockFindings);
    expect(result.tracerExamples).toHaveLength(1);
    expect(result.tracerExamples[0]).toContain("user/repo1");
  });

  test("extracts codebase patterns from relevant dimensions", () => {
    const result = collectFindings(mockFindings);
    expect(result.codebasePatterns).toHaveLength(2); // code_paths + existing_patterns
  });

  test("handles empty findings", () => {
    const result = collectFindings([]);
    expect(result.oracle).toHaveLength(0);
    expect(result.tracer).toHaveLength(0);
    expect(result.oracleSummaries).toHaveLength(0);
    expect(result.tracerExamples).toHaveLength(0);
    expect(result.evidenceScore.composite).toBe(0);
  });
});

describe("evidence scoring", () => {
  test("high confidence with full evidence", () => {
    const findings: Finding[] = [
      {
        dimension: "api_correctness",
        source: "oracle",
        content: "A".repeat(150), // Substantive
        isNovel: true,
      },
      {
        dimension: "similar_solutions",
        source: "tracer",
        content: "B".repeat(150),
        isNovel: false,
        evidence: { source: "tracer", repos: ["a/b", "c/d", "e/f"] },
      },
      {
        dimension: "existing_patterns",
        source: "oracle",
        content: "C".repeat(150),
        isNovel: false,
      },
    ];

    const result = collectFindings(findings, 3);
    const score = result.evidenceScore;

    // All agents returned, 3 repos, has patterns, has novelty
    expect(score.agentConvergence).toBe(1);
    expect(score.tracerEvidence).toBe(1);
    expect(score.patternConsistency).toBe(0.8);
    expect(score.noveltySignal).toBe(1);
    expect(score.completeness).toBe(1);
    expect(score.composite).toBeGreaterThan(0.7);
  });

  test("low confidence with partial evidence", () => {
    const findings: Finding[] = [
      {
        dimension: "api_correctness",
        source: "oracle",
        content: "Short.", // Not substantive
        isNovel: false,
      },
    ];

    const result = collectFindings(findings, 5);
    const score = result.evidenceScore;

    // 1/5 agents, no repos, no patterns, no novelty
    expect(score.agentConvergence).toBeLessThan(0.5);
    expect(score.tracerEvidence).toBe(0);
    expect(score.noveltySignal).toBe(0);
    expect(score.completeness).toBe(0.2);
    expect(score.composite).toBeLessThan(0.3);
  });

  test("medium confidence with some tracer evidence", () => {
    const findings: Finding[] = [
      {
        dimension: "api_correctness",
        source: "oracle",
        content: "A".repeat(150),
        isNovel: false,
      },
      {
        dimension: "similar_solutions",
        source: "tracer",
        content: "B".repeat(150),
        isNovel: false,
        evidence: { source: "tracer", repos: ["a/b"] },
      },
    ];

    const result = collectFindings(findings, 3);
    const score = result.evidenceScore;

    expect(score.tracerEvidence).toBeCloseTo(0.333, 2);
    expect(score.composite).toBeGreaterThan(0.2);
    expect(score.composite).toBeLessThan(0.7);
  });

  test("breakdown string contains repo count", () => {
    const findings: Finding[] = [
      {
        dimension: "similar_solutions",
        source: "tracer",
        content: "A".repeat(150),
        isNovel: false,
        evidence: { source: "tracer", repos: ["a/b", "c/d"] },
      },
    ];

    const result = collectFindings(findings, 1);
    expect(result.evidenceScore.breakdown).toContain("2 real repos found");
  });

  test("breakdown mentions novel discoveries", () => {
    const findings: Finding[] = [
      {
        dimension: "api_correctness",
        source: "oracle",
        content: "A".repeat(150),
        isNovel: true,
      },
    ];

    const result = collectFindings(findings, 1);
    expect(result.evidenceScore.breakdown).toContain("1 novel discoveries");
  });

  test("cross-validation bonus when Oracle and Tracer agree on same dimension", () => {
    // Both Oracle AND Tracer returned findings for api_correctness (dual-mode)
    const findings: Finding[] = [
      {
        dimension: "api_correctness",
        source: "oracle",
        content: "A".repeat(150),
        isNovel: true,
      },
      {
        dimension: "api_correctness",
        source: "tracer",
        content: "B".repeat(150),
        isNovel: false,
        evidence: { source: "tracer", repos: ["a/b", "c/d"] },
      },
    ];

    const result = collectFindings(findings, 2);
    const score = result.evidenceScore;

    // Should have cross-validation bonus
    expect(score.breakdown).toContain("cross-validated by Oracle+Tracer");
    // Score should be higher than without cross-validation
    expect(score.composite).toBeGreaterThan(0.3);
  });

  test("no cross-validation when Oracle and Tracer cover different dimensions", () => {
    const findings: Finding[] = [
      {
        dimension: "api_correctness",
        source: "oracle",
        content: "A".repeat(150),
        isNovel: false,
      },
      {
        dimension: "similar_solutions",
        source: "tracer",
        content: "B".repeat(150),
        isNovel: false,
      },
    ];

    const result = collectFindings(findings, 2);
    // Different dimensions, no cross-validation
    expect(result.evidenceScore.breakdown).not.toContain("cross-validated");
  });

  test("zero score for empty findings", () => {
    const result = collectFindings([], 0);
    expect(result.evidenceScore.composite).toBe(0);
    expect(result.evidenceScore.breakdown).toBe("No agent findings available");
  });
});
