import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFences, parseClaudeResult } from './build-review.mjs';

test('stripFences unwraps a ```json fence', () => {
  assert.equal(stripFences('prefix\n```json\n{"a":1}\n```\nsuffix').trim(), '{"a":1}');
});

test('stripFences falls back to first-brace..last-brace', () => {
  assert.equal(stripFences('Here you go: {"a":1} thanks').trim(), '{"a":1}');
});

test('parseClaudeResult reads the envelope .result string', () => {
  const envelope = JSON.stringify({ is_error: false, result: '{"summary":"ok","findings":[]}' });
  assert.deepEqual(parseClaudeResult(envelope), { summary: 'ok', findings: [] });
});

test('parseClaudeResult tolerates a fenced result', () => {
  const envelope = JSON.stringify({ is_error: false, result: '```json\n{"summary":"s","findings":[]}\n```' });
  assert.equal(parseClaudeResult(envelope).summary, 's');
});

test('parseClaudeResult throws on is_error', () => {
  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: '{}' })));
});

test('parseClaudeResult throws when result is not our shape', () => {
  assert.throws(() => parseClaudeResult(JSON.stringify({ result: '{"nope":1}' })));
});

test('parseClaudeResult throws on non-JSON result', () => {
  assert.throws(() => parseClaudeResult(JSON.stringify({ result: 'I could not comply' })));
});

test('parseClaudeResult parses unfenced JSON whose finding body embeds its own code fence', () => {
  // A finding's `body` can legitimately contain a ```suggestion/```yaml example.
  // The outer result itself is unfenced raw JSON — stripFences must not be
  // triggered at all here (or, if it is, must not grab the inner fence).
  const inner = {
    summary: 's',
    findings: [{ path: 'a.ts', line: 1, severity: 'Low', body: 'try this:\n```yaml\nif: true\n```' }],
  };
  const envelope = JSON.stringify({ is_error: false, result: JSON.stringify(inner) });
  assert.deepEqual(parseClaudeResult(envelope), inner);
});

import { parseDiffHunks, isCommentable, validateFinding } from './build-review.mjs';

const SAMPLE_DIFF = `diff --git a/src/db/x.ts b/src/db/x.ts
--- a/src/db/x.ts
+++ b/src/db/x.ts
@@ -10,3 +10,4 @@ context
 unchanged
+added line
 unchanged
 unchanged
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-deleted
-deleted
`;

test('parseDiffHunks captures RIGHT-side ranges for modified files', () => {
  const h = parseDiffHunks(SAMPLE_DIFF);
  assert.deepEqual(h.get('src/db/x.ts'), [[10, 13]]);
});

test('parseDiffHunks skips deleted files (+++ /dev/null)', () => {
  const h = parseDiffHunks(SAMPLE_DIFF);
  assert.equal(h.has('src/gone.ts'), false);
});

test('isCommentable is true inside a hunk, false outside', () => {
  const h = parseDiffHunks(SAMPLE_DIFF);
  assert.equal(isCommentable(h, 'src/db/x.ts', 11), true);
  assert.equal(isCommentable(h, 'src/db/x.ts', 99), false);
  assert.equal(isCommentable(h, 'unknown.ts', 11), false);
});

const HUNKS = parseDiffHunks(SAMPLE_DIFF); // src/db/x.ts: [10,13]
const base = { path: 'src/db/x.ts', line: 11, side: 'RIGHT', severity: 'High', confidence: 'High' };

