#!/bin/sh
# Symposium Installer
# Multi-agent reasoning engine for Claude Code
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sam-siavoshian/Symposium/main/install.sh | sh
#   curl -fsSL ... | NIA_API_KEY=nk_... sh
#   sh install.sh
#
# Environment variables:
#   NIA_API_KEY    - Your Nia API key (prompted if not set)
#   INSTALL_DIR    - Where to clone Symposium (default: ~/.symposium)

set -eu

# ─── Colors (256-color, clack-inspired) ─────────────────

BOLD=""
DIM=""
RESET=""
# 256-color palette
C_ACCENT=""      # violet/purple - branding, prompts
C_SUCCESS=""     # green - checkmarks, success
C_INFO=""        # cyan - info bullets, step numbers
C_WARN=""        # yellow/orange - warnings
C_ERROR=""       # red - errors
C_RAIL=""        # gray - vertical rail, borders
C_SUBTLE=""      # dim gray - hints, secondary text

if [ -t 1 ]; then
  BOLD="\033[1m"
  DIM="\033[2m"
  RESET="\033[0m"
  C_ACCENT="\033[38;5;141m"
  C_SUCCESS="\033[38;5;78m"
  C_INFO="\033[38;5;75m"
  C_WARN="\033[38;5;209m"
  C_ERROR="\033[38;5;196m"
  C_RAIL="\033[38;5;240m"
  C_SUBTLE="\033[38;5;245m"
fi

# ─── UI primitives ──────────────────────────────────────

rail()    { printf "  ${C_RAIL}│${RESET}\n"; }
check()   { printf "  ${C_RAIL}│${RESET}  ${C_SUCCESS}✓${RESET} %s\n" "$*"; }
xmark()   { printf "  ${C_RAIL}│${RESET}  ${C_ERROR}✗${RESET} %s\n" "$*"; }
bullet()  { printf "  ${C_RAIL}│${RESET}  ${C_WARN}!${RESET} %s\n" "$*"; }
detail()  { printf "  ${C_RAIL}│${RESET}  %s\n" "$*"; }
done_step() { printf "  ${C_SUCCESS}◇${RESET}  %s\n" "$*"; }
warn_msg() { printf "  ${C_RAIL}│${RESET}  ${C_WARN}%s${RESET}\n" "$*" >&2; }

error() {
  rail
  printf "  ${C_ERROR}■${RESET}  ${C_ERROR}%b${RESET}\n" "$*" >&2
  rail
  printf "  ${C_RAIL}└${RESET}  ${DIM}Exited with error.${RESET}\n\n"
  exit 1
}

# ─── Timing ─────────────────────────────────────────────

_now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000'
  else
    echo "$(date +%s)000"
  fi
}

TOTAL_START=$(_now_ms)

_elapsed() {
  _end=$(_now_ms)
  _diff=$(( _end - $1 ))
  _sec=$(( _diff / 1000 ))
  _frac=$(( (_diff % 1000) / 100 ))
  printf "${DIM}%d.%ds${RESET}" "$_sec" "$_frac"
}

# ─── Constants ──────────────────────────────────────────

INSTALL_DIR="${INSTALL_DIR:-$HOME/.symposium}"
REPO_URL="https://github.com/sam-siavoshian/Symposium.git"
CLAUDE_CONFIG="$HOME/.claude.json"
SERVER_NAME="symposium"
ENTRY_POINT="$INSTALL_DIR/src/index.ts"

# ─── Intro ──────────────────────────────────────────────

printf "\n"
printf "  ${C_ACCENT}┌${RESET}  ${BOLD}${C_ACCENT} symposium ${RESET}\n"
rail
printf "  ${C_INFO}●${RESET}  Multi-agent reasoning engine for Claude Code\n"

# ═════════════════════════════════════════════════════════
# Step 1: Prerequisites
# ═════════════════════════════════════════════════════════

STEP_START=$(_now_ms)
rail

# git
if ! command -v git >/dev/null 2>&1; then
  error "git is required. Install it: https://git-scm.com"
