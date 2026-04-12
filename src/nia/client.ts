import { NiaSDK } from "nia-ai-ts";
import {
  OpenAPI,
  V2ApiContextsService,
  GithubSearchService,
  AdvisorService,
  V2ApiSearchService,
  V2ApiSourcesService,
} from "nia-ai-ts";
import type {
  ContextShareRequest,
  ContextSemanticSearchResponse,
  AdvisorRequest,
  AdvisorResponse,
} from "nia-ai-ts";
import { createLogger } from "../utils/logger";

const log = createLogger("nia-client");

let sdk: NiaSDK | null = null;

/** Initialize Nia SDK. Do NOT override OpenAPI.BASE after this, the constructor sets it correctly. */
export function initNia(apiKey: string): NiaSDK {
  sdk = new NiaSDK({ apiKey });
  if (OpenAPI.TOKEN !== apiKey) OpenAPI.TOKEN = apiKey;
  log.info("Nia SDK initialized", { base: OpenAPI.BASE });
  return sdk;
}

function getSDK(): NiaSDK {
  if (!sdk) throw new Error("Nia SDK not initialized. Call initNia() first.");
  return sdk;
}

// ─── Oracle ──────────────────────────────────────────────────

async function createOracleJob(query: string, options?: {
  repositories?: string[];
  data_sources?: string[];
  model?: string;
}): Promise<string> {
  const s = getSDK();
  const job = await s.oracle.createJob({
    query,
    repositories: options?.repositories,
    data_sources: options?.data_sources,
    output_format: "markdown",
    model: options?.model || "claude-opus-4-6",
  });

  const jobId = job.id || job.job_id;
  if (!jobId) {
    throw new Error(`Oracle job creation returned no job ID. Response: ${JSON.stringify(job).slice(0, 200)}`);
  }

  log.info("Oracle job created", { jobId });
  return jobId;
}

/**
 * Wait for an Oracle job to complete. Tries streaming first for lower latency,
 * falls back to polling if streaming fails.
 */
async function waitForOracle(jobId: string, timeoutMs = 600_000, onActivity?: OracleActivityCallback): Promise<string> {
  const s = getSDK();

  // Try streaming first (real-time activity + lower latency)
  try {
    return await streamOracleResult(s, jobId, timeoutMs, onActivity);
  } catch (streamErr) {
    log.debug("Streaming failed, falling back to polling", { jobId, error: String(streamErr) });
  }

  // Fallback: polling
  const result = await s.oracle.waitForJob(jobId, timeoutMs, 3000);
  return extractOracleAnswer(jobId, result);
}

/**
 * Stream Oracle job results via SSE. Returns the answer from the final event.
 */
const ACTIVITY_LABELS: Record<string, string> = {
  doc_grep: "⌕ searching docs",
  doc_tree: "◌ browsing doc tree",
  doc_read: "▸ reading page",
  run_web_search: "⌕ web search",
  list_sources: "◌ finding sources",
  finish: "◆ writing report",
};

async function streamOracleResult(s: NiaSDK, jobId: string, timeoutMs: number, onActivity?: OracleActivityCallback): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastEvent: Record<string, unknown> | null = null;

  for await (const event of s.oracle.streamJob(jobId)) {
    lastEvent = event;

    // Forward activity events to the callback
    if (onActivity) {
      const type = String(event.type ?? "");
      if (type === "tool_start") {
        const action = String((event as any).action ?? "");
        const label = ACTIVITY_LABELS[action] || action;
        onActivity(label);
      } else if (type === "tool_progress") {
        const msg = String((event as any).message ?? "");
        if (msg) onActivity(msg.toLowerCase());
      } else if (type === "generating_report") {
        onActivity("synthesizing findings into report");
      } else if (type === "iteration_start") {
        const iter = (event as any).iteration;
        if (iter) onActivity(`thinking (iteration ${iter})`);
      }
    }

    // Check for terminal states
    const type = String(event.type ?? "");
    if (type === "complete") {
      const result = (event as any).result;
      if (result && typeof result === "object") {
        return extractOracleAnswer(jobId, result as Record<string, unknown>);
      }
      // If complete event doesn't have result, fetch it
      const finalJob = await s.oracle.getJob(jobId);
      return extractOracleAnswer(jobId, finalJob);
    }

    const status = String(event.status ?? "");
    if (status === "completed" || status === "done") {
      return extractOracleAnswer(jobId, event);
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      const errMsg = String(event.error || event.message || "unknown error");
      throw new Error(`Oracle job ${jobId} failed: ${errMsg}`);
    }

    if (Date.now() > deadline) {
      throw new Error(`Oracle stream timed out after ${timeoutMs}ms`);
    }
  }

  // Stream ended without terminal event. Try to extract from last event.
  if (lastEvent) {
    return extractOracleAnswer(jobId, lastEvent);
  }
  throw new Error(`Oracle stream ended without result for job ${jobId}`);
}

