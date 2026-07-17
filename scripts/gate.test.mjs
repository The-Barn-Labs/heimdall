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

import { classifyTrigger, isAuthorized, isReleaseTrain } from './gate.mjs';

// Fixtures are REAL file-valet PR titles, so a convention drift shows up here.
test('isReleaseTrain matches the promote-title convention', () => {
  // #1797, #808, #1230
  assert.equal(isReleaseTrain({ title: 'promote: dev → staging (2026-07-17) — Client Groups, Audit dashboard' }), true);
  assert.equal(isReleaseTrain({ title: 'promote: staging → main (2026-06-11)' }), true);
  // #1446, #1448, #1463 — capitalized, no colon
  assert.equal(isReleaseTrain({ title: 'Promote dev → staging' }), true);
  assert.equal(isReleaseTrain({ title: 'Promote staging → main (production)' }), true);
});

test('isReleaseTrain does NOT match a title merely mentioning a promotion', () => {
  // #1743 and #1506 — ordinary PRs that must still be reviewed.
  assert.equal(isReleaseTrain({ title: 'docs(inbox): triage 2026-07-14 — promote 4 items to dev' }), false);
  assert.equal(isReleaseTrain({ title: 'docs(inbox): clear triage batch (promoted 6 captures)' }), false);
  // #1620 — "promoted" inside the title, not the convention.
  assert.equal(isReleaseTrain({ title: 'ci(staging): add served-vs-promoted commit gate on push' }), false);
  // Anchored: the word must START the title.
  assert.equal(isReleaseTrain({ title: 'fix: do not promote stale artifacts' }), false);
  // The convention is "promote:" / "Promote " specifically. A hyphen or slash
  // after the word is ordinary work, not a release train (PR #10 review).
  assert.equal(isReleaseTrain({ title: 'promote-feature-flag: add X' }), false);
  assert.equal(isReleaseTrain({ title: 'promote/api-version bump' }), false);
  assert.equal(isReleaseTrain({ title: 'Promoted staging to main' }), false);
});

test('isReleaseTrain matches a PR from a long-lived integration branch', () => {
  assert.equal(isReleaseTrain({ headRef: 'dev' }), true);
  assert.equal(isReleaseTrain({ headRef: 'staging' }), true);
  assert.equal(isReleaseTrain({ headRef: 'develop' }), true);
  // Feature branches are normal work.
  assert.equal(isReleaseTrain({ headRef: 'fix/large-pr-diff-406' }), false);
  assert.equal(isReleaseTrain({ headRef: 'feat/client-groups' }), false);
  // Substring of an integration branch name is not a match.
  assert.equal(isReleaseTrain({ headRef: 'dev-tools' }), false);
  assert.equal(isReleaseTrain({ headRef: 'feature/staging-fix' }), false);
});

test('isReleaseTrain tolerates missing/blank facts', () => {
  assert.equal(isReleaseTrain({}), false);
  assert.equal(isReleaseTrain(), false);
  // null is not undefined, so a `= {}` default would NOT cover it and the
  // destructure would throw (PR #10 review).
  assert.equal(isReleaseTrain(null), false);
  assert.equal(isReleaseTrain({ title: undefined, headRef: null }), false);
});

test('pull_request on a promote PR is SKIPPED (release-train)', () => {
  const r = classifyTrigger({
    eventName: 'pull_request', action: 'opened',
    title: 'promote: dev → staging (2026-07-17)', headRef: 'dev',
  });
  assert.equal(r.run, false); assert.equal(r.reason, 'release-train');
});

test('pull_request on an ordinary PR still runs', () => {
  const r = classifyTrigger({
    eventName: 'pull_request', action: 'opened',
    title: 'fix(review): capture diff locally', headRef: 'fix/large-pr-diff-406',
  });
  assert.equal(r.run, true); assert.equal(r.reason, 'pr-event');
});

// The escape hatch: the skip is for AUTOMATIC triggers only. A human who asks
// for a promote review by name has opted in and must still get one.
test('explicit @heim-dall review on a promote PR STILL runs', () => {
  const r = classifyTrigger({
    eventName: 'issue_comment', isPullRequestComment: true, isFork: false,
    commentBody: '@heim-dall review',
    title: 'promote: dev → staging (2026-07-17)', headRef: 'dev',
  });
  assert.equal(r.run, true); assert.equal(r.command, 'review');
});

test('workflow_dispatch on a promote PR STILL runs', () => {
  const r = classifyTrigger({
    eventName: 'workflow_dispatch',
    title: 'promote: dev → staging (2026-07-17)', headRef: 'dev',
  });
  assert.equal(r.run, true); assert.equal(r.command, 'review');
});

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
