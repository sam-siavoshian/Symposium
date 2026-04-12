import type { SymposiumInput, SymposiumOutput, ProgressCallback, LogEmitter, KnowledgeEntry, SynthesisResult } from "../nia/types";
import { recall } from "../engine/recall";
import { decompose } from "../engine/decomposer";
import { spawnAgents } from "../engine/spawner";
import { collectFindings } from "../engine/collector";
import { synthesize, synthesizeFast } from "../engine/synthesizer";
import { learn } from "../engine/learner";
import { recordUsage, autoFeedback } from "../engine/feedback";
import { runOracle, verifyWithAdvisor, subscribeDependency } from "../nia/client";
import { safeParseJSON } from "../nia/safe-parse";
import { fastPathPrompt } from "../utils/prompts";
import { createLogger } from "../utils/logger";

const log = createLogger("symposium");

const TOTAL_STEPS_FULL = 6;
const TOTAL_STEPS_FAST = 3; // recall -> fast synthesis -> deliver

function noopProgress(): Promise<void> { return Promise.resolve(); }
function noopLog(): Promise<void> { return Promise.resolve(); }

/**
 * Main Symposium pipeline:
 *
 * FAST PATH (recall hit):   recall -> fast synthesis -> deliver
 * FULL PATH (no recall):    recall -> decompose -> spawn -> collect -> synthesize -> learn -> deliver
 *
 * The fast path is the "money shot" for the demo. Second run is instant.
 */
