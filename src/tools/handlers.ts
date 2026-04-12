import { searchContexts } from "../nia/client";
import { safeParseJSON } from "../nia/safe-parse";
import type { KnowledgeEntry, SymposiumOutput } from "../nia/types";
import { fillKnowledgeDefaults } from "../nia/types";

// ─── Error Formatting ───────────────────────────────────

export function formatError(message: string): string {
  const lm = message.toLowerCase();

  if (lm.includes("cancelled") || lm.includes("aborted")) {
    return "Symposium was cancelled.";
  }

  if (lm.includes("401") || lm.includes("unauthorized") || lm.includes("invalid key")) {
    return `Symposium auth error: ${message}\n\nYour NIA_API_KEY may be invalid or expired. Get a new key at https://app.trynia.ai/settings and update your MCP config.`;
  }

  if (lm.includes("429") || lm.includes("rate limit") || lm.includes("too many")) {
    return `Symposium rate limited: ${message}\n\nNia API rate limit hit. Wait 30 seconds and try again, or use depth: "quick" to reduce API calls.`;
  }

  if (lm.includes("timeout") || lm.includes("timed out") || lm.includes("timedout")) {
    return `Symposium timeout: ${message}\n\nOracle or Tracer took too long. Try again with depth: "quick" (3 agents instead of 5-8), or check if the Nia API is experiencing high load.`;
  }

  if (lm.includes("network") || lm.includes("econnrefused") || lm.includes("fetch failed") || lm.includes("dns")) {
    return `Symposium network error: ${message}\n\nCan't reach the Nia API. Check your internet connection. If using a VPN, try disabling it.`;
  }

  if (lm.includes("all research agents failed")) {
    return `Symposium research failed: ${message}\n\nNo agents returned results. This usually means the Nia API is having issues. Try again in a minute, or check API status.`;
  }

  if (lm.includes("empty response")) {
    return `Symposium got empty response: ${message}\n\nThe Nia API returned an empty result. This can happen with very short or unclear queries. Try rephrasing the issue with more detail about the specific library and what you're trying to do.`;
  }

  return `Symposium error: ${message}\n\nTry again or reduce depth to "quick".`;
}

// ─── Knowledge Lookup Handler ───────────────────────────

export async function handleKnowledgeLookup(args: Record<string, unknown> | undefined) {
  const query = typeof args?.query === "string" ? args.query : "";
  const limit = typeof args?.limit === "number" ? args.limit : 10;

  try {
    const searchQuery = query || "symposium-knowledge";
    const results = await searchContexts(searchQuery, limit);

    if (!results || results.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No knowledge entries found. Run the `symposium` tool first to discover and store knowledge.",
        }],
      };
    }

    const validEntries: { entry: KnowledgeEntry; raw: any }[] = [];
    for (const result of results) {
      const parsed = (() => { const p = safeParseJSON<Record<string, any>>(result.content || result.summary || ""); return p ? fillKnowledgeDefaults(p) : null; })();
      if (parsed?.library && parsed?.correct) {
        validEntries.push({ entry: parsed, raw: result });
      }
    }

    if (validEntries.length === 0) {
      return {
        content: [{
          type: "text",
          text: `Found ${results.length} context entries but none are valid Symposium knowledge. Run the \`symposium\` tool to discover and store knowledge.`,
        }],
      };
    }

    const s: string[] = [];
    s.push(`# Symposium Knowledge Base\n`);
    s.push(`**${validEntries.length} discoveries** stored across ${new Set(validEntries.map(e => e.entry.library)).size} libraries.\n`);

    const byLibrary = new Map<string, typeof validEntries>();
    for (const ve of validEntries) {
      const key = ve.entry.library;
      const group = byLibrary.get(key) || [];
      group.push(ve);
      byLibrary.set(key, group);
    }

    for (const [lib, libEntries] of byLibrary) {
      for (const { entry } of libEntries) {
        const confPct = Math.round((entry.confidence ?? 0.5) * 100);
        const statusBadge = entry.status === "deprecated" ? " [DEPRECATED]" : "";
        s.push(`## ${lib}@${entry.version || "?"} (${entry.category || "api_change"}) ${confPct}% confidence${statusBadge}`);
        s.push(`- **What models get wrong:** \`${entry.mistake}\``);
        s.push(`- **Correct usage:** \`${entry.correct}\``);
        if (entry.root_cause) {
          s.push(`- **Why:** ${entry.root_cause}`);
        }
        if (entry.evidence?.source) {
          const evidenceParts = [`Source: ${entry.evidence.source}`];
          if (entry.evidence.repos?.length) {
            evidenceParts.push(`Repos: ${entry.evidence.repos.join(", ")}`);
          }
          s.push(`- **Evidence:** ${evidenceParts.join(" | ")}`);
        }
        if (entry.times_used > 0) {
          s.push(`- **Used ${entry.times_used} time${entry.times_used > 1 ? "s" : ""}** | Confirmed: ${entry.confidence_signals?.times_recalled_ok ?? 0} | Contradicted: ${entry.confidence_signals?.times_contradicted ?? 0}`);
        }
        s.push("");
      }
    }

    s.push("---");
    const tracerCount = validEntries.filter(e => e.entry.evidence?.source === "tracer").length;
    s.push(`*${validEntries.length} entries | ${tracerCount} verified by GitHub repos | ${new Set(validEntries.map(e => e.entry.library)).size} libraries*`);

    return { content: [{ type: "text", text: s.join("\n") }] };
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `Failed to query knowledge base: ${(err as Error).message}`,
      }],
      isError: true,
    };
  }
}

