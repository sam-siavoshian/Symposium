import { test, expect, describe } from "bun:test";

/**
 * Test the learner's quality gate and categorization logic.
 */

describe("knowledge quality gate", () => {
  test("rejects discoveries with missing library", () => {
    const discoveries = [
      { library: "", version: "1.0", mistake: "old()", correct: "new()", evidence_source: "oracle" },
    ];
    const valid = discoveries.filter(d => d.library && d.correct && d.mistake);
    expect(valid).toHaveLength(0);
  });

  test("rejects discoveries with missing correct usage", () => {
    const discoveries = [
      { library: "react", version: "18", mistake: "old()", correct: "", evidence_source: "oracle" },
    ];
    const valid = discoveries.filter(d => d.library && d.correct && d.mistake);
    expect(valid).toHaveLength(0);
  });

  test("rejects discoveries with missing mistake", () => {
    const discoveries = [
      { library: "react", version: "18", mistake: "", correct: "new()", evidence_source: "oracle" },
    ];
    const valid = discoveries.filter(d => d.library && d.correct && d.mistake);
    expect(valid).toHaveLength(0);
  });

  test("accepts complete discoveries", () => {
    const discoveries = [
      { library: "react", version: "18", mistake: "useEffect(() => {}, [])", correct: "useEffect(() => { return cleanup; }, [dep])", evidence_source: "oracle" },
    ];
    const valid = discoveries.filter(d => d.library && d.correct && d.mistake);
    expect(valid).toHaveLength(1);
  });
});

describe("vagueness detection", () => {
  // Replicate the isVague logic for testing
  function isVague(text: string): boolean {
    if (text.length < 10) return true;
    const codeSignals = ["(", ")", "{", "}", "=>", "import", "require", ".", "::", "[]", "<", ">", "=", "/"];
    const hasCodeToken = codeSignals.some(sig => text.includes(sig));
    if (hasCodeToken) return false;
    const vagueSignals = ["best practice", "latest version", "recommended approach", "should use", "consider using", "it is better to", "general", "typically", "usually"];
    const hasVaguePhrase = vagueSignals.some(sig => text.toLowerCase().includes(sig));
    if (hasVaguePhrase && !hasCodeToken) return true;
    if (text.length < 30 && !hasCodeToken) return true;
    return false;
  }

  test("rejects short vague text", () => {
    expect(isVague("use v3")).toBe(true);
    expect(isVague("update it")).toBe(true);
  });

  test("rejects generic advice", () => {
    expect(isVague("You should use the latest version of the library")).toBe(true);
    expect(isVague("Consider using the recommended approach for auth")).toBe(true);
  });

  test("accepts code-like text", () => {
    expect(isVague("createAuth({secret, baseURL})")).toBe(false);
    expect(isVague("import { session } from 'betterauth/v3'")).toBe(false);
    expect(isVague("auth.api.getSession({headers: req.headers})")).toBe(false);
  });

  test("accepts specific API descriptions", () => {
    expect(isVague("The createAuth() function now requires a baseURL parameter as the second argument")).toBe(false);
  });
});

describe("knowledge categorization", () => {
  function categorize(discovery: { mistake: string; correct: string; library: string }): string {
    const text = `${discovery.mistake} ${discovery.correct}`.toLowerCase();
    if (text.includes("deprecated") || text.includes("removed")) return "deprecated";
    if (text.includes("breaking") || text.includes("incompatible")) return "breaking_change";
    if (text.includes("new") || text.includes("added") || text.includes("introduced")) return "new_pattern";
    if (text.includes("gotcha") || text.includes("subtle") || text.includes("unexpected")) return "gotcha";
    return "api_change";
  }

  test("categorizes deprecated patterns", () => {
    expect(categorize({ library: "x", mistake: "deprecated function foo()", correct: "use bar()" })).toBe("deprecated");
  });

  test("categorizes breaking changes", () => {
    expect(categorize({ library: "x", mistake: "old API", correct: "breaking change in v3, use new API" })).toBe("breaking_change");
  });

  test("categorizes new patterns", () => {
    expect(categorize({ library: "x", mistake: "no such feature", correct: "newly added in v2" })).toBe("new_pattern");
  });

  test("defaults to api_change", () => {
    expect(categorize({ library: "x", mistake: "wrong params", correct: "correct params" })).toBe("api_change");
  });
});
