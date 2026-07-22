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

# 1b) aider (Python) — required for the `edit_exists` transport that gives
# real agentic file-editing behavior across ~100 providers via LiteLLM. It is
# a separate Python package because npm cannot install Python code. Best-
# effort: pipx first (isolated, cleanest), then pip3 --user, then a warning.
# We do NOT fail the install if none of those work — the operator can still
# use generate_new transport for free-tier providers, and install aider later.
say "Installing aider (Python — for agentic file-editing transport)…"
if command -v aider >/dev/null 2>&1; then
  ok "aider already installed: $(aider --version 2>&1 | head -1)"
elif command -v pipx >/dev/null 2>&1; then
  pipx install aider-chat >/dev/null 2>&1 && ok "aider installed via pipx." || warn "pipx install aider-chat failed. Install manually: pipx install aider-chat"
elif command -v pip3 >/dev/null 2>&1; then
  # Some distros gate pip3 with PEP 668 externally-managed marker — try
  # --user first, then --break-system-packages as a last resort.
  if pip3 install --user aider-chat >/dev/null 2>&1; then
    ok "aider installed via pip3 --user (add ~/.local/bin to PATH if 'aider' is not found)."
  elif pip3 install --user --break-system-packages aider-chat >/dev/null 2>&1; then
    ok "aider installed via pip3 --user --break-system-packages."
  else
    warn "pip3 install aider-chat failed. Install manually: pip install aider-chat"
  fi
elif command -v python3 >/dev/null 2>&1; then
  python3 -m ensurepip --user >/dev/null 2>&1 || true
  if python3 -m pip install --user aider-chat >/dev/null 2>&1; then
    ok "aider installed via python3 -m pip --user (add ~/.local/bin to PATH if 'aider' is not found)."
  else
    warn "python3 -m pip install aider-chat failed. Install manually: pip install aider-chat"
  fi
else
  warn "python3 not found on PATH — skipping aider. Install Python 3.10+ then run: pip install aider-chat"
  warn "  Free-tier providers (Groq / Cerebras / OpenRouter / Gemini / DeepSeek) still work through the 'generate_new' transport (native fetch — no aider required)."
fi

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
