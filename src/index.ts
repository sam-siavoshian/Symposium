import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initNia, healthCheck, warmupOracle } from "./nia/client";
import { runSymposium } from "./tools/symposium";
import { handleKnowledgeLookup, handleKnowledgeExport, formatOutput, formatError } from "./tools/handlers";
import { recordExplicitFeedback } from "./engine/feedback";
import type { SymposiumInput } from "./nia/types";
import { createLogger } from "./utils/logger";

const log = createLogger("server");

// ─── Environment ────────────────────────────────────────

const NIA_API_KEY = process.env.NIA_API_KEY;
let niaInitialized = false;

if (NIA_API_KEY) {
  initNia(NIA_API_KEY);
  niaInitialized = true;
  // Pre-warm Oracle inference backend to eliminate cold-start on first real query
  warmupOracle().catch(() => {});
} else {
  log.error("NIA_API_KEY not set. Tools will return errors until the key is provided.");
}

function ensureNia(): string | null {
  if (!niaInitialized) {
    return "Symposium is not configured. Set the NIA_API_KEY environment variable and restart. Get a key at https://app.trynia.ai/settings";
  }
  return null;
}

// ─── MCP Server ──────────────────────────────────────────

const server = new Server(
  {
    name: "symposium",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  },
);

// ─── List Tools ──────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "symposium",
        description: [
          "Multi-agent research engine that makes you smarter. Spawns parallel Nia-powered agents to research a coding task from multiple angles, then synthesizes findings into a verified plan.",
          "",
          "USE THIS TOOL WHEN:",
          "- You need to use an API or library you're not 100% sure about (it may have changed since your training data)",
          "- The user asks you to implement something involving a specific library version (e.g., 'add BetterAuth v3 session management')",
          "- You're about to write code that calls an external API and want to verify the current correct usage",
          "- You hit an error that suggests you used a deprecated or changed API",
          "- The user asks you to research how to implement something before coding it",
          "",
          "DO NOT USE when: the task is pure logic/algorithms with no external dependencies, or for simple file operations.",
          "",
          "The tool learns from every run. If it has researched a similar problem before, it returns instantly from stored knowledge.",
          "",
          "FEEDBACK LOOP: If the response includes `recalled_entry_ids`, call `symposium_feedback` AFTER the user confirms the implementation works (or after tests pass) to report whether the recalled knowledge was correct. This makes future recalls more accurate.",
        ].join("\n"),
        inputSchema: {
          type: "object" as const,
          properties: {
            issue: {
              type: "string",
              description:
                "Describe the coding task from the user's perspective. Include: what library/API is involved, what version if known, what the user wants to achieve. Example: 'Add BetterAuth v3 session management to this Next.js app. Currently using createAuth() from v2 but the session API changed in v3.'",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "File paths that are relevant to the task. Include the files that need to change and any config files.",
            },
            codebase_id: {
              type: "string",
              description:
                "Nia source ID of the indexed codebase. If the user has indexed their project in Nia, pass the source ID here for codebase-aware research.",
            },
            depth: {
              type: "string",
              enum: ["auto", "quick", "standard", "deep"],
              description:
                "Research depth. auto (default): analyzes the issue and picks minimum agents needed (fastest). quick: 3 agents. standard: 5 agents. deep: 6 agents. Use auto for most tasks.",
              default: "auto",
            },
          },
          required: ["issue"],
        },
      },
      {
        name: "symposium_knowledge",
        description: [
          "List knowledge that Symposium has learned from previous research runs.",
          "Each entry represents a verified discovery: something that models typically get wrong, and the correct usage found from live documentation or real GitHub repos.",
          "",
          "USE THIS TOOL WHEN:",
          "- The user asks 'what has Symposium learned?' or 'what do you know about X library?'",
          "- You want to check if Symposium already has knowledge about a library before running full research",
          "- After a symposium run, to show the user what was stored",
        ].join("\n"),
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Search query to filter knowledge entries. Pass the library name for best results (e.g. 'betterauth', 'next.js'). If omitted, lists all recent entries.",
            },
            limit: {
              type: "number",
              description: "Max entries to return (default: 10)",
              default: 10,
            },
          },
        },
      },
      {
        name: "symposium_export",
        description: [
          "Export the Symposium knowledge base as structured training data.",
          "Returns all stored knowledge entries in a format suitable for fine-tuning: each entry has a 'mistake' (what models get wrong) and 'correct' (the verified right answer), with evidence sources.",
          "",
          "USE THIS TOOL WHEN:",
          "- The user asks to export or download the knowledge base",
          "- The user wants to see all discoveries in a machine-readable format",
          "- For generating fine-tuning data from Symposium's discoveries",
        ].join("\n"),
        inputSchema: {
          type: "object" as const,
          properties: {
            format: {
              type: "string",
              enum: ["jsonl", "markdown", "training"],
              description: "Export format. jsonl: basic export. markdown: human-readable report. training: DPO-format with chosen/rejected pairs and reasoning for fine-tuning.",
              default: "jsonl",
            },
          },
        },
      },
      {
        name: "symposium_feedback",
        description: [
          "Provide feedback on recalled knowledge to improve future accuracy.",
          "",
          "WHEN TO CALL: After the user confirms the implementation works, or after tests pass. Do NOT call immediately after generating code. Wait for verification.",
          "",
          "USE THIS TOOL WHEN:",
          "- You implemented code using Symposium's recalled knowledge and the user confirmed it works (outcome: correct)",
          "- The implementation failed or needed changes (outcome: incorrect)",
          "- It partially worked but needed adjustments (outcome: partial)",
          "- The recalled_entry_ids from a previous symposium call are available",
        ].join("\n"),
        inputSchema: {
          type: "object" as const,
          properties: {
            knowledge_id: {
              type: "string",
              description: "The knowledge entry ID (from recalled_entry_ids in the symposium output).",
            },
            outcome: {
              type: "string",
              enum: ["correct", "incorrect", "partial"],
              description: "Was the recalled knowledge correct? correct: it worked. incorrect: it was wrong. partial: partially right.",
            },
            detail: {
              type: "string",
              description: "Optional detail about what happened.",
            },
          },
          required: ["knowledge_id", "outcome"],
        },
      },
    ],
  };
});