// ─── Knowledge Export Handler ───────────────────────────

export async function handleKnowledgeExport(args: Record<string, unknown> | undefined) {
  const format = (typeof args?.format === "string" ? args.format : "jsonl") as "jsonl" | "markdown" | "training";

  try {
    const results = await searchContexts("symposium-knowledge", 50);

    if (!results || results.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No knowledge entries to export. Run the `symposium` tool first to discover and store knowledge.",
        }],
      };
    }

    const entries: KnowledgeEntry[] = [];
    for (const result of results) {
      const parsed = (() => { const p = safeParseJSON<Record<string, any>>(result.content || result.summary || ""); return p ? fillKnowledgeDefaults(p) : null; })();
      if (parsed?.library && parsed?.correct) {
        entries.push(parsed);
      }
    }

    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: "No valid knowledge entries found." }],
      };
    }

    if (format === "training") {
      // DPO-format: chosen/rejected pairs with reasoning for fine-tuning
      const lines = entries.map(e => JSON.stringify({
        system: `You are a coding assistant working with ${e.library}${e.version !== "unknown" ? ` v${e.version}` : ""}.`,
        prompt: `How do I use ${e.library}${e.version !== "unknown" ? ` v${e.version}` : ""} correctly?`,
        chosen: e.correct,
        chosen_reasoning: e.root_cause
          ? `${e.root_cause}. Verified by ${e.evidence?.source || "research"}${e.evidence?.repos?.length ? ` (${e.evidence.repos.length} repos)` : ""}.`
          : `Verified correct usage from ${e.evidence?.source || "research"}.`,
        rejected: e.mistake,
        rejected_reasoning: e.root_cause
          ? `Models write this because ${e.root_cause}. This is the ${e.category} pattern.`
          : `Common model mistake for ${e.library}. Category: ${e.category}.`,
        confidence: e.confidence,
        evidence: {
          source: e.evidence?.source,
          repos: e.evidence?.repos?.length || 0,
          cross_validated: e.confidence_signals?.cross_validated || false,
          times_confirmed: e.confidence_signals?.times_recalled_ok || 0,
        },
      }));

      const output = [
        `# Symposium DPO Training Export (${entries.length} entries)`,
        `# Format: DPO-compatible JSONL (chosen/rejected pairs with reasoning)`,
        `# Generated: ${new Date().toISOString()}`,
        `# Each entry has: system, prompt, chosen, chosen_reasoning, rejected, rejected_reasoning, confidence`,
        "",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text: output }] };

    } else if (format === "jsonl") {
      const lines = entries.map(e => JSON.stringify({
        library: e.library,
        version: e.version,
        category: e.category,
        prompt: `What is the correct way to use ${e.library}${e.version !== "unknown" ? ` v${e.version}` : ""}?`,
        wrong_completion: e.mistake,
        correct_completion: e.correct,
        evidence_source: e.evidence?.source,
        evidence_repos: e.evidence?.repos,
      }));

      const output = [
        `# Symposium Knowledge Export (${entries.length} entries)`,
        `# Format: JSONL (one JSON object per line)`,
        `# Generated: ${new Date().toISOString()}`,
        `# Use for fine-tuning: each entry has a prompt, wrong_completion, and correct_completion`,
        "",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text: output }] };
    } else {
      const s: string[] = [];
      s.push(`# Symposium Knowledge Export`);
      s.push(`**${entries.length} entries** | Generated: ${new Date().toISOString()}\n`);
      s.push(`> This dataset represents verified knowledge gaps in language models. Each entry documents something models consistently get wrong, with the correct answer verified from live documentation or real GitHub repositories.\n`);

      const withTracerEvidence = entries.filter(e => e.evidence?.source === "tracer").length;
      const withRepoEvidence = entries.filter(e => e.evidence?.repos && e.evidence.repos.length > 0).length;
      const categories = new Map<string, number>();
      const libraries = new Set<string>();
      for (const e of entries) {
        libraries.add(e.library);
        categories.set(e.category, (categories.get(e.category) || 0) + 1);
      }

      s.push("## Dataset Quality Metrics\n");
      s.push(`| Metric | Value |`);
      s.push(`|--------|-------|`);
      s.push(`| Total entries | ${entries.length} |`);
      s.push(`| Unique libraries | ${libraries.size} |`);
      s.push(`| Verified by Tracer (GitHub) | ${withTracerEvidence} (${Math.round(withTracerEvidence / entries.length * 100)}%) |`);
      s.push(`| With repo evidence | ${withRepoEvidence} (${Math.round(withRepoEvidence / entries.length * 100)}%) |`);
      for (const [cat, count] of categories) {
        s.push(`| Category: ${cat} | ${count} |`);
      }
      s.push("");
      s.push(`> **Training data quality**: ${withTracerEvidence} of ${entries.length} entries are backed by real GitHub repositories. These are the highest-quality corrections because they're verified against production code, not just documentation.\n`);

      const byLibrary = new Map<string, KnowledgeEntry[]>();
      for (const e of entries) {
        const group = byLibrary.get(e.library) || [];
        group.push(e);
        byLibrary.set(e.library, group);
      }

      for (const [lib, libEntries] of byLibrary) {
        s.push(`## ${lib} (${libEntries.length} entries)\n`);
        for (const e of libEntries) {
          s.push(`### ${e.category}: ${e.version}`);
          s.push(`| | |`);
          s.push(`|---|---|`);
          s.push(`| **Models write** | \`${e.mistake}\` |`);
          s.push(`| **Correct** | \`${e.correct}\` |`);
          s.push(`| **Evidence** | ${e.evidence?.source || "unknown"}${e.evidence?.repos?.length ? ` (${e.evidence.repos.join(", ")})` : ""} |`);
          s.push("");
        }
      }

      return { content: [{ type: "text", text: s.join("\n") }] };
    }
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `Failed to export knowledge: ${(err as Error).message}`,
      }],
      isError: true,
    };
  }
}

