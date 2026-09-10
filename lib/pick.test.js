import assert from "node:assert/strict";
import { test } from "node:test";

import { pickAgents, isAgentEnabled } from "./pick.js";
import { selectTransport } from "./dispatch.js";

const registry = {
  agents: [
    { id: "http-only", provider: "p1", transports: { generate_new: { url: "https://example.invalid" } } },
    {
      id: "http-declared",
      provider: "p4",
      transports: {
        read_only: { via: "generate_new", verified: "by_construction" },
        generate_new: { url: "https://example.invalid" },
      },
    },
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

test("pickAgents --transport read_only excludes an HTTP entry that does not DECLARE read_only", () => {
  // This used to match, on the true observation that an HTTP call cannot write.
  // dispatch.js disagreed: it requires the declaration to be explicit, because
  // an entry nobody has considered otherwise looks identical to one deliberately
  // cleared for read-only use (#32). pick handed out a seat, selectTransport
  // threw, and the panel lost a reviewer in 11 of 16 consecutive gate rounds.
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(!picked.includes("http-only"));
});

test("pickAgents --transport read_only matches an HTTP entry that declares read_only via generate_new", () => {
  const picked = pickAgents(registry, {}, { n: 4, filter: { transport: "read_only" } });
  assert.ok(picked.includes("http-declared"));
});

test("pick and selectTransport agree about read_only for every entry", () => {
  // The invariant the two sides drifted on. Written as a loop over the whole
  // fixture so a future entry shape cannot reintroduce the disagreement in one
  // place only.
  for (const entry of registry.agents) {
    const seated = pickAgents({ agents: [entry] }, {}, { n: 1, filter: { transport: "read_only" } })
      .includes(entry.id);
    let dispatchable = true;
    try {
      selectTransport(entry, { transport: "read_only", cwd: "/repo" });
    } catch {
      dispatchable = false;
    }
    assert.equal(seated, dispatchable, `${entry.id}: pick says ${seated}, selectTransport says ${dispatchable}`);
  }
});

test("pickAgents --transport read_only excludes a read_only that delegates to a missing transport", () => {
  // selectTransport throws on this shape, so seating it would be a seat that
  // cannot be dispatched.
  const broken = { agents: [{ id: "bad-via", provider: "p9", transports: { read_only: { via: "generate_new" } } }] };
  const picked = pickAgents(broken, {}, { n: 1, filter: { transport: "read_only" } });
  assert.deepEqual(picked, []);
});

test("pickAgents --prompt-bytes skips an agent whose declared limits cannot hold the prompt", () => {
  // Seven recorded HTTP 413s, all "Request too large … TPM: Limit 8000", against
  // an entry whose own registry note warns about that cap. The facts were in the
  // registry; nothing read them.
  const sized = { agents: [
    { id: "small-tpm", provider: "p1", transports: { read_only: { via: "generate_new" }, generate_new: { url: "u" } }, token_limits: { tpm: 8000 } },
    { id: "big-tpm", provider: "p2", transports: { read_only: { via: "generate_new" }, generate_new: { url: "u" } }, token_limits: { tpm: 250000 } },
    { id: "no-limits", provider: "p3", transports: { read_only: { via: "generate_new" }, generate_new: { url: "u" } } },
  ] };
  const f = (bytes) => pickAgents(sized, {}, { n: 5, filter: { transport: "read_only", prompt_bytes: bytes } });
  // 40 KB ≈ 10k tokens: over the 8000 cap, under 250000.
  assert.ok(!f(40000).includes("small-tpm"));
  assert.ok(f(40000).includes("big-tpm"));
  // An entry that declares no limits is not refused — silence is not "too small",
  // and treating it as such would empty the pool.
  assert.ok(f(40000).includes("no-limits"));
  // A small prompt keeps everyone.
  assert.ok(f(4000).includes("small-tpm"));
  // No sizing asked for: the filter does not run at all.
  assert.ok(pickAgents(sized, {}, { n: 5, filter: { transport: "read_only" } }).includes("small-tpm"));
});

test("--prompt-bytes sizes with an upper-bound ratio, not the median", () => {
  // The 413 this ratio exists to stop: groq-gpt-oss-120b-2 rejected a
  // 28,930-byte prompt against its measured 8000-token ceiling. At the old 4:1
  // that estimated 7233 tokens — under the cap, so the gate seated it and the
  // provider did the refusing. Real bytes/token bottoms out near 2.44 across
  // 4004 measured dispatches; 4.0 was the median, which is the wrong statistic
  // for a bound.
  const sized = { agents: [
    { id: "small-tpm", provider: "p1", transports: { read_only: { via: "generate_new" }, generate_new: { url: "u" } }, token_limits: { tpm: 8000 } },
  ] };
  const f = (bytes) => pickAgents(sized, {}, { n: 5, filter: { transport: "read_only", prompt_bytes: bytes } });

  assert.deepEqual(f(28930), [], "the recorded 413 payload must not be seated on an 8000-token seat");
  // The boundary, stated in bytes so a ratio change has to move it on purpose:
  // 8000 tokens × 3.5 = 28,000 bytes.
  assert.deepEqual(f(28001), [], "just over the ceiling is refused");
  assert.deepEqual(f(28000), ["small-tpm"], "exactly at the ceiling still fits");

  // prompt_tokens is a real count, so it bypasses the ratio entirely.
  assert.deepEqual(
    pickAgents(sized, {}, { n: 5, filter: { transport: "read_only", prompt_tokens: 7233 } }),
    ["small-tpm"],
    "a caller's own token count is trusted as given",
  );
});

test("token limits are inherited from a sibling key serving the same model", () => {
  // Measured: of eight model families declaring limits, every one has numbered
  // siblings declaring none — so a per-entry read would skip the oversized seat
  // and hand the prompt straight to its clone.
  const clones = { agents: [
    { id: "groq-x", provider: "groq", model: "openai/gpt-oss-120b", transports: { read_only: { via: "generate_new" }, generate_new: { url: "u" } }, token_limits: { tpm: 8000 } },
    { id: "groq-x-2", provider: "groq2", model: "openai/gpt-oss-120b", transports: { read_only: { via: "generate_new" }, generate_new: { url: "u" } } },
  ] };
  const picked = pickAgents(clones, {}, { n: 5, filter: { transport: "read_only", prompt_bytes: 40000 } });
  assert.deepEqual(picked, []);
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

// isAgentEnabled is the shared kill-switch check pickAgents filters on AND
// the dispatch entrypoints (cli.js, server.js) guard with directly, so a
// disabled entry refuses a direct by-id dispatch and not just automatic
// picking. All four (registry × state) combinations must agree with pickAgents.
test("isAgentEnabled: registry-enabled entry is enabled with no state record", () => {
  assert.equal(isAgentEnabled({ id: "a" }, {}), true);
});

test("isAgentEnabled: registry-disabled entry with no state override stays disabled", () => {
  assert.equal(isAgentEnabled({ id: "a", enabled: false }, {}), false);
});

test("isAgentEnabled: state enabled:true overrides a registry-disabled entry", () => {
  assert.equal(isAgentEnabled({ id: "a", enabled: false }, { a: { enabled: true } }), true);
});

test("isAgentEnabled: state enabled:false disables a registry-enabled entry (operator toggle)", () => {
  assert.equal(isAgentEnabled({ id: "a" }, { a: { enabled: false } }), false);
});

// ---------------------------------------------------------------------------
// Expiry of a non-healthy verdict.
//
// errored_transient used to be permanent: it was the one failing state that
// never recorded a cooldown, and this filter only readmits an entry once a
// cooldown has ELAPSED. So one bad minute — a 5xx, a timeout, a probe run with
// a broken PATH — took an agent out of every future pick until a human noticed
// and re-probed it by hand. Nobody notices; the pool just quietly gets weaker.
// ---------------------------------------------------------------------------
const expiryRegistry = {
  agents: [
    { id: "flaky", provider: "p1", tier: "strong", transports: { generate_new: { url: "https://example.invalid" } } },
  ],
};

test("a legacy errored_transient record with no cooldown stops blocking once its derived expiry passes", () => {
  const fresh = Math.floor(Date.now() / 1000);
  assert.deepEqual(
    pickAgents(expiryRegistry, { flaky: { state: "errored_transient", checked: fresh } }, { n: 1 }),
    [],
    "a verdict from a moment ago must still bind",
  );

  const stale = fresh - 4000; // well past ERRORED_TRANSIENT_TTL_S
  assert.deepEqual(
    pickAgents(expiryRegistry, { flaky: { state: "errored_transient", checked: stale } }, { n: 1 }),
    ["flaky"],
    "an old transient verdict must not keep an agent out of the pool forever",
  );
});

test("standing conditions keep blocking however old they are", () => {
  const ancient = Math.floor(Date.now() / 1000) - 90 * 86400;
  for (const state of ["needs_auth", "model_unavailable"]) {
    assert.deepEqual(
      pickAgents(expiryRegistry, { flaky: { state, checked: ancient } }, { n: 1 }),
      [],
      `${state} is a standing condition, not a moment — age must not clear it`,
    );
  }
});

test("an explicit unexpired cooldown still wins over the derived one", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(
    pickAgents(
      expiryRegistry,
      { flaky: { state: "errored_transient", checked: now - 4000, cooldown_until: now + 3600 } },
      { n: 1 },
    ),
    [],
  );
});
