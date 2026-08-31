// Token accounting for CLI transports.
//
// The HTTP seats got measurable in 0.53.0 by reading rate-limit headers off every
// response (lib/budget.js). CLI seats have no headers, so they stayed invisible:
// measured over 8079 dispatches, 1984 successful ones reported no tokens at all,
// and 1574 of those were CLI seats — including every single `claude` dispatch,
// which for most of that window was the busiest agent in the pool.
//
// But most of these CLIs will tell you, if you ask in the right format. Verified
// live rather than read off a docs page, and they do NOT agree on a shape:
//
//   claude --print --output-format json
//     [ …events…, {"type":"result","result":"Ok",
//                  "usage":{"input_tokens":10,"output_tokens":209,
//                           "cache_read_input_tokens":21675},
//                  "total_cost_usd":0.0377} ]
//
//   agy --output-format json
//     {"status":"SUCCESS","response":"Ok.\n",
//      "usage":{"input_tokens":11150,"output_tokens":24,"total_tokens":11174}}
//
// One is an array of events whose answer lives under `.result`; the other is a
// single object whose answer lives under `.response`. Hard-coding either would
// mean a new branch per CLI, so the shape is declared in the registry as data
// (`usage_from`) and this module is the one interpreter. Adding codex or
// cursor-agent later is a registry entry, not a code change.
//
// ONE SAFETY RULE, and it outranks everything else here: a parse failure must
// never cost the caller its answer. Asking a CLI for JSON changes stdout from
// "the reply" into "an envelope containing the reply", so a spec that does not
// match would otherwise turn a perfectly good dispatch into an empty one — the
// exact class of bug (a run that did work being reported as having done none)
// that 0.52.0 existed to fix. Every failure path returns null, and the caller
// keeps raw stdout.

// Path segments that must never be walked.
//
// Raised in review, and the point is precision rather than exploitability:
// `obj["__proto__"]` returns the prototype object, which is truthy, so a careless
// registry path would "line up" — contradicting this module's promise that
// anything not lining up returns null. The value would still die in num() as
// NaN, so nothing was exploitable; the docstring was simply not true. Now it is.
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Resolve a dotted path (`usage.input_tokens`) against an object. */
function at(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const key of String(path).split(".")) {
    if (FORBIDDEN_SEGMENTS.has(key)) return undefined;
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Extract the answer text and token usage from a CLI's structured output.
 *
 * @param {string} stdout raw (ANSI-stripped) stdout
 * @param {object} spec the entry's `usage_from` block
 * @returns {{text: string, tokens_in: number|null, tokens_out: number|null,
 *            cost_usd: number|null, cache_read: number|null}|null}
 *          null whenever anything at all does not line up — see the safety rule.
 */
export function parseCliUsage(stdout, spec) {
  if (!spec || typeof spec !== "object") return null;
  if (typeof stdout !== "string" || stdout.trim() === "") return null;

  let doc;
  if (spec.kind === "json") {
    try {
      doc = JSON.parse(stdout);
    } catch {
      return null;
    }
  } else if (spec.kind === "jsonl") {
    // One JSON document per line, and the LAST line must parse.
    //
    // Tolerating a truncated tail sounded generous and was wrong, raised in
    // review: the selection step below takes the last matching event as the
    // TOTALS, so a stream cut mid-write would hand back an intermediate event's
    // numbers as if the run had finished there. Silently reporting a partial
    // count as a total is worse than reporting nothing, because nothing is
    // visible as a gap while a wrong number is not.
    //
    // Earlier non-JSON lines are still skipped — a CLI that prints a banner
    // before its event stream is ordinary — but a broken FINAL line means the
    // process did not get to say how it ended, and that is refused.
    const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) return null;
    try {
      JSON.parse(lines[lines.length - 1]);
    } catch {
      return null; // truncated stream: no totals to trust
    }
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a banner or log line before the stream — skip it */
      }
    }
    if (events.length === 0) return null;
    doc = events;
  } else {
    return null; // unknown kind: refuse rather than improvise
  }

  // An array is a stream of events; pick the LAST one matching `event`, because
  // a multi-turn run emits several and the final one carries the totals.
  let node = doc;
  if (Array.isArray(doc)) {
    const wanted = spec.event;
    const matches = wanted
      ? doc.filter((e) => e && typeof e === "object" && e.type === wanted)
      : doc;
    node = matches.length > 0 ? matches[matches.length - 1] : null;
  }
  if (node == null || typeof node !== "object") return null;

  const tokensIn = num(at(node, spec.tokens_in));
  const tokensOut = num(at(node, spec.tokens_out));
  // Usage is the whole point. A spec that matched structurally but produced no
  // numbers has not measured anything, and claiming otherwise would put a
  // confident zero into the ledger.
  if (tokensIn == null && tokensOut == null) return null;

  // The text is optional in one direction only: if the spec names a path and it
  // is missing, that is a mismatch and the caller must keep raw stdout. If the
  // spec names no path, the caller keeps raw stdout anyway and we only add usage.
  let text;
  if (spec.text) {
    const t = at(node, spec.text);
    if (typeof t !== "string") return null;
    text = t;
  }

  return {
    ...(text !== undefined ? { text } : {}),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: num(at(node, spec.cost_usd)),
    cache_read: num(at(node, spec.cache_read)),
  };
}