export async function runSymposium(input: SymposiumInput): Promise<SymposiumOutput> {
  const start = Date.now();
  const depth = input.depth || "quick";
  const files = input.files || [];
  const signal = input.signal;
  const progress: ProgressCallback = input.onProgress || noopProgress;
  const emit: LogEmitter = input.onLog || noopLog;
  let niaCalls = 0;

  log.info("=== Symposium starting ===", { issue: input.issue.slice(0, 100), depth });
  await emit("info", "symposium", `Starting research for: "${input.issue.slice(0, 80)}..."`);

  // ─── Phase 0: RECALL ─────────────────────────────────
  checkCancelled(signal);
  await progress(1, TOTAL_STEPS_FULL, "◎ Searching knowledge base...");
  const recalledEntries = await recall(input.issue);
  niaCalls += 1;

  // Filter recalled entries to only those relevant to the current issue
  // Semantic search can return tangential matches (e.g., "session" matches both BetterAuth and NextAuth)
  const issueLower = input.issue.toLowerCase();
  const issueNormalized = issueLower.replace(/[-_.]/g, ""); // normalize separators: "better-auth" / "better.auth" → "betterauth"
  const relevantEntries = recalledEntries?.filter(entry => {
    const libLower = entry.library.toLowerCase();
    const libNormalized = libLower.replace(/[-_.]/g, "");
    // Match on both raw and normalized forms of both sides
    return issueLower.includes(libLower) ||
      issueLower.includes(libNormalized) ||
      issueNormalized.includes(libLower) ||
      issueNormalized.includes(libNormalized);
  }) || [];
  const recalled = relevantEntries.length > 0;

  if (recalledEntries && recalledEntries.length > 0 && !recalled) {
    await emit("info", "recall", `Found ${recalledEntries.length} entries but none match this task's libraries. Proceeding with full research.`);
  }

  if (recalled) {
    await emit("info", "recall", `Found ${relevantEntries.length} relevant knowledge entries.`);
    for (const entry of relevantEntries) {
      await emit("info", "recall", `  Known: ${entry.library}@${entry.version} - ${entry.mistake.slice(0, 80)}`);
    }

    // ─── FAST PATH ─────────────────────────────────────
    // Skip decompose, spawn, collect. Go straight to a lightweight synthesis
    // using stored knowledge. This is ~10x faster (1 Oracle call vs 5+).
    await emit("info", "recall", "FAST PATH: Using stored knowledge. Skipping full research.");
    await progress(2, TOTAL_STEPS_FAST, "⚡ Generating plan from stored knowledge...");

    const fastResult = await runFastPath(input.issue, files, relevantEntries, signal);
    niaCalls += 1; // One Oracle call for fast synthesis

    // Record usage on each recalled entry (fire-and-forget, non-blocking)
    for (const entry of relevantEntries) {
      recordUsage(entry.id).catch(() => {});
    }

    const duration = Date.now() - start;
    await progress(3, TOTAL_STEPS_FAST, `✓ Instant recall complete — ${(duration / 1000).toFixed(1)}s`);
    await emit("info", "symposium", `FAST PATH complete in ${(duration / 1000).toFixed(1)}s. Knowledge recalled, no new research needed.`);

    const output: SymposiumOutput & { _recalled_knowledge?: Array<{ library: string; version: string; mistake: string; correct: string }> } = {
      recalled: true,
      recalled_entries: relevantEntries.length,
      recalled_entry_ids: relevantEntries.map(e => e.id).filter(id => id && id !== "unknown"),
      approach: {
        name: fastResult.winner.name,
        summary: fastResult.winner.summary,
        confidence: fastResult.winner.confidence,
        plan: {
          steps: fastResult.plan?.steps || [],
          tests: fastResult.tests || [],
        },
        evidence: {
          oracle_findings: [],
          tracer_examples: [],
          codebase_patterns: [],
        },
      },
      learned: [],
      // Attach recalled entries for inline display in formatOutput (#14)
      _recalled_knowledge: relevantEntries.map(e => ({
        library: e.library,
        version: e.version,
        mistake: e.mistake,
        correct: e.correct,
      })),
      evidence_breakdown: `Recalled ${relevantEntries.length} prior discoveries (fast path, no new research)`,
      stats: {
        agents_spawned: 0,
        nia_calls: niaCalls,
        knowledge_entries_stored: 0,
        knowledge_entries_recalled: relevantEntries.length,
        duration_ms: duration,
      },
    };
    return output;
  }

  // ─── FULL PATH (no recall hit) ───────────────────────
  await emit("info", "recall", "No prior knowledge found. Full research required.");
  const recallEnd = Date.now();

  // ─── Phase 0b: AUTO-SUBSCRIBE DEPENDENCIES ───────────
  // Extract library names from the issue and index their docs in Nia.
  // Runs in background (non-blocking) so it doesn't add latency.
  const libraryHints = extractLibraryNames(input.issue);
  if (libraryHints.length > 0) {
    await emit("info", "subscribe", `Indexing documentation for: ${libraryHints.join(", ")}`);
    // Fire-and-forget: subscribe in parallel, don't wait
    const subscribePromises = libraryHints.map(lib =>
      subscribeDependency(`https://github.com/${lib}`, "documentation")
        .then(id => {
          if (id) {
            niaCalls++;
            log.info("Subscribed dependency", { library: lib, sourceId: id });
          }
        })
        .catch(() => {}) // Non-critical, swallow errors
    );
    // True fire-and-forget: subscriptions resolve in background before Advisor runs (~30s later)
    Promise.allSettled(subscribePromises).catch(() => {});
  }

  // ─── Phase 1: DECOMPOSE ──────────────────────────────
  checkCancelled(signal);
  const decomposeStart = Date.now();
  await progress(2, TOTAL_STEPS_FULL, "◈ Selecting research dimensions...");

  const dimensions = await decompose(input.issue, files, depth);
  const decomposeEnd = Date.now();

  const dimNames = dimensions.map(d => `${d.type}${d.usesTracer ? " (tracer)" : ""}`);
  await emit("info", "decomposer", `Selected ${dimensions.length} dimensions: ${dimNames.join(", ")}`);

  // ─── Phase 2: RESEARCH (parallel agents) ─────────────
  checkCancelled(signal);
  const researchStart = Date.now();
  let agentsStarted = 0;
  let agentsCompleted = 0;
  // Count dual-mode expansion: each dualMode dimension becomes 2 jobs
  const totalAgentJobs = dimensions.reduce((n, d) => n + (d.dualMode ? 2 : 1), 0);
  await progress(3, TOTAL_STEPS_FULL, `◉ Dispatching ${totalAgentJobs} research agents...`);

  const { findings, niaCalls: spawnCalls, lateFindings } = await spawnAgents(
    dimensions,
    input.issue,
    files,
    input.codebase_id,
    signal,
    async (event) => {
      const bar = `[${agentsCompleted}/${totalAgentJobs}]`;
      if (event.type === "batch_started") {
        await progress(3, TOTAL_STEPS_FULL, `◉ ${bar} Research started...`);
      } else if (event.type === "agent_started") {
        agentsStarted++;
        const isDual = event.dimension.includes(":tracer");
        const name = isDual
          ? event.dimension.replace(":tracer", "") + " ↔"
          : event.dimension;
        const icon = event.source === "tracer" ? "⌕" : "●";
        await progress(3, TOTAL_STEPS_FULL, `◉ ${bar} ${icon} ${name} started`);
      } else if (event.type === "agent_completed") {
        agentsCompleted++;
        const bar2 = `[${agentsCompleted}/${totalAgentJobs}]`;
        const isDual = event.dimension.includes(":tracer");
        const name = isDual
          ? event.dimension.replace(":tracer", "") + " ↔"
          : event.dimension;
        const novelTag = event.isNovel ? " ★" : "";
        await progress(3, TOTAL_STEPS_FULL, `◉ ${bar2} ✓ ${name}${novelTag} — ${(event.durationMs / 1000).toFixed(0)}s`);
      } else if (event.type === "agent_activity") {
        const isDual = event.dimension.includes(":tracer");
        const shortName = isDual
          ? event.dimension.replace(":tracer", "").replace(/_/g, " ")
          : event.dimension.replace(/_/g, " ");
        await progress(3, TOTAL_STEPS_FULL, `◉ ${bar} ${shortName} → ${event.activity}`);
      } else if (event.type === "agent_failed") {
        agentsCompleted++;
        const bar2 = `[${agentsCompleted}/${totalAgentJobs}]`;
        await progress(3, TOTAL_STEPS_FULL, `◉ ${bar2} ✗ ${event.dimension} failed`);
      } else if (event.type === "agent_retrying") {
        await progress(3, TOTAL_STEPS_FULL, `◉ ${bar} ↻ ${event.dimension} retrying...`);
      }
    },
  );
  niaCalls += spawnCalls;

  // Consume late findings in background (fire-and-forget for learning loop)
  if (lateFindings) {
    lateFindings.then(late => {
      if (late.length > 0) {
        log.info("Late findings arrived after synthesis started", { count: late.length });
      }
    }).catch(() => {});
  }

  const researchEnd = Date.now();
  const researchSecs = ((researchEnd - researchStart) / 1000).toFixed(1);
  const novelInResearch = findings.filter(f => f.isNovel);
  const tracerFindings = findings.filter(f => f.source === "tracer");

  const earlyTag = lateFindings ? " (early synthesis, 1 agent still running)" : "";
  let researchSummary = `Research complete: ${findings.length} findings in ${researchSecs}s${earlyTag}`;
  if (tracerFindings.length > 0) researchSummary += `, ${tracerFindings.length} from GitHub repos`;
  if (novelInResearch.length > 0) researchSummary += `, ${novelInResearch.length} novel`;
  await emit("info", "spawner", researchSummary);

  // ─── Phase 3: COLLECT + SYNTHESIZE ───────────────────
  const synthesisStart = Date.now();
  checkCancelled(signal);
  await progress(4, TOTAL_STEPS_FULL, `◆ Synthesizing ${findings.length} findings...`);
  const collected = collectFindings(findings, dimensions.length);

  const score = collected.evidenceScore;

  // Quick/auto: fast synthesis (no Oracle call, saves 3-5 min)
  // Standard/deep: full Oracle synthesis (debates approaches, picks winner)
  const useFastSynthesis = depth === "quick" || depth === "auto";
  let synthesis: SynthesisResult;

  if (useFastSynthesis) {
    await progress(4, TOTAL_STEPS_FULL, `◆ Structuring ${findings.length} findings...`);
    synthesis = synthesizeFast(findings);
    synthesis.winner.confidence = Math.min(score.composite + 0.1, 1.0);
    await emit("info", "synthesizer", `◆ Fast synthesis — ${findings.length} findings structured (${Math.round(synthesis.winner.confidence * 100)}%)`);
  } else {
    await emit("info", "synthesizer", "◆ Asking Oracle to debate approaches...");
    synthesis = await synthesize(input.issue, files, findings, "", score);
    niaCalls += 1;
    const evidenceConfidence = score.composite;
    const oracleConfidence = synthesis.winner.confidence;
    synthesis.winner.confidence = Math.min(Math.max(evidenceConfidence, oracleConfidence * 0.8), 1.0);
  }

  await emit("info", "synthesizer", `✓ ${synthesis.winner.name} (${Math.round(synthesis.winner.confidence * 100)}%)`);
  if (synthesis.plan?.steps?.length > 0) {
    await emit("info", "synthesizer", `Plan: ${synthesis.plan.steps.length} steps, ${(synthesis.tests || []).length} tests`);
  }

  const synthesisEnd = Date.now();

  // ─── Phase 4: LEARN + ADVISOR (fire-and-forget) ──────
  // Don't block the response on learning or advisor verification.
  // Return immediately after synthesis. Knowledge gets stored in background.
  const learnStart = Date.now();

  // Fire-and-forget: learn, advisor, and auto-feedback all run after we return
  const backgroundWork = (async () => {
    try {
      const [storedKnowledge] = await Promise.all([
        learn(synthesis, findings),
        (depth === "quick" || depth === "auto") ? Promise.resolve() : (async () => {
          if (!synthesis.plan?.steps?.length) return;
          try {
            const planSummary = synthesis.plan.steps
              .map(s => `${s.action} ${s.file}: ${s.description}`)
              .join("\n");
            await verifyWithAdvisor({
              query: `Verify this implementation plan for: ${input.issue}\n\nPlan:\n${planSummary}`,
              dataSources: input.codebase_id ? [input.codebase_id] : undefined,
            });
          } catch {}
        })(),
      ]);
      if (storedKnowledge.length > 0) {
        log.info("Background learn complete", { stored: storedKnowledge.length });
      }
    } catch (err) {
      log.warn("Background learn/advisor failed", { error: String(err) });
    }

    // Auto-feedback
    if (recalledEntries && recalledEntries.length > 0) {
      const newDiscoveries = synthesis.novel_discoveries || [];
      autoFeedback(recalledEntries, newDiscoveries).catch(() => {});
    }
  })();
  backgroundWork.catch(() => {}); // Swallow unhandled rejection

  // ─── Phase 5: DELIVER (immediately after synthesis) ──
  const duration = Date.now() - start;
  await progress(6, TOTAL_STEPS_FULL,
    `✓ Done — ${findings.length} findings, ${niaCalls} calls, ${(duration / 1000).toFixed(0)}s`
  );
  await emit("info", "symposium", `Complete in ${(duration / 1000).toFixed(1)}s. ${niaCalls} Nia API calls. Learning continues in background.`);

  return {
    recalled: false,
    recalled_entries: 0,
    recalled_entry_ids: [],
    approach: {
      name: synthesis.winner.name,
      summary: synthesis.winner.summary,
      confidence: synthesis.winner.confidence,
      plan: {
        steps: synthesis.plan.steps,
        tests: synthesis.tests,
      },
      evidence: {
        oracle_findings: collected.oracleSummaries,
        tracer_examples: collected.tracerExamples,
        codebase_patterns: collected.codebasePatterns,
      },
    },
    learned: [],
    evidence_breakdown: collected.evidenceScore.breakdown,
    stats: {
      agents_spawned: dimensions.length,
      nia_calls: niaCalls,
      knowledge_entries_stored: 0, // Actual count unknown, learning is async
      knowledge_entries_recalled: 0,
      duration_ms: duration,
    },
    timing: {
      recall_ms: recallEnd - start,
      decompose_ms: decomposeEnd - decomposeStart,
      research_ms: researchEnd - researchStart,
      synthesis_ms: synthesisEnd - synthesisStart,
      learn_ms: Date.now() - learnStart, // Near-zero since fire-and-forget
    },
  };
}

