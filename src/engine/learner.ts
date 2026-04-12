import { saveContext, searchContexts } from "../nia/client";
import type { SynthesisResult, KnowledgeEntry, Finding, ConfidenceSignals } from "../nia/types";
import { createLogger } from "../utils/logger";

const log = createLogger("learner");

/**
 * Compute confidence from real evidence signals.
 * Not a vibes number. Math.
 */
export function computeConfidence(signals: ConfidenceSignals): number {
  let score = 0.2; // Base: Oracle said it

  if (signals.tracer_repo_count >= 3) score += 0.3;
  else if (signals.tracer_repo_count >= 1) score += 0.15;

  if (signals.advisor_verified) score += 0.15;
  if (signals.cross_validated) score += 0.15;

  // Feedback loop adjustment
  const totalRecalls = signals.times_recalled_ok + signals.times_contradicted;
  if (totalRecalls > 0) {
    const successRate = signals.times_recalled_ok / totalRecalls;
    score += (successRate - 0.5) * 0.2;
  }

  return Math.max(0.05, Math.min(score, 1.0));
}

/**
 * Extract novel discoveries from synthesis and store them in Nia Context.
 *
 * Quality gate: 4-criteria test (novel, corrective, specific, verified).
 * Now also stores: root_cause, confidence, confidence_signals, status.
 */
export async function learn(
  synthesis: SynthesisResult,
  findings?: Finding[],
): Promise<KnowledgeEntry[]> {
  const discoveries = synthesis.novel_discoveries;

  if (!discoveries || discoveries.length === 0) {
    log.info("No novel discoveries to store");
    return [];
  }

  log.info("Processing novel discoveries", { count: discoveries.length });

  const stored: KnowledgeEntry[] = [];

  for (const discovery of discoveries) {
    if (!discovery.library || !discovery.correct) {
      log.info("Rejected: missing library or correct usage", { library: discovery.library });
      continue;
    }
    if (!discovery.mistake) {
      log.info("Rejected: no common mistake specified", { library: discovery.library });
      continue;
    }
    if (isVague(discovery.correct) || isVague(discovery.mistake)) {
      log.info("Rejected: too vague", { library: discovery.library, correct: discovery.correct.slice(0, 50) });
      continue;
    }

    const isDuplicate = await checkDuplicate(discovery.library, discovery.correct);
    if (isDuplicate) {
      log.info("Skipping duplicate knowledge", { library: discovery.library });
      continue;
    }

    // Build confidence signals from the research findings
    const hasTracerEvidence = findings
      ? findings.some(f => f.source === "tracer" && f.content.toLowerCase().includes(discovery.library.toLowerCase()))
      : false;
    const tracerRepoCount = hasTracerEvidence && findings
      ? countReposForLibrary(findings, discovery.library)
      : 0;
    const hasCrossValidation = findings
      ? findings.some(f => f.source === "oracle" && f.content.toLowerCase().includes(discovery.library.toLowerCase())) && hasTracerEvidence
      : false;

    const signals: ConfidenceSignals = {
      tracer_repo_count: tracerRepoCount,
      advisor_verified: false, // Set by advisor step in pipeline if it ran
      cross_validated: hasCrossValidation,
      times_recalled_ok: 0,
      times_contradicted: 0,
    };

    const confidence = computeConfidence(signals);
    const now = new Date().toISOString();
    const evidenceSource = (discovery.evidence_source as "oracle" | "tracer" | "docs") || (hasTracerEvidence ? "tracer" : "oracle");

    const entry: KnowledgeEntry = {
      id: "",
      library: discovery.library,
      version: discovery.version || "unknown",
      category: categorize(discovery),
      mistake: discovery.mistake,
      correct: discovery.correct,
      root_cause: discovery.root_cause || "",
      confidence,
      confidence_signals: signals,
      status: "active",
      evidence: {
        source: evidenceSource,
        repos: hasTracerEvidence && findings ? extractRepoNames(findings, discovery.library) : undefined,
      },
      created_at: now,
      updated_at: now,
      times_used: 0,
      last_used_at: null,
    };

    try {
      const contextId = await saveContext({
        title: `${entry.library}@${entry.version}: ${entry.category}`,
        summary: `Mistake: ${entry.mistake}. Correct: ${entry.correct}`,
        content: JSON.stringify(entry),
        tags: [entry.library, entry.version, entry.category, "symposium-knowledge"],
        memory_type: "fact",
        metadata: {
          confidence: entry.confidence,
          status: entry.status,
          times_used: entry.times_used,
          last_used_at: entry.last_used_at,
        },
      });

      entry.id = contextId;
      stored.push(entry);
      log.info("Stored knowledge", {
        library: entry.library,
        category: entry.category,
        confidence: Math.round(entry.confidence * 100) + "%",
        evidence: entry.evidence.source,
        repos: tracerRepoCount,
        root_cause: entry.root_cause ? "yes" : "no",
      });
    } catch (err) {
      log.warn("Failed to store knowledge entry", {
        library: entry.library,
        error: String(err),
      });
    }
  }

  log.info("Learning complete", {
    stored: stored.length,
    rejected: discoveries.length - stored.length,
    total: discoveries.length,
  });
  return stored;
}

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

function countReposForLibrary(findings: Finding[], library: string): number {
  const repos = new Set<string>();
  const lowerLib = library.toLowerCase();
  for (const f of findings) {
    if (f.source === "tracer" && f.content.toLowerCase().includes(lowerLib) && f.evidence?.repos) {
      for (const repo of f.evidence.repos) repos.add(repo);
    }
  }
  return repos.size;
}

function extractRepoNames(findings: Finding[], library: string): string[] {
  const repos: string[] = [];
  const lowerLib = library.toLowerCase();
  for (const f of findings) {
    if (f.source === "tracer" && f.content.toLowerCase().includes(lowerLib) && f.evidence?.repos) {
      for (const repo of f.evidence.repos) {
        if (!repos.includes(repo)) repos.push(repo);
      }
    }
  }
  return repos;
}

async function checkDuplicate(library: string, correct: string): Promise<boolean> {
  try {
    const existing = await searchContexts(`${library} ${correct}`, 3);
    if (!existing || existing.length === 0) return false;
    for (const entry of existing) {
      const tags: string[] = entry.tags || [];
      if (tags.includes(library) && tags.includes("symposium-knowledge")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function categorize(discovery: { mistake: string; correct: string; library: string }): KnowledgeEntry["category"] {
  const text = `${discovery.mistake} ${discovery.correct}`.toLowerCase();
  if (text.includes("deprecated") || text.includes("removed")) return "deprecated";
  if (text.includes("breaking") || text.includes("incompatible")) return "breaking_change";
  if (text.includes("new") || text.includes("added") || text.includes("introduced")) return "new_pattern";
  if (text.includes("gotcha") || text.includes("subtle") || text.includes("unexpected")) return "gotcha";
  return "api_change";
}