// ─── Call Tool ───────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  // Check Nia is configured before any tool call
  const niaError = ensureNia();
  if (niaError) {
    return { content: [{ type: "text", text: niaError }], isError: true };
  }

  // ─── symposium_feedback tool ───────────────────────────
  if (name === "symposium_feedback") {
    const typedArgs = args as Record<string, unknown> | undefined;
    const knowledgeId = typeof typedArgs?.knowledge_id === "string" ? typedArgs.knowledge_id : "";
    const outcome = typedArgs?.outcome as "correct" | "incorrect" | "partial";
    const detail = typeof typedArgs?.detail === "string" ? typedArgs.detail : undefined;

    if (!knowledgeId || !outcome) {
      return { content: [{ type: "text", text: "Missing required parameters: knowledge_id and outcome" }], isError: true };
    }

    const result = await recordExplicitFeedback(knowledgeId, outcome, detail);
    if (result.success) {
      return {
        content: [{
          type: "text",
          text: `Feedback recorded. Knowledge entry updated.\n- Outcome: ${outcome}\n- New confidence: ${Math.round((result.newConfidence || 0) * 100)}%\n- Status: ${result.newStatus || "active"}${detail ? `\n- Detail: ${detail}` : ""}`,
        }],
      };
    }
    return { content: [{ type: "text", text: "Failed to record feedback. The knowledge entry may not exist." }], isError: true };
  }

  // ─── symposium_knowledge tool ─────────────────────────
  if (name === "symposium_knowledge") {
    return handleKnowledgeLookup(args as Record<string, unknown> | undefined);
  }

  // ─── symposium_export tool ────────────────────────────
  if (name === "symposium_export") {
    return handleKnowledgeExport(args as Record<string, unknown> | undefined);
  }

  if (name !== "symposium") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const progressToken = request.params._meta?.progressToken;

  // Validate and extract arguments
  const typedArgs = args as Record<string, unknown> | undefined;
  const rawIssue = typedArgs?.issue;
  const rawFiles = typedArgs?.files;
  const rawCodebaseId = typedArgs?.codebase_id;
  const rawDepth = typedArgs?.depth;

  if (typeof rawIssue !== "string" || rawIssue.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Missing or invalid required parameter: issue (must be a non-empty string)" }],
      isError: true,
    };
  }

  const validDepths = ["auto", "quick", "standard", "deep"] as const;
  const depth = (typeof rawDepth === "string" && validDepths.includes(rawDepth as any))
    ? (rawDepth as "auto" | "quick" | "standard" | "deep")
    : "auto";

  const input: SymposiumInput = {
    issue: rawIssue,
    files: Array.isArray(rawFiles) ? rawFiles.filter((f): f is string => typeof f === "string") : undefined,
    codebase_id: typeof rawCodebaseId === "string" ? rawCodebaseId : undefined,
    depth,
    signal: extra.signal,

    // Progress notifications (numbered steps: 1/6, 2/6...)
    onProgress: async (progress: number, total: number, message: string) => {
      if (progressToken !== undefined) {
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total, message },
          });
        } catch (e) {
          log.debug("Failed to send progress notification", { error: String(e) });
        }
      }
      log.info(`[${progress}/${total}] ${message}`);
    },

    // Real-time log messages (detailed per-agent events)
    onLog: async (level: "info" | "warning" | "error", logger: string, data: string) => {
      try {
        await server.sendLoggingMessage({
          level,
          logger: `symposium/${logger}`,
          data,
        });
      } catch (e) {
        log.debug("Failed to send log message", { error: String(e) });
      }
      // Also to stderr
      if (level === "error") {
        log.error(`[${logger}] ${data}`);
      } else if (level === "warning") {
        log.warn(`[${logger}] ${data}`);
      } else {
        log.info(`[${logger}] ${data}`);
      }
    },
  };

  try {
    log.info("Symposium tool called", { issue: input.issue.slice(0, 100), depth: input.depth });
    const result = await runSymposium(input);
    const output = formatOutput(result);
    return { content: [{ type: "text", text: output }] };
  } catch (err) {
    const message = (err as Error).message || String(err);
    log.error("Symposium tool failed", { error: message });

    return {
      content: [{ type: "text", text: formatError(message) }],
      isError: true,
    };
  }
});


