import { test, expect, describe } from "bun:test";
import { decomposerPrompt, researchPrompt, synthesizerPrompt, fastPathPrompt } from "./prompts";
import type { Finding, KnowledgeEntry } from "../nia/types";

describe("prompt sanitization", () => {
  test("caps issue length at 4000 chars", () => {
    const longIssue = "x".repeat(10000);
    const prompt = decomposerPrompt(longIssue, []);
    // The sanitized issue should be wrapped in tags and capped
    expect(prompt).toContain("<user_issue>");
    expect(prompt).toContain("</user_issue>");
    // Should not contain the full 10000 chars
    expect(prompt.length).toBeLessThan(10000);
  });

  test("wraps issue in XML delimiters", () => {
    const prompt = decomposerPrompt("test issue", []);
    expect(prompt).toContain("<user_issue>test issue</user_issue>");
  });

  test("caps file paths at 500 chars each", () => {
    const longPath = "/".repeat(1000);
    const prompt = decomposerPrompt("test", [longPath]);
    expect(prompt.length).toBeLessThan(2000 + 4000); // prompt template + capped inputs
  });

  test("handles empty files array", () => {
    const prompt = decomposerPrompt("test", []);
    expect(prompt).toContain("none specified");
  });
});

describe("research prompts", () => {
  const dimensions = [
    "code_paths",
    "api_correctness",
    "failure_modes",
    "similar_solutions",
    "existing_patterns",
    "test_strategy",
  ] as const;

  for (const dim of dimensions) {
    test(`${dim} prompt contains issue and returns JSON instruction`, () => {
      const prompt = researchPrompt(dim, "Add BetterAuth v3 session management", ["src/auth.ts"]);
      expect(prompt).toContain("<user_issue>");
      expect(prompt).toContain("BetterAuth");
      expect(prompt).toContain("JSON");
    });

    test(`${dim} prompt is within reasonable length`, () => {
      const prompt = researchPrompt(dim, "test issue", ["file.ts"]);
      expect(prompt.length).toBeGreaterThan(200);
      expect(prompt.length).toBeLessThan(5000);
    });
  }

  test("api_correctness explains novel discovery concept", () => {
    const prompt = researchPrompt("api_correctness", "test", []);
    expect(prompt).toContain("NOVEL DISCOVERY");
    expect(prompt).toContain("training data");
  });

  test("similar_solutions mentions GitHub search", () => {
    const prompt = researchPrompt("similar_solutions", "test", []);
    expect(prompt).toContain("GitHub");
    expect(prompt).toContain("repos");
  });

  test("failure_modes covers all failure categories", () => {
    const prompt = researchPrompt("failure_modes", "test", []);
    expect(prompt).toContain("Concurrency");
    expect(prompt).toContain("Network");
    expect(prompt).toContain("Data");
    expect(prompt).toContain("Resources");
    expect(prompt).toContain("Auth");
  });
});

describe("synthesizer prompt", () => {
  const mockFindings: Finding[] = [
    { dimension: "api_correctness", source: "oracle", content: "Finding 1", isNovel: true },
    { dimension: "similar_solutions", source: "tracer", content: "Finding 2", isNovel: false },
  ];

  test("includes all findings with agent labels", () => {
    const prompt = synthesizerPrompt("test", ["file.ts"], mockFindings, "none", 2);
    expect(prompt).toContain("Agent 1: api_correctness (via oracle)");
    expect(prompt).toContain("Agent 2: similar_solutions (via tracer)");
    expect(prompt).toContain("[NOVEL DISCOVERY]");
  });

  test("includes scoring rubric", () => {
    const prompt = synthesizerPrompt("test", [], mockFindings, "none", 2);
    expect(prompt).toContain("Agent convergence");
    expect(prompt).toContain("Tracer evidence");
    expect(prompt).toContain("Pattern consistency");
  });

  test("includes novelty extraction instructions", () => {
    const prompt = synthesizerPrompt("test", [], mockFindings, "none", 2);
    expect(prompt).toContain("novel_discovery");
    expect(prompt).toContain("ALL FOUR criteria");
  });

  test("includes prior knowledge when provided", () => {
    const prompt = synthesizerPrompt("test", [], mockFindings, "betterauth: use baseURL", 2);
    expect(prompt).toContain("betterauth: use baseURL");
  });

  test("handles no prior knowledge", () => {
    const prompt = synthesizerPrompt("test", [], mockFindings, "", 2);
    expect(prompt).toContain("No prior knowledge available");
  });
});

describe("fast path prompt", () => {
  const mockEntries: KnowledgeEntry[] = [
    {
      id: "1",
      library: "betterauth",
      version: "3.x",
      category: "api_change",
      mistake: "createAuth({secret})",
      correct: "createAuth({secret, baseURL})",
      root_cause: "v3.0.0 made baseURL required",
      confidence: 0.85,
      confidence_signals: { tracer_repo_count: 1, advisor_verified: false, cross_validated: false, times_recalled_ok: 0, times_contradicted: 0 },
      status: "active",
      evidence: { source: "tracer", repos: ["user/repo1"] },
      created_at: "2026-04-12T00:00:00Z",
      updated_at: "2026-04-12T00:00:00Z",
      times_used: 1,
      last_used_at: null,
    },
  ];

  test("includes all recalled entries", () => {
    const prompt = fastPathPrompt("test issue", ["auth.ts"], mockEntries);
    expect(prompt).toContain("betterauth@3.x");
    expect(prompt).toContain("createAuth({secret})");
    expect(prompt).toContain("createAuth({secret, baseURL})");
  });

  test("mentions this is a fast path", () => {
    const prompt = fastPathPrompt("test", [], mockEntries);
    expect(prompt).toContain("fast-path");
    expect(prompt).toContain("WITHOUT additional research");
  });

  test("asks for JSON output", () => {
    const prompt = fastPathPrompt("test", [], mockEntries);
    expect(prompt).toContain("Return ONLY valid JSON");
    expect(prompt).toContain('"winner"');
  });
});
