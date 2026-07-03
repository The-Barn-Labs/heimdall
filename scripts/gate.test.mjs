import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './gate.mjs';

test('parseCommand returns null for empty', () => {
  assert.equal(parseCommand(''), null);
});
