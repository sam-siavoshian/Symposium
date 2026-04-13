#!/bin/bash
# Terminal-Bench 2.0 setup script
# Run this once to install Harbor and verify everything works.

set -e

echo "=== Terminal-Bench 2.0 Setup ==="
echo ""

# ─── Check Docker ───────────────────────────────────────
echo "Checking Docker..."
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker is not running. Start Docker Desktop and try again."
    exit 1
fi
echo "  Docker OK"

# ─── Check API Keys ────────────────────────────────────
echo "Checking API keys..."
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "ERROR: ANTHROPIC_API_KEY not set."
    echo "  export ANTHROPIC_API_KEY='your-key'"
    exit 1
fi
echo "  ANTHROPIC_API_KEY set"

if [ -z "${NIA_API_KEY:-}" ]; then
    echo "ERROR: NIA_API_KEY not set."
    echo "  export NIA_API_KEY='your-key'"
    exit 1
fi
echo "  NIA_API_KEY set"

# ─── Install uv (if missing) ───────────────────────────
if ! command -v uv &>/dev/null; then
    echo "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
echo "  uv $(uv --version)"

# ─── Install Harbor ─────────────────────────────────────
echo "Installing Harbor..."
uv tool install harbor 2>/dev/null || uv tool upgrade harbor 2>/dev/null || true
echo "  harbor $(harbor --version 2>/dev/null || echo 'install failed')"

# ─── Verify Harbor ──────────────────────────────────────
echo ""
echo "Verifying Harbor can reach the registry..."
harbor datasets list 2>&1 | head -5 || echo "  WARNING: Could not list datasets (might need harbor auth login)"

# ─── Create Results Dir ─────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SCRIPT_DIR/results"
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Quick smoke test (2 tasks, oracle agent):"
echo "     harbor run -d terminal-bench/terminal-bench-2 -a oracle -n 2 -l 2 -y"
echo ""
echo "  2. Run the benchmark:"
echo "     ./benchmark/run.sh"
echo ""
echo "  3. Run enhanced only (skip baseline):"
echo "     ./benchmark/run.sh --enhanced-only"
