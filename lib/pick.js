import { effectiveCooldownUntil } from "./state.js";

function getTransportConfig(entry, transport) {
  const value = entry?.transports?.[transport];
  if (!value) return null;
  if (typeof value === "string") return { cmd: value };
  if (typeof value === "object") return value;
  return null;
}

// A numbered provider slug is one API KEY within a family: google3 and google4
// are both `google`. Exported because exclusion and diversity must agree on what
// "the same source" means — they were two different answers before, which is how
// `--exclude-providers google` could still seat gemini-3.6-flash-6.
export const providerFamily = (provider) => String(provider || "").replace(/\d+$/, "");

// CLI entries share the literal model "default" (cursor-agent, kiro, codex,
// claude...), so the model alone would collapse unrelated agents into one.
// Qualify it with the family, which is what actually distinguishes them.
export const agentVoice = (entry) => `${providerFamily(entry.provider)}::${entry.model || entry.id}`;

// The operator kill switch, two layers:
//   1. Registry `enabled: false` — model disabled by default (e.g. paid-only)
//   2. State `enabled === false` — operator toggle from the UI/CLI
// State overrides registry: operator can re-enable a registry-disabled model.
// Shared by pickAgents below AND the dispatch entrypoints (cli.js, server.js)
// — a disabled entry must refuse a direct, by-id dispatch too, not just be
// hidden from automatic picking. Naming an id explicitly is not consent to
// bypass a switch the operator flipped off on purpose.
export function isAgentEnabled(entry, state) {
  const stateEnabled = state?.[entry.id]?.enabled;
  if (stateEnabled === false) return false;
  if (entry.enabled === false && stateEnabled !== true) return false;
  return true;
}

