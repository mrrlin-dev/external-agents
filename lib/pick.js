function getTransportConfig(entry, transport) {
  const value = entry?.transports?.[transport];
  if (!value) return null;
  if (typeof value === "string") return { cmd: value };
  if (typeof value === "object") return value;
  return null;
}

export function pickAgents(registry, state, opts = {}) {
  const n = Math.max(1, opts.n || 1);
  const filter = opts.filter || {};
  const minDistinct = opts.min_distinct_providers;

  const excludeSet = new Set(filter.exclude_ids || []);
  const requestedTags = filter.tags || [];

  const requestedTransport = filter.transport; // "generate_new" | "edit_exists" | "read_only" | undefined
  const requestedEffort = filter.effort;

  const now = Math.floor(Date.now() / 1000);
  const candidates = registry.agents.filter((entry) => {
    if (excludeSet.has(entry.id)) return false;

    // Kill switch — two layers:
    //   1. Registry `enabled: false` — model disabled by default (e.g. paid-only)
    //   2. State `enabled === false` — operator toggle from the UI
    // State overrides registry: operator can re-enable a registry-disabled model.
    const stateEnabled = state[entry.id]?.enabled;
    if (stateEnabled === false) return false;
    if (entry.enabled === false && stateEnabled !== true) return false;

    const rec = state[entry.id];
    const entryState = rec?.state;
    if (entryState && entryState !== "healthy" && !(rec.cooldown_until != null && now >= rec.cooldown_until)) return false;

    if (filter.tier && entry.tier !== filter.tier) return false;

    if (requestedTags.length > 0) {
      const entryTags = new Set(entry.tags || []);
      for (const t of requestedTags) {
        if (!entryTags.has(t)) return false;
      }
    }

    if (requestedTransport === "read_only") {
      // generate_new (HTTP) has no filesystem access at all, so it satisfies a
      // read_only request without declaring the transport explicitly — same
      // rule as dispatch.js's selectTransport. An edit_exists-only entry with
      // no declared read_only command does NOT qualify: falling back to its
      // write-capable command would silently reproduce the kiro incident.
      if (!getTransportConfig(entry, "read_only") && !getTransportConfig(entry, "generate_new")) return false;
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
  const familyOf = (provider) => String(provider || "").replace(/\d+$/, "");
  // CLI entries share the literal model "default" (cursor-agent, kiro, codex,
  // claude...), so the model alone would collapse unrelated agents into one.
  // Qualify it with the family, which is what actually distinguishes them.
  const voiceOf = (entry) => `${familyOf(entry.provider)}::${entry.model || entry.id}`;

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