test('validateFinding accepts a well-formed in-diff finding', () => {
  assert.deepEqual(validateFinding({ ...base }, HUNKS), { ok: true });
});
test('validateFinding rejects out-of-diff line', () => {
  assert.equal(validateFinding({ ...base, line: 99 }, HUNKS).reason, 'out-of-diff');
});
test('validateFinding rejects LEFT/other side', () => {
  assert.equal(validateFinding({ ...base, side: 'LEFT' }, HUNKS).reason, 'side');
});
test('validateFinding rejects bad severity', () => {
  assert.equal(validateFinding({ ...base, severity: 'Critical' }, HUNKS).reason, 'severity');
});
test('validateFinding rejects start_line >= line', () => {
  assert.equal(validateFinding({ ...base, start_line: 11, line: 11 }, HUNKS).reason, 'range');
});
test('validateFinding rejects start_line out of diff', () => {
  assert.equal(validateFinding({ ...base, start_line: 2, line: 11 }, HUNKS).reason, 'start-out-of-diff');
});
test('validateFinding accepts a valid multi-line range', () => {
  assert.deepEqual(validateFinding({ ...base, start_line: 10, line: 12 }, HUNKS), { ok: true });
});

import { buildReviewPayload } from './build-review.mjs';

test('buildReviewPayload splits inline vs folded and keeps the marker', () => {
  const parsed = {
    summary: 'Looks mostly good.',
    findings: [
      { path: 'src/db/x.ts', line: 11, side: 'RIGHT', severity: 'High', category: 'Security', confidence: 'High', body: 'RLS bypass.' },
      { path: 'src/db/x.ts', line: 99, side: 'RIGHT', severity: 'Low', category: 'Style', confidence: 'Low', body: 'nit' },
    ],
  };
  const p = buildReviewPayload(parsed, HUNKS);
  assert.equal(p.event, 'COMMENT');
  assert.equal(p.comments.length, 1);
  assert.equal(p.comments[0].line, 11);
  assert.match(p.body, /^<!-- ai-pr-review-go -->/);
  assert.match(p.body, /Findings outside the diff/);
  assert.match(p.body, /src\/db\/x\.ts:99/);
});
test('buildReviewPayload strips a suggestion block when confidence is not High', () => {
  const parsed = { summary: 's', findings: [
    { path: 'src/db/x.ts', line: 11, side: 'RIGHT', severity: 'Low', confidence: 'Low',
      body: 'try\n```suggestion\nconst x = 1;\n```' },
  ]};
  const p = buildReviewPayload(parsed, HUNKS);
  assert.doesNotMatch(p.comments[0].body, /```suggestion/);
});
test('buildReviewPayload keeps a High-confidence suggestion block', () => {
  const parsed = { summary: 's', findings: [
    { path: 'src/db/x.ts', line: 11, side: 'RIGHT', severity: 'High', confidence: 'High',
      body: 'fix\n```suggestion\nconst x = 1;\n```' },
  ]};
  const p = buildReviewPayload(parsed, HUNKS);
  assert.match(p.comments[0].body, /```suggestion/);
});
test('buildReviewPayload sets start_side for multi-line comments', () => {
  const parsed = { summary: 's', findings: [
    { path: 'src/db/x.ts', start_line: 10, line: 12, side: 'RIGHT', severity: 'High', confidence: 'High', body: 'range' },
  ]};
  const p = buildReviewPayload(parsed, HUNKS);
  assert.equal(p.comments[0].start_line, 10);
  assert.equal(p.comments[0].start_side, 'RIGHT');
});

import { runCli } from './build-review.mjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('runCli writes a payload + summary from raw + diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-'));
  const raw = JSON.stringify({ is_error: false, result: JSON.stringify({
    summary: 'ok',
    findings: [{ path: 'src/db/x.ts', line: 11, side: 'RIGHT', severity: 'High', confidence: 'High', body: 'bug' }],
  })});
  writeFileSync(join(dir, 'raw.json'), raw);
  writeFileSync(join(dir, 'pr.diff'), SAMPLE_DIFF);
  runCli(join(dir, 'raw.json'), join(dir, 'pr.diff'), join(dir, 'payload.json'), join(dir, 'summary.md'));
  const payload = JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf8'));
  assert.equal(payload.comments.length, 1);
  assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /ai-pr-review-go/);
});