// ─── Output Formatting ──────────────────────────────────

export function formatOutput(result: SymposiumOutput): string {
  const s: string[] = [];
  const confPct = Math.round(result.approach.confidence * 100);

  if (result.recalled && result.stats.agents_spawned === 0) {
    s.push("# ⚡ Symposium — Instant Recall\n");
    s.push(`> ${result.recalled_entries} discoveries loaded from knowledge base. No research needed. ${(result.stats.duration_ms / 1000).toFixed(1)}s.\n`);
  } else if (result.recalled) {
    s.push("# ◆ Symposium Report\n");
    s.push(`> ${result.recalled_entries} prior discoveries applied.\n`);
  } else {
    s.push("# ◆ Symposium Report\n");
  }

  // ─── #9: TL;DR at top ─────────────────────────────────
  // The most actionable info first: file changes and code hints
  const steps = result.approach.plan?.steps || [];
  if (steps.length > 0) {
    s.push("## TL;DR\n");
    for (const step of steps) {
      const hint = step.code_hint ? `: \`${step.code_hint.split("\n")[0]}\`` : "";
      s.push(`- **${(step.action || "modify").toUpperCase()}** \`${step.file || "unknown"}\`${hint}`);
    }
    s.push("");
  }

  // ─── #14: Inline recalled knowledge ────────────────────
  // Show what was recalled so the agent sees it without a separate tool call
  if (result.recalled && result.recalled_entries > 0 && (result as any)._recalled_knowledge) {
    const recalled = (result as any)._recalled_knowledge as Array<{ library: string; version: string; mistake: string; correct: string }>;
    s.push("## Recalled Knowledge\n");
    for (const entry of recalled) {
      s.push(`- **${entry.library}@${entry.version}**: use \`${entry.correct}\` (not \`${entry.mistake}\`)`);
    }
    s.push("");
  }

  // ─── #13: Confidence threshold guidance ────────────────
  s.push(`## ${result.approach.name}`);
  s.push(`**Confidence:** ${confPct}%`);
  if (confPct < 40) {
    s.push(`> **Low confidence.** This plan may be unreliable. Verify each step against official documentation before implementing.`);
  } else if (confPct < 60) {
    s.push(`> **Moderate confidence.** Consider verifying critical API calls manually before implementing.`);
  }
  if (result.evidence_breakdown) {
    s.push(`**Evidence:** ${result.evidence_breakdown}`);
  }
  s.push("");
  s.push(result.approach.summary);
  s.push("");

  if (steps.length > 0) {
    s.push("## Implementation Plan\n");
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      s.push(`### Step ${i + 1}: ${(step.action || "modify").toUpperCase()} \`${step.file || "unknown"}\``);
      s.push(step.description || "No description provided.");
      if (step.code_hint) {
        const ext = (step.file || "").split(".").pop() || "";
        const langMap: Record<string, string> = { ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", py: "python", rs: "rust" };
        const lang = langMap[ext] || "";
        s.push(`\`\`\`${lang}\n${step.code_hint}\n\`\`\``);
      }
      s.push("");
    }
  }

  const tests = result.approach.plan?.tests || [];
  if (tests.length > 0) {
    s.push("## Tests to Write\n");
    for (const test of tests) {
      s.push(`- [ ] ${test}`);
    }
    s.push("");
  }

  const tracerExamples = result.approach.evidence?.tracer_examples || [];
  if (tracerExamples.length > 0) {
    s.push("## ⌕ Evidence from Production Repos\n");
    for (const ex of tracerExamples) {
      s.push(`- ${ex}`);
    }
    s.push("");
  }

  if (result.learned && result.learned.length > 0) {
    s.push("## ★ Novel Knowledge Stored\n");
    s.push("> Stored in knowledge base. Future runs recall these instantly.\n");
    for (const entry of result.learned) {
      s.push(`**${entry.library}**`);
      s.push(`- Models typically write: \`${entry.mistake}\``);
      s.push(`- Correct usage: \`${entry.correct}\``);
      s.push("");
    }
  }

  // Feedback reminder for recalled entries
  if (result.recalled_entry_ids && result.recalled_entry_ids.length > 0) {
    s.push("> **Feedback requested:** After implementing this plan, call `symposium_feedback` with the recalled_entry_ids to report whether the knowledge was correct.\n");
  }

  s.push("---");
  const parts: string[] = [];
  if (result.stats.agents_spawned > 0) parts.push(`${result.stats.agents_spawned} agents`);
  parts.push(`${result.stats.nia_calls} API calls`);
  if (result.stats.knowledge_entries_stored > 0) parts.push(`${result.stats.knowledge_entries_stored} stored`);
  if (result.stats.knowledge_entries_recalled > 0) parts.push(`${result.stats.knowledge_entries_recalled} recalled`);
  parts.push(`${(result.stats.duration_ms / 1000).toFixed(0)}s`);
  s.push(`*${parts.join(" · ")}*`);

  if (result.timing) {
    const t = result.timing;
    const phases: string[] = [];
    if (t.recall_ms > 100) phases.push(`recall ${(t.recall_ms / 1000).toFixed(0)}s`);
    if (t.research_ms > 100) phases.push(`research ${(t.research_ms / 1000).toFixed(0)}s`);
    if (t.synthesis_ms > 100) phases.push(`synthesis ${(t.synthesis_ms / 1000).toFixed(0)}s`);
    if (phases.length > 0) s.push(`*${phases.join(" → ")}*`);
  }

  // ─── #10: Machine-readable JSON for agent parsing ──────
  // Embed the raw structured data as an HTML comment so the agent
  // can parse it without losing the human-readable markdown above
  try {
    s.push("");
    s.push(`<!-- SYMPOSIUM_JSON: ${JSON.stringify(result)} -->`);
  } catch {
    // JSON serialization failed, skip the structured data
  }

  return s.join("\n");
}
