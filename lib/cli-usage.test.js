import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliUsage } from './cli-usage.js';

// Both fixtures are real output captured on 2026-08-31, not invented shapes. They
// are deliberately different, which is why the spec lives in the registry as data
// instead of as a branch per CLI.

const CLAUDE_SPEC = {
  kind: 'json',
  event: 'result',
  text: 'result',
  tokens_in: 'usage.input_tokens',
  tokens_out: 'usage.output_tokens',
  cache_read: 'usage.cache_read_input_tokens',
  cost_usd: 'total_cost_usd',
};

const CLAUDE_OUT = JSON.stringify([
  { type: 'system', subtype: 'init', session_id: 'abc' },
  {
    type: 'result',
    subtype: 'success',
    result: 'Ok',
    usage: { input_tokens: 10, output_tokens: 209, cache_read_input_tokens: 21675 },
    total_cost_usd: 0.0377905,
    duration_ms: 5015,
  },
]);

const AGY_SPEC = {
  kind: 'json',
  text: 'response',
  tokens_in: 'usage.input_tokens',
  tokens_out: 'usage.output_tokens',
  cache_read: 'usage.cache_read_tokens',
};

const AGY_OUT = JSON.stringify({
  conversation_id: 'fa655ccf',
  status: 'SUCCESS',
  response: 'Ok.\n',
  duration_seconds: 1.902482,
  num_turns: 1,
  usage: { input_tokens: 11150, output_tokens: 24, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 11174 },
});

test('reads the claude envelope: an array of events, answer under .result', () => {
  const u = parseCliUsage(CLAUDE_OUT, CLAUDE_SPEC);
  assert.equal(u.text, 'Ok');
  assert.equal(u.tokens_in, 10);
  assert.equal(u.tokens_out, 209);
  assert.equal(u.cache_read, 21675);
  assert.equal(u.cost_usd, 0.0377905);
});

test('reads the agy envelope: a single object, answer under .response', () => {
  const u = parseCliUsage(AGY_OUT, AGY_SPEC);
  assert.equal(u.text, 'Ok.\n');
  assert.equal(u.tokens_in, 11150);
  assert.equal(u.tokens_out, 24);
  assert.equal(u.cache_read, 0);
  assert.equal(u.cost_usd, null, 'agy reports no cost and none is invented');
});

test('takes the LAST matching event, because a multi-turn run emits several', () => {
  const out = JSON.stringify([
    { type: 'result', result: 'first', usage: { input_tokens: 1, output_tokens: 1 } },
    { type: 'other', result: 'noise' },
    { type: 'result', result: 'final', usage: { input_tokens: 500, output_tokens: 900 } },
  ]);
  const u = parseCliUsage(out, CLAUDE_SPEC);
  assert.equal(u.text, 'final');
  assert.equal(u.tokens_in, 500);
});

// --- the safety rule: a parse failure must never cost the caller its answer ---

test('every mismatch returns null so the caller keeps raw stdout', () => {
  // Asking a CLI for JSON turns stdout from "the reply" into "an envelope
  // containing the reply". A spec that does not match would otherwise turn a
  // good dispatch into an empty one — the exact bug class 0.52.0 fixed.
  assert.equal(parseCliUsage('plain text answer, not JSON', CLAUDE_SPEC), null);
  assert.equal(parseCliUsage('', CLAUDE_SPEC), null);
  assert.equal(parseCliUsage('   ', CLAUDE_SPEC), null);
  assert.equal(parseCliUsage(CLAUDE_OUT, null), null, 'no spec declared');
  assert.equal(parseCliUsage(CLAUDE_OUT, { kind: 'toml' }), null, 'unknown kind is refused, not improvised');
  assert.equal(parseCliUsage(null, CLAUDE_SPEC), null);
});

test('a structurally valid envelope with no usage numbers is not a measurement', () => {
  // Returning zeros here would put a confident 0 into the ledger for a run that
  // really did spend tokens.
  const out = JSON.stringify([{ type: 'result', result: 'Ok' }]);
  assert.equal(parseCliUsage(out, CLAUDE_SPEC), null);
});

test('a missing text path is a mismatch, not a silent empty answer', () => {
  const out = JSON.stringify([{ type: 'result', usage: { input_tokens: 5, output_tokens: 5 } }]);
  assert.equal(parseCliUsage(out, CLAUDE_SPEC), null, 'spec names .result and it is absent');
});

test('a spec with no text path adds usage and leaves the answer alone', () => {
  const usageOnly = { ...CLAUDE_SPEC };
  delete usageOnly.text;
  const u = parseCliUsage(CLAUDE_OUT, usageOnly);
  assert.equal(Object.prototype.hasOwnProperty.call(u, 'text'), false);
  assert.equal(u.tokens_in, 10);
});

test('the wanted event simply not being there returns null', () => {
  const out = JSON.stringify([{ type: 'system' }, { type: 'turn.failed' }]);
  assert.equal(parseCliUsage(out, CLAUDE_SPEC), null);
});

test('negative or non-numeric token counts are refused', () => {
  const bad = JSON.stringify([{ type: 'result', result: 'Ok', usage: { input_tokens: -5, output_tokens: 'lots' } }]);
  assert.equal(parseCliUsage(bad, CLAUDE_SPEC), null, 'neither axis produced a usable number');
});

// --- jsonl, for the event-stream CLIs -------------------------------------

test('jsonl keeps the events that parsed and ignores a truncated tail', () => {
  // A CLI killed by a timeout mid-write is a real case; the events before the
  // cut are still true.
  const spec = { kind: 'jsonl', event: 'turn.completed', text: 'text', tokens_in: 'usage.in', tokens_out: 'usage.out' };
  const out = [
    '{"type":"turn.started"}',
    '{"type":"turn.completed","text":"done","usage":{"in":7,"out":9}}',
    '{"type":"turn.par',
  ].join('\n');
  const u = parseCliUsage(out, spec);
  assert.equal(u.text, 'done');
  assert.equal(u.tokens_in, 7);
  assert.equal(u.tokens_out, 9);
});

test('jsonl with nothing parseable returns null', () => {
  const spec = { kind: 'jsonl', event: 'x', tokens_in: 'a', tokens_out: 'b' };
  assert.equal(parseCliUsage('not json\nalso not json', spec), null);
});
