import { runOracle, runTracer, type OracleActivityCallback } from "../nia/client";
import { safeParseJSON } from "../nia/safe-parse";
import type { Dimension, Finding, DimensionType } from "../nia/types";
import { researchPrompt } from "../utils/prompts";
import { createLogger } from "../utils/logger";

const log = createLogger("spawner");

const JOB_TIMEOUT_MS = 600_000; // Oracle research jobs take 3-5 minutes. 10 min cap.
const MAX_FINDING_LENGTH_NOVEL = 3000;
const MAX_FINDING_LENGTH_DEFAULT = 1500;

/** Non-critical dimensions use Sonnet for 2-3x faster response. Core dimensions stay on Opus. */
const DIMENSION_MODEL: Partial<Record<DimensionType, string>> = {
  code_paths: "claude-sonnet-4-20250514",
  failure_modes: "claude-sonnet-4-20250514",
  existing_patterns: "claude-sonnet-4-20250514",
  test_strategy: "claude-sonnet-4-20250514",
};

/** Events emitted during agent execution for real-time UI updates */
export type SpawnerEvent =
  | { type: "batch_started"; batchNum: number; dimensions: string[] }
  | { type: "agent_started"; dimension: string; source: "oracle" | "tracer" }
  | { type: "agent_completed"; dimension: string; source: "oracle" | "tracer"; isNovel: boolean; durationMs: number }
  | { type: "agent_failed"; dimension: string; error: string }
  | { type: "agent_retrying"; dimension: string }
  | { type: "agent_activity"; dimension: string; activity: string };

export type SpawnerEventCallback = (event: SpawnerEvent) => Promise<void>;

function noopCallback(): Promise<void> { return Promise.resolve(); }

/** Dimensions that must complete before early synthesis can start */
const CRITICAL_DIMENSIONS: Set<DimensionType> = new Set(["api_correctness"]);

/**
 * Spawn parallel Oracle/Tracer agents for each dimension.
 * Fires all at once. Returns early when critical dimensions + N-1 total are done.
 * Late-arriving findings are returned as a promise for optional incorporation.
 * Retries failed agents once before giving up.
 */
export async function spawnAgents(
  dimensions: Dimension[],
  issue: string,
  files: string[],
  codebaseId?: string,
  externalSignal?: AbortSignal,
  onEvent?: SpawnerEventCallback,
): Promise<{ findings: Finding[]; niaCalls: number; lateFindings?: Promise<Finding[]> }> {
  const findings: Finding[] = [];
  let niaCalls = 0;
  const failed: Dimension[] = [];
  const emit = onEvent || noopCallback;

  log.info("Spawning agents", { count: dimensions.length });

  // Fire ALL agents at once. Oracle handles server-side queueing.
  await emit({ type: "batch_started", batchNum: 1, dimensions: dimensions.map(d => d.type) });

  const allResults = await runBatch(dimensions, issue, files, codebaseId, externalSignal, emit);
  niaCalls += allResults.niaCalls;

  for (const f of allResults.findings) findings.push(f);
  for (const f of allResults.failed) failed.push(f);

  // Retry failed agents once
  if (failed.length > 0 && failed.length <= 3) {
    for (const dim of failed) {
      await emit({ type: "agent_retrying", dimension: dim.type });
    }
    const retryResults = await runBatch(failed, issue, files, codebaseId, externalSignal, emit);
    niaCalls += retryResults.niaCalls;
    for (const f of retryResults.findings) findings.push(f);
  }

  if (findings.length === 0) {
    throw new Error("All research agents failed. Cannot proceed with synthesis.");
  }

  if (findings.length < 2) {
    log.warn("Only 1 agent returned results. Synthesis may be limited.", { count: findings.length });
  }

  log.info("All agents complete", { findings: findings.length, niaCalls });
  return { findings, niaCalls, lateFindings: allResults.lateFindings };
}

