/** Reasoning dimensions that agents can research */
export type DimensionType =
  | "code_paths"
  | "api_correctness"
  | "failure_modes"
  | "similar_solutions"
  | "existing_patterns"
  | "test_strategy";

export interface Dimension {
  type: DimensionType;
  /** Whether this dimension uses Tracer (GitHub search) vs Oracle */
  usesTracer: boolean;
  /** If true, dispatch BOTH Oracle AND Tracer for this dimension (stronger evidence) */
  dualMode?: boolean;
}

export interface Finding {
  dimension: DimensionType;
  source: "oracle" | "tracer";
  content: string;
  isNovel: boolean;
  library?: string;
  version?: string;
  category?: "api_change" | "deprecated" | "new_pattern" | "gotcha" | "breaking_change";
  commonMistake?: string;
  correctUsage?: string;
  evidence?: {
    source: "oracle" | "tracer" | "docs";
    url?: string;
    repos?: string[];
  };
}

export interface ConfidenceSignals {
  tracer_repo_count: number;
  advisor_verified: boolean;
  cross_validated: boolean;
  times_recalled_ok: number;
  times_contradicted: number;
}

export interface KnowledgeEntry {
  id: string;
  library: string;
  version: string;
  category: "api_change" | "deprecated" | "new_pattern" | "gotcha" | "breaking_change";
  mistake: string;
  correct: string;
  root_cause: string;
  confidence: number;
  confidence_signals: ConfidenceSignals;
  status: "active" | "superseded" | "deprecated";
  evidence: {
    source: "oracle" | "tracer" | "docs";
    url?: string;
    repos?: string[];
  };
  created_at: string;
  updated_at: string;
  times_used: number;
  last_used_at: string | null;
}

/** Fill defaults for old KnowledgeEntry JSON missing new fields */
export function fillKnowledgeDefaults(partial: Record<string, any>): KnowledgeEntry {
  return {
    id: partial.id || "unknown",
    library: partial.library || "unknown",
    version: partial.version || "unknown",
    category: partial.category || "api_change",
    mistake: partial.mistake || "",
    correct: partial.correct || "",
    root_cause: partial.root_cause || "",
    confidence: typeof partial.confidence === "number" ? partial.confidence : 0.5,
    confidence_signals: {
      tracer_repo_count: partial.confidence_signals?.tracer_repo_count ?? 0,
      advisor_verified: partial.confidence_signals?.advisor_verified ?? false,
      cross_validated: partial.confidence_signals?.cross_validated ?? false,
      times_recalled_ok: partial.confidence_signals?.times_recalled_ok ?? 0,
      times_contradicted: partial.confidence_signals?.times_contradicted ?? 0,
    },
    status: partial.status || "active",
    evidence: {
      source: partial.evidence?.source || "oracle",
      url: partial.evidence?.url,
      repos: partial.evidence?.repos,
    },
    created_at: partial.created_at || new Date().toISOString(),
    updated_at: partial.updated_at || partial.created_at || new Date().toISOString(),
    times_used: partial.times_used ?? 0,
    last_used_at: partial.last_used_at ?? null,
  };
}

export interface SynthesisResult {
  winner: {
    name: string;
    summary: string;
    confidence: number;
  };
  plan: {
    steps: Array<{
      file: string;
      action: "create" | "modify" | "delete";
      description: string;
      code_hint: string;
    }>;
  };
  tests: string[];
  novel_discoveries: Array<{
    library: string;
    version: string;
    mistake: string;
    correct: string;
    evidence_source: string;
    root_cause?: string;
  }>;
}

/** Callback for reporting progress during pipeline execution */
export type ProgressCallback = (progress: number, total: number, message: string) => Promise<void>;

/** Callback for sending real-time log messages to the client */
export type LogEmitter = (level: "info" | "warning" | "error", logger: string, data: string) => Promise<void>;

export interface SymposiumInput {
  issue: string;
  files?: string[];
  codebase_id?: string;
  depth?: "auto" | "quick" | "standard" | "deep";
  /** MCP abort signal for cancellation */
  signal?: AbortSignal;
  /** Progress reporting callback */
  onProgress?: ProgressCallback;
  /** Real-time log message emitter */
  onLog?: LogEmitter;
}

export interface SymposiumOutput {
  recalled: boolean;
  recalled_entries: number;
  approach: {
    name: string;
    summary: string;
    confidence: number;
    plan: {
      steps: Array<{
        file: string;
        action: "create" | "modify" | "delete";
        description: string;
        code_hint: string;
      }>;
      tests: string[];
    };
    evidence: {
      oracle_findings: string[];
      tracer_examples: string[];
      codebase_patterns: string[];
    };
  };
  learned: Array<{
    library: string;
    mistake: string;
    correct: string;
  }>;
  recalled_entry_ids: string[];
  evidence_breakdown: string;
  stats: {
    agents_spawned: number;
    nia_calls: number;
    knowledge_entries_stored: number;
    knowledge_entries_recalled: number;
    duration_ms: number;
  };
  /** Phase timing for demo visibility */
  timing?: {
    recall_ms: number;
    decompose_ms: number;
    research_ms: number;
    synthesis_ms: number;
    learn_ms: number;
  };
}

export const DEPTH_TO_AGENT_COUNT: Record<string, number> = {
  quick: 3,
  standard: 5,
  deep: 8,
};
