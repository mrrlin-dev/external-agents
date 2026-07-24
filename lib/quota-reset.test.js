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
