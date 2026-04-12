import type { Dimension, DimensionType } from "../nia/types";
import { createLogger } from "../utils/logger";

const log = createLogger("decomposer");

const TRACER_DIMS: DimensionType[] = ["similar_solutions"];

/**
 * Select reasoning dimensions based on depth mode.
 *
 * auto: Analyzes the issue to pick the minimum effective set.
 *       Fastest for benchmarks. 1-3 agents.
 * quick: 3 agents (api_correctness + similar_solutions + code_paths)
 * standard: 5 agents
 * deep: 6 agents
 */
export async function decompose(
  issue: string,
  _files: string[],
  depth: "auto" | "quick" | "standard" | "deep" = "quick",
): Promise<Dimension[]> {
  if (depth === "auto") {
    return autoDecompose(issue);
  }
  log.info("Using default dimensions", { depth });
  return getDefaultDimensions(depth);
}

/**
 * Auto mode: analyze the issue text and pick the minimum agents needed.
 *
 * Strategy:
 * - Always: api_correctness (Oracle, the core value)
 * - Always: similar_solutions (Tracer, fast GitHub search)
 * - Only if issue mentions existing code/files: code_paths
 * - Only if issue mentions errors/failures/security: failure_modes
 * - Dual-mode on api_correctness only if the issue names a specific library
 *
 * Result: 1 Oracle + 1-2 Tracer calls. ~3 min wall time.
 */
function autoDecompose(issue: string): Dimension[] {
  const lower = issue.toLowerCase();
  const dims: Dimension[] = [];

  // Does the issue name a specific library? If yes, dual-mode is worth it.
  const hasLibraryMention = /\b(v\d|version|library|package|api|sdk|import|require)\b/i.test(issue);

  // Core: api_correctness (always)
  dims.push({
    type: "api_correctness",
    usesTracer: false,
    dualMode: hasLibraryMention, // Only dual-mode if a library is mentioned
  });

  // Core: similar_solutions via Tracer (always, fast)
  dims.push({
    type: "similar_solutions",
    usesTracer: true,
  });

  // Optional: code_paths if the issue references existing code
  const mentionsCode = lower.includes("file") || lower.includes("existing") ||
    lower.includes("refactor") || lower.includes("modify") || lower.includes("change") ||
    lower.includes(".ts") || lower.includes(".js") || lower.includes(".py");
  if (mentionsCode) {
    dims.push({ type: "code_paths", usesTracer: false });
  }

  // Optional: failure_modes if the issue mentions errors or crashes (not just "auth" which is a library name)
  const mentionsFailures = lower.includes("error") || lower.includes("fail") ||
    lower.includes("security") || lower.includes("race") ||
    lower.includes("timeout") || lower.includes("crash") || lower.includes("bug");
  if (mentionsFailures) {
    dims.push({ type: "failure_modes", usesTracer: false });
  }

  log.info("Auto mode selected dimensions", {
    count: dims.length,
    dimensions: dims.map(d => d.type + (d.dualMode ? " (dual)" : "")),
    hasLibrary: hasLibraryMention,
  });

  return dims;
}

function getDefaultDimensions(depth: "auto" | "quick" | "standard" | "deep"): Dimension[] {
  const defaults: Record<string, DimensionType[]> = {
    auto: ["api_correctness", "similar_solutions"],
    quick: ["api_correctness", "similar_solutions", "code_paths"],
    standard: ["api_correctness", "similar_solutions", "code_paths", "failure_modes", "test_strategy"],
    deep: ["api_correctness", "similar_solutions", "code_paths", "failure_modes", "existing_patterns", "test_strategy"],
  };

  const selected = defaults[depth] ?? defaults.quick!;
  return selected.map(type => ({
    type,
    usesTracer: TRACER_DIMS.includes(type),
    dualMode: type === "api_correctness",
  }));
}
