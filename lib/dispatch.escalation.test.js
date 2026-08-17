import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEscalation } from "./dispatch.js";

// resolveEscalation shares its kill-switch check (isAgentEnabled) with
// pickAgents and the dispatch entrypoints — a strong-tier sibling that the
// operator has disabled must not be offered as an escalation target just
// because it is otherwise the right provider/tier.
const registry = {
  agents: [
    { id: "weak-source", provider: "groq", tier: "weak" },
    { id: "strong-sibling", provider: "groq", tier: "strong" },
    { id: "other-provider-strong", provider: "openrouter", tier: "strong" },
  ],
};

test("resolveEscalation picks a same-provider strong-tier sibling by default", () => {
  const esc = resolveEscalation(registry, "weak-source", {});
  assert.equal(esc?.id, "strong-sibling");
});

test("resolveEscalation returns null when the only strong sibling is registry-disabled", () => {
  const disabledRegistry = {
    agents: [
      { id: "weak-source", provider: "groq", tier: "weak" },
      { id: "strong-sibling", provider: "groq", tier: "strong", enabled: false },
    ],
  };
  const esc = resolveEscalation(disabledRegistry, "weak-source", {});
  assert.equal(esc, null);
});

test("resolveEscalation skips a strong sibling the operator disabled via state, even though the registry enables it by default", () => {
  const esc = resolveEscalation(registry, "weak-source", { "strong-sibling": { enabled: false } });
  assert.equal(esc, null, "an operator toggle-off must not be bypassed by naming the source for escalation");
});

test("resolveEscalation honors a state override that re-enables a registry-disabled sibling", () => {
  const disabledRegistry = {
    agents: [
      { id: "weak-source", provider: "groq", tier: "weak" },
      { id: "strong-sibling", provider: "groq", tier: "strong", enabled: false },
    ],
  };
  const esc = resolveEscalation(disabledRegistry, "weak-source", { "strong-sibling": { enabled: true } });
  assert.equal(esc?.id, "strong-sibling");
});

test("resolveEscalation never returns the source itself, even if it is the only strong-tier entry", () => {
  const selfOnly = {
    agents: [
      { id: "strong-source", provider: "groq", tier: "strong" },
    ],
  };
  const esc = resolveEscalation(selfOnly, "strong-source", {});
  assert.equal(esc, null);
});
