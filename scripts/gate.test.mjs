import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './gate.mjs';

test('parseCommand returns null for empty', () => {
  assert.equal(parseCommand(''), null);
});

test('parseCommand recognizes review', () => {
  assert.equal(parseCommand('@heimdall review'), 'review');
});

test('parseCommand recognizes review deep (deep wins over review)', () => {
  assert.equal(parseCommand('please @heimdall review deep now'), 'review-deep');
});

test('parseCommand recognizes explain', () => {
  assert.equal(parseCommand('@heimdall explain the RLS change'), 'explain');
});

test('parseCommand is case-insensitive', () => {
  assert.equal(parseCommand('@Heimdall REVIEW'), 'review');
});

test('parseCommand ignores unrelated mentions', () => {
  assert.equal(parseCommand('@someone-else review'), null);
});