fi
GIT_VER=$(git --version 2>/dev/null | sed 's/git version //')
check "git ${DIM}${GIT_VER}${RESET}"

# curl
HAS_CURL=false
if command -v curl >/dev/null 2>&1; then
  HAS_CURL=true
  check "curl"
else
  bullet "curl ${C_SUBTLE}(optional, health check will be skipped)${RESET}"
fi

# bun
if ! command -v bun >/dev/null 2>&1; then
  detail "${C_WARN}Bun not found. Installing...${RESET}"
  if [ "$HAS_CURL" = true ]; then
    curl -fsSL https://bun.sh/install | bash 2>/dev/null
  else
    error "Cannot install Bun without curl.\n  Install manually: https://bun.sh"
  fi
  if [ -f "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    error "Bun installation failed.\n  Install manually: https://bun.sh"
  fi
  BUN_VER=$(bun --version 2>/dev/null || echo "?")
  check "bun ${DIM}v${BUN_VER}${RESET} ${C_SUBTLE}(just installed)${RESET}"
else
  BUN_VER=$(bun --version 2>/dev/null || echo "?")
  check "bun ${DIM}v${BUN_VER}${RESET}"
fi

# Claude Code
if [ ! -f "$CLAUDE_CONFIG" ]; then
  bullet "Claude Code ${C_SUBTLE}(config will be created)${RESET}"
  detail "${C_SUBTLE}Get Claude Code: https://claude.ai/download${RESET}"
else
  check "Claude Code"
fi

rail
done_step "Prerequisites OK $(_elapsed "$STEP_START")"

# ═════════════════════════════════════════════════════════
# Step 2: Install
# ═════════════════════════════════════════════════════════

STEP_START=$(_now_ms)
rail

if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/src/index.ts" ]; then
  detail "Found existing install at ${C_SUBTLE}${INSTALL_DIR}${RESET}"
  detail "Pulling latest..."
  cd "$INSTALL_DIR"
  git pull --ff-only >/dev/null 2>&1 || warn_msg "Could not pull (offline or dirty). Using existing."
elif [ -d "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/src/index.ts" ]; then
  error "${INSTALL_DIR} exists but isn't Symposium.\n  Remove it or set INSTALL_DIR to a different path."
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "$SCRIPT_DIR/src/index.ts" ]; then
    detail "Running from repo at ${C_SUBTLE}${SCRIPT_DIR}${RESET}"
    if [ "$INSTALL_DIR" != "$SCRIPT_DIR" ]; then
      ln -sfn "$SCRIPT_DIR" "$INSTALL_DIR" 2>/dev/null || cp -r "$SCRIPT_DIR" "$INSTALL_DIR"
      detail "Linked to ${C_SUBTLE}${INSTALL_DIR}${RESET}"
    fi
    cd "$SCRIPT_DIR"
  else
    detail "Cloning to ${C_SUBTLE}${INSTALL_DIR}${RESET}"
    git clone --depth 1 --progress "$REPO_URL" "$INSTALL_DIR" || error "Clone failed. Check your internet connection."
    cd "$INSTALL_DIR"
  fi
fi

# Version
SYM_VER="?"
if [ -f "$INSTALL_DIR/package.json" ]; then
  SYM_VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$INSTALL_DIR/package.json" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"/\1/' || echo "?")
fi

detail "Installing dependencies..."
bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1 || error "bun install failed"
check "Symposium ${DIM}v${SYM_VER}${RESET}"

if [ ! -f "$ENTRY_POINT" ]; then
  error "Entry point missing: ${ENTRY_POINT}\n  Repository may be corrupted. Try removing ${INSTALL_DIR} and reinstalling."
fi

rail
done_step "Installed $(_elapsed "$STEP_START")"

# ═════════════════════════════════════════════════════════
# Step 3: API Key
# ═════════════════════════════════════════════════════════

STEP_START=$(_now_ms)
rail

