import { test, expect, describe } from "bun:test";
import { safeParseJSON } from "../nia/safe-parse";
import type { KnowledgeEntry } from "../nia/types";

/**
 * Test the recall module's knowledge parsing and extraction logic.
 * These simulate what recall.ts does with raw Nia Context responses.
 */

describe("knowledge entry parsing", () => {
  test("parses a stored knowledge entry from JSON content", () => {
    const content = JSON.stringify({
      id: "abc123",
      library: "betterauth",
      version: "3.x",
      category: "api_change",
      mistake: "createAuth({secret}) without baseURL",
      correct: "createAuth({secret, baseURL})",
      evidence: { source: "tracer", repos: ["user/repo1"] },
      created_at: "2026-04-12T00:00:00Z",
      times_used: 0,
    });

    const parsed = safeParseJSON<KnowledgeEntry>(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.library).toBe("betterauth");
    expect(parsed!.version).toBe("3.x");
    expect(parsed!.correct).toBe("createAuth({secret, baseURL})");
  });

  test("extracts library from title format 'library@version: category'", () => {
    const title = "betterauth@3.x: api_change";
    const match = title.match(/^([^@]+)@/);
    expect(match?.[1]?.trim()).toBe("betterauth");
  });

  test("extracts version from title format", () => {
    const title = "betterauth@3.x: api_change";
    const match = title.match(/@([^:]+)/);
    expect(match?.[1]?.trim()).toBe("3.x");
  });

  test("handles summary format 'Mistake: X. Correct: Y'", () => {
    const summary = "Mistake: createAuth({secret}). Correct: createAuth({secret, baseURL})";
    const mistake = summary.split("Correct:")[0]?.replace("Mistake:", "").trim();
    const correct = summary.split("Correct:")[1]?.trim();
    expect(mistake).toBe("createAuth({secret}).");
    expect(correct).toBe("createAuth({secret, baseURL})");
  });

  test("handles malformed summary gracefully", () => {
    const summary = "Some random text without the expected format";
    const mistake = summary.split("Correct:")[0]?.replace("Mistake:", "").trim() || summary;
    const correct = summary.split("Correct:")[1]?.trim() || "";
    expect(mistake).toBe("Some random text without the expected format");
    expect(correct).toBe("");
  });
});
