import test from 'node:test';
import assert from 'node:assert/strict';
import { stripBenignStderrNoise } from './dispatch.js';

test('strips the ollama non-terminal-stdin warning line', () => {
  const input = 'Warning: Input is not a terminal (fd=0).';
  assert.strictEqual(stripBenignStderrNoise(input), '');
});

test('strips the warning line while preserving surrounding real error text', () => {
  const input = [
    'Warning: Input is not a terminal (fd=0).',
    'litellm.RateLimitError: rate limit exceeded',
  ].join('\n');
  assert.strictEqual(stripBenignStderrNoise(input), 'litellm.RateLimitError: rate limit exceeded');
});

test('leaves unrelated stderr untouched', () => {
  const input = 'AuthenticationError: no authentication token';
  assert.strictEqual(stripBenignStderrNoise(input), input);
});

test('handles empty and nullish input', () => {
  assert.strictEqual(stripBenignStderrNoise(''), '');
  assert.strictEqual(stripBenignStderrNoise(undefined), '');
  assert.strictEqual(stripBenignStderrNoise(null), '');
});