async function runBatch(
  batch: Dimension[],
  issue: string,
  files: string[],
  codebaseId: string | undefined,
  externalSignal: AbortSignal | undefined,
  emit: SpawnerEventCallback,
): Promise<{ findings: Finding[]; failed: Dimension[]; niaCalls: number; lateFindings?: Promise<Finding[]> }> {
  const findings: Finding[] = [];
  const failed: Dimension[] = [];
  let niaCalls = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  // Expand dual-mode dimensions into two jobs (Oracle + Tracer)
  type Job = { dim: Dimension; forceTracer?: boolean };
  const jobs: Job[] = [];
  for (const dim of batch) {
    if (dim.dualMode) {
      // Oracle pass: verify against docs
      jobs.push({ dim: { ...dim, usesTracer: false, dualMode: false } });
      // Tracer pass: find real implementations
      jobs.push({ dim: { ...dim, usesTracer: true, dualMode: false }, forceTracer: true });
    } else {
      jobs.push({ dim });
    }
  }

  // Emit start events for each job
  for (const job of jobs) {
    await emit({
      type: "agent_started",
      dimension: job.forceTracer ? `${job.dim.type}:tracer` : job.dim.type,
      source: job.dim.usesTracer ? "tracer" : "oracle",
    });
  }

  const startTimes = jobs.map(() => Date.now());

  // Track per-job completion for early synthesis
  const jobResults: (Finding | null)[] = new Array(jobs.length).fill(null);
  let completedCount = 0;
  let criticalDone = false;
  let earlyResolve: (() => void) | null = null;

  // Count how many critical jobs exist so we know when all critical are done
  const criticalJobCount = jobs.filter(j => CRITICAL_DIMENSIONS.has(j.dim.type)).length;
  let criticalCompleted = 0;

  const earlyPromise = new Promise<void>(resolve => { earlyResolve = resolve; });

  const jobPromises = jobs.map(async (job, i) => {
    try {
      const label = job.forceTracer ? `${job.dim.type}:tracer` : job.dim.type;
      const activityCb: OracleActivityCallback = (activity) => {
        emit({ type: "agent_activity", dimension: label, activity }).catch(() => {});
      };
      const result = await runDimension(job.dim, issue, files, codebaseId, controller.signal, activityCb);
      jobResults[i] = result;
      completedCount++;

      if (CRITICAL_DIMENSIONS.has(job.dim.type)) criticalCompleted++;
      criticalDone = criticalCompleted >= criticalJobCount;

      // Early resolve when: all critical dimensions done + at least N-1 total jobs done
      if (criticalDone && completedCount >= jobs.length - 1) {
        earlyResolve?.();
      }
    } catch (err) {
      completedCount++;
      // Still count toward early resolve threshold
      if (completedCount >= jobs.length - 1 && criticalDone) {
        earlyResolve?.();
      }
      throw err;
    }
  });

  // Wait for either all jobs OR early completion threshold
  const allDone = Promise.allSettled(jobPromises);
  await Promise.race([allDone, earlyPromise]);

  // Process all results that are available now
  const failedDimSet = new Set<string>();
  const lateJobIndices: number[] = [];

  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j]!;
    const result = jobResults[j];
    const durationMs = Date.now() - startTimes[j]!;
    const label = job.forceTracer ? `${job.dim.type}:tracer` : job.dim.type;

    if (result) {
      niaCalls++;
      findings.push(result);
      await emit({
        type: "agent_completed",
        dimension: label,
        source: result.source,
        isNovel: result.isNovel,
        durationMs,
      });
    } else if (completedCount >= jobs.length) {
      // Job finished but returned null or failed
      niaCalls++;
      await emit({ type: "agent_failed", dimension: label, error: "returned null or failed" });
      if (!job.forceTracer && !failedDimSet.has(job.dim.type)) {
        failedDimSet.add(job.dim.type);
        failed.push(job.dim);
      }
    } else {
      // Job still running (early completion path)
      lateJobIndices.push(j);
    }
  }

  // If we resolved early, create a promise for late-arriving findings
  let lateFindings: Promise<Finding[]> | undefined;
  if (lateJobIndices.length > 0) {
    log.info("Early completion: starting synthesis while waiting for late agents", {
      earlyFindings: findings.length,
      lateJobs: lateJobIndices.length,
    });

    lateFindings = (async () => {
      await allDone; // Wait for remaining jobs
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);

      const late: Finding[] = [];
      for (const j of lateJobIndices) {
        niaCalls++;
        const result = jobResults[j];
        const job = jobs[j]!;
        const durationMs = Date.now() - startTimes[j]!;
        const label = job.forceTracer ? `${job.dim.type}:tracer` : job.dim.type;

        if (result) {
          late.push(result);
          await emit({
            type: "agent_completed",
            dimension: label,
            source: result.source,
            isNovel: result.isNovel,
            durationMs,
          });
        } else {
          await emit({ type: "agent_failed", dimension: label, error: "returned null or failed" });
          if (!job.forceTracer && !failedDimSet.has(job.dim.type)) {
            failedDimSet.add(job.dim.type);
            failed.push(job.dim);
          }
        }
      }
      return late;
    })();
  } else {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  return { findings, failed, niaCalls, lateFindings };
}

