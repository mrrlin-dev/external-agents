import test from "node:test";
import assert from "node:assert/strict";
import { deriveDisplayState } from "./state.js";

test("deriveDisplayState marks expired quota cooldowns as need_check", () => {
  const derived = deriveDisplayState({
    state: "quota_exhausted",
    cooldown_until: 100,
    note: "provider said come back later",
  }, 101);

  assert.equal(derived.state, "need_check");
  assert.equal(derived.stale_state, "quota_exhausted");
  assert.match(derived.note, /Cooldown expired; run probe/);
  assert.equal(derived.cooldown_until, 100);
});

test("deriveDisplayState leaves active cooldowns untouched", () => {
  const active = {
    state: "rate_limited",
    cooldown_until: 200,
  };

  assert.deepEqual(deriveDisplayState(active, 199), active);
});

test("deriveDisplayState flips to need_check exactly at cooldown expiry", () => {
  const derived = deriveDisplayState({
    state: "errored_transient",
    cooldown_until: 200,
  }, 200);

  assert.equal(derived.state, "need_check");
  assert.equal(derived.stale_state, "errored_transient");
});

test("deriveDisplayState leaves healthy records untouched", () => {
  const healthy = {
    state: "healthy",
    cooldown_until: 100,
  };

  assert.deepEqual(deriveDisplayState(healthy, 999), healthy);
});
