import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseDurationToSeconds,
  parsePeriod,
  parseResetFromHeaders,
  parseResetFromBody,
  nextMidnightEpoch,
  resolveExhaustionResetAt,
} from "./quota-reset.js";

const NOW_MS = Date.UTC(2026, 6, 24, 15, 0, 0); // 2026-07-24T15:00:00Z
const NOW_SEC = Math.floor(NOW_MS / 1000);

test("parseDurationToSeconds: durations and bare numbers", () => {
  assert.equal(parseDurationToSeconds("1m26.4s"), 87);
  assert.equal(parseDurationToSeconds("6m0s"), 360);
  assert.equal(parseDurationToSeconds("2h30m"), 9000);
  assert.equal(parseDurationToSeconds("41s"), 41);
  assert.equal(parseDurationToSeconds("185ms"), 1);
  assert.equal(parseDurationToSeconds("90"), 90);
  assert.equal(parseDurationToSeconds(""), null);
  assert.equal(parseDurationToSeconds("garbage"), null);
});

test("parsePeriod: monthly / daily / none", () => {
  assert.equal(parsePeriod("Monthly request limit reached"), "monthly");
  assert.equal(parsePeriod("You exceeded your quota per month"), "monthly");
  assert.equal(parsePeriod("GenerateRequestsPerDayPerProjectPerModel exceeded"), "daily");
  assert.equal(parsePeriod("limit per day reached"), "daily");
  assert.equal(parsePeriod("rate limit exceeded, too many requests"), null);
});

test("parseResetFromHeaders: groq duration header", () => {
  const r = parseResetFromHeaders({ "x-ratelimit-reset-requests": "1m26.4s", "x-ratelimit-reset-tokens": "185ms" }, NOW_MS);
  assert.equal(r, NOW_SEC + 87); // takes the LATEST (max) reset
});

test("parseResetFromHeaders: retry-after integer and HTTP-date", () => {
  assert.equal(parseResetFromHeaders({ "retry-after": "120" }, NOW_MS), NOW_SEC + 120);
  const httpDate = new Date(NOW_MS + 300_000).toUTCString();
  assert.equal(parseResetFromHeaders({ "retry-after": httpDate }, NOW_MS), NOW_SEC + 300);
});

test("parseResetFromHeaders: anthropic RFC3339 absolute reset", () => {
  const iso = new Date(NOW_MS + 3600_000).toISOString();
  const r = parseResetFromHeaders({ "anthropic-ratelimit-requests-reset": iso }, NOW_MS);
  assert.equal(r, NOW_SEC + 3600);
});

test("parseResetFromHeaders: openrouter x-ratelimit-reset unix ms", () => {
  const r = parseResetFromHeaders({ "x-ratelimit-reset": String(NOW_MS + 5000) }, NOW_MS);
  assert.equal(r, Math.floor((NOW_MS + 5000) / 1000));
});

test("parseResetFromHeaders: Headers-like object with .get()", () => {
  const h = new Map([["retry-after", "60"]]);
  const r = parseResetFromHeaders(h, NOW_MS);
  assert.equal(r, NOW_SEC + 60);
});

test("parseResetFromBody: google retryDelay and 'try again in'", () => {
  assert.equal(parseResetFromBody('{"retryDelay": "41s"}', NOW_MS), NOW_SEC + 41);
  assert.equal(parseResetFromBody("Please try again in 12h34m.", NOW_MS), NOW_SEC + 12 * 3600 + 34 * 60);
  assert.equal(parseResetFromBody("reset in 30 seconds", NOW_MS), NOW_SEC + 30);
});

test("nextMidnightEpoch: UTC next midnight is in the future and < 24h away", () => {
  const e = nextMidnightEpoch(NOW_MS, "UTC");
  assert.ok(e > NOW_SEC);
  assert.ok(e - NOW_SEC <= 24 * 3600);
  assert.equal(e, Math.floor(Date.UTC(2026, 6, 25, 0, 0, 0) / 1000)); // next UTC midnight
});

test("resolveExhaustionResetAt: headers win over everything", () => {
  const r = resolveExhaustionResetAt({
    text: "Monthly request limit reached",
    headers: { "retry-after": "90" },
    provider: "kiro",
    nowMs: NOW_MS,
  });
  assert.equal(r, NOW_SEC + 90);
});

