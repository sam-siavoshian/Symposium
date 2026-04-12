import { runOracle } from "../nia/client";
import { safeParseJSON } from "../nia/safe-parse";
import type { Finding, SynthesisResult } from "../nia/types";
import { synthesizerPrompt } from "../utils/prompts";
import { createLogger } from "../utils/logger";

const log = createLogger("synthesizer");

/**
 * Fast synthesis: skip Oracle, structure findings directly.
 * Used in quick/auto mode to avoid a 3-5 min synthesis Oracle call.
 */
export function synthesizeFast(findings: Finding[]): SynthesisResult {
  log.info("Fast synthesis (no Oracle call)", { findingsCount: findings.length });

  // Extract any novel discoveries from findings
  const novelFindings = findings.filter(f => f.isNovel && f.library && f.correctUsage);

  // Build plan steps from findings that have actionable content
  const steps: SynthesisResult["plan"]["steps"] = [];
  for (const f of findings) {
    if (f.correctUsage) {
      steps.push({
        file: "see finding",
        action: "modify",
        description: `[${f.dimension}] ${f.content.slice(0, 500)}`,
        code_hint: f.correctUsage,
      });
    }
  }

  // If no structured steps, use the raw content from the most important finding
  if (steps.length === 0) {
    const best = findings.find(f => f.dimension === "api_correctness") || findings[0];
    if (best) {
      steps.push({
        file: "implementation",
        action: "modify",
        description: best.content.slice(0, 1500),
        code_hint: "",
      });
    }
  }

  return {
    winner: {
      name: "Research Findings",
      summary: `Direct findings from ${findings.length} research agents. ${novelFindings.length > 0 ? `${novelFindings.length} novel discoveries found.` : ""}`,
      confidence: findings.length > 0 ? 0.7 : 0.3,
    },
    plan: { steps },
    tests: [],
    novel_discoveries: novelFindings.map(f => ({
      library: f.library || "unknown",
      version: f.version || "unknown",
      mistake: f.commonMistake || "unknown",
      correct: f.correctUsage || "unknown",
      evidence_source: f.source,
      root_cause: "",
    })),
  };
}

/**
 * Full synthesis: uses Oracle to debate findings and pick the best approach.
 * Slower (~3-5 min) but produces a more coherent plan.
 */
export async function synthesize(
  issue: string,
  files: string[],
  findings: Finding[],
  recalledKnowledge: string,
  evidenceScore?: { composite: number; breakdown: string },
): Promise<SynthesisResult> {
  log.info("Starting synthesis", { findingsCount: findings.length });

  const prompt = synthesizerPrompt(issue, files, findings, recalledKnowledge, findings.length, evidenceScore);

  let raw: string;
  try {
    raw = await runOracle(prompt);
  } catch (err) {
    log.error("Synthesis Oracle call failed", { error: String(err) });
    return buildFallbackSynthesis(findings, String(err));
  }

  const parsed = safeParseJSON<SynthesisResult>(raw);

  if (!parsed || !parsed.winner) {
    log.warn("Synthesis returned unparseable result, building fallback");
    return buildFallbackSynthesis(findings);
  }

  // Normalize winner fields
  parsed.winner.name = parsed.winner.name || "Unnamed Approach";
  parsed.winner.summary = parsed.winner.summary || "No summary provided.";
  const rawConf = Number(parsed.winner.confidence);
  parsed.winner.confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(rawConf, 1)) : 0.5;

  // Validate and normalize required fields
  if (!parsed.plan?.steps || !Array.isArray(parsed.plan.steps)) {
    parsed.plan = { steps: [] };
  } else {
    // Ensure every step has required fields (Oracle might omit some)
    parsed.plan.steps = parsed.plan.steps.map(step => ({
      file: step.file || "unknown",
      action: step.action || "modify",
      description: step.description || "",
      code_hint: step.code_hint || "",
    }));
  }
  if (!parsed.tests || !Array.isArray(parsed.tests)) {
    parsed.tests = [];
  }
  if (!parsed.novel_discoveries || !Array.isArray(parsed.novel_discoveries)) {
    parsed.novel_discoveries = [];
  } else {
    // Filter out incomplete discoveries
    parsed.novel_discoveries = parsed.novel_discoveries.filter(
      d => d.library && d.correct
    );
  }

  log.info("Synthesis complete", {
    approach: parsed.winner.name,
    confidence: parsed.winner.confidence,
    steps: parsed.plan.steps.length,
    novelDiscoveries: parsed.novel_discoveries.length,
  });

  return parsed;
}

/**
 * Fallback synthesis when Oracle fails to return structured JSON.
 * Combines all findings into a basic plan.
 */
function buildFallbackSynthesis(findings: Finding[], error?: string): SynthesisResult {
  if (findings.length === 0) {
    return {
      winner: {
        name: "No Results",
        summary: error
          ? `Synthesis failed: ${error}. No agent findings available.`
          : "All agents failed to return results. Try again or reduce complexity.",
        confidence: 0,
      },
      plan: { steps: [] },
      tests: [],
      novel_discoveries: [],
    };
  }

  const novelFindings = findings.filter(f => f.isNovel);

  return {
    winner: {
      name: "Raw Findings (synthesis failed)",
      summary: error
        ? `Synthesis Oracle call failed (${error}). Returning ${findings.length} raw agent findings for manual review.`
        : `Could not parse synthesis. Returning ${findings.length} raw agent findings for manual review.`,
      confidence: 0.3,
    },
    plan: {
      steps: findings.map(f => ({
        file: f.dimension,
        action: "modify" as const,
        description: f.content.slice(0, 1000),
        code_hint: "",
      })),
    },
    tests: [],
    novel_discoveries: novelFindings.map(f => ({
      library: f.library || "unknown",
      version: f.version || "unknown",
      mistake: f.commonMistake || "unknown",
      correct: f.correctUsage || "see findings",
      evidence_source: f.source,
    })),
  };
}
