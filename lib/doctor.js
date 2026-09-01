// `external-agents doctor` — does the pool still meet the five goals?
//
// The goals are in README ("What this is optimizing for"). This file is the part
// that checks them instead of assuming them, because every single defect fixed in
// this area was found in the logs and none of them was found by reading code:
// a 5000-token ceiling nobody had written down, a one-second cooldown obeyed
// literally, an agent seated 73 times without once answering. All three were
// visible in telemetry for weeks while everything looked fine.
//
// So the checks below are deliberately shaped as "what would this defect look
// like tomorrow", not as general statistics. Each one names the goal it defends,
// carries the evidence that would let somebody verify or dismiss it, and says
// what to do about it. A check that cannot say what to do is noise, and noise in
// a daily job is worse than no daily job — it trains you to close the report.

import { QUARANTINE_AFTER_ATTEMPTS, quarantineReason } from "./outcome.js";
import { effectiveTokenCeiling } from "./budget.js";
import { agentVoice, isAgentEnabled, providerFamily } from "./pick.js";

// Test fixtures used to dispatch through the real path and fail on purpose,
// because there was nowhere else for them to write — measured: they contributed
// 174 guaranteed failures to a 1472-failure total. The suite now redirects
// itself with EXTERNAL_AGENTS_DISPATCH_LOG_FILE, so nothing new arrives here.
// The filter stays because the rows it subtracts are already on disk and would
// skew every threshold below for as long as the window can still reach them.
const FIXTURE = /^test-/;

// Where the log is, how long it is kept and how it is read back belong to one
// module now — doctor read it through a second private copy of the path that
// could not see an override the writer honoured.
export { getDispatchLogPath, readDispatchRows } from "./dispatch-log.js";

// Re-exported, not re-implemented. There were three copies of this expression
// across lib/ and a reviewer was right to call it out: two of them can share one,
// and the third (quota-reset.js) cannot only because importing pick.js from there
// would close a cycle — pick imports budget, budget imports quota-reset. That one
// keeps a local copy with the reason written next to it.
export const providerFamilyOf = providerFamily;

/**
 * Every check, run over one window.
 *
 * @param {object} p
 * @param {Array<object>} p.rows   dispatch-log rows
 * @param {object} p.registry      loaded registry
 * @param {object} p.state         state.json
 * @param {number} p.since         epoch seconds — window start
 * @param {number} p.now           epoch seconds
 */
