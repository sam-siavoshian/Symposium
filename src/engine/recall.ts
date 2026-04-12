import { searchContexts } from "../nia/client";
import { safeParseJSON } from "../nia/safe-parse";
import type { KnowledgeEntry } from "../nia/types";
import { fillKnowledgeDefaults } from "../nia/types";
import { createLogger } from "../utils/logger";

const log = createLogger("recall");

/**
 * Query the Nia Context vector DB for prior knowledge about this issue.
 * Returns matching knowledge entries if any exist, or null if this is a new problem.
 */
export async function recall(issue: string): Promise<KnowledgeEntry[] | null> {
  log.info("Searching for prior knowledge", { query: issue.slice(0, 100) });

  try {
    const results = await searchContexts(issue, 5);

    if (!results || results.length === 0) {
      log.info("No prior knowledge found");
      return null;
    }

    const entries: KnowledgeEntry[] = [];
    for (const result of results) {
      // Context content is stored as JSON string
      const content = result.content || result.summary;
      const parsed = safeParseJSON<Record<string, any>>(content);
      if (parsed && parsed.library && parsed.correct) {
        // Use fillKnowledgeDefaults for backward compat with old entries
        entries.push(fillKnowledgeDefaults(parsed));
      } else if (result.title && result.summary) {
        // Fallback: reconstruct from context metadata
        entries.push(fillKnowledgeDefaults({
          id: result.id || result._id || "unknown",
          library: extractLibrary(result.title ?? "") || "unknown",
          version: extractVersion(result.title ?? "") || "unknown",
          mistake: result.summary.split("Correct:")[0]?.replace("Mistake:", "").trim() || result.summary,
          correct: result.summary.split("Correct:")[1]?.trim() || "",
          evidence: { source: "oracle" },
          created_at: result.created_at || new Date().toISOString(),
          times_used: (result.times_used || 0) + 1,
          // Pull mutable fields from metadata if available
          confidence: result.metadata?.confidence,
          status: result.metadata?.status,
          last_used_at: result.metadata?.last_used_at,
        }));
      }
    }

    if (entries.length > 0) {
      log.info("Recalled prior knowledge", { count: entries.length });
      return entries;
    }

    return null;
  } catch (err) {
    log.warn("Recall failed, proceeding without prior knowledge", { error: String(err) });
    return null;
  }
}

function extractLibrary(title: string): string | null {
  const match = title.match(/^([^@]+)@/);
  return match?.[1]?.trim() ?? null;
}

function extractVersion(title: string): string | null {
  const match = title.match(/@([^:]+)/);
  return match?.[1]?.trim() ?? null;
}