/**
 * Fast path: generate a plan from recalled knowledge using a single Oracle call.
 * Skips decompose, spawn, collect. ~10x faster than full pipeline.
 */
async function runFastPath(
  issue: string,
  files: string[],
  entries: KnowledgeEntry[],
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const prompt = fastPathPrompt(issue, files, entries);

  try {
    const raw = await runOracle(prompt, { signal });
    const parsed = safeParseJSON<SynthesisResult>(raw);

    if (parsed?.winner) {
      // Boost confidence since we're using verified knowledge
      parsed.winner.confidence = Math.min((parsed.winner.confidence || 0.7) + 0.1, 1.0);
      if (!parsed.plan?.steps) parsed.plan = { steps: [] };
      if (!parsed.tests) parsed.tests = [];
      if (!parsed.novel_discoveries) parsed.novel_discoveries = [];
      return parsed;
    }
  } catch (err) {
    log.warn("Fast path Oracle call failed", { error: String(err) });
  }

  // Fallback: return the recalled knowledge as a basic plan
  return {
    winner: {
      name: "Recalled Knowledge (synthesis unavailable)",
      summary: entries.map(e => `${e.library}: use ${e.correct} (not ${e.mistake})`).join(". "),
      confidence: 0.6,
    },
    plan: {
      steps: entries.map(e => ({
        file: "see knowledge entries",
        action: "modify" as const,
        description: `${e.library}@${e.version}: ${e.correct}`,
        code_hint: e.correct,
      })),
    },
    tests: [],
    novel_discoveries: [],
  };
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Symposium cancelled by user.");
  }
}