export function pickAgents(registry, state, opts = {}) {
  const n = Math.max(1, opts.n || 1);
  const filter = opts.filter || {};
  const minDistinct = opts.min_distinct_providers;

  const requestedTags = filter.tags || [];

  const requestedTransport = filter.transport; // "generate_new" | "edit_exists" | "read_only" | undefined
  const requestedEffort = filter.effort;

  // Bytes→tokens at 4:1. Deliberately crude and deliberately on the low side of
  // no estimate at all: the point is to keep a 40 KB review prompt away from an
  // 8000-TPM seat, not to predict a tokenizer. Callers that know better can pass
  // prompt_tokens directly.
  const estimatedTokens = Number.isFinite(filter.prompt_tokens)
    ? filter.prompt_tokens
    : Number.isFinite(filter.prompt_bytes)
    ? Math.ceil(filter.prompt_bytes / 4)
    : null;

  // Exclusion cascades to every clone of what was excluded, on both axes.
  //
  // Naming ONE key excluded ONE key, so a caller trying to keep a model out of a
  // panel played whack-a-mole: `--exclude gemini-3.6-flash-6` simply seated
  // gemini-3.6-flash-5 instead, and `--exclude-providers google` (exact slug
  // match) seated it too, because the clones live under google3..google8. Both
  // are the same mistake 0.41.0 fixed for diversity — counting keys where the
  // caller means sources — so they now use the same family/voice identity.
  //
  // An excluded id therefore removes every entry sharing its voice, and an
  // excluded provider removes its whole family. Excluding a single key is not a
  // use case this supports: a key that is merely rate-limited or out of quota is
  // already skipped via state, which is the mechanism that belongs to keys.
  const excludedIds = new Set(filter.exclude_ids || []);
  const excludedFamilies = new Set((filter.exclude_providers || []).map(providerFamily));
  const excludedVoices = new Set();
  for (const entry of registry.agents) {
    if (excludedIds.has(entry.id)) excludedVoices.add(agentVoice(entry));
  }

  // A TPM ceiling belongs to the MODEL, and the numbered keys are clones of it —
  // the same identity the exclusion and diversity logic above already collapses
  // on. Measured: of eight model families that declare limits, every one has
  // numbered siblings declaring none (groq-gpt-oss-120b-2, gemini-3.6-flash-3..9,
  // openrouter-nemotron-*-2 …), so a per-entry read would have skipped the
  // oversized seat and then handed the prompt straight to its clone. Inheriting
  // by voice fixes all of them at once, including keys added later.
  const limitsByVoice = new Map();
  for (const entry of registry.agents) {
    if (!entry.token_limits) continue;
    const voice = agentVoice(entry);
    if (!limitsByVoice.has(voice)) limitsByVoice.set(voice, entry.token_limits);
  }

  const now = Math.floor(Date.now() / 1000);
  const candidates = registry.agents.filter((entry) => {
    if (excludedIds.has(entry.id)) return false;
    if (excludedVoices.has(agentVoice(entry))) return false;
    if (excludedFamilies.has(providerFamily(entry.provider))) return false;

    if (!isAgentEnabled(entry, state)) return false;

    // A non-healthy verdict blocks the entry until it EXPIRES. What counts as
    // expiry is derived, not read straight off the record: errored_transient
    // records written before this rule existed carry no cooldown_until at all,
    // and reading the raw field would keep filtering them out forever. See
    // effectiveCooldownUntil in state.js.
    const rec = state[entry.id];
    const entryState = rec?.state;
    if (entryState && entryState !== "healthy") {
      const expiresAt = effectiveCooldownUntil(rec);
      if (!(expiresAt != null && now >= expiresAt)) return false;
    }

    if (filter.tier && entry.tier !== filter.tier) return false;

    if (requestedTags.length > 0) {
      const entryTags = new Set(entry.tags || []);
      for (const t of requestedTags) {
        if (!entryTags.has(t)) return false;
      }
    }

    // Sizing. `token_limits` has been in the registry all along, for exactly
    // this — "machine-readable sizing facts for whoever is PICKING an agent for
    // a prompt … so an oversized prompt can be routed elsewhere instead of
    // failing live" — and nothing read it, so oversized prompts kept being
    // seated and kept failing live: seven recorded HTTP 413s, all groq, all
    // "Request too large … TPM: Limit 8000, Requested 8118/8195/10098", against
    // an entry whose own note in the registry warns about that exact cap.
    //
    // A missing limit is not a refusal: most entries declare nothing, and
    // treating silence as "too small" would empty the pool. Only a limit that
    // is present AND smaller than the request removes the entry.
    if (estimatedTokens != null) {
      const limits = entry.token_limits || limitsByVoice.get(agentVoice(entry));
      if (limits) {
        if (Number.isFinite(limits.tpm) && limits.tpm < estimatedTokens) return false;
        if (Number.isFinite(limits.context_window) && limits.context_window < estimatedTokens) return false;
      }
    }

    if (requestedTransport === "read_only") {
      // The rule here must be selectTransport's rule, exactly. It was looser —
      // a bare generate_new counted, on the true observation that an HTTP call
      // cannot write — and the comment claimed the two matched. They did not:
      // dispatch requires the declaration to be EXPLICIT, because an entry
      // nobody had considered is otherwise indistinguishable from one
      // deliberately cleared for read-only use (#32). So `pick` handed out
      // seats that `dispatch` then refused, with an uncaught stack trace: 11 of
      // 16 consecutive consensus rounds lost a reviewer that way.
      //
      // Fixed on the side that was wrong. An entry that really is read-only by
      // construction says so — `read_only: {via: generate_new}` — and `add-model`
      // now writes that for every entry it creates.
      const ro = getTransportConfig(entry, "read_only");
      if (!ro) return false;
      // `via` may only delegate to generate_new, and only if it exists —
      // selectTransport throws otherwise, and a seat that cannot be dispatched
      // is worse than an empty one.
      if (ro.via && (ro.via !== "generate_new" || !getTransportConfig(entry, "generate_new"))) return false;
    } else if (requestedTransport && !getTransportConfig(entry, requestedTransport)) {
      return false;
    }

    if (requestedEffort) {
      // "read_only" is satisfied by either a declared read_only cmd or an
      // implicit generate_new — check whichever of those two actually exists,
      // not the literal string "read_only" (which a generate_new-only entry
      // never declares and would otherwise wrongly fail this check).
      const transportsToCheck = requestedTransport === "read_only"
        ? ["read_only", "generate_new"]
        : requestedTransport
        ? [requestedTransport]
        : Object.keys(entry.transports || {});
      const supportsEffort = transportsToCheck.some((transport) => {
        const config = getTransportConfig(entry, transport);
        return Array.isArray(config?.effort_levels) && config.effort_levels.includes(requestedEffort);
      });
      if (!supportsEffort) return false;
    }

    return true;
  });

  candidates.sort((a, b) => {
    const pa = a.preference_order ?? 999;
    const pb = b.preference_order ?? 999;
    if (pa !== pb) return pa - pb;
    const la = state[a.id]?.last_used_at ?? 0;
    const lb = state[b.id]?.last_used_at ?? 0;
    return la - lb;
  });

  // Two axes get conflated here, and keeping them apart is the whole point.
  //
  // A numbered provider slug (google3, google4, ...) is one API KEY — a real,
  // independent QUOTA bucket, which is why dispatch round-robins across them.
  // It is not an independent OPINION: every one of them serves the same
  // gemini-3.6-flash. Counting raw slugs let `min_distinct_providers: 2` be
  // satisfied by four clones of one model — a four-seat jury with one voice,
  // which is the exact failure a panel exists to avoid.
  //
  // So: diversity is counted per FAMILY (slug with its key suffix stripped),
  // and no model is seated twice while an unseated one is still available.
  // Quota spreading is unaffected — it happens at dispatch, across the keys
  // of whichever entry gets picked.
  const familyOf = providerFamily;
  const voiceOf = agentVoice;

  const picked = [];
  const seenFamilies = new Set();
  const seenVoices = new Set();
  const skipped = [];

  for (const entry of candidates) {
    if (picked.length >= n) break;
    const family = familyOf(entry.provider);
    const voice = voiceOf(entry);
    const needsMoreFamilies = minDistinct != null && seenFamilies.size < minDistinct;
    if ((needsMoreFamilies && seenFamilies.has(family)) || seenVoices.has(voice)) {
      skipped.push(entry);
      continue;
    }
    picked.push(entry.id);
    seenFamilies.add(family);
    seenVoices.add(voice);
  }

  // Backfill. `n` is a request for N agents, and a caller that asks for four
  // and needs four should not silently get two because the pool ran out of
  // distinct models. Duplicates are the fallback, never the first choice —
  // and they arrive in the same preference/least-recently-used order the main
  // pass used, so the extra seats still spread across keys.
  for (const entry of skipped) {
    if (picked.length >= n) break;
    picked.push(entry.id);
  }

  return picked;
}
