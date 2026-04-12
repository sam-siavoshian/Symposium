# Symposium

Multi-agent reasoning engine. MCP server that spawns parallel Nia-powered research agents to discover knowledge that language models don't have, then stores it for future recall.

## Runtime

Bun. Not Node. Use `bun test`, `bun run`, `bun install`.

## Architecture

MCP server (stdio transport). Three tools: `symposium` (main research pipeline), `symposium_knowledge` (inspect stored knowledge), and `symposium_export` (export knowledge as training data).

**Pipeline**: recall -> decompose -> spawn agents -> collect -> synthesize -> verify (advisor) -> learn -> deliver

**Key files:**
- `src/index.ts` - MCP server, tool handlers, output formatting
- `src/tools/symposium.ts` - Main pipeline orchestration, fast path logic
- `src/engine/spawner.ts` - Parallel agent dispatch with batching, retry, dual-mode
- `src/engine/collector.ts` - Evidence scoring (agent convergence + tracer evidence + cross-validation)
- `src/engine/synthesizer.ts` - Oracle synthesis with fallback
- `src/engine/learner.ts` - Store novel discoveries to Nia Context
- `src/engine/recall.ts` - Search Nia Context for prior knowledge
- `src/nia/client.ts` - Nia SDK wrapper (Oracle, Tracer, Context, Advisor, Search, Subscribe)
- `src/utils/prompts.ts` - All prompt templates (decomposer, 6 research dimensions, synthesizer, fast path)

## Nia API

Uses nia-ai-ts SDK. Key services:
- `NiaSDK.oracle` - Research agents and synthesis (createJob, waitForJob)
- `GithubSearchService` - Tracer (GitHub code search)
- `V2ApiContextsService` - Context Sharing (learning loop storage)
- `AdvisorService` - Code verification against indexed docs
- `V2ApiSearchService` - Fast code search
- `V2ApiSourcesService` - Auto-subscribe to dependency docs

**Critical**: Do NOT set `OpenAPI.BASE` manually. The NiaSDK constructor handles it.

## Testing

`bun test` runs all tests. 96 tests across 8 files. Tests don't require NIA_API_KEY.

`NIA_API_KEY=key bun run scripts/smoke-test.ts` for live API verification.

## Type checking

`bunx tsc --noEmit --skipLibCheck`

## Key design decisions

- Quick mode (demo default, 3 agents) skips the decomposer Oracle call. Uses hardcoded defaults.
- `api_correctness` runs in dual mode: both Oracle AND Tracer in parallel for cross-validated evidence.
- Fast path: if recall finds prior knowledge, skips full research. One Oracle call instead of 5+.
- Evidence scoring is computed from real signals (agent count, repo count, cross-validation), not hallucinated by Oracle.
- All log output goes to stderr (MCP uses stdout for protocol).
- Server starts even without NIA_API_KEY (returns clear errors on tool calls instead of crashing).
- Oracle uses streaming (SSE) first, falls back to polling. Saves ~3-9s per pipeline run.
- Synthesizer receives pre-computed evidence score to calibrate its confidence output.
- Knowledge quality gate: 4-criteria test (novel, corrective, specific, verified) before storing.
- Auto-subscribe: extracts library names from issue and indexes their docs before research.
- safeParseJSON handles trailing commas, comments, multi-code-block extraction, balanced brace matching.
