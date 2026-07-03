import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './gate.mjs';

test('parseCommand returns null for empty', () => {
  assert.equal(parseCommand(''), null);
});

test('parseCommand recognizes review', () => {
  assert.equal(parseCommand('@heim-dall review'), 'review');
});

test('parseCommand recognizes review deep (deep wins over review)', () => {
  assert.equal(parseCommand('please @heim-dall review deep now'), 'review-deep');
});

test('parseCommand recognizes explain', () => {
  assert.equal(parseCommand('@heim-dall explain the RLS change'), 'explain');
});

test('parseCommand is case-insensitive', () => {
  assert.equal(parseCommand('@Heim-Dall REVIEW'), 'review');
});

test('parseCommand ignores unrelated mentions', () => {
  assert.equal(parseCommand('@someone-else review'), null);
});

import { classifyTrigger, isAuthorized } from './gate.mjs';

test('workflow_dispatch always runs a review', () => {
  const r = classifyTrigger({ eventName: 'workflow_dispatch' });
  assert.deepEqual(r, { run: true, command: 'review', reason: 'dispatch' });
});

test('pull_request opened runs', () => {
  const r = classifyTrigger({ eventName: 'pull_request', action: 'opened' });
  assert.equal(r.run, true); assert.equal(r.command, 'review');
});

test('pull_request synchronize does NOT run', () => {
  const r = classifyTrigger({ eventName: 'pull_request', action: 'synchronize' });
  assert.equal(r.run, false);
});

test('issue_comment on non-PR does not run', () => {
  const r = classifyTrigger({ eventName: 'issue_comment', isPullRequestComment: false, commentBody: '@heim-dall review' });
  assert.equal(r.run, false); assert.equal(r.reason, 'not-a-pr-comment');
});

test('issue_comment command on same-repo PR runs', () => {
  const r = classifyTrigger({ eventName: 'issue_comment', isPullRequestComment: true, isFork: false, commentBody: '@heim-dall review deep' });
  assert.equal(r.run, true); assert.equal(r.command, 'review-deep');
});

test('issue_comment command on FORK PR is blocked', () => {
  const r = classifyTrigger({ eventName: 'issue_comment', isPullRequestComment: true, isFork: true, commentBody: '@heim-dall review' });
  assert.equal(r.run, false); assert.equal(r.reason, 'fork-comment-blocked');
});

test('issue_comment without a command is ignored', () => {
  const r = classifyTrigger({ eventName: 'issue_comment', isPullRequestComment: true, isFork: false, commentBody: 'lgtm' });
  assert.equal(r.run, false); assert.equal(r.reason, 'no-command');
});

test('isAuthorized only for write/admin', () => {
  assert.equal(isAuthorized('admin'), true);
  assert.equal(isAuthorized('write'), true);
  assert.equal(isAuthorized('read'), false);
  assert.equal(isAuthorized('none'), false);
});
