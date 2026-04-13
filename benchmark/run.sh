#!/bin/bash
# Terminal-Bench 2.0: Local Benchmark Runner
#
# Runs Claude Code locally (your subscription) against Docker containers.
# Baseline: vanilla Claude, no MCP, no skills, low reasoning (fast)
# Enhanced: Claude + Symposium MCP, auto reasoning (full power)
# All 13 tasks run in parallel per batch. Everything logged.
#
# Usage:
#   ./benchmark/run.sh                          # Both runs, all parallel
#   ./benchmark/run.sh --enhanced-only          # Skip baseline
#   ./benchmark/run.sh --baseline-only          # Skip enhanced
#   BENCH_CONCURRENCY=5 ./benchmark/run.sh      # Limit concurrency

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TASKS_DIR="$HOME/.cache/harbor/tasks/packages/terminal-bench"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="$PROJECT_DIR/benchmark/results/$TIMESTAMP"
CONCURRENCY="${BENCH_CONCURRENCY:-13}"
MASTER_LOG="$RESULTS_DIR/master.log"

# Parse flags
RUN_BASELINE=true
RUN_ENHANCED=true
for arg in "$@"; do
  case "$arg" in
    --enhanced-only) RUN_BASELINE=false ;;
    --baseline-only) RUN_ENHANCED=false ;;
  esac
done

# SWE tasks from Terminal Bench 2.0
SWE_TASKS=(
  fix-code-vulnerability
  fix-git
  fix-ocaml-gc
  cancel-async-tasks
  cobol-modernization
  compile-compcert
  configure-git-webserver
  git-leak-recovery
  git-multibranch
  polyglot-c-py
  polyglot-rust-c
  query-optimize
  sanitize-git-repo
)

# ─── Logging ────────────────────────────────────────────
mkdir -p "$RESULTS_DIR"
exec > >(tee -a "$MASTER_LOG") 2>&1

log() {
  echo "[$(date '+%H:%M:%S')] $*"
}

# ─── Preflight ──────────────────────────────────────────
echo "╔══════════════════════════════════════════════════╗"
echo "║  Terminal-Bench 2.0: Symposium Benchmark Runner  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker not running"; exit 1; }

if [ ! -d "$TASKS_DIR" ]; then
  log "Downloading Terminal Bench 2.0 tasks..."
  harbor datasets download terminal-bench/terminal-bench-2
fi

log "Tasks:       ${#SWE_TASKS[@]} SWE tasks"
log "Concurrency: $CONCURRENCY (all parallel)"
log "Results:     $RESULTS_DIR"
log "Baseline:    $RUN_BASELINE (low reasoning, no MCP, no skills)"
log "Enhanced:    $RUN_ENHANCED (auto reasoning, Symposium MCP)"
echo ""

# ─── Helper: Get task path ──────────────────────────────
get_task_dir() {
  local task="$1"
  local task_path="$TASKS_DIR/$task"
  local hash
  hash=$(ls "$task_path/" 2>/dev/null | head -1)
  echo "$task_path/$hash"
}