test("resolveExhaustionResetAt: kiro monthly text → +7 days", () => {
  const r = resolveExhaustionResetAt({ text: "Monthly request limit reached", provider: "kiro", nowMs: NOW_MS });
  assert.equal(r, NOW_SEC + 7 * 24 * 3600);
});

test("resolveExhaustionResetAt: google daily → next Pacific midnight (future, <30h)", () => {
  const r = resolveExhaustionResetAt({
    text: "Quota exceeded: GenerateRequestsPerDayPerProjectPerModel",
    provider: "google",
    nowMs: NOW_MS,
  });
  assert.ok(r > NOW_SEC);
  assert.ok(r - NOW_SEC <= 30 * 3600); // Pacific midnight is within ~a day+ of any UTC instant
});

test("resolveExhaustionResetAt: no signal → 48h bounded fallback (limited always yields a value)", () => {
  const r = resolveExhaustionResetAt({ text: "hit your usage limit", provider: "groq", nowMs: NOW_MS });
  assert.equal(r, NOW_SEC + 48 * 3600);
});

test("resolveExhaustionResetAt: GPT 'try again at <date>' absolute reset is captured", () => {
  const r = resolveExhaustionResetAt({
    text: "ERROR: You've hit your usage limit. ... or try again at Jul 29th, 2026 7:20 PM.",
    provider: "openai",
    nowMs: NOW_MS,
  });
  // Jul 29 2026 is ~5 days out (within the 7d clamp) — the exact date, not the 48h fallback.
  const expected = Math.floor(Date.parse("Jul 29, 2026 7:20 PM") / 1000);
  assert.equal(r, expected);
  assert.ok(r > NOW_SEC + 48 * 3600); // proves it beat the fallback
});

test("clamp: far-future misparse capped to now+7d; monthly keeps 7d; past → fallback", () => {
  const r = resolveExhaustionResetAt({ text: "quota exceeded", headers: { "retry-after": String(400 * 24 * 3600) }, nowMs: NOW_MS });
  assert.equal(r, NOW_SEC + 7 * 24 * 3600); // 400d clamped to 7d
});

test("resolveExhaustionResetAt: pure rate-limit with no reset → short 60s default (not 48h quota fallback)", () => {
  const r = resolveExhaustionResetAt({ text: "429 Too Many Requests: rate limit exceeded", provider: "groq", nowMs: NOW_MS });
  assert.equal(r, NOW_SEC + 60);
});

test("resolveExhaustionResetAt: quota wording (not rate-limit-only) still gets the 48h fallback", () => {
  const r = resolveExhaustionResetAt({ text: "quota exceeded for this project", provider: "groq", nowMs: NOW_MS });
  assert.equal(r, NOW_SEC + 48 * 3600);
});

// --- "try again at <bare clock time>" -------------------------------------

test('a bare clock time resolves to the NEXT occurrence, not the 48h default', () => {
  // codex prints the bare form when the reset is inside 24h and the dated form
  // only once it is further out. Date.parse returns NaN for a lone time, so this
  // shape fell through to the 48-hour default on six recorded rows — throwing a
  // working seat away for two days to wait out something minutes off.
  const text = 'ERROR: You have hit your usage limit. Upgrade to Pro, visit ... or try again at 3:03 PM.';

  // 14:00 local, so 15:03 is still ahead: ~63 minutes.
  const before = new Date(2026, 7, 31, 14, 0, 0).getTime();
  const r1 = resolveExhaustionResetAt({ text, provider: 'openai', nowMs: before });
  assert.equal(r1, Math.floor(new Date(2026, 7, 31, 15, 3, 0).getTime() / 1000));

  // 16:00 local, so 15:03 has gone: tomorrow, never the past.
  const after = new Date(2026, 7, 31, 16, 0, 0).getTime();
  const r2 = resolveExhaustionResetAt({ text, provider: 'openai', nowMs: after });
  assert.equal(r2, Math.floor(new Date(2026, 8, 1, 15, 3, 0).getTime() / 1000));
  assert.ok(r2 > Math.floor(after / 1000));
});

