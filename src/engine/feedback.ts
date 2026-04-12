import { getContext, updateContext } from "../nia/client";
import { safeParseJSON } from "../nia/safe-parse";
import { computeConfidence } from "./learner";
import type { KnowledgeEntry, ConfidenceSignals } from "../nia/types";
import { fillKnowledgeDefaults } from "../nia/types";
import { createLogger } from "../utils/logger";

/**
 * Recompute confidence from signals, but never drop below the stored
 * confidence on the first feedback event. Old entries stored before
 * confidence_signals existed have signals=zeros but confidence=0.5.
 * Without this floor, the first feedback recomputes from zeros and
 * drops confidence from 0.5 to ~0.2.
 */
function recomputeConfidence(signals: ConfidenceSignals, storedConfidence: number): number {
  const fromSignals = computeConfidence(signals);
  const totalFeedback = signals.times_recalled_ok + signals.times_contradicted;
  // If this is the first feedback event (totalFeedback <= 1), preserve the
  // stored confidence as a floor. After multiple feedback events the signals
  // are authoritative and the floor no longer applies.
  if (totalFeedback <= 1) {
    return Math.max(fromSignals, storedConfidence);
  }
  return fromSignals;
}

const log = createLogger("feedback");

/**
 * Record that a knowledge entry was used (fast path recall).
 * Increments times_used, updates last_used_at, persists via updateContext.
 */
export async function recordUsage(entryId: string): Promise<void> {
  if (!entryId || entryId === "unknown") return;

  try {
    const context = await getContext(entryId);
    if (!context) return;

    const entry = safeParseJSON<Record<string, any>>(context.content || "");
    if (!entry) return;

    const filled = fillKnowledgeDefaults(entry);
    filled.times_used++;
    filled.last_used_at = new Date().toISOString();
    filled.updated_at = new Date().toISOString();

    await updateContext(entryId, {
      content: JSON.stringify(filled),
      metadata: {
        confidence: filled.confidence,
        status: filled.status,
        times_used: filled.times_used,
        last_used_at: filled.last_used_at,
      },
    });

    log.info("Usage recorded", { entryId, times_used: filled.times_used });
  } catch (err) {
    log.warn("Failed to record usage", { entryId, error: String(err) });
  }
}

/**
 * Auto-feedback: compare recalled knowledge against fresh research findings.
 * Uses library-match-only strategy (no string comparison of correct fields).
 *
 * If fresh research did NOT produce a new entry for the same library → confirmed
 * If fresh research DID produce a new entry for the same library → contradicted
 */
export async function autoFeedback(
  recalledEntries: KnowledgeEntry[],
  newDiscoveries: Array<{ library: string; version: string; mistake: string; correct: string }>,
): Promise<void> {
  if (!recalledEntries || recalledEntries.length === 0) return;

  const newLibraries = new Set(newDiscoveries.map(d => d.library.toLowerCase()));

  // Filter to entries with usable IDs, then process in parallel
  const validEntries = recalledEntries.filter(e => e.id && e.id !== "unknown");
  if (validEntries.length === 0) return;

  await Promise.allSettled(validEntries.map(async (entry) => {
    try {
      const context = await getContext(entry.id);
      if (!context) return;

      const stored = safeParseJSON<Record<string, any>>(context.content || "");
      if (!stored) return;

      const filled = fillKnowledgeDefaults(stored);
      const now = new Date().toISOString();

      if (newLibraries.has(entry.library.toLowerCase())) {
        // Fresh research found something new for the same library.
        // This is a contradiction signal.
        filled.confidence_signals.times_contradicted++;
        log.info("Knowledge contradicted", { library: entry.library, entryId: entry.id });
      } else {
        // Fresh research didn't override this library's knowledge.
        // That's an implicit confirmation.
        filled.confidence_signals.times_recalled_ok++;
        log.info("Knowledge confirmed", { library: entry.library, entryId: entry.id });
      }

      // Recompute confidence
      filled.confidence = recomputeConfidence(filled.confidence_signals, filled.confidence);
      filled.updated_at = now;

      // Auto-deprecate if confidence drops too low
      if (filled.confidence < 0.15) {
        filled.status = "deprecated";
        log.warn("Knowledge auto-deprecated (confidence too low)", {
          library: entry.library,
          confidence: filled.confidence,
        });
      }

      await updateContext(entry.id, {
        content: JSON.stringify(filled),
        metadata: {
          confidence: filled.confidence,
          status: filled.status,
          times_used: filled.times_used,
          last_used_at: filled.last_used_at,
        },
      });
    } catch (err) {
      log.warn("Auto-feedback failed for entry", { entryId: entry.id, error: String(err) });
    }
  }));
}

/**
 * Explicit feedback from the symposium_feedback MCP tool.
 */
export async function recordExplicitFeedback(
  entryId: string,
  outcome: "correct" | "incorrect" | "partial",
  detail?: string,
): Promise<{ success: boolean; newConfidence?: number; newStatus?: string }> {
  try {
    const context = await getContext(entryId);
    if (!context) return { success: false };

    const stored = safeParseJSON<Record<string, any>>(context.content || "");
    if (!stored) return { success: false };

    const filled = fillKnowledgeDefaults(stored);
    const now = new Date().toISOString();

    if (outcome === "correct") {
      filled.confidence_signals.times_recalled_ok++;
    } else if (outcome === "incorrect") {
      filled.confidence_signals.times_contradicted++;
    } else {
      // partial: count as one recall, split between ok and contradicted
      filled.confidence_signals.times_recalled_ok++;
      filled.confidence_signals.times_contradicted++;
    }

    filled.confidence = recomputeConfidence(filled.confidence_signals, filled.confidence);
    filled.updated_at = now;
    filled.times_used++;

    if (filled.confidence < 0.15) {
      filled.status = "deprecated";
    }

    await updateContext(entryId, {
      content: JSON.stringify(filled),
      metadata: {
        confidence: filled.confidence,
        status: filled.status,
        times_used: filled.times_used,
        last_used_at: now,
      },
      summary: detail
        ? `Mistake: ${filled.mistake}. Correct: ${filled.correct}. Feedback: ${detail}`
        : undefined,
    });

    log.info("Explicit feedback recorded", {
      entryId,
      outcome,
      newConfidence: Math.round(filled.confidence * 100) + "%",
      newStatus: filled.status,
    });

    return { success: true, newConfidence: filled.confidence, newStatus: filled.status };
  } catch (err) {
    log.warn("Failed to record explicit feedback", { entryId, error: String(err) });
    return { success: false };
  }
}