if [ -z "${NIA_API_KEY:-}" ]; then
  EXISTING_KEY=""
  if [ -f "$CLAUDE_CONFIG" ]; then
    EXISTING_KEY=$(grep -o '"NIA_API_KEY"[[:space:]]*:[[:space:]]*"[^"]*"' "$CLAUDE_CONFIG" 2>/dev/null | head -1 | sed 's/.*:.*"\([^"]*\)"/\1/' || true)
  fi

  if [ -n "$EXISTING_KEY" ]; then
    MASKED=$(printf "%s" "$EXISTING_KEY" | cut -c1-7)
    TAIL=$(printf "%s" "$EXISTING_KEY" | rev | cut -c1-4 | rev)
    detail "Found existing key: ${C_SUBTLE}${MASKED}...${TAIL}${RESET}"
    detail "${C_SUBTLE}Press Enter to keep it, or paste a new key.${RESET}"
  fi

  if [ -t 0 ]; then
    rail
    printf "  ${C_ACCENT}◆${RESET}  ${BOLD}Enter your Nia API key${RESET}\n"
    detail "${C_SUBTLE}Get one at https://app.trynia.ai/settings${RESET}"
    printf "  ${C_RAIL}│${RESET}  ${C_ACCENT}>${RESET} "
    read -r NIA_API_KEY_INPUT

    if [ -z "$NIA_API_KEY_INPUT" ] && [ -n "$EXISTING_KEY" ]; then
      NIA_API_KEY="$EXISTING_KEY"
      check "Keeping existing key"
    elif [ -z "$NIA_API_KEY_INPUT" ]; then
      error "API key is required.\n\n  Run again with: ${BOLD}NIA_API_KEY=nk_... sh install.sh${RESET}\n  Get a key at: https://app.trynia.ai/settings"
    else
      NIA_API_KEY="$NIA_API_KEY_INPUT"
    fi
  elif [ -n "$EXISTING_KEY" ]; then
    NIA_API_KEY="$EXISTING_KEY"
    check "Using existing key from config"
  else
    error "NIA_API_KEY is required.\n\n  ${BOLD}curl -fsSL <url> | NIA_API_KEY=nk_your_key sh${RESET}\n  Get a key at: https://app.trynia.ai/settings"
  fi
else
  check "Key provided via environment"
fi

# Validate format
case "$NIA_API_KEY" in
  nk_*)
    check "Key format valid"
    ;;
  *)
    error "API key must start with 'nk_'.\n  Got: $(printf "%s" "$NIA_API_KEY" | cut -c1-8)...\n  Get a valid key at: https://app.trynia.ai/settings"
    ;;
esac

rail
done_step "API key ready $(_elapsed "$STEP_START")"

# ═════════════════════════════════════════════════════════
# Step 4: Validate
# ═════════════════════════════════════════════════════════

STEP_START=$(_now_ms)
rail

KEY_VALID=false
if [ "$HAS_CURL" = true ]; then
  detail "Connecting to Nia API..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $NIA_API_KEY" \
    "https://apigcp.trynia.ai/v2/contexts?limit=1&offset=0" 2>/dev/null || echo "000")

  case "$HTTP_CODE" in
    200)
      KEY_VALID=true
      check "Connected to Nia API"
      ;;
    401)
      xmark "API key is invalid or expired"
      detail "${C_SUBTLE}Get a new one at: https://app.trynia.ai/settings${RESET}"
      ;;
    000)
      bullet "Could not reach Nia API ${C_SUBTLE}(network error)${RESET}"
      detail "${C_SUBTLE}Key will be saved. Verify later.${RESET}"
      ;;
    *)
      bullet "Unexpected HTTP ${HTTP_CODE} ${C_SUBTLE}(saving key anyway)${RESET}"
      ;;
  esac
else
  bullet "Skipped validation ${C_SUBTLE}(curl not available)${RESET}"
fi

if [ "$KEY_VALID" = false ] && [ -t 0 ]; then
  rail
  printf "  ${C_WARN}◆${RESET}  Continue with this key? ${C_SUBTLE}[Y/n]${RESET} "
  read -r CONTINUE
  case "$CONTINUE" in
    [nN]*)
      rail
      printf "  ${C_RAIL}└${RESET}  ${DIM}Setup cancelled.${RESET}\n\n"
      exit 130
      ;;
  esac
