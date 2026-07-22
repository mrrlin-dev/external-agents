#!/usr/bin/env node
// Prints a short banner on `npm i -g @mrrlin-dev/external-agents` completion.
// Skipped when npm runs in a CI or non-interactive context so we do not spam
// build logs. We stay well within npm etiquette — no auto-launch, no network
// calls, just a hint.
if (process.env.CI || process.env.npm_config_production === "true") process.exit(0);
if (!process.stderr.isTTY) process.exit(0);

const G = "\x1b[32m";  // green
const B = "\x1b[1m";   // bold
const D = "\x1b[2m";   // dim
const R = "\x1b[0m";   // reset

process.stderr.write(`
${G}${B}✓ @mrrlin-dev/external-agents installed.${R}

${B}Next step (one command):${R}  ${G}external-agents init${R}
  ${D}↳ opens the local dashboard on http://127.0.0.1:4711${R}
  ${D}↳ paste API keys inline for Groq / Cerebras / OpenRouter (free tiers)${R}
  ${D}↳ each provider unlocks in ~30 seconds${R}

Wire the MCP server into your primary agent:
  ${G}claude mcp add external-agents external-agents-mcp${R}
  ${G}codex  mcp add external-agents -- external-agents-mcp${R}

More at ${B}https://github.com/mrrlin-dev/external-agents${R}
`);
