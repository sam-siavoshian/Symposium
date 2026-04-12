/**
 * Extract JSON from Oracle/Tracer markdown responses.
 * Oracle wraps JSON in code blocks, adds prose, and sometimes produces
 * slightly malformed JSON (trailing commas, comments). This handles it all.
 */

export function safeParseJSON<T>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;

  // Strategy 1: Direct parse (fastest path)
  try {
    return JSON.parse(raw) as T;
  } catch {}

  // Strategy 2: Extract from markdown code blocks
  // Try ALL code blocks, not just the first (JSON is sometimes in the second block)
  const codeBlocks = [...raw.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)];
  for (const match of codeBlocks) {
    const content = match[1]?.trim();
    if (content) {
      const parsed = tryParseWithFixes<T>(content);
      if (parsed !== null) return parsed;
    }
  }

  // Strategy 3: Find the largest balanced JSON object in the text
  // More robust than indexOf/lastIndexOf which can span across unrelated braces
  const jsonObj = extractBalancedJSON(raw, "{", "}");
  if (jsonObj) {
    const parsed = tryParseWithFixes<T>(jsonObj);
    if (parsed !== null) return parsed;
  }

  // Strategy 4: Find balanced JSON array
  const jsonArr = extractBalancedJSON(raw, "[", "]");
  if (jsonArr) {
    const parsed = tryParseWithFixes<T>(jsonArr);
    if (parsed !== null) return parsed;
  }

  // Strategy 5: Last resort, try the old approach (first { to last })
  const braceStart = raw.indexOf("{");
  const braceEnd = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    const parsed = tryParseWithFixes<T>(raw.slice(braceStart, braceEnd + 1));
    if (parsed !== null) return parsed;
  }

  return null;
}

/**
 * Try parsing JSON with common LLM fixes applied.
 */
function tryParseWithFixes<T>(text: string): T | null {
  // Try direct parse first
  try {
    return JSON.parse(text) as T;
  } catch {}

  // Fix 1: Remove trailing commas before } or ]
  let fixed = text.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(fixed) as T;
  } catch {}

  // Fix 2: Remove single-line comments (// ...)
  fixed = fixed.replace(/\/\/[^\n]*/g, "");
  try {
    return JSON.parse(fixed) as T;
  } catch {}

  // Fix 3: Replace single quotes with double quotes (Python-style dicts)
  fixed = fixed.replace(/'/g, '"');
  try {
    return JSON.parse(fixed) as T;
  } catch {}

  return null;
}

/**
 * Extract the first balanced JSON structure from text.
 * Finds the first opening bracket and tracks nesting depth to find its matching close.
 * Ignores brackets inside strings.
 */
function extractBalancedJSON(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // Unbalanced
}