export function runChecks({ rows, registry, state, since, now }) {
  const win = rows.filter((r) => (r.ts || 0) >= since && !FIXTURE.test(String(r.agent_id || "")));
  const windowHours = Math.max(1, Math.round((now - since) / 3600));
  const findings = [];
  const add = (f) => findings.push(f);

  // ---- goal 2: a prompt that gets sent fits -------------------------------
  // After the observed-limits ledger, a 413 is not bad luck. Something seated a
  // prompt that the seat's own headers had already said it could not hold, so
  // either the ceiling was never measured or the estimate was consulted and
  // ignored. Both are bugs in here, not in the provider.
  const oversized = win.filter((r) => r.http_status === 413);
  if (oversized.length > 0) {
    const byAgent = tally(oversized.map((r) => r.agent_id));
    add({
      id: "oversized_dispatch",
      goal: 2,
      severity: "high",
      summary: `${oversized.length} dispatch(es) rejected as too large in the last ${windowHours}h`,
      detail:
        "A 413 means a prompt was seated on an agent that could not hold it. With the "
        + "observed-limits ledger in place this should be unreachable: either the agent's "
        + "ceiling has never been measured, or the caller did not pass --prompt-bytes.",
      remedy: `external-agents audit --provider ${providerFamilyOf(oversized[0].provider)}`,
      evidence: Object.entries(byAgent).map(([id, n]) => `${id} ×${n}`),
    });
  }

  // ---- goal 1: a seat that gets handed out is alive -----------------------
  // The quarantine rule exists to make this impossible, so anything showing up
  // here means the mechanism itself regressed — a state write that drops the
  // health block, a pick path that skips the filter.
  const perAgent = {};
  for (const r of win) {
    const a = (perAgent[r.agent_id] ??= { n: 0, ok: 0, ts: [] });
    a.n++;
    if (r.outcome === "success") a.ok++;
  }
  const neverAnswered = Object.entries(perAgent)
    .filter(([, a]) => a.n >= QUARANTINE_AFTER_ATTEMPTS && a.ok === 0)
    .map(([id, a]) => ({ id, ...a }));
  for (const a of neverAnswered) {
    const quarantined = Boolean(quarantineReason(state[a.id]));
    add({
      id: "never_answered",
      goal: 1,
      severity: quarantined ? "low" : "high",
      summary: `${a.id}: ${a.n} dispatches, 0 successes in the last ${windowHours}h`,
      detail: quarantined
        ? "Already quarantined, so the mechanism worked — these are the attempts it took to "
          + "reach the bar. Nothing to do unless the count keeps climbing."
        : "Not quarantined despite never answering. The health counters are the only thing "
          + "standing between this and the 73-failures-over-40-days pattern, so this is a "
          + "regression in the counters or in the pick filter, not a provider problem.",
      remedy: quarantined ? null : `external-agents audit; then check state.json .["${a.id}"].health`,
      evidence: [`attempts=${a.n}`, `successes=0`, `quarantined=${quarantined}`],
    });
  }

  // ---- goal 2, leading indicator: seats nobody has measured ---------------
  // This is the check that would have caught azure-kimi-k2-5-safe on day one
  // instead of after 45 impossible dispatches. An unmeasured seat is not broken;
  // it is a seat `pick` cannot protect, which is strictly worse than a small one.
  const unmeasured = [];
  const limitsByVoice = new Map();
  for (const e of registry.agents) {
    if (e.token_limits && !limitsByVoice.has(agentVoice(e))) limitsByVoice.set(agentVoice(e), e.token_limits);
  }
  for (const e of registry.agents) {
    if (!isAgentEnabled(e, state)) continue;
    if (!e.transports?.generate_new?.url) continue; // only HTTP seats report headers
    const { tpm, source } = effectiveTokenCeiling(e, state[e.id], limitsByVoice.get(agentVoice(e)), now);
    const ctx = (e.token_limits || limitsByVoice.get(agentVoice(e)) || {}).context_window;
    if (tpm == null && !Number.isFinite(ctx)) unmeasured.push(`${e.id} [${e.provider}] (${source})`);
  }
  if (unmeasured.length > 0) {
    add({
      id: "unmeasured_seat",
      goal: 2,
      severity: "medium",
      summary: `${unmeasured.length} enabled HTTP seat(s) have no token ceiling, declared or observed`,
      detail:
        "Nothing can keep an oversized prompt away from these. One audit fixes it — the probe "
        + "reads the real ceiling out of the response headers, which is how every other seat "
        + "in the pool got its number.",
      remedy: "external-agents audit",
      evidence: unmeasured,
    });
  }

  // ---- goal 3: more successes, fewer failures -----------------------------
  const total = win.length;
  const ok = win.filter((r) => r.outcome === "success").length;
  const rate = total > 0 ? ok / total : null;
  if (total >= 20 && rate != null && rate < SUCCESS_FLOOR) {
    add({
      id: "success_rate",
      goal: 3,
      severity: "high",
      summary: `success rate ${(rate * 100).toFixed(1)}% over ${total} dispatches (floor ${(SUCCESS_FLOOR * 100).toFixed(0)}%)`,
      detail:
        "The measured baseline before the ledger landed was 73.1% over the trailing week, and "
        + "26.9% of dispatches were being thrown away. Dropping back toward that means a fix "
        + "stopped working rather than that the pool is merely busy.",
      remedy: "external-agents doctor --json | jq '.by_status' to see which class grew",
      evidence: statusTally(win),
    });
  }

  // ---- goal 4: load spreads across the live models of a tier -------------
  for (const tier of ["strong", "weak"]) {
    const ids = new Set(registry.agents.filter((a) => a.tier === tier).map((a) => a.id));
    const inTier = win.filter((r) => ids.has(r.agent_id));
    if (inTier.length < 20) continue;
    const counts = tally(inTier.map((r) => r.agent_id));
    const distinct = Object.keys(counts).length;
    if (distinct < 3) continue;
    const [topId, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const share = topN / inTier.length;
    // Fair share plus a wide margin: with N agents in play, any one of them
    // taking more than three times its share is concentration, not luck.
    const threshold = Math.min(0.6, (1 / distinct) * 3);
    if (share > threshold) {
      add({
        id: "tier_imbalance",
        goal: 4,
        severity: "low",
        summary: `${topId} took ${(share * 100).toFixed(0)}% of ${tier}-tier dispatches (${distinct} agents in play)`,
        detail:
          "Health-banded LRU should spread this. A single seat dominating usually means the "
          + "others are being filtered out — cooled down, quarantined, or size-gated — so the "
          + "concentration is a symptom and the filtered seats are the thing to look at.",
        remedy: "external-agents status | grep -v healthy",
        evidence: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ×${v}`),
      });
    }
  }

  // ---- goal 5: provider limits get spent, not admired --------------------
  // Reported only where a per-key `rpd` is actually known. Guessing a
  // denominator would turn the one goal that is about *unused* capacity into the
  // least trustworthy number in the report.
  const byFamily = {};
  for (const r of win) {
    const f = providerFamilyOf(r.provider);
    const fam = (byFamily[f] ??= { requests: 0, tokens_in: 0, token_pressure: 0 });
    fam.requests++;
    fam.tokens_in += r.tokens_in || 0;
    // 413 and 429 both mean a TOKEN or rate ceiling bit, not a request-count one.
    if (r.http_status === 413 || r.http_status === 429) fam.token_pressure++;
  }
  const keysByFamily = {};
  const rpdByFamily = {};
  for (const e of registry.agents) {
    if (!isAgentEnabled(e, state)) continue;
    const f = providerFamilyOf(e.provider);
    (keysByFamily[f] ??= new Set()).add(e.provider);
    const rpd = e.token_limits?.rpd;
    if (Number.isFinite(rpd)) rpdByFamily[f] = Math.max(rpdByFamily[f] ?? 0, rpd);
  }
  const days = Math.max(1, (now - since) / 86400);
  for (const [family, rpd] of Object.entries(rpdByFamily)) {
    const keys = keysByFamily[family]?.size ?? 1;
    const allowance = rpd * keys * days;
    const used = byFamily[family]?.requests ?? 0;
    const util = used / allowance;
    // Only "idle" if nothing in this window says the family is up against a
    // DIFFERENT ceiling. groq has request headroom to spare and is throttled by
    // an 8000-token minute — calling that spare capacity and routing more work
    // at it is how the 413s happened in the first place. The check is about
    // capacity being discarded, so a family under pressure is out of scope for
    // it whatever its request count says.
    const underPressure = (byFamily[family]?.token_pressure ?? 0) > 0;
    if (util < IDLE_FLOOR && !underPressure) {
      add({
        id: "idle_bucket",
        goal: 5,
        severity: "low",
        summary: `${family}: ${used} requests against ~${Math.round(allowance)} allowed (${(util * 100).toFixed(1)}%)`,
        detail:
          "A free tier that resets unused is tokens thrown away, and this family shows no "
          + "sign of being up against any other ceiling. Measured when this check was written: "
          + "google had 8 keys × 1500 rpd — 12,000 requests a day — and peaked at 62, about "
          + "0.5%, while the tightest-capped provider in the pool carried the load and failed "
          + "over 20% of the time. The reason is a policy, not a bug: consensus panels exclude "
          + "the whole family on purpose, because many keys serving one model is one opinion, "
          + "not many. That argument does not apply to work with no panel in it.",
        remedy:
          `send single-worker work here — sweeps, compression, long mechanical passes — by `
          + `dispatching a ${family} id directly. Leave the consensus panel exclusion alone; `
          + `it is protecting vote independence, not capacity.`,
        evidence: [`keys=${keys}`, `rpd_per_key=${rpd}`, `window_days=${days.toFixed(1)}`],
      });
    }
  }

  // ---- goal 5, for seats no header can reach --------------------------
  //
  // A subscription CLI has no rate-limit headers, so its ceiling cannot be
  // observed the way an HTTP seat's can. But it can be MEASURED after the fact:
  // whatever it served between running out twice IS the allowance for that
  // period, in the provider's own accounting, with no guessing.
  //
  // This is reported and never gated on, and that is a deliberate choice. A
  // ceiling set too high costs nothing — exhaustion still stops us — while one
  // set too low silently discards the rest of the allowance with nothing failing
  // to point at, which is exactly the pathology of a provider sitting at 0.5%
  // utilization. So: measure now, and only consider gating once the number has
  // stopped moving across several periods.
  const exhaustedAt = {};
  for (const r of rows) {
    if (FIXTURE.test(String(r.agent_id || ""))) continue;
    const isExhaustion = r.outcome === "quota_exhausted" || r.http_status === 429;
    if (isExhaustion) (exhaustedAt[r.agent_id] ??= []).push(r.ts || 0);
  }
  const allowances = [];
  for (const [id, stamps] of Object.entries(exhaustedAt)) {
    const sorted = [...stamps].sort((a, b) => a - b);
    if (sorted.length < 2) continue; // one data point is not an interval
    const to = sorted[sorted.length - 1];
    // Walk back to the previous exhaustion that is not part of the same burst:
    // a run of 429s seconds apart is one event hit repeatedly, not two periods.
    let from = null;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (to - sorted[i] > BURST_GAP_S) { from = sorted[i]; break; }
    }
    if (from == null) continue;
    const between = rows.filter(
      (r) => r.agent_id === id && (r.ts || 0) > from && (r.ts || 0) < to && r.outcome === "success",
    );
    if (between.length === 0) continue;
    const tokens = between.reduce((a, r) => a + (r.tokens_in || 0) + (r.tokens_out || 0), 0);
    allowances.push({
      id,
      served: between.length,
      tokens,
      period_hours: Math.round((to - from) / 3600),
      tokens_known: between.filter((r) => (r.tokens_in || 0) > 0).length,
    });
  }
  if (allowances.length > 0) {
    add({
      id: "observed_allowance",
      goal: 5,
      severity: "low",
      summary: `${allowances.length} seat(s) have a measured allowance between their last two exhaustions`,
      detail:
        "What a seat served between running out twice IS its allowance for that period, in the "
        + "provider's own accounting. Reported, never gated on: a ceiling set too low silently "
        + "discards the rest of an allowance with nothing failing to point at. Watch whether the "
        + "number holds across periods before trusting it.",
      remedy: null,
      evidence: allowances
        .sort((a, b) => b.served - a.served)
        .slice(0, 8)
        .map((a) => `${a.id}: ${a.served} dispatches` + (a.tokens > 0 ? `, ${a.tokens} tokens` : ", tokens unknown") + ` over ~${a.period_hours}h`),
    });
  }

  return {
    window: { since, now, hours: windowHours },
    totals: { dispatches: total, successes: ok, success_rate: rate },
    by_status: statusTally(win),
    by_family: byFamily,
    // Per-agent spend in the window. Empty before 0.54.0 for every CLI seat,
    // because a CLI transport has no headers and nothing asked the CLI itself —
    // see lib/cli-usage.js. `tokens_unknown` is the honest half of the number.
    spend: Object.fromEntries(
      Object.entries(
        win.reduce((acc, r) => {
          const a = (acc[r.agent_id] ??= { dispatches: 0, tokens_in: 0, tokens_out: 0, tokens_unknown: 0 });
          a.dispatches++;
          if ((r.tokens_in || 0) > 0 || (r.tokens_out || 0) > 0) {
            a.tokens_in += r.tokens_in || 0;
            a.tokens_out += r.tokens_out || 0;
          } else if (r.outcome === "success") {
            a.tokens_unknown++;
          }
          return acc;
        }, {}),
      ).sort((a, b) => b[1].dispatches - a[1].dispatches),
    ),
    findings,
  };
}

// A pool this size having a bad hour is normal; sustained loss is not. Set from
// the measured baseline: 80.3% success over 40 days, 73.1% over the worst
// trailing week. A floor of 80% flags the bad week without flagging the pool.
export const SUCCESS_FLOOR = 0.8;

// Under 5% of a known allowance is not "quiet", it is capacity being discarded.
export const IDLE_FLOOR = 0.05;

// Two exhaustion events closer together than this are one event hit repeatedly,
// not two periods. Measured: a rate-limited seat produces runs of 429s seconds
// apart — 21 re-dispatches inside 60s of a single 429 before the token-axis
// cooldown floor landed — and counting those as period boundaries would report
// an "allowance" of whatever happened to fit between two retries.
export const BURST_GAP_S = 3600;

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

function statusTally(rows) {
  const out = {};
  for (const r of rows) {
    const key = r.outcome === "success"
      ? "success"
      : r.http_status
      ? `http_${r.http_status}`
      : r.outcome === "timeout"
      ? "timeout"
      : "error";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** Human report. Returns the text and the exit code the CLI should use. */
export function formatReport(result) {
  const lines = [];
  const { totals, window, findings } = result;
  const pct = totals.success_rate == null ? "n/a" : `${(totals.success_rate * 100).toFixed(1)}%`;
  lines.push(`external-agents doctor — last ${window.hours}h`);
  lines.push(`dispatches ${totals.dispatches}   success ${pct}`);
  const statuses = Object.entries(result.by_status).sort((a, b) => b[1] - a[1]);
  if (statuses.length) lines.push(`status     ${statuses.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("no findings — the five goals hold over this window.");
    return { text: lines.join("\n"), exitCode: 0 };
  }

  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of sorted) {
    const mark = f.severity === "high" ? "✗" : f.severity === "medium" ? "⚠" : "·";
    lines.push(`${mark} [goal ${f.goal}] ${f.summary}`);
    lines.push(`  ${f.detail}`);
    if (f.evidence?.length) lines.push(`  evidence: ${f.evidence.slice(0, 8).join(", ")}`);
    if (f.remedy) lines.push(`  remedy:   ${f.remedy}`);
    lines.push("");
  }
  // Exit 1 only for `high`. A daily job that exits non-zero on a low-severity
  // observation gets muted, and a muted watchdog is not a watchdog.
  const worst = sorted[0].severity;
  return { text: lines.join("\n").trimEnd(), exitCode: worst === "high" ? 1 : 0 };
}