# ─── Helper: Run one task ──────────────────────────────
run_task() {
  local task="$1"
  local mode="$2"  # "baseline" or "enhanced"
  local task_dir
  task_dir=$(get_task_dir "$task")
  local result_dir="$RESULTS_DIR/$mode/$task"
  mkdir -p "$result_dir"

  # Read task config
  local docker_image
  docker_image=$(grep 'docker_image' "$task_dir/task.toml" | sed 's/.*= *"//' | sed 's/"//')
  local instruction
  instruction=$(cat "$task_dir/instruction.md")

  log "[$mode] START $task"

  # Pull image (silent if already cached)
  docker pull "$docker_image" >"$result_dir/docker-pull.log" 2>&1 || true

  # Start container
  local cid
  cid=$(docker run -d \
    --name "tbench-${mode}-${task}-$$" \
    --cpus 1 \
    --memory 2g \
    "$docker_image" \
    sleep 3600)

  echo "$cid" > "$result_dir/container-id.txt"
  log "[$mode] Container ${cid:0:12} for $task"

  # Create log directories inside container
  docker exec "$cid" bash -c "mkdir -p /logs/verifier /logs/agent" 2>/dev/null || true

  # Copy test files into container
  docker cp "$task_dir/tests/." "$cid:/tests/" 2>/dev/null || true

  # ─── Build claude command based on mode ─────────────
  local claude_args=()
  claude_args+=(-p "$instruction")
  claude_args+=(--model opus)
  claude_args+=(--permission-mode bypassPermissions)
  claude_args+=(--output-format text)
  claude_args+=(--verbose)

  if [ "$mode" = "baseline" ]; then
    # BASELINE: no MCP (empty strict config), no skills, medium reasoning
    claude_args+=(--effort medium)
    claude_args+=(--strict-mcp-config)
    claude_args+=(--mcp-config '{"mcpServers":{}}')
    claude_args+=(--disable-slash-commands)
    claude_args+=(--append-system-prompt "You are solving a Terminal-Bench task inside a Docker container.

RULES:
- Do NOT use any MCP tools, skills, plugins, or external services
- Do NOT call any symposium, research, or knowledge tools
- Solve the task using ONLY your built-in knowledge and the Bash tool
- Execute ALL commands using: docker exec $cid bash -c 'your command here'
- Check the working directory first: docker exec $cid pwd
- Work quickly and efficiently
- You are being benchmarked. Solve the task as fast and correctly as possible.")

  else
    # ENHANCED: Symposium MCP loaded from ~/.claude.json, medium reasoning, no turn cap
    claude_args+=(--effort medium)
    claude_args+=(--append-system-prompt "You are solving a Terminal-Bench task inside a Docker container.

You have access to the Symposium MCP tool, a multi-agent research engine. USE IT.

BEFORE writing any code or running any commands, call the 'symposium' tool with:
- issue: a description of the task you need to solve
- This will research live documentation, verify correct API usage, and find real GitHub implementations

RULES:
- ALWAYS call symposium FIRST to research the correct approach before doing anything else
- Execute ALL commands using: docker exec $cid bash -c 'your command here'
- Check the working directory first: docker exec $cid pwd
- Use the verified knowledge from Symposium to solve the task correctly
- If Symposium finds that an API or tool works differently than you expected, TRUST Symposium over your training data
- You are being benchmarked. Accuracy matters more than speed.")

  fi

  # ─── Run Claude Code ────────────────────────────────
  local start_time
  start_time=$(date +%s)

  # Save the exact command we ran
  printf '%q ' claude "${claude_args[@]}" > "$result_dir/claude-command.txt"
  echo "" >> "$result_dir/claude-command.txt"

  # Run with timeout: no cap for either mode (30 min safety net)
  local task_timeout=1800

  timeout $task_timeout claude "${claude_args[@]}" \
    > "$result_dir/claude-output.txt" \
    2> "$result_dir/claude-stderr.txt" || true

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))

  log "[$mode] Claude done: $task (${duration}s)"

  # ─── Pre-install test deps (fix expired GPG keys) ───
  docker exec "$cid" bash -c '
    apt-get update --allow-insecure-repositories 2>/dev/null || apt-get update 2>/dev/null || true
    apt-get install -y --allow-unauthenticated curl 2>/dev/null || true
    if ! command -v uvx &>/dev/null; then
      curl -LsSf https://astral.sh/uv/0.9.5/install.sh 2>/dev/null | sh 2>/dev/null || true
    fi
  ' > "$result_dir/test-deps.log" 2>&1 || true

  # ─── Run Tests ──────────────────────────────────────
  docker exec "$cid" bash -c "export PATH=\"\$HOME/.local/bin:\$PATH\" && chmod +x /tests/test.sh && bash /tests/test.sh" \
    > "$result_dir/test-output.txt" 2>&1 || true

  # Extract reward
  local reward
  reward=$(docker exec "$cid" cat /logs/verifier/reward.txt 2>/dev/null || echo "0")
  reward=$(echo "$reward" | tr -d '[:space:]')
  [ -z "$reward" ] && reward="0"

  echo "$reward" > "$result_dir/reward.txt"

  # Save all container logs
  docker logs "$cid" > "$result_dir/container-logs.txt" 2>&1 || true

  # Copy verifier logs out of container
  docker cp "$cid:/logs/verifier/." "$result_dir/verifier-logs/" 2>/dev/null || true

  # Save metadata
  cat > "$result_dir/meta.json" <<METAEOF
{
  "task": "$task",
  "mode": "$mode",
  "docker_image": "$docker_image",
  "duration_sec": $duration,
  "reward": $reward,
  "container_id": "$cid",
  "timestamp": "$TIMESTAMP",
  "model": "claude-opus-4-6",
  "effort": "medium"
}
METAEOF

  local status="FAIL"
  [ "$reward" = "1" ] && status="PASS"
  log "[$mode] $status: $task (${duration}s, reward=$reward)"

  # Cleanup container
  docker rm -f "$cid" >/dev/null 2>&1 || true
}

