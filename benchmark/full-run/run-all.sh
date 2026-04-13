#!/bin/bash
# Terminal-Bench 2.0: FULL 89-task run with Symposium MCP
#
# Enhanced only. All 89 tasks. Maximum parallelism.
# Completely isolated from the SWE-subset runs.
#
# Usage:
#   ./benchmark/full-run/run-all.sh              # 20 concurrent (default)
#   BENCH_CONCURRENCY=30 ./benchmark/full-run/run-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
TASKS_DIR="$HOME/.cache/harbor/tasks/packages/terminal-bench"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="$SCRIPT_DIR/results/$TIMESTAMP"
CONCURRENCY="${BENCH_CONCURRENCY:-20}"
MASTER_LOG="$RESULTS_DIR/master.log"

mkdir -p "$RESULTS_DIR"
exec > >(tee -a "$MASTER_LOG") 2>&1

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ─── Preflight ──────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Terminal-Bench 2.0: FULL RUN (89 tasks + Symposium) ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker not running"; exit 1; }

if [ ! -d "$TASKS_DIR" ]; then
  log "Downloading Terminal Bench 2.0 tasks..."
  harbor datasets download terminal-bench/terminal-bench-2
fi

# Get all task names
ALL_TASKS=()
for task_dir in "$TASKS_DIR"/*/; do
  task=$(basename "$task_dir")
  ALL_TASKS+=("$task")
done

log "Tasks:       ${#ALL_TASKS[@]}"
log "Concurrency: $CONCURRENCY"
log "Results:     $RESULTS_DIR"
log "Mode:        enhanced (Symposium MCP, medium effort)"
echo ""

# ─── Helper: Get task path ──────────────────────────────
get_task_dir() {
  local task="$1"
  local task_path="$TASKS_DIR/$task"
  local hash
  hash=$(ls "$task_path/" 2>/dev/null | head -1)
  echo "$task_path/$hash"
}

# ─── Run one task ───────────────────────────────────────
run_task() {
  local task="$1"
  local task_dir
  task_dir=$(get_task_dir "$task")
  local result_dir="$RESULTS_DIR/enhanced/$task"
  mkdir -p "$result_dir"

  # Read config
  local docker_image
  docker_image=$(grep 'docker_image' "$task_dir/task.toml" | sed 's/.*= *"//' | sed 's/"//')
  local instruction
  instruction=$(cat "$task_dir/instruction.md")

  # Get agent timeout from task.toml (default 900)
  local agent_timeout
  agent_timeout=$(awk '/\[agent\]/{found=1;next} found && /timeout_sec/{gsub(/[^0-9.]/,"",$NF); printf "%d", $NF; exit}' "$task_dir/task.toml" 2>/dev/null)
  [ -z "$agent_timeout" ] && agent_timeout=900

  log "[enhanced] START $task (timeout=${agent_timeout}s)"

  # Pull image
  docker pull "$docker_image" >"$result_dir/docker-pull.log" 2>&1 || true

  # Start container
  local cid
  cid=$(docker run -d \
    --name "tbench-full-${task}-$$" \
    --cpus 1 \
    --memory 2g \
    "$docker_image" \
    sleep $((agent_timeout + 300))) 2>/dev/null

  if [ -z "$cid" ]; then
    log "[enhanced] CONTAINER FAILED: $task"
    echo "0" > "$result_dir/reward.txt"
    echo '{"task":"'"$task"'","mode":"enhanced","reward":0,"error":"container_start_failed"}' > "$result_dir/meta.json"
    return
  fi

  echo "$cid" > "$result_dir/container-id.txt"

  # Setup container
  docker exec "$cid" bash -c "mkdir -p /logs/verifier /logs/agent" 2>/dev/null || true
  docker cp "$task_dir/tests/." "$cid:/tests/" 2>/dev/null || true

  # Build claude command
  local start_time
  start_time=$(date +%s)

  # Save command for debugging
  echo "claude -p [instruction] --model opus --effort medium --permission-mode bypassPermissions --append-system-prompt [symposium prompt with cid=$cid]" > "$result_dir/claude-command.txt"

  timeout "$agent_timeout" claude -p "$instruction" \
    --model opus \
    --effort medium \
    --permission-mode bypassPermissions \
    --output-format text \
    --verbose \
    --append-system-prompt "You are solving a Terminal-Bench task inside a Docker container.

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
- You are being benchmarked. Accuracy matters more than speed." \
    > "$result_dir/claude-output.txt" \
    2> "$result_dir/claude-stderr.txt" || true

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))

  log "[enhanced] Claude done: $task (${duration}s)"

  # Pre-install test dependencies (fix expired GPG keys in old container images)
  docker exec "$cid" bash -c '
    # Fix expired GPG keys by allowing insecure repos
    apt-get update --allow-insecure-repositories 2>/dev/null || apt-get update 2>/dev/null || true
    apt-get install -y --allow-unauthenticated curl 2>/dev/null || true
    # Install uv if not present
    if ! command -v uvx &>/dev/null; then
      curl -LsSf https://astral.sh/uv/0.9.5/install.sh 2>/dev/null | sh 2>/dev/null || true
      export PATH="$HOME/.local/bin:$PATH"
    fi
  ' > "$result_dir/test-deps.log" 2>&1 || true

  # Run tests
  docker exec "$cid" bash -c "export PATH=\"\$HOME/.local/bin:\$PATH\" && chmod +x /tests/test.sh && bash /tests/test.sh" \
    > "$result_dir/test-output.txt" 2>&1 || true

  # Get reward
  local reward
  reward=$(docker exec "$cid" cat /logs/verifier/reward.txt 2>/dev/null || echo "0")
  reward=$(echo "$reward" | tr -d '[:space:]')
  [ -z "$reward" ] && reward="0"
  echo "$reward" > "$result_dir/reward.txt"

  # Save logs
  docker logs "$cid" > "$result_dir/container-logs.txt" 2>&1 || true
  docker cp "$cid:/logs/verifier/." "$result_dir/verifier-logs/" 2>/dev/null || true

  # Metadata
  cat > "$result_dir/meta.json" <<METAEOF
{
  "task": "$task",
  "mode": "enhanced",
  "docker_image": "$docker_image",
  "duration_sec": $duration,
  "reward": $reward,
  "container_id": "$cid",
  "timestamp": "$TIMESTAMP",
  "model": "claude-opus-4-6",
  "effort": "medium",
  "agent_timeout": $agent_timeout
}
METAEOF

  local status="FAIL"
  [ "$reward" = "1" ] && status="PASS"
  log "[enhanced] $status: $task (${duration}s, reward=$reward)"

  # Cleanup
  docker rm -f "$cid" >/dev/null 2>&1 || true
}

# ─── Run all tasks with throttled concurrency ───────────
BATCH_START=$(date +%s)

log "Launching ${#ALL_TASKS[@]} tasks, $CONCURRENCY at a time..."
echo ""

pids=()
running=0

for task in "${ALL_TASKS[@]}"; do
  while [ $running -ge $CONCURRENCY ]; do
    wait -n 2>/dev/null || true
    running=$((running - 1))
  done

  run_task "$task" &
  pids+=($!)
  running=$((running + 1))
done

# Wait for all
for pid in "${pids[@]}"; do
  wait "$pid" 2>/dev/null || true
done

BATCH_END=$(date +%s)
BATCH_DURATION=$((BATCH_END - BATCH_START))

echo ""
log "ALL TASKS COMPLETE in ${BATCH_DURATION}s ($(( BATCH_DURATION / 60 ))m $(( BATCH_DURATION % 60 ))s)"
echo ""

# ─── Score ──────────────────────────────────────────────
passed=0
total=0
for task in "${ALL_TASKS[@]}"; do
  r=$(cat "$RESULTS_DIR/enhanced/$task/reward.txt" 2>/dev/null || echo "0")
  r=$(echo "$r" | tr -d '[:space:]')
  total=$((total + 1))
  [ "$r" = "1" ] && passed=$((passed + 1))
done

echo "╔══════════════════════════════════════════════════════╗"
echo "║  FINAL SCORE: $passed/$total ($(( passed * 100 / total ))%)                          ║"
echo "║  Baseline (Claude Code + Opus 4.6): 58.0%           ║"
echo "║  Delta: $(( passed * 100 / total - 58 )) percentage points                       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Save per-task breakdown
log "Per-task results:"
for task in "${ALL_TASKS[@]}"; do
  r=$(cat "$RESULTS_DIR/enhanced/$task/reward.txt" 2>/dev/null || echo "0")
  r=$(echo "$r" | tr -d '[:space:]')
  dur=""
  [ -f "$RESULTS_DIR/enhanced/$task/meta.json" ] && dur=" ($(grep duration "$RESULTS_DIR/enhanced/$task/meta.json" | grep -o '[0-9]*' | head -1)s)"
  icon="FAIL"
  [ "$r" = "1" ] && icon="PASS"
  echo "  [$icon] $task$dur"
done

# Save config
cat > "$RESULTS_DIR/run-config.json" <<CFGEOF
{
  "timestamp": "$TIMESTAMP",
  "total_tasks": ${#ALL_TASKS[@]},
  "concurrency": $CONCURRENCY,
  "mode": "enhanced",
  "effort": "medium",
  "model": "claude-opus-4-6",
  "duration_sec": $BATCH_DURATION,
  "passed": $passed,
  "total": $total,
  "rate": $(echo "scale=4; $passed / $total" | bc)
}
CFGEOF

echo ""
log "All results saved to: $RESULTS_DIR"
echo "  master.log                    — full run log"
echo "  run-config.json               — run configuration + final score"
echo "  enhanced/<task>/reward.txt    — per-task pass/fail"
echo "  enhanced/<task>/meta.json     — per-task metadata"
echo "  enhanced/<task>/claude-*.txt  — Claude output + stderr"
