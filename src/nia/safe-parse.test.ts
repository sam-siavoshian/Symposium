import { test, expect, describe } from "bun:test";
import { safeParseJSON } from "./safe-parse";

describe("safeParseJSON", () => {
  test("parses plain JSON", () => {
    const result = safeParseJSON<{ foo: string }>('{"foo": "bar"}');
    expect(result).toEqual({ foo: "bar" });
  });

  test("parses JSON from markdown code block", () => {
    const input = `Here's the analysis:

\`\`\`json
{"dimensions": ["code_paths", "api_correctness"]}
\`\`\`

That's what I found.`;
    const result = safeParseJSON<{ dimensions: string[] }>(input);
    expect(result).toEqual({ dimensions: ["code_paths", "api_correctness"] });
  });

  test("parses JSON from unmarked code block", () => {
    const input = `Result:

\`\`\`
{"winner": {"name": "approach A", "confidence": 0.9}}
\`\`\``;
    const result = safeParseJSON<any>(input);
    expect(result?.winner?.name).toBe("approach A");
  });

  test("extracts JSON object embedded in prose", () => {
    const input = `Based on my analysis, the result is {"findings": "some data", "is_novel": true} which shows the API changed.`;
    const result = safeParseJSON<{ findings: string; is_novel: boolean }>(input);
    expect(result?.is_novel).toBe(true);
  });

  test("extracts JSON array from prose", () => {
    const input = `The repos found: ["owner/repo1", "owner/repo2"]`;
    const result = safeParseJSON<string[]>(input);
    expect(result).toEqual(["owner/repo1", "owner/repo2"]);
  });

  test("returns null for completely non-JSON text", () => {
    const result = safeParseJSON("This is just a paragraph with no JSON at all.");
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const result = safeParseJSON('{"broken": }');
    expect(result).toBeNull();
  });

  test("handles nested objects in code blocks", () => {
    const input = `\`\`\`json
{
  "winner": {"name": "Direct API Fix", "summary": "Use v3 API", "confidence": 0.85},
  "plan": {
    "steps": [
      {"file": "auth.ts", "action": "modify", "description": "Fix import", "code_hint": "import { v3 } from 'lib'"}
    ]
  },
  "tests": ["test auth flow"],
  "novel_discoveries": []
}
\`\`\``;
    const result = safeParseJSON<any>(input);
    expect(result?.winner?.confidence).toBe(0.85);
    expect(result?.plan?.steps).toHaveLength(1);
  });

  test("prefers code block over embedded JSON", () => {
    const input = `Here {"wrong": true} is noise.

\`\`\`json
{"correct": true}
\`\`\``;
    const result = safeParseJSON<any>(input);
    expect(result?.correct).toBe(true);
  });

  // ─── New edge case tests ────────────────────────────

  test("finds JSON in second code block when first is code example", () => {
    const input = `Here's how the API works:

\`\`\`typescript
const auth = createAuth({secret: "key"});
\`\`\`

And here's my analysis:

\`\`\`json
{"findings": "API requires baseURL", "is_novel": true}
\`\`\``;
    const result = safeParseJSON<any>(input);
    expect(result?.findings).toBe("API requires baseURL");
    expect(result?.is_novel).toBe(true);
  });

  test("handles trailing commas", () => {
    const input = '{"a": 1, "b": 2,}';
    const result = safeParseJSON<any>(input);
    expect(result?.a).toBe(1);
    expect(result?.b).toBe(2);
  });

  test("handles trailing comma in array", () => {
    const input = '["a", "b", "c",]';
    const result = safeParseJSON<string[]>(input);
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("handles single-line comments in JSON", () => {
    const input = `{
  "library": "react", // the library name
  "version": "18" // latest major
}`;
    const result = safeParseJSON<any>(input);
    expect(result?.library).toBe("react");
    expect(result?.version).toBe("18");
  });

  test("handles braces in prose before actual JSON", () => {
    // The old parser would try to parse from "returns {status}" to the end
    const input = `The API returns {status: ok} in most cases. Here's the real data:

\`\`\`json
{"findings": "verified", "correct": true}
\`\`\``;
    const result = safeParseJSON<any>(input);
    expect(result?.findings).toBe("verified");
  });

  test("handles balanced nested JSON extraction", () => {
    const input = `Some text before {"outer": {"inner": {"deep": true}}} and text after {"noise": false}`;
    const result = safeParseJSON<any>(input);
    expect(result?.outer?.inner?.deep).toBe(true);
  });

  test("returns null for null/undefined/empty input", () => {
    expect(safeParseJSON(null as any)).toBeNull();
    expect(safeParseJSON(undefined as any)).toBeNull();
    expect(safeParseJSON("")).toBeNull();
  });

  test("handles JSON with escaped quotes in strings", () => {
    const input = '{"code": "const x = \\"hello\\""}';
    const result = safeParseJSON<any>(input);
    expect(result?.code).toBe('const x = "hello"');
  });
});