# ─── Run ALL tasks in parallel ──────────────────────────
run_batch() {
  local mode="$1"
  local batch_start
  batch_start=$(date +%s)

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $mode RUN — ${#SWE_TASKS[@]} tasks, $CONCURRENCY concurrent"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  local pids=()
  local running=0

  for task in "${SWE_TASKS[@]}"; do
    # Throttle concurrency
    while [ $running -ge $CONCURRENCY ]; do
      wait -n 2>/dev/null || true
      running=$((running - 1))
    done

    run_task "$task" "$mode" &
    pids+=($!)
    running=$((running + 1))
  done

  # Wait for all
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  local batch_end
  batch_end=$(date +%s)
  local batch_duration=$((batch_end - batch_start))

  echo ""
  log "$mode COMPLETE in ${batch_duration}s"

  # Quick summary
  local passed=0
  local total=0
  for task in "${SWE_TASKS[@]}"; do
    local r
    r=$(cat "$RESULTS_DIR/$mode/$task/reward.txt" 2>/dev/null || echo "0")
    r=$(echo "$r" | tr -d '[:space:]')
    total=$((total + 1))
    [ "$r" = "1" ] && passed=$((passed + 1))
  done
  log "$mode SCORE: $passed/$total ($(( passed * 100 / total ))%)"
}

# ─── Main ───────────────────────────────────────────────
START_TIME=$(date +%s)

# Save run config
cat > "$RESULTS_DIR/run-config.json" <<CFGEOF
{
  "timestamp": "$TIMESTAMP",
  "tasks": $(printf '%s\n' "${SWE_TASKS[@]}" | jq -R . | jq -s .),
  "concurrency": $CONCURRENCY,
  "run_baseline": $RUN_BASELINE,
  "run_enhanced": $RUN_ENHANCED,
  "baseline_effort": "medium",
  "enhanced_effort": "medium",
  "model": "claude-opus-4-6",
  "timeout_per_task_sec": 900
}
CFGEOF

if [ "$RUN_BASELINE" = true ]; then
  run_batch "baseline"
fi

if [ "$RUN_ENHANCED" = true ]; then
  run_batch "enhanced"
fi

END_TIME=$(date +%s)
TOTAL=$((END_TIME - START_TIME))

echo ""
log "TOTAL TIME: ${TOTAL}s ($(( TOTAL / 60 ))m $(( TOTAL % 60 ))s)"
echo ""

# ─── Collect & Compare Results ──────────────────────────
bun run "$SCRIPT_DIR/collect_results.ts" "$RESULTS_DIR"

echo ""
echo "All logs saved to: $RESULTS_DIR"
echo "  master.log         — full run log"
echo "  run-config.json    — run configuration"
echo "  <mode>/<task>/     — per-task results:"
echo "    claude-output.txt   — Claude's full response"
echo "    claude-stderr.txt   — Claude debug/verbose output"
echo "    claude-command.txt  — exact command that was run"
echo "    test-output.txt     — test script output"
echo "    container-logs.txt  — Docker container logs"
echo "    verifier-logs/      — verifier output files"
echo "    reward.txt          — 0 or 1"
echo "    meta.json           — task metadata + timing"
echo "  comparison.json    — structured results comparison"