async function runDimension(
  dim: Dimension,
  issue: string,
  files: string[],
  codebaseId: string | undefined,
  signal: AbortSignal,
  onActivity?: OracleActivityCallback,
): Promise<Finding | null> {
  const prompt = dim.usesTracer && dim.type === "api_correctness"
    ? `Find GitHub repositories that correctly use the APIs mentioned in this task. Focus on finding CURRENT, WORKING implementations. Task: ${issue.slice(0, 500)}`
    : researchPrompt(dim.type, issue, files);

  try {
    let rawResult: string;

    if (dim.usesTracer) {
      rawResult = await runTracer(prompt, { signal });
    } else {
      rawResult = await runOracle(prompt, {
        data_sources: codebaseId ? [codebaseId] : undefined,
        signal,
        model: DIMENSION_MODEL[dim.type],
        onActivity,
      });
    }

    return parseFinding(dim.type, dim.usesTracer ? "tracer" : "oracle", rawResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.includes("abort")) {
      log.warn(`Agent timed out: ${dim.type}`);
    } else {
      log.error(`Agent error: ${dim.type}`, { error: msg });
    }
    return null;
  }
}

function parseFinding(
  dimension: DimensionType,
  source: "oracle" | "tracer",
  raw: string,
): Finding {
  const parsed = safeParseJSON<Record<string, any>>(raw);

  // Novel findings get full length (3000) for learning loop. Non-novel get 1500 for faster synthesis.
  const isNovel = parsed?.is_novel === true;
  const maxLen = isNovel ? MAX_FINDING_LENGTH_NOVEL : MAX_FINDING_LENGTH_DEFAULT;
  const truncatedContent = raw.length > maxLen
    ? raw.slice(0, maxLen) + "\n... [truncated]"
    : raw;

  // Extract novel discovery fields. Some prompts put these at top level,
  // api_correctness also has them nested in incorrect_usages[0].
  let library = parsed?.library;
  let version = parsed?.version;
  let commonMistake = parsed?.common_mistake;
  let correctUsage = parsed?.correct_usage;

  // Fallback: try to extract from incorrect_usages array (api_correctness format)
  if (!library && parsed && parsed.incorrect_usages?.length > 0) {
    const first = parsed.incorrect_usages[0];
    library = library || first?.api;
    commonMistake = commonMistake || first?.model_would_write;
    correctUsage = correctUsage || first?.correct_usage;
  }

  const finding: Finding = {
    dimension,
    source,
    content: truncatedContent,
    isNovel: parsed?.is_novel === true,
    library,
    version,
    category: parsed?.category,
    commonMistake,
    correctUsage,
  };

  // Extract repo evidence from any finding that has it (Tracer or Oracle can mention repos)
  if (parsed?.repos) {
    finding.evidence = {
      source: source as "oracle" | "tracer",
      repos: Array.isArray(parsed.repos) ? parsed.repos.map((r: any) => typeof r === "string" ? r : r.name || String(r)) : [],
    };
  }

  return finding;
}
