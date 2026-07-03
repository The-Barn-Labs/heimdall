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