test('a bare clock time handles midnight and noon meridiems', () => {
  const at = (t) => `... or try again at ${t}.`;
  const now = new Date(2026, 7, 31, 6, 0, 0).getTime();
  const got = (t) => resolveExhaustionResetAt({ text: at(t), provider: 'openai', nowMs: now });
  assert.equal(got('12:12 AM'), Math.floor(new Date(2026, 8, 1, 0, 12, 0).getTime() / 1000), '12 AM is 00:xx, and today 00:12 is past');
  assert.equal(got('12:30 PM'), Math.floor(new Date(2026, 7, 31, 12, 30, 0).getTime() / 1000), '12 PM is noon, not midnight');
  assert.equal(got('7:05'), Math.floor(new Date(2026, 7, 31, 7, 5, 0).getTime() / 1000), 'no meridiem: read as 24h');
});

test('a nonsense clock time is not invented into a reset', () => {
  const now = Date.now();
  const r = resolveExhaustionResetAt({
    text: '... usage limit ... or try again at 99:99 PM.',
    provider: 'openai',
    nowMs: now,
  });
  // Falls through to the bounded provider default rather than producing garbage.
  assert.equal(r, Math.floor(now / 1000) + 48 * 3600);
});

test('the dated form still wins, and a PAST date is still treated as unknown', () => {
  const now = new Date(2026, 7, 31, 12, 0, 0).getTime();
  const future = resolveExhaustionResetAt({
    text: '... or try again at Sep 1st, 2026 12:12 AM.',
    provider: 'openai',
    nowMs: now,
  });
  assert.equal(future, Math.floor(new Date(2026, 8, 1, 0, 12, 0).getTime() / 1000));

  const past = resolveExhaustionResetAt({
    text: '... or try again at Aug 16th, 2026 11:23 AM.',
    provider: 'openai',
    nowMs: now,
  });
  assert.equal(past, Math.floor(now / 1000) + 48 * 3600, 'clock skew / stale row → unknown, not the past');
});

// --- PROVIDER_PERIOD: a plan the provider never mentions -------------------

test('a provider that states no period gets the operator-declared one', () => {
  // cursor-agent's failure says only "You have hit your usage limit Get Cursor
  // Pro for more Agent usage" — no period, no reset, no hint. It took the 48h
  // default and was re-seated ~15 times a month, every one a guaranteed failure.
  const now = Date.now();
  const text = 'ActionRequiredError: You have hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more';
  const r = resolveExhaustionResetAt({ text, provider: 'cursor', nowMs: now });
  assert.equal(r, Math.floor(now / 1000) + 7 * 24 * 3600, 'same +7d re-check that already makes kiro behave');
});

test('a numbered clone inherits the declared period', () => {
  const now = Date.now();
  const text = 'You have hit your usage limit Get Cursor Pro for more Agent usage';
  assert.equal(
    resolveExhaustionResetAt({ text, provider: 'cursor2', nowMs: now }),
    Math.floor(now / 1000) + 7 * 24 * 3600,
  );
});

test('a period in the provider own words outranks the table', () => {
  const now = Date.now();
  // Hypothetical: if cursor ever started saying "Resets in 90s", that beats the
  // operator's belief about the plan — the text describes THIS failure.
  const r = resolveExhaustionResetAt({ text: 'usage limit reached. Resets in 90s.', provider: 'cursor', nowMs: now });
  assert.ok(r < Math.floor(now / 1000) + 3600, `expected a short precise reset, got ${r - Math.floor(now / 1000)}s`);
});

test('providers that already worked are untouched', () => {
  const now = Date.now();
  const s = Math.floor(now / 1000);
  assert.equal(
    resolveExhaustionResetAt({ text: 'Monthly request limit reached.', provider: 'kiro', nowMs: now }),
    s + 7 * 24 * 3600, 'kiro reads its own period',
  );
  assert.equal(
    resolveExhaustionResetAt({ text: 'Individual quota reached. Resets in 4h30m14s.', provider: 'antigravity', nowMs: now }),
    s + 4 * 3600 + 30 * 60 + 14, 'agy states an exact duration',
  );
  assert.equal(
    resolveExhaustionResetAt({ text: 'HTTP 429 rate limit exceeded, too many requests', provider: 'groq', nowMs: now }),
    s + 60, 'a pure rate limit stays a minute',
  );
});
