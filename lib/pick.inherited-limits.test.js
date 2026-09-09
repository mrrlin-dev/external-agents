import assert from "node:assert/strict";
import { test } from "node:test";

import { inheritedTokenLimits } from "./pick.js";

// Extracted from pickAgents' own `limitsByVoice` build (lib/pick.js) so
// dispatch.js's oversized-prompt precheck can look up the same
// sibling-inherited token_limits pick already uses, without duplicating the
// voice-collapsing logic pick was fixed to use in #51/#54.

const registry = {
  agents: [
    { id: "groq-gpt-oss-120b", provider: "groq", model: "openai/gpt-oss-120b", token_limits: { tpm: 8000 } },
    { id: "groq-gpt-oss-120b-2", provider: "groq2", model: "openai/gpt-oss-120b" }, // no own limits
    { id: "unrelated", provider: "openrouter", model: "some/other-model" },
  ],
};

test("inheritedTokenLimits returns the entry's own declared limits when it has them", () => {
  const entry = registry.agents[0];
  assert.deepEqual(inheritedTokenLimits(registry, entry), { tpm: 8000 });
});

test("inheritedTokenLimits finds a same-voice sibling's declared limits", () => {
  const entry = registry.agents[1];
  assert.deepEqual(inheritedTokenLimits(registry, entry), { tpm: 8000 });
});

test("inheritedTokenLimits returns null when no entry sharing the voice declares limits", () => {
  const entry = registry.agents[2];
  assert.equal(inheritedTokenLimits(registry, entry), null);
});
