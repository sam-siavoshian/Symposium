import type { Finding } from "../nia/types";
import { createLogger } from "../utils/logger";

const log = createLogger("collector");

export interface EvidenceScore {
  /** How many agents agree on the same general approach (0-1) */
  agentConvergence: number;
  /** How many real repos were found via Tracer (0-1) */
  tracerEvidence: number;
  /** Whether findings are consistent with existing codebase patterns (0-1) */
  patternConsistency: number;
  /** Whether novel knowledge was discovered (0-1) */
  noveltySignal: number;
  /** How many agents returned results out of total spawned (0-1) */
  completeness: number;
  /** Final composite score (0-1) */
  composite: number;
  /** Human-readable breakdown */
  breakdown: string;
}

export interface CollectedFindings {
  oracle: Finding[];
  tracer: Finding[];
  all: Finding[];
  oracleSummaries: string[];
  tracerExamples: string[];
  codebasePatterns: string[];
  evidenceScore: EvidenceScore;
}

/**
 * Gather and structure findings from all agents.
 * Computes an evidence-based confidence score from actual signals.
 */
export function collectFindings(findings: Finding[], totalAgentsSpawned?: number): CollectedFindings {
  const oracle = findings.filter(f => f.source === "oracle");
  const tracer = findings.filter(f => f.source === "tracer");

  const oracleSummaries = oracle.map(f => {
    const preview = f.content.slice(0, 500);
    return `[${f.dimension}] ${preview}`;
  });

  const tracerExamples = tracer.map(f => {
    const repos = f.evidence?.repos?.join(", ") || "unknown repos";
    return `[${f.dimension}] Found in: ${repos}. ${f.content.slice(0, 300)}`;
  });

  const codebasePatterns = findings
    .filter(f => f.dimension === "existing_patterns" || f.dimension === "code_paths")
    .map(f => f.content.slice(0, 300));

  const evidenceScore = computeEvidenceScore(findings, totalAgentsSpawned || findings.length);

  log.info("Findings collected", {
    total: findings.length,
    oracle: oracle.length,
    tracer: tracer.length,
    confidence: Math.round(evidenceScore.composite * 100) + "%",
  });

  return {
    oracle,
    tracer,
    all: findings,
    oracleSummaries,
    tracerExamples,
    codebasePatterns,
    evidenceScore,
  };
}

/**
 * Compute a real evidence score from actual signals in the findings.
 * This replaces Oracle's hallucinated confidence number with math.
 *
 * Formula from spec: score = agent_convergence + (2 * tracer_examples) + pattern_matches
 * Normalized to 0-1 range.
 */
function computeEvidenceScore(findings: Finding[], totalAgentsSpawned: number): EvidenceScore {
  // Early return for empty findings
  if (findings.length === 0) {
    return {
      agentConvergence: 0, tracerEvidence: 0, patternConsistency: 0,
      noveltySignal: 0, completeness: 0, composite: 0,
      breakdown: "No agent findings available",
    };
  }

  // ─── Agent Convergence ──────────────────────────────
  // Do multiple agents' findings point in the same direction?
  // Measured by: how many agents returned substantive content
  // (>100 chars, meaning they actually found something)
  const substantiveFindings = findings.filter(f => f.content.length > 100);
  const agentConvergence = totalAgentsSpawned > 0
    ? Math.min(substantiveFindings.length / totalAgentsSpawned, 1)
    : 0;

  // ─── Tracer Evidence ────────────────────────────────
  // Real repos found via GitHub search. This is the strongest signal.
  // Count unique repos across all tracer findings.
  const allRepos = new Set<string>();
  for (const f of findings) {
    if (f.evidence?.repos) {
      for (const repo of f.evidence.repos) {
        allRepos.add(repo);
      }
    }
  }
  // 3+ repos = perfect score. Each repo is worth 0.33.
  const tracerEvidence = Math.min(allRepos.size / 3, 1);

  // ─── Pattern Consistency ────────────────────────────
  // Did the existing_patterns agent find relevant patterns?
  const patternFindings = findings.filter(f => f.dimension === "existing_patterns");
  const hasPatterns = patternFindings.length > 0 && patternFindings.some(f => f.content.length > 100);
  const patternConsistency = hasPatterns ? 0.8 : 0.3; // Penalty if no patterns found, not zero

  // ─── Cross-Validation ────────────────────────────────
  // When both Oracle and Tracer returned findings for the same dimension,
  // that's cross-validated evidence. Much stronger than either alone.
  const dimensionsWithOracle = new Set(findings.filter(f => f.source === "oracle").map(f => f.dimension));
  const dimensionsWithTracer = new Set(findings.filter(f => f.source === "tracer").map(f => f.dimension));
  const crossValidated = [...dimensionsWithOracle].filter(d => dimensionsWithTracer.has(d));
  const crossValidationBonus = crossValidated.length > 0 ? 0.5 : 0;

  // ─── Novelty Signal ─────────────────────────────────
  // Did any agent discover something new? This is the core mission.
  const novelFindings = findings.filter(f => f.isNovel);
  const hasNovelty = novelFindings.length > 0;
  const noveltySignal = hasNovelty ? 1.0 : 0.0;

  // ─── Completeness ───────────────────────────────────
  // What % of spawned agents actually returned results?
  const completeness = totalAgentsSpawned > 0
    ? Math.min(findings.length / totalAgentsSpawned, 1.0)
    : 0;

  // ─── Composite Score ────────────────────────────────
  // Weighted formula aligned with the spec:
  // agent_convergence (1) + tracer_evidence (2) + pattern_matches (1) + novelty (0.5) + cross_validation (0.5)
  // Normalized by total weight (5.0)
  const rawScore = (
    agentConvergence * 1.0 +
    tracerEvidence * 2.0 +
    patternConsistency * 1.0 +
    noveltySignal * 0.5 +
    crossValidationBonus
  ) / 5.0;

  // Apply completeness as a multiplier (if half the agents failed, halve confidence)
  const composite = Math.min(rawScore * Math.max(completeness, 0.5), 1.0);

  // Build human-readable breakdown
  const parts: string[] = [];
  parts.push(`${substantiveFindings.length}/${totalAgentsSpawned} agents returned results`);
  if (allRepos.size > 0) parts.push(`${allRepos.size} real repos found`);
  if (crossValidated.length > 0) parts.push(`${crossValidated.length} cross-validated by Oracle+Tracer`);
  if (hasPatterns) parts.push("consistent with codebase patterns");
  if (hasNovelty) parts.push(`${novelFindings.length} novel discoveries`);

  const breakdown = parts.join(", ");

  return {
    agentConvergence,
    tracerEvidence,
    patternConsistency,
    noveltySignal,
    completeness,
    composite,
    breakdown,
  };
}