function extractOracleAnswer(jobId: string, result: Record<string, unknown>): string {
  const status = String(result.status ?? "");
  if (status === "failed" || status === "error") {
    const errMsg = String(result.error || result.message || "unknown error");
    throw new Error(`Oracle job ${jobId} failed: ${errMsg}`);
  }

  const answer = (result as any).final_report || (result as any).answer || (result as any).result;
  if (!answer) {
    log.warn("Oracle response missing final_report/answer/result field", { jobId, keys: Object.keys(result) });
    const fallback = JSON.stringify(result);
    if (fallback === "{}" || fallback === "null") {
      throw new Error(`Oracle job ${jobId} returned empty response`);
    }
    return fallback;
  }

  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

/** Callback for Oracle streaming activity updates */
export type OracleActivityCallback = (activity: string) => void;

export async function runOracle(query: string, options?: {
  repositories?: string[];
  data_sources?: string[];
  signal?: AbortSignal;
  model?: string;
  onActivity?: OracleActivityCallback;
}): Promise<string> {
  const jobId = await createOracleJob(query, options);

  if (options?.signal) {
    return new Promise<string>((resolve, reject) => {
      const sig = options.signal!;
      if (sig.aborted) {
        reject(new Error("Oracle job aborted"));
        return;
      }
      const onAbort = () => reject(new Error("Oracle job aborted"));
      sig.addEventListener("abort", onAbort, { once: true });
      waitForOracle(jobId, 600_000, options.onActivity)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          try { sig.removeEventListener("abort", onAbort); } catch {}
        });
    });
  }

  return waitForOracle(jobId, 600_000, options?.onActivity);
}

// ─── Tracer (GitHub code search agent) ──────────────────────

async function createTracerJob(query: string, options?: {
  repositories?: string[];
  mode?: "tracer-fast" | "tracer-deep";
}): Promise<string> {
  const result = await GithubSearchService.createTracerJobV2GithubTracerPost({
    query,
    repositories: options?.repositories,
    mode: options?.mode || "tracer-fast",
  });

  const jobId = result.job_id || result.id;
  if (!jobId) {
    throw new Error(`Tracer job creation returned no job ID. Response: ${JSON.stringify(result).slice(0, 200)}`);
  }

  log.info("Tracer job created", { jobId });
  return jobId;
}

async function waitForTracer(jobId: string, timeoutMs = 90_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await GithubSearchService.getTracerJobV2GithubTracerJobIdGet(jobId);
    const status = resp.status;

    // Terminal success states
    if (status === "completed" || status === "done") {
      return resp.result || resp.answer || JSON.stringify(resp);
    }

    // Terminal failure states
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Tracer job failed (${status}): ${resp.error || "unknown"}`);
    }

    // Known in-progress states: keep polling
    // Unknown states: log warning but keep polling (might be a new status we don't know about)
    if (status !== "pending" && status !== "queued" && status !== "running" && status !== "in_progress") {
      log.warn("Tracer job in unknown status, continuing to poll", { jobId, status });
    }

    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Tracer job timed out after ${timeoutMs}ms`);
}

export async function runTracer(query: string, options?: {
  repositories?: string[];
  signal?: AbortSignal;
}): Promise<string> {
  const jobId = await createTracerJob(query, { repositories: options?.repositories });

  if (options?.signal) {
    return new Promise<string>((resolve, reject) => {
      const sig = options.signal!;
      if (sig.aborted) {
        reject(new Error("Tracer job aborted"));
        return;
      }
      const onAbort = () => reject(new Error("Tracer job aborted"));
      sig.addEventListener("abort", onAbort, { once: true });
      waitForTracer(jobId)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          try { sig.removeEventListener("abort", onAbort); } catch {}
        });
    });
  }

  return waitForTracer(jobId);
}

// ─── Context Sharing (Learning Loop) ────────────────────────

export async function saveContext(params: {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  memory_type?: "scratchpad" | "episodic" | "fact" | "procedural";
  metadata?: Record<string, any>;
}): Promise<string> {
  const request: ContextShareRequest = {
    title: params.title,
    summary: params.summary,
    content: params.content,
    tags: [...params.tags, "symposium"],
    agent_source: "symposium",
    memory_type: params.memory_type || "fact",
    metadata: params.metadata,
  };
  const result = await V2ApiContextsService.saveContextV2V2ContextsPost(request);
  const id = (result as any).id || (result as any).context_id;
  log.info("Context saved", { id, title: params.title });
  return id;
}

export async function searchContexts(query: string, limit = 5): Promise<any[]> {
  try {
    const response: ContextSemanticSearchResponse =
      await V2ApiContextsService.semanticSearchContextsV2V2ContextsSemanticSearchGet(
        query, limit, false
      );
    return response.results || [];
  } catch (err) {
    log.warn("Semantic search failed, falling back to text search", { error: String(err) });
    try {
      const fallback = await V2ApiContextsService.searchContextsV2V2ContextsSearchGet(
        query, limit, undefined, "symposium"
      );
      return (fallback as any).contexts || [];
    } catch {
      return [];
    }
  }
}