fi

rail
if [ "$KEY_VALID" = true ]; then
  done_step "Validated $(_elapsed "$STEP_START")"
else
  printf "  ${C_WARN}◇${RESET}  Validation skipped $(_elapsed "$STEP_START")\n"
fi

# ═════════════════════════════════════════════════════════
# Step 5: Configure
# ═════════════════════════════════════════════════════════

STEP_START=$(_now_ms)
rail

SERVER_JSON=$(cat <<ENDJSON
{
    "type": "stdio",
    "command": "bun",
    "args": ["run", "$ENTRY_POINT"],
    "env": {
      "NIA_API_KEY": "$NIA_API_KEY"
    }
  }
ENDJSON
)

if [ -f "$CLAUDE_CONFIG" ]; then
  if ! bun -e "JSON.parse(require('fs').readFileSync('$CLAUDE_CONFIG','utf-8'))" >/dev/null 2>&1; then
    BACKUP="$CLAUDE_CONFIG.bak.$(date +%s)"
    cp "$CLAUDE_CONFIG" "$BACKUP"
    bullet "Config was malformed. Backed up to ${C_SUBTLE}${BACKUP}${RESET}"
    printf '{}' > "$CLAUDE_CONFIG"
  fi

  bun -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$CLAUDE_CONFIG', 'utf-8') || '{}');
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['$SERVER_NAME'] = $SERVER_JSON;
    fs.writeFileSync('$CLAUDE_CONFIG', JSON.stringify(config, null, 2) + '\n');
  " || error "Failed to update ${CLAUDE_CONFIG}"
else
  bun -e "
    const fs = require('fs');
    const config = { mcpServers: { '$SERVER_NAME': $SERVER_JSON } };
    fs.writeFileSync('$CLAUDE_CONFIG', JSON.stringify(config, null, 2) + '\n');
  " || error "Failed to create ${CLAUDE_CONFIG}"
fi

check "Saved to ${C_SUBTLE}${CLAUDE_CONFIG}${RESET}"

rail
done_step "Configured $(_elapsed "$STEP_START")"

# ═════════════════════════════════════════════════════════
# Done
# ═════════════════════════════════════════════════════════

TOTAL_ELAPSED=$(_elapsed "$TOTAL_START")

rail
printf "  ${C_RAIL}├───────────────────────────────────────────────╮${RESET}\n"
printf "  ${C_RAIL}│${RESET}                                               ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}│${RESET}  ${BOLD}Next steps${RESET}                                  ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}│${RESET}                                               ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}│${RESET}  ${C_INFO}1.${RESET} Restart Claude Code ${DIM}(or run /mcp)${RESET}        ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}│${RESET}  ${C_INFO}2.${RESET} Try: ${DIM}\"Research BetterAuth v3 sessions\"${RESET}  ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}│${RESET}  ${C_INFO}3.${RESET} Check: ${DIM}\"What has Symposium learned?\"${RESET}    ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}│${RESET}                                               ${C_RAIL}│${RESET}\n"
printf "  ${C_RAIL}├───────────────────────────────────────────────╯${RESET}\n"
rail
printf "  ${C_RAIL}│${RESET}  ${C_SUBTLE}Installed to: %s${RESET}\n" "$INSTALL_DIR"
printf "  ${C_RAIL}│${RESET}  ${C_SUBTLE}Docs: https://github.com/sam-siavoshian/Symposium${RESET}\n"
printf "  ${C_RAIL}│${RESET}  ${C_SUBTLE}Nia:  https://app.trynia.ai${RESET}\n"
printf "  ${C_RAIL}│${RESET}  ${C_SUBTLE}Uninstall: rm -rf ~/.symposium && remove \"symposium\" from ~/.claude.json${RESET}\n"
rail
printf "  ${C_RAIL}└${RESET}  ${C_SUCCESS}Symposium is ready.${RESET} ${DIM}(%s total)${RESET}\n" "$TOTAL_ELAPSED"
printf "\n"
