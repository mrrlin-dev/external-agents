export function pickAgents(registry, state, opts = {}) {
  const n = Math.max(1, opts.n || 1);
  const filter = opts.filter || {};
  const minDistinct = opts.min_distinct_providers;

  const excludeSet = new Set(filter.exclude_ids || []);
  const requestedTags = filter.tags || [];

  const requestedTransport = filter.transport; // "generate_new" | "edit_exists" | undefined

  const candidates = registry.agents.filter((entry) => {
    if (excludeSet.has(entry.id)) return false;

    // Operator kill switch — state.<id>.enabled === false hides the entry
    // from pick + dispatch entirely, regardless of state. Set from the UI
    // toggle. Missing (default) means enabled. Explicit `true` also enabled.
    if (state[entry.id]?.enabled === false) return false;

    const entryState = state[entry.id]?.state;
    if (entryState && entryState !== "healthy") return false;

    if (filter.tier && entry.tier !== filter.tier) return false;

    if (requestedTags.length > 0) {
      const entryTags = new Set(entry.tags || []);
      for (const t of requestedTags) {
        if (!entryTags.has(t)) return false;
      }
    }

    if (requestedTransport && !entry.transports?.[requestedTransport]) return false;

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
