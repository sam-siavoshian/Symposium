# Symposium — Multi-Agent Reasoning Engine for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Runtime-Bun-black.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/Protocol-MCP-purple.svg)](https://modelcontextprotocol.io)

### +23.1% on Terminal Bench 2.0 SWE tasks — 46.2% → 69.2% (Opus 4.6 baseline → Opus 4.6 + Symposium)

Discovers what LLMs get wrong, researches the real answer from live docs and code, solves it in real-time, and exports corrections as training data to train better models.

> **TL;DR:** An MCP server that spawns parallel research agents to find knowledge that language models don't have. Each agent researches the problem from a different angle (docs, repos, failure modes, codebase patterns, tests). Findings get cross-validated, synthesized into a verified plan, and stored so the next user gets an instant answer. Every discovery exports as fine-tuning data.

```
┌─────────────┐       ┌─────────────┐       ┌────────────────────────────────┐
│ Claude Code │◄────► │  Symposium  │◄────► │        Nia Platform            │
│  (your IDE) │ MCP   │  MCP Server │ SDK   │  Oracle · Tracer · Context     │
└─────────────┘       └─────────────┘       └────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         Research       Synthesize     Learn & Export
        (parallel       (verified     (knowledge base +
         agents)         plan)        training data)
```

## Why?

LLMs are great at the stuff in their training data. Add Stripe. Read docs. Update an API. Easy. But some tasks, they just fail. Hallucinate a function signature. Use a deprecated API. Confidently write broken code.

In World War II, the Allies studied bullet holes on surviving bombers and said "reinforce those spots." Abraham Wald pointed out the flaw: you're only seeing the planes that made it back. The ones hit in other places never returned. Armor the spots with no holes.

Same idea here. Models nail the common patterns. Symposium finds those blind spots, fixes them live, and turns every correction into training data.

---

## 📈 Benchmark: Outperforming Opus on Terminal Bench 2.0

I ran the **13 hardest SWE tasks** from Terminal Bench 2.0 head-to-head. Vanilla Claude Code (Opus 4.6) vs Claude Code + Symposium. Same model. Same effort. Same timeout.

```
┌────────────────────────────┬────────────────────────────┐
│   Vanilla Claude Code      │   Claude + Symposium       │
│                            │                            │
│        46.2%               │        69.2%  ✅           │
│       6 of 13              │       9 of 13              │
│                            │                            │
│   Opus 4.6, no MCP        │   Opus 4.6 + Symposium     │
└────────────────────────────┴────────────────────────────┘

  +3 tasks flipped  ·  0 regressions  ·  +23.1% score gain
```

**Every task vanilla solved, Symposium also solved. Zero regressions.** Three tasks that vanilla Claude failed were flipped to pass:

| Task | Vanilla | Symposium | What happened |
|------|---------|-----------|---------------|
| `cancel-async-tasks` | ❌ Fail (41s) | ✅ Pass (759s) | Needed specific async cancellation patterns. Vanilla gave up with a wrong approach. Symposium researched the patterns, gave Claude verified knowledge. |
| `compile-compcert` | ❌ Fail (900s) | ✅ Pass (1068s) | Required knowledge about CompCert's build system that wasn't in training data. Vanilla timed out. Symposium found the correct configuration live. |
| `fix-ocaml-gc` | ❌ Fail (900s) | ✅ Pass (1460s) | Required deep knowledge of OCaml's garbage collector internals. Vanilla timed out. Symposium researched the right approach live and Claude fixed the GC. |

<details>
<summary><b>Full results (all 13 tasks)</b></summary>

| Task | Vanilla | Symposium | Time (V) | Time (S) |
|------|---------|-----------|----------|----------|
| `cancel-async-tasks` | ❌ | ✅ | 41s | 759s |
| `cobol-modernization` | ✅ | ✅ | 201s | 523s |
| `compile-compcert` | ❌ | ✅ | 900s | 1068s |
| `configure-git-webserver` | ❌ | ❌ | 126s | 592s |
| `fix-code-vulnerability` | ✅ | ✅ | 67s | 134s |
| `fix-git` | ✅ | ✅ | 47s | 61s |
| `fix-ocaml-gc` | ❌ | ✅ | 900s | 1460s |
| `git-leak-recovery` | ✅ | ✅ | 35s | 58s |
| `git-multibranch` | ✅ | ✅ | 99s | 404s |
| `polyglot-c-py` | ❌ | ❌ | 188s | 203s |
| `polyglot-rust-c` | ❌ | ❌ | 202s | 340s |
| `query-optimize` | ❌ | ❌ | 900s | 1255s |
| `sanitize-git-repo` | ✅ | ✅ | 104s | 414s |

