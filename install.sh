#!/usr/bin/env bash
# @mrrlin-dev/external-agents — one-command installer.
#
# What it does:
#   1. Installs the package globally via `npm i -g @mrrlin-dev/external-agents`.
#   2. Registers the MCP server with EVERY supported host that is on your PATH
#      (Claude Code + Codex). Missing hosts are skipped, not fatal.
#   3. Launches `external-agents init` — brings the local dashboard up on
#      http://127.0.0.1:4711 and opens it in your default browser so you can
#      paste API keys for the free-tier providers (Groq, Cerebras, OpenRouter).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mrrlin-dev/external-agents/main/install.sh | bash
#
# The script is idempotent: re-running it upgrades the npm package and re-runs
# the MCP-registration one-liners (both hosts' `mcp add` is a no-op when the
# entry already matches). Nothing is deleted, nothing is elevated.
set -euo pipefail

say()  { printf '\033[1m→\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

# 1) npm install (global)
if ! command -v npm >/dev/null 2>&1; then
  printf '\033[31m✗\033[0m npm is not on PATH. Install Node.js (>=20) first.\n' >&2
  exit 1
fi

say "Installing @mrrlin-dev/external-agents globally via npm…"
npm install -g @mrrlin-dev/external-agents
ok "Installed. Binaries: external-agents, external-agents-mcp"

# 2) Register the MCP server with every host we can find. Errors are non-fatal
# because the operator may only use one of them.
if command -v claude >/dev/null 2>&1; then
  say "Registering with Claude Code (claude mcp add)…"
  claude mcp add external-agents external-agents-mcp 2>/dev/null && ok "Claude Code wired." || warn "claude mcp add returned non-zero (already registered? or CLI is too old). Manual: claude mcp add external-agents external-agents-mcp"
else
  warn "Claude Code CLI not found on PATH — skipping. Run this yourself later: claude mcp add external-agents external-agents-mcp"
fi

if command -v codex >/dev/null 2>&1; then
  say "Registering with Codex CLI (codex mcp add)…"
  codex mcp add external-agents -- external-agents-mcp 2>/dev/null && ok "Codex CLI wired." || warn "codex mcp add returned non-zero (already registered? or CLI is too old). Manual: codex mcp add external-agents -- external-agents-mcp"
else
  warn "Codex CLI not found on PATH — skipping. Run this yourself later: codex mcp add external-agents -- external-agents-mcp"
fi

# 3) Launch the dashboard. `init` foregrounds the UI process AND opens the
# browser; the operator hits Ctrl-C when done.
say "Launching the local dashboard — paste your free-tier API keys inline…"
say "(Press Ctrl-C to quit the dashboard once you are done.)"
exec external-agents init