// ─── Start ───────────────────────────────────────────────

async function main() {
  log.info("Symposium MCP server starting...");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Symposium MCP server connected via stdio");

  // Send startup notification so Claude Code knows we're ready
  try {
    if (niaInitialized) {
      const healthy = await healthCheck();

      // Check knowledge base size for the startup message
      let knowledgeCount = 0;
      try {
        const { searchContexts } = await import("./nia/client");
        const entries = await searchContexts("symposium-knowledge", 50);
        knowledgeCount = entries?.length || 0;
      } catch {
        // Non-critical, just don't show the count
      }

      const knowledgeLine = knowledgeCount > 0
        ? `${knowledgeCount} knowledge entries in memory (use symposium_knowledge to browse).`
        : "No prior knowledge stored yet. First research run will start building the knowledge base.";

      await server.sendLoggingMessage({
        level: healthy ? "info" : "warning",
        logger: "symposium",
        data: healthy
          ? [
            "Symposium ready. Nia API connected.",
            `4 tools: symposium (research), symposium_knowledge (browse), symposium_export (training data), symposium_feedback (improve accuracy).`,
            knowledgeLine,
          ].join(" ")
          : "Symposium started but Nia API health check failed. Tools may not work correctly.",
      });
    } else {
      await server.sendLoggingMessage({
        level: "error",
        logger: "symposium",
        data: "Symposium started but NIA_API_KEY is not set. Tools will not work. Set the env var and restart. Get a key at https://app.trynia.ai/settings",
      });
    }
  } catch {
    // Notification failed, not critical. Server is still running.
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
