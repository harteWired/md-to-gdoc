import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/args.js';

test('positionals only', () => {
  const { positional, flags } = parseArgs(['read', 'abc123']);
  assert.deepEqual(positional, ['read', 'abc123']);
  assert.deepEqual(flags, {});
});

test('flag with value', () => {
  const { flags } = parseArgs(['--to', 'a@b.com', '--subject', 'Hi']);
  assert.equal(flags.to, 'a@b.com');
  assert.equal(flags.subject, 'Hi');
});

test('boolean flag (no value / followed by another flag)', () => {
  const { flags } = parseArgs(['--html', '--body', 'x']);
  assert.equal(flags.html, true);
  assert.equal(flags.body, 'x');
});

test('trailing boolean flag', () => {
  const { flags } = parseArgs(['send', '--manual']);
  assert.equal(flags.manual, true);
});

test('repeated flag collects into array', () => {
  const { flags } = parseArgs(['--attach', 'a.pdf', '--attach', 'b.png', '--to', 'x@y.com']);
  assert.deepEqual(flags.attach, ['a.pdf', 'b.png']);
  assert.equal(flags.to, 'x@y.com');
});

test('mixed positionals and flags', () => {
  const { positional, flags } = parseArgs(['modify', 'id1', 'id2', '--add', 'Work']);
  assert.deepEqual(positional, ['modify', 'id1', 'id2']);
  assert.equal(flags.add, 'Work');
});