/**
 * Extract library/package names from the issue text.
 * Looks for common patterns like "BetterAuth v3", "next.js 16", "@scope/package".
 *
 * Returns GitHub-compatible identifiers when possible (owner/repo format).
 * Falls back to npm package names.
 */
export function extractLibraryNames(issue: string): string[] {
  const libraries: string[] = [];
  const seen = new Set<string>();

  // Match @scope/package or package-name patterns near version indicators
  // e.g., "BetterAuth v3", "next.js 16", "@auth/core 2.0"
  const patterns = [
    // @scope/package
    /@[\w-]+\/[\w-]+/g,
    // Common library names followed by version
    /\b([\w.-]+)\s+v?\d+/gi,
    // Quoted package names
    /['"`]([\w@/.-]+)['"`]/g,
  ];

  for (const pattern of patterns) {
    const matches = issue.matchAll(pattern);
    for (const match of matches) {
      const name = (match[1] || match[0]).toLowerCase().replace(/^@/, "");
      // Filter out common false positives
      if (name.length < 2 || name.length > 50) continue;
      // Stop words: common English words that appear near numbers but aren't library names
      const stopWords = [
        "the", "this", "that", "with", "from", "step", "file", "code", "test",
        "line", "error", "version", "node", "page", "type", "data", "item",
        "index", "module", "class", "function", "const", "port", "route",
        "model", "table", "column", "field", "param", "arg", "option",
      ];
      if (stopWords.includes(name)) continue;

      if (!seen.has(name)) {
        seen.add(name);
        libraries.push(name);
      }
    }
  }

  // Cap at 3 to avoid excessive API calls
  return libraries.slice(0, 3);
}
