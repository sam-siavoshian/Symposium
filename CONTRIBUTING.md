# Contributing

Thanks for considering a PR.

## Setup

```bash
git clone https://github.com/sam-siavoshian/Symposium.git
cd Symposium
bun install
```

Need a Nia API key from [app.trynia.ai/settings](https://app.trynia.ai/settings) (`nk_*` format). Export it before running anything that hits live APIs:

```bash
export NIA_API_KEY=nk_your_key
```

## Run locally

```bash
NIA_API_KEY=nk_... bun run start            # MCP server on stdio
NIA_API_KEY=nk_... bun run smoke            # live Nia API smoke test
```

To test against Claude Code, point `~/.claude.json` at your local checkout (see README "Manual install").

## Tests

```bash
bun test                # 96 unit tests, no API key needed
bun run typecheck       # tsc --noEmit --skipLibCheck
bun run check           # both
```

Unit tests mock the Nia SDK. The live smoke test (`bun run smoke`) is the only path that hits real APIs.

## Benchmark

The Terminal Bench 2.0 harness lives in `benchmark/`. It needs Docker, the Harbor CLI, `ANTHROPIC_API_KEY`, and `NIA_API_KEY`. Don't run it in CI, run it locally:

```bash
bash benchmark/setup.sh
bash benchmark/run.sh
```

Results land in `benchmark/results/<timestamp>/`. Use `bun run benchmark/collect_results.ts <dir>` to aggregate.

## Filing PRs

- Keep diffs small. One concern per PR.
- Open a draft PR early for non-trivial changes so we can agree on approach before the refactor.
- Match the existing voice: lowercase headers in source files, numbers over adjectives, no fluff.
- New prompts go in `src/utils/prompts.ts`. New research dimensions need both a prompt and a decomposer entry.

## Bugs

Use the templates under [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/). Include:

- Bun version, OS, MCP client (Claude Code version)
- The issue/task you asked Symposium about
- Output from `LOG_LEVEL=debug` if relevant
- Whether `bun run smoke` passes