</details>

The gap between "what models know" and "what they need to know" is where Symposium lives.

---

## ✨ Features

- **Multi-angle research.** Spawns parallel agents that each approach the problem differently. One reads docs, one searches GitHub repos, one checks failure modes, one studies your codebase, one plans tests. Not 10 agents hallucinating the same wrong answer.
- **Dual-mode cross-validation.** `api_correctness` runs both Oracle (docs) and Tracer (real GitHub code) in parallel. When they agree, confidence goes up. When they don't, you know something's off.
- **Evidence scoring from real signals.** Agent convergence, unique repo count, cross-validation bonus, pattern consistency. Real math, not a model guessing "I'm 85% confident."
- **Learning loop.** Novel discoveries pass a 4-criteria quality gate and get stored. Next time anyone hits the same issue, instant recall. One call instead of five.
- **Training data export.** `symposium_export` gives DPO-format pairs: what the model got wrong (rejected) vs the verified answer (chosen). Ready for fine-tuning.
- **Feedback loop.** After code works or fails, user feedback adjusts confidence. Bad knowledge gets deprecated automatically.
- **Auto-subscribe.** Extracts library names from the issue and indexes their docs before research even starts.
- **Fast.** SSE streaming for Oracle (falls back to polling). Early completion starts synthesis when N-1 agents finish. Pre-warms the inference backend on startup.
- **4 MCP tools.** `symposium` (research), `symposium_knowledge` (browse), `symposium_export` (training data), `symposium_feedback` (improve accuracy).

---

## Quick Start

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/sam-siavoshian/Symposium/main/install.sh | NIA_API_KEY=nk_your_key sh
```

The installer checks prerequisites, installs Bun if needed, clones the repo, validates your API key against Nia, and writes the MCP config to `~/.claude.json`. Takes about 10 seconds.

### Manual install

```bash
git clone https://github.com/sam-siavoshian/Symposium.git ~/.symposium
cd ~/.symposium
bun install
```

Then add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "symposium": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/Users/you/.symposium/src/index.ts"],
      "env": {
        "NIA_API_KEY": "nk_your_key"
      }
    }
  }
}
```

Restart Claude Code (or run `/mcp`).

### Requirements