// ─── Context Update (Feedback Loop) ─────────────────────────

export async function updateContext(contextId: string, params: {
  content?: string;
  metadata?: Record<string, any>;
  summary?: string;
}): Promise<void> {
  try {
    await V2ApiContextsService.updateContextV2V2ContextsContextIdPut(contextId, {
      content: params.content ?? null,
      metadata: params.metadata ?? null,
      summary: params.summary ?? null,
    });
    log.info("Context updated", { contextId });
  } catch (err) {
    log.warn("Failed to update context", { contextId, error: String(err) });
  }
}

export async function getContext(contextId: string): Promise<any | null> {
  try {
    const result = await V2ApiContextsService.getContextV2V2ContextsContextIdGet(contextId);
    return result;
  } catch (err) {
    log.warn("Failed to get context", { contextId, error: String(err) });
    return null;
  }
}

// ─── Advisor (Code Verification) ────────────────────────────

export async function verifyWithAdvisor(params: {
  query: string;
  files?: Record<string, string>;
  dependencies?: Record<string, string>;
  dataSources?: string[];
}): Promise<{ advice: string; sourcesSearched: number }> {
  try {
    const request: AdvisorRequest = {
      query: params.query,
      codebase: {
        files: params.files,
        dependencies: params.dependencies,
      },
      search_scope: params.dataSources ? { data_sources: params.dataSources } : undefined,
      output_format: "checklist",
    };

    const result: AdvisorResponse = await AdvisorService.analyzeCodebaseV2AdvisorPost(request);
    const advice = (result as any).advice || (result as any).answer || JSON.stringify(result);
    const sourcesSearched = (result as any).sources_searched || 0;

    log.info("Advisor verification complete", { sourcesSearched });
    return { advice: typeof advice === "string" ? advice : JSON.stringify(advice), sourcesSearched };
  } catch (err) {
    log.warn("Advisor verification failed", { error: String(err) });
    return { advice: "", sourcesSearched: 0 };
  }
}

// ─── Search (Fast Code Search) ──────────────────────────────

export async function searchCode(params: {
  query: string;
  dataSources?: string[];
  repositories?: string[];
  fastMode?: boolean;
}): Promise<string> {
  try {
    const result = await V2ApiSearchService.unifiedSearchV2V2SearchPost({
      messages: [{ role: "user", content: params.query }],
      data_sources: params.dataSources?.map(id => id),
      repositories: params.repositories?.map(r => r),
      search_mode: "unified",
      fast_mode: params.fastMode ?? true,
      skip_llm: params.fastMode ?? true,
      include_sources: true,
      mode: "query",
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    log.warn("Code search failed", { error: String(err) });
    return "";
  }
}

// ─── Auto-Subscribe (Index Dependencies) ────────────────────

export async function subscribeDependency(url: string, sourceType?: "repository" | "documentation"): Promise<string | null> {
  try {
    const result = await V2ApiSourcesService.subscribeSourceV2SourcesSubscribePost({
      url,
      source_type: sourceType || "documentation",
    });
    const sourceId = (result as any).global_source_id || (result as any).local_reference_id || (result as any).id;
    log.info("Subscribed to dependency", { url, sourceId });
    return sourceId;
  } catch (err) {
    log.warn("Failed to subscribe to dependency", { url, error: String(err) });
    return null;
  }
}

export async function resolveSource(identifier: string): Promise<{ id: string; status: string } | null> {
  try {
    const result = await V2ApiSourcesService.resolveSourceV2SourcesResolveGet(identifier);
    return {
      id: (result as any).id || (result as any).source_id || "",
      status: (result as any).status || "unknown",
    };
  } catch {
    return null;
  }
}

// ─── Health Check ────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    await V2ApiContextsService.listContextsV2V2ContextsGet(1, 0);
    return true;
  } catch (err) {
    log.error("Health check failed", { error: String(err) });
    return false;
  }
}

// ─── Oracle Warmup ──────────────────────────────────────────

/**
 * Pre-warm the Oracle inference backend with a tiny throwaway query.
 * LLM serving infra has cold starts (3-8s). Running this at server startup
 * ensures the first real query doesn't pay the cold-start penalty.
 * Fire-and-forget: never blocks startup.
 */
export async function warmupOracle(): Promise<void> {
  try {
    const s = getSDK();
    const job = await s.oracle.createJob({
      query: "ping",
      output_format: "markdown",
      model: "claude-opus-4-6",
    });
    const jobId = job.id || job.job_id;
    if (jobId) {
      // Don't wait for completion. Just creating the job warms the routing.
      // The job will complete on its own and be discarded.
      log.info("Oracle warmup job sent", { jobId });
    }
  } catch (err) {
    log.debug("Oracle warmup failed (non-critical)", { error: String(err) });
  }
}
