"""
Symposium-enhanced Claude Code agent for Terminal-Bench 2.0.

Extends Harbor's built-in ClaudeCode agent with Symposium MCP server.
The MCP server gives Claude access to a multi-agent research engine
that verifies APIs against live docs and real GitHub repos.

Usage:
    harbor run -d terminal-bench/terminal-bench-2 \
        --agent-import-path benchmark/symposium_agent:SymposiumClaudeCode \
        -m anthropic/claude-opus-4-6 \
        -n 13 -y
"""

import json
import os
import shlex

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment


# Path to Symposium source on the HOST machine (used for reference only)
SYMPOSIUM_SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Git URL for cloning Symposium into containers
# TODO: replace with your actual repo URL if private
SYMPOSIUM_GIT_URL = os.environ.get(
    "SYMPOSIUM_GIT_URL",
    f"file://{SYMPOSIUM_SRC}",  # Default: local git repo
)


class SymposiumClaudeCode(ClaudeCode):
    """Claude Code + Symposium MCP. Knowledge compounds across tasks."""

    @staticmethod
    def name() -> str:
        return "symposium-claude-code"

    async def install(self, environment: BaseEnvironment) -> None:
        # Standard Claude Code install (curl + claude CLI)
        await super().install(environment)

        # Install Bun (Symposium's runtime)
        await self.exec_as_root(
            environment,
            command=(
                "curl -fsSL https://bun.sh/install | bash && "
                'echo \'export BUN_INSTALL="/root/.bun"\' >> /etc/profile.d/bun.sh && '
                'echo \'export PATH="/root/.bun/bin:$PATH"\' >> /etc/profile.d/bun.sh'
            ),
        )

        # Also set up Bun for the agent user
        await self.exec_as_agent(
            environment,
            command=(
                "curl -fsSL https://bun.sh/install | bash && "
                'echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> ~/.bashrc'
            ),
        )

        # Copy Symposium source into the container
        # We tar the source on the host and pipe it into the container
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p ~/symposium && "
                "cd ~/symposium && "
                f"git clone --depth 1 {shlex.quote(SYMPOSIUM_GIT_URL)} . 2>/dev/null || "
                # Fallback: if git clone fails (e.g., no .git), try direct copy approach
                "true"
            ),
        )

        # Install Symposium dependencies
        await self.exec_as_agent(
            environment,
            command=(
                'export PATH="$HOME/.bun/bin:$PATH" && '
                "cd ~/symposium && "
                "bun install --frozen-lockfile 2>/dev/null || bun install"
            ),
        )

    def _build_register_mcp_servers_command(self) -> str | None:
        """Register Symposium MCP server alongside any task-defined MCP servers."""
        parent_cmd = super()._build_register_mcp_servers_command()

        nia_key = os.environ.get("NIA_API_KEY", "")
        if not nia_key:
            print("WARNING: NIA_API_KEY not set. Symposium MCP will fail to authenticate.")
            return parent_cmd

        # Build the Symposium server config
        symposium_server = {
            "type": "stdio",
            "command": "bun",
            "args": ["run", "/home/user/symposium/src/index.ts"],
            "env": {"NIA_API_KEY": nia_key},
        }

        if parent_cmd:
            # Parent already writes a .claude.json. Merge Symposium into it.
            merge_script = (
                "python3 -c \""
                "import json; "
                "f=open(\\\"$CLAUDE_CONFIG_DIR/.claude.json\\\"); "
                "cfg=json.load(f); f.close(); "
                "cfg.setdefault(\\\"mcpServers\\\", {})[\\\"symposium\\\"] = "
                f"{json.dumps(symposium_server)}; "
                "f=open(\\\"$CLAUDE_CONFIG_DIR/.claude.json\\\", \\\"w\\\"); "
                "json.dump(cfg, f, indent=2); f.close()"
                "\""
            )
            return f"{parent_cmd} && {merge_script}"
        else:
            # No parent MCP config. Write fresh.
            config = {"mcpServers": {"symposium": symposium_server}}
            escaped = shlex.quote(json.dumps(config, indent=2))
            return f"echo {escaped} > $CLAUDE_CONFIG_DIR/.claude.json"
