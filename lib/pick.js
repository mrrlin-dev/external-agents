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

  const requestedTransport = filter.transport; // "generate_new" | "edit_exists" | undefined
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

    if (requestedTransport && !getTransportConfig(entry, requestedTransport)) return false;

    if (requestedEffort) {
      const transportsToCheck = requestedTransport
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

  const picked = [];
  const seenProviders = new Set();
  for (const entry of candidates) {
    if (picked.length >= n) break;
    if (minDistinct != null && seenProviders.size < minDistinct && seenProviders.has(entry.provider)) {
      continue;
    }
    picked.push(entry.id);
    seenProviders.add(entry.provider);
  }

  return picked;
}
