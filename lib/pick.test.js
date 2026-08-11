import assert from "node:assert/strict";
import { test } from "node:test";

import { pickAgents } from "./pick.js";

const registry = {
  agents: [
    { id: "http-only", provider: "p1", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "edit-only", provider: "p2", transports: { edit_exists: { cmd: "example-cli" } } },
    {
      id: "edit-and-ro",
      provider: "p3",
      transports: {
        edit_exists: { cmd: "example-cli --write", effort_levels: ["low", "high"] },
        read_only: { cmd: "example-cli --safe" },
      },
    },
  ],
};

test("pickAgents --transport read_only matches an implicit generate_new entry", () => {
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(picked.includes("http-only"));
});

test("pickAgents --transport read_only matches an entry with a declared read_only command", () => {
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(picked.includes("edit-and-ro"));
});

test("pickAgents --transport read_only excludes an edit_exists-only entry with no read_only command", () => {
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(!picked.includes("edit-only"));
});

test("pickAgents --transport read_only --effort checks the transport that actually satisfies read_only", () => {
  // edit-and-ro's read_only cmd declares no effort_levels (only its edit_exists
  // cmd does) — a naive check of literal "read_only" would wrongly exclude it.
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only", effort: "high" } });
  assert.ok(!picked.includes("edit-and-ro"), "read_only cmd itself declares no effort_levels");
});

// A numbered provider slug is one API KEY (an independent quota bucket), not
// an independent OPINION — every google<N> serves the same model. Counting raw
// slugs let `min_distinct_providers: 2` be satisfied by four clones of one
// model: a four-seat jury with a single voice.
const keyedRegistry = {
  agents: [
    { id: "flash-3", provider: "google3", model: "gemini-3.6-flash", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "flash-4", provider: "google4", model: "gemini-3.6-flash", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "flash-7", provider: "google7", model: "gemini-3.6-flash", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "flash-8", provider: "google8", model: "gemini-3.6-flash", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "other-a", provider: "groq", model: "llama-3.1-8b", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "other-b", provider: "deepseek", model: "deepseek-v4-flash", transports: { generate_new: { url: "https://example.invalid" } } },
  ],
};

test("pickAgents does not seat the same model twice while another is available", () => {
  const picked = pickAgents(keyedRegistry, {}, { n: 4, min_distinct_providers: 2 });
  const models = picked.map((id) => keyedRegistry.agents.find((a) => a.id === id).model);
  assert.equal(new Set(models).size, 3, `expected 3 distinct models, got ${models.join(", ")}`);
});

test("pickAgents counts diversity per provider family, not per API key", () => {
  const picked = pickAgents(keyedRegistry, {}, { n: 2, min_distinct_providers: 2 });
  const families = picked.map((id) =>
    keyedRegistry.agents.find((a) => a.id === id).provider.replace(/\d+$/, "")
  );
  assert.equal(new Set(families).size, 2, `two google keys are one family, got ${families.join(", ")}`);
});

test("pickAgents still returns n agents, falling back to duplicate models", () => {
  const picked = pickAgents(keyedRegistry, {}, { n: 5, min_distinct_providers: 2 });
  assert.equal(picked.length, 5, "n is a request for n agents, not an upper bound");
  assert.equal(new Set(picked).size, 5, "no agent may be seated twice");
});

test("pickAgents does not collapse distinct CLI agents that share model 'default'", () => {
  const cliRegistry = {
    agents: [
      { id: "cli-a", provider: "cursor", model: "default", transports: { edit_exists: { cmd: "a" } } },
      { id: "cli-b", provider: "kiro", model: "default", transports: { edit_exists: { cmd: "b" } } },
    ],
  };
  const picked = pickAgents(cliRegistry, {}, { n: 2, min_distinct_providers: 2 });
  assert.equal(picked.length, 2, "different agents, same placeholder model — both must be eligible");
});

// Exclusion used to be exact-string, so a caller trying to keep a model out of a
// panel played whack-a-mole: naming one key simply seated the next clone.
test("exclude_ids cascades to every clone of the excluded model", () => {
  const picked = pickAgents(keyedRegistry, {}, {
    n: 4,
    filter: { exclude_ids: ["flash-3"] },
  });
  assert.ok(!picked.some((id) => id.startsWith("flash-")),
    `excluding one key must drop every clone of its model, got ${picked.join(", ")}`);
  assert.deepEqual(picked.sort(), ["other-a", "other-b"], "the rest of the pool is untouched");
});

test("exclude_providers matches by family, so google covers google3..google8", () => {
  const picked = pickAgents(keyedRegistry, {}, {
    n: 4,
    filter: { exclude_providers: ["google"] },
  });
  assert.deepEqual(picked.sort(), ["other-a", "other-b"],
    `the bare family slug must exclude every numbered key, got ${picked.join(", ")}`);
});

test("exclude_providers accepts a numbered slug and still excludes the family", () => {
  const picked = pickAgents(keyedRegistry, {}, {
    n: 4,
    filter: { exclude_providers: ["google7"] },
  });
  assert.ok(!picked.some((id) => id.startsWith("flash-")),
    `naming one key excludes its family — a single key is skipped via state, not here, got ${picked.join(", ")}`);
});

test("exclusion cascade does not collapse distinct models under one family", () => {
  // groq serves two different models; excluding one must not take the other.
  const twoModelFamily = {
    agents: [
      { id: "groq-a", provider: "groq", model: "llama-3.1-8b", transports: { generate_new: { url: "https://example.invalid" } } },
      { id: "groq-b", provider: "groq", model: "gpt-oss-120b", transports: { generate_new: { url: "https://example.invalid" } } },
    ],
  };
  const picked = pickAgents(twoModelFamily, {}, { n: 2, filter: { exclude_ids: ["groq-a"] } });
  assert.deepEqual(picked, ["groq-b"], "same provider, different model — must survive an id exclusion");
});

// The --tier-prefer backfill passes exclude_ids and exclude_providers together:
// already-picked ids plus the FAMILIES they came from. Before family matching,
// excluding the raw slug `google3` left `google4` free to backfill the same model
// into the next slot — the panel looked provider-diverse and was not.
test("exclude_ids and exclude_providers compose, as the tier-prefer backfill uses them", () => {
  const tiered = {
    agents: [
      { id: "flash-3", provider: "google3", tier: "strong", model: "gemini-3.6-flash", transports: { generate_new: { url: "https://example.invalid" } } },
      { id: "flash-4", provider: "google4", tier: "weak", model: "gemini-3.6-flash", transports: { generate_new: { url: "https://example.invalid" } } },
      { id: "other-a", provider: "groq", tier: "weak", model: "llama-3.1-8b", transports: { generate_new: { url: "https://example.invalid" } } },
    ],
  };
  const backfill = pickAgents(tiered, {}, {
    n: 2,
    filter: { tier: "weak", exclude_ids: ["flash-3"], exclude_providers: ["google"] },
  });
  assert.deepEqual(backfill, ["other-a"],
    `backfill must not reseat the primary pick's model under a sibling key, got ${backfill.join(", ")}`);
});