- **[Bun](https://bun.sh)** runtime (installer handles this)
- **[Claude Code](https://code.claude.com)** (CLI or IDE extension)
- **[Nia API key](https://app.trynia.ai/settings)** — powers the research agents

---

## Usage

Once installed, Claude Code automatically uses Symposium when it needs to research something. You can also ask directly:

```
"Research how to add BetterAuth v3 session management to this Next.js app"
```

```
"What has Symposium learned?"
```

```
"Export Symposium's knowledge as training data"
```

### Research depths


| Depth      | Agents | When to use                                                           |
| ---------- | ------ | --------------------------------------------------------------------- |
| `auto`     | 2-4    | Default. Analyzes the issue and picks minimum agents needed.          |
| `quick`    | 3      | Fast results. `api_correctness` + `similar_solutions` + `code_paths`. |
| `standard` | 5      | Most tasks. Adds `failure_modes` + `test_strategy`.                   |
| `deep`     | 6      | Complex problems. All 6 research dimensions.                          |


### Tools


| Tool                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `symposium`           | Main research pipeline. Describe the issue, get a verified plan. |
| `symposium_knowledge` | Browse stored knowledge. Search by library name.                 |
| `symposium_export`    | Export as JSONL, markdown, or DPO training data.                 |
| `symposium_feedback`  | Report if recalled knowledge was correct, incorrect, or partial. |


---

## How It Works

```
User asks about a library/API
         │
         ▼
    ┌──────────┐
    │  RECALL  │  Search stored knowledge
    └─────┬────┘
          │
     Has relevant knowledge?
      ┌───┴───┐
     YES      NO
      │        │
      ▼        ▼
 ┌─────────┐  ┌───────────┐
 │FAST PATH│  │ DECOMPOSE │  Pick research dimensions
 │(instant)│  └─────┬─────┘
 └─────────┘        │
                    ▼
             ┌─────────────┐
             │SPAWN AGENTS │  Parallel Oracle + Tracer
             └──────┬──────┘
                    │
                    ▼
             ┌─────────────┐
             │   COLLECT   │  Score evidence
             └──────┬──────┘
                    │
                    ▼
             ┌─────────────┐
             │ SYNTHESIZE  │  Merge into verified plan
             └──────┬──────┘
                    │
                    ▼
             ┌─────────────┐
             │    LEARN    │  Store novel discoveries
             └──────┬──────┘
                    │
                    ▼
              DELIVER PLAN
```

### Research dimensions


| Dimension           | Agent type                  | What it does                                                 |
| ------------------- | --------------------------- | ------------------------------------------------------------ |
| `api_correctness`   | Oracle + Tracer (dual-mode) | Verifies API usage against real docs and real code           |
| `similar_solutions` | Tracer                      | Finds how people actually solve this in GitHub repos         |
| `code_paths`        | Oracle                      | Maps execution flows in the existing codebase                |
| `failure_modes`     | Oracle                      | Identifies what can go wrong (auth, networking, concurrency) |
| `existing_patterns` | Oracle                      | Studies patterns the codebase already uses                   |
| `test_strategy`     | Oracle                      | Plans how to test the implementation                         |


### Evidence scoring

Evidence scores come from actual signals, not LLM-generated confidence.

```
composite = (convergence×1 + tracerEvidence×2 + patternConsistency×1
             + noveltySignal×0.5 + crossValidationBonus) / 5
             × max(completeness, 0.5)
```

- **Agent convergence:** substantive findings / total agents spawned
- **Tracer evidence:** unique GitHub repos found (3 repos = full score)
- **Cross-validation:** Oracle and Tracer agree on the same dimension → +0.5 bonus
- **Completeness:** findings returned / agents dispatched

---

## Project Layout

```
src/
  index.ts                 MCP server, tool handlers, startup
  tools/
    symposium.ts           Main pipeline orchestration, fast path
    handlers.ts            Output formatting, knowledge lookup, export
  engine/
    recall.ts              Search prior knowledge from Nia Context
    decomposer.ts          Pick research dimensions by depth
    spawner.ts             Parallel agent dispatch, dual-mode, retry
    collector.ts           Evidence scoring and finding aggregation
    synthesizer.ts         Oracle synthesis with fallback
    learner.ts             Store novel discoveries, quality gate
    feedback.ts            Usage tracking, auto-feedback, explicit feedback
  nia/
    client.ts              Nia SDK wrapper (Oracle, Tracer, Context, Advisor)
    types.ts               Shared types and constants
    safe-parse.ts          JSON parsing for LLM outputs
  utils/
    prompts.ts             All prompt templates (6 dimensions + synthesizer)
    logger.ts              Stderr logger with colors and timestamps
scripts/
  smoke-test.ts            Live API verification
  test-oracle.ts           Ad-hoc Oracle debugging
install.sh                 One-line installer with terminal UI
```

---

## Development

```bash
# run tests (no API key needed)
bun test

# type check
bun run typecheck

# both
bun run check

# live API smoke test (needs NIA_API_KEY)
NIA_API_KEY=nk_... bun run smoke

# start the server directly
NIA_API_KEY=nk_... bun run start
```

### Environment variables


| Variable          | Required | Description                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------------- |
| `NIA_API_KEY`     | Yes      | Your Nia API key. Get one at [app.trynia.ai/settings](https://app.trynia.ai/settings). |
| `LOG_LEVEL`       | No       | `debug`, `info`, `warn`, or `error`. Default: `info`.                                  |
| `DIMENSION_MODEL` | No       | Override the model for secondary dimensions.                                           |


---

## Training Data Export

Symposium doesn't just fix problems in real-time. It builds a dataset of what models get wrong.

```
"Export Symposium's knowledge as training data"
```

Three formats:

- **`jsonl`** — One JSON object per line. Each entry has `library`, `mistake`, `correct`, `confidence`, `evidence`.
- **`markdown`** — Human-readable report of all discoveries.
- **`training`** — DPO-format with `chosen` (verified answer) and `rejected` (what the model got wrong) pairs, with reasoning. Ready for fine-tuning.

The idea: the stuff models fail at today becomes the data that fixes them tomorrow.

---

## Built With

- [Model Context Protocol](https://modelcontextprotocol.io) — tool protocol for AI assistants
- [Nia SDK](https://www.trynia.ai) — Oracle agents, Tracer (GitHub search), Context API, Advisor
- [Bun](https://bun.sh) — JavaScript runtime
- [TypeScript](https://www.typescriptlang.org/) — strict mode, ESNext

---

## License

[MIT](./LICENSE) © Saam Siavoshian

## Author

**Saam Siavoshian**

- X: [@samsiavoshian](https://x.com/samsiavoshian)
- Email: [samsiavoshian2009@gmail.com](mailto:samsiavoshian2009@gmail.com)

