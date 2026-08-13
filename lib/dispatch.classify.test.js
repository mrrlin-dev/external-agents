import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVerifyResult } from './dispatch.js';

test('returns healthy when ok is true', () => {
  assert.strictEqual(classifyVerifyResult({ ok: true }), 'healthy');
  assert.strictEqual(classifyVerifyResult({ ok: true, status: 200 }), 'healthy');
});

test('returns model_unavailable when modelUnavailable is true', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, modelUnavailable: true, status: 404 }),
    'model_unavailable'
  );
});

test('returns quota_exhausted when quotaExhausted is true', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, quotaExhausted: true }),
    'quota_exhausted'
  );
});

test('returns needs_auth when explicit needsAuth flag is set', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, needsAuth: true }),
    'needs_auth'
  );
});

test('returns needs_auth when status is 401', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, status: 401 }),
    'needs_auth'
  );
});

test('returns needs_auth when status is 403', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, status: 403 }),
    'needs_auth'
  );
});

test('returns rate_limited when status is 429', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, status: 429 }),
    'rate_limited'
  );
});

test('returns errored_transient for 500 status', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, status: 500 }),
    'errored_transient'
  );
});

test('returns errored_transient when status is missing (network/timeout error)', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, hint: 'timeout after 10s' }),
    'errored_transient'
  );
});

test('modelUnavailable takes precedence over 429 rate limit status', () => {
  assert.strictEqual(
    classifyVerifyResult({ ok: false, modelUnavailable: true, status: 429 }),
    'model_unavailable'
  );
});
