import assert from "node:assert/strict";
import { test } from "node:test";

import { oversizedPromptReason } from "./dispatch.js";

// Regression guard for the class of 413 seen on groq-gpt-oss-120b: `pick`
// already refuses to SEAT an oversized prompt (lib/pick.js), but `dispatch`
// (and therefore any caller that names an agent directly, skipping pick) never
// checked the same ceiling before sending. Two live 413s on 2026-09-08/09
// requested 17124 and 22583 tokens against a seat whose observed tpm ceiling
// was a known, unchanged 8000 the whole time.

const GROQ_ENTRY = { id: "groq-gpt-oss-120b", provider: "groq", model: "openai/gpt-oss-120b" };

test("oversizedPromptReason refuses a prompt bigger than the seat's observed ceiling", () => {
  const now = 1_000_000;
  const rec = { observed_limits: { tpm: 8000, axis_seen_at: { tpm: now - 10 }, source: "headers" } };
  const bigPrompt = "x".repeat(40_000); // ~10000 estimated tokens at the pool's 4 bytes/token estimate
  const reason = oversizedPromptReason(GROQ_ENTRY, bigPrompt, rec, null, now);
  assert.match(reason, /groq-gpt-oss-120b/);
  assert.match(reason, /8000/);
});

test("oversizedPromptReason allows a prompt within the ceiling", () => {
  const now = 1_000_000;
  const rec = { observed_limits: { tpm: 8000, axis_seen_at: { tpm: now - 10 }, source: "headers" } };
  const smallPrompt = "x".repeat(1000);
  assert.equal(oversizedPromptReason(GROQ_ENTRY, smallPrompt, rec, null, now), null);
});

test("oversizedPromptReason allows anything when no ceiling is known (declared or observed)", () => {
  const hugePrompt = "x".repeat(500_000);
  assert.equal(oversizedPromptReason({ id: "mystery" }, hugePrompt, undefined, null, 1_000_000), null);
});

test("oversizedPromptReason falls back to inherited (sibling-voice) declared limits", () => {
  const entryWithNoOwnLimits = { id: "groq-gpt-oss-120b-3", provider: "groq3", model: "openai/gpt-oss-120b" };
  const inherited = { tpm: 8000 };
  const bigPrompt = "x".repeat(40_000);
  const reason = oversizedPromptReason(entryWithNoOwnLimits, bigPrompt, undefined, inherited, 1_000_000);
  assert.match(reason, /groq-gpt-oss-120b-3/);
});

test("oversizedPromptReason ignores a stale observed ceiling past its TTL, falling back to declared", () => {
  // 30 days (OBSERVED_LIMIT_TTL_S) plus a bit — the observation must not be
  // trusted forever; a declared ceiling (if any) takes over instead of the
  // (absent here) observation silently disappearing into "no ceiling at all".
  const now = 1_000_000;
  const staleRec = { observed_limits: { tpm: 8000, axis_seen_at: { tpm: now - 31 * 86400 }, source: "headers" } };
  const bigPrompt = "x".repeat(40_000);
  assert.equal(oversizedPromptReason(GROQ_ENTRY, bigPrompt, staleRec, null, now), null);
});
