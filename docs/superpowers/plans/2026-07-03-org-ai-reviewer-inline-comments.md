# Org-wide AI PR Reviewer + Inline Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn File Valet's proven single-repo AI PR reviewer into an org-wide reviewer that runs under a GitHub App identity and posts line-anchored inline review comments, distributed as one versioned reusable workflow.

**Architecture:** A dedicated `heimdall` repo hosts a reusable workflow (`workflow_call`); each target repo has a thin caller. The App mints a **minimal-scoped** installation token per run. The risky deterministic logic (parse claude's JSON, validate findings against the diff, build the Reviews API payload, decide trigger/auth gating) is extracted into **unit-tested Node modules** (`node:test`, zero deps) rather than inline bash, so it has a real red→green test cycle. The workflow YAML is orchestration only, validated with `actionlint` + live dogfood.

**Tech Stack:** GitHub Actions (reusable workflows), `actions/create-github-app-token`, Node ≥20 built-in `node:test`, `gh` CLI (REST + GraphQL), `claude -p` against the OpenCode Go endpoint, `actionlint`.

**Source spec:** `docs/superpowers/specs/2026-07-02-org-ai-reviewer-github-app-design.md` (v2).

## Global Constraints

- Reviewer token is minted **minimal-scope**: `permission-pull-requests: write`, `permission-contents: read`, `permission-issues: write`, `permission-checks: write`. Never the App's full union.
- Review is always posted with `event: COMMENT` — never `REQUEST_CHANGES`.
- Trigger events: `pull_request [opened, ready_for_review, reopened]`, `issue_comment [created]`, `workflow_dispatch`. **Never `synchronize`.**
- The `issue_comment` command path runs **only** on same-repo (non-fork) PRs, **only** for actors with `write`/`admin` permission, and checks out a **pinned head SHA**.
- Styleguide is read from the **BASE ref only** (`git show origin/$BASE:.ai-review/styleguide.md`).
- Model command name: `@heim-dall <command>` — `review`, `review deep`, `explain <topic>`.
- Node scripts use **only** the Node standard library (`node:test`, `node:assert`, `node:fs`) — no npm dependencies, so `heimdall` needs no install step.
- Comment marker (upsert key): `<!-- ai-pr-review-go -->`.
- Reusable-workflow versioning: immutable `@vX.Y.Z` tags + a **moving `@v1`** alias; callers pin `@v1`.

---

## File Structure

**`heimdall` repo (new):**
- `.github/workflows/ai-pr-review.yml` — reusable workflow (`on: workflow_call`); orchestration only.
- `scripts/gate.mjs` — pure trigger/command/auth decisions. Testable.
- `scripts/gate.test.mjs` — tests for gate.mjs.
- `scripts/build-review.mjs` — parse claude output, parse diff hunks, validate findings, build Reviews API payload. Testable + a CLI entry.
- `scripts/build-review.test.mjs` — tests for build-review.mjs.
- `README.md` — what the repo is, how callers consume it, how to cut a release.

**Each target repo (File Valet first):**
- `.github/workflows/ai-review.yml` — ~15-line caller.
- `.ai-review/styleguide.md` — repo conventions (already exists in File Valet).
- (cutover) delete the standalone `.github/workflows/ai-pr-review.yml`.

---

## Phase 0 — Prerequisites (human/admin; not code)

These are the §12 blockers. An **org admin** must complete them before any code task runs. Each has an explicit acceptance check the implementer can verify with `gh`.

- [ ] **P0.1 — Register the GitHub App.** Create an org-owned App named `heim-dall`.
  - Permissions (the **union**, for future Hermes reuse): Pull requests: R/W · Contents: R/W · Metadata: R · Issues: R/W · Checks: W · Actions: R/W · Deployments: R/W.
  - Webhook: leave **Active** unchecked — events are consumed via GitHub Actions triggers (`on: pull_request`/`on: issue_comment` in the caller workflow), not a webhook server. No event subscription needed.
  - Install on the org (all repos, or a chosen set including File Valet).
  - **Accept check:** `gh api /orgs/<ORG>/installations --jq '.installations[].app_slug' | grep -qx heim-dall && echo OK`

- [ ] **P0.2 — Store org secrets.** Add org-level Actions secrets:
  - `HEIMDALL_APP_ID` = the App's numeric ID.
  - `HEIMDALL_PRIVATE_KEY` = the App private key (PEM, full file contents).
  - `OPENCODE_GO_KEY` already exists org-wide; confirm it's visible to the target repos.
  - **Accept check:** `gh api /orgs/<ORG>/actions/secrets --jq '.secrets[].name' | grep -E 'HEIMDALL_APP_ID|HEIMDALL_PRIVATE_KEY'`

- [ ] **P0.3 — Create the `heimdall` repo.** New repo `<ORG>/heimdall`, private/internal.
  - Settings → Actions → "Access": **Accessible from repositories in the organization** (so other repos can call the reusable workflow).
  - Name an owner responsible for cutting tags + moving the `@v1` alias.
  - **Accept check:** `gh repo view <ORG>/heimdall --json name -q .name` returns `heimdall`, and Actions access policy is set to organization.

> Do not start Phase 1 until all three accept-checks pass. The workflow cannot authenticate or be called otherwise.

---

## Phase 1 — Testable core: `gate.mjs`

Pure decision logic for whether/what to run. No `gh` calls here — the workflow gathers facts and passes them in.

### Task 1: Scaffold `heimdall` + prove the test runner

**Files:**
- Create: `scripts/gate.mjs`, `scripts/gate.test.mjs`, `README.md`

**Interfaces:**
- Produces: nothing yet (harness proof).

- [ ] **Step 1: Write a trivial failing test**

```js
// scripts/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './gate.mjs';

test('parseCommand returns null for empty', () => {
  assert.equal(parseCommand(''), null);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test scripts/gate.test.mjs`
Expected: FAIL — `Cannot find module './gate.mjs'` (or `parseCommand is not a function`).

- [ ] **Step 3: Create `gate.mjs` with a minimal `parseCommand`**

```js
// scripts/gate.mjs
export function parseCommand(body) {
  if (!body) return null;
  return null;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `node --test scripts/gate.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Write `README.md`**

```markdown
# heimdall

Shared, versioned CI for the org. Currently: the AI PR reviewer.

## Consuming the reviewer
Add `.github/workflows/ai-review.yml` to your repo (see the playbook asset) and pin `@v1`.

## Releasing
Edit `.github/workflows/ai-pr-review.yml` or `scripts/*.mjs`, then:
`git tag v1.2.3 && git push origin v1.2.3 && git tag -f v1 v1.2.3 && git push -f origin v1`
Callers pinned to `@v1` pick it up. Breaking changes: cut `v2`, migrate callers deliberately.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/gate.mjs scripts/gate.test.mjs README.md
git commit -m "chore: scaffold heimdall with node:test harness"
```

### Task 2: `parseCommand` — recognize the three commands

**Files:**
- Modify: `scripts/gate.mjs`, `scripts/gate.test.mjs`

**Interfaces:**
- Produces: `parseCommand(body: string): 'review'|'review-deep'|'explain'|null`

- [ ] **Step 1: Write failing tests**

```js
// append to scripts/gate.test.mjs
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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/gate.test.mjs`
Expected: FAIL (new tests error/fail; `review deep` returns null).

- [ ] **Step 3: Implement**

```js
// replace parseCommand in scripts/gate.mjs
export function parseCommand(body) {
  if (!body) return null;
  const m = body.match(/@heim-dall\s+(review\s+deep|review|explain)\b/i);
  if (!m) return null;
  const c = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (c === 'review deep') return 'review-deep';
  if (c === 'review') return 'review';
  if (c === 'explain') return 'explain';
  return null;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/gate.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.mjs scripts/gate.test.mjs
git commit -m "feat: parse @heim-dall commands"
```

### Task 3: `classifyTrigger` + `isAuthorized` — the gate

**Files:**
- Modify: `scripts/gate.mjs`, `scripts/gate.test.mjs`

**Interfaces:**
- Consumes: `parseCommand`.
- Produces:
  - `classifyTrigger(ctx): { run: boolean, command: 'review'|'review-deep'|'explain'|null, reason: string }`
    where `ctx = { eventName, action, isPullRequestComment, isFork, commentBody }`.
  - `isAuthorized(permission: string): boolean` — true for `'write'`/`'admin'`.

- [ ] **Step 1: Write failing tests**

```js
// append to scripts/gate.test.mjs
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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/gate.test.mjs`
Expected: FAIL — `classifyTrigger`/`isAuthorized` not exported.

- [ ] **Step 3: Implement**

```js
// append to scripts/gate.mjs
export function classifyTrigger(ctx) {
  if (ctx.eventName === 'workflow_dispatch') {
    return { run: true, command: 'review', reason: 'dispatch' };
  }
  if (ctx.eventName === 'pull_request') {
    if (['opened', 'ready_for_review', 'reopened'].includes(ctx.action)) {
      return { run: true, command: 'review', reason: 'pr-event' };
    }
    return { run: false, command: null, reason: 'ignored-pr-action' };
  }
  if (ctx.eventName === 'issue_comment') {
    if (!ctx.isPullRequestComment) return { run: false, command: null, reason: 'not-a-pr-comment' };
    const command = parseCommand(ctx.commentBody);
    if (!command) return { run: false, command: null, reason: 'no-command' };
    if (ctx.isFork) return { run: false, command, reason: 'fork-comment-blocked' };
    return { run: true, command, reason: 'command' };
  }
  return { run: false, command: null, reason: 'unknown-event' };
}

export function isAuthorized(permission) {
  return permission === 'write' || permission === 'admin';
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/gate.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.mjs scripts/gate.test.mjs
git commit -m "feat: trigger + authorization gate logic"
```

---

## Phase 2 — Testable core: `build-review.mjs`

Parse claude's output, map findings to the diff, build the Reviews API payload. Every sub-piece is a pure function with tests.

### Task 4: `stripFences` + `parseClaudeResult`

**Files:**
- Create: `scripts/build-review.mjs`, `scripts/build-review.test.mjs`

**Interfaces:**
- Produces:
  - `stripFences(s: string): string` — extract the JSON body from fenced/prose-wrapped text.
  - `parseClaudeResult(rawStdout: string): { summary: string, findings: object[] }` — throws on total failure (signals the workflow to use the legacy fallback).

- [ ] **Step 1: Write failing tests**

```js
// scripts/build-review.test.mjs
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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/build-review.test.mjs`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement**

```js
// scripts/build-review.mjs
export function stripFences(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}

export function parseClaudeResult(rawStdout) {
  const envelope = JSON.parse(rawStdout); // throws on non-JSON envelope
  if (envelope.is_error) throw new Error('claude reported is_error');
  const resultStr = envelope.result;
  if (typeof resultStr !== 'string' || resultStr.length === 0) {
    throw new Error('envelope has no .result string');
  }
  const obj = JSON.parse(stripFences(resultStr).trim()); // throws on non-JSON result
  if (!obj || typeof obj !== 'object' || typeof obj.summary !== 'string' || !Array.isArray(obj.findings)) {
    throw new Error('result is not {summary, findings[]}');
  }
  return obj;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/build-review.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-review.mjs scripts/build-review.test.mjs
git commit -m "feat: robust parse of claude JSON output"
```

### Task 5: `parseDiffHunks` + `isCommentable`

**Files:**
- Modify: `scripts/build-review.mjs`, `scripts/build-review.test.mjs`

**Interfaces:**
- Produces:
  - `parseDiffHunks(diffText: string): Map<string, Array<[number, number]>>` — per path, the RIGHT-side (new-file) line ranges present in the diff.
  - `isCommentable(hunks, path: string, line: number): boolean`.

- [ ] **Step 1: Write failing tests**

```js
// append to scripts/build-review.test.mjs
import { parseDiffHunks, isCommentable } from './build-review.mjs';

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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/build-review.test.mjs`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```js
// append to scripts/build-review.mjs
export function parseDiffHunks(diffText) {
  const files = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      current = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
    } else if (line.startsWith('@@') && current) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (m) {
        const start = parseInt(m[1], 10);
        const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
        if (count > 0) files.get(current).push([start, start + count - 1]);
      }
    }
  }
  return files;
}

export function isCommentable(hunks, path, line) {
  const ranges = hunks.get(path);
  if (!ranges) return false;
  return ranges.some(([s, e]) => line >= s && line <= e);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/build-review.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-review.mjs scripts/build-review.test.mjs
git commit -m "feat: parse diff hunks into commentable RIGHT-side ranges"
```

### Task 6: `validateFinding` — enforce the line-anchoring rules

**Files:**
- Modify: `scripts/build-review.mjs`, `scripts/build-review.test.mjs`

**Interfaces:**
- Consumes: `isCommentable`.
- Produces: `validateFinding(f, hunks): { ok: boolean, reason?: string }`. Rules (spec §7.1): `path` string; `line` integer in a hunk; `side` if present must be `'RIGHT'`; `severity` ∈ {High,Medium,Low}; `confidence` if present ∈ {High,Medium,Low}; if `start_line` present it must be an integer `< line` and also in a hunk.

- [ ] **Step 1: Write failing tests**

```js
// append to scripts/build-review.test.mjs
import { validateFinding } from './build-review.mjs';

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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/build-review.test.mjs`
Expected: FAIL — `validateFinding` missing.

- [ ] **Step 3: Implement**

```js
// append to scripts/build-review.mjs
const SEVERITIES = new Set(['High', 'Medium', 'Low']);

export function validateFinding(f, hunks) {
  if (!f || typeof f.path !== 'string' || !Number.isInteger(f.line)) return { ok: false, reason: 'shape' };
  if (f.side !== undefined && f.side !== 'RIGHT') return { ok: false, reason: 'side' };
  if (!SEVERITIES.has(f.severity)) return { ok: false, reason: 'severity' };
  if (f.confidence !== undefined && !SEVERITIES.has(f.confidence)) return { ok: false, reason: 'confidence' };
  if (f.start_line !== undefined && f.start_line !== null) {
    if (!Number.isInteger(f.start_line) || f.start_line >= f.line) return { ok: false, reason: 'range' };
    if (!isCommentable(hunks, f.path, f.start_line)) return { ok: false, reason: 'start-out-of-diff' };
  }
  if (!isCommentable(hunks, f.path, f.line)) return { ok: false, reason: 'out-of-diff' };
  return { ok: true };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/build-review.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-review.mjs scripts/build-review.test.mjs
git commit -m "feat: validate findings against diff + anchoring rules"
```

### Task 7: `buildReviewPayload` — inline vs folded, suggestion gating

**Files:**
- Modify: `scripts/build-review.mjs`, `scripts/build-review.test.mjs`

**Interfaces:**
- Consumes: `validateFinding`.
- Produces: `buildReviewPayload(parsed, hunks): { body: string, event: 'COMMENT', comments: Array<{path,line,side,body,start_line?,start_side?}> }`. Valid findings → inline comments (with `start_side:'RIGHT'` when `start_line` set); invalid → folded into `body` under "Findings outside the diff"; a ```suggestion block is stripped unless `confidence === 'High'`; body begins with the marker.

- [ ] **Step 1: Write failing tests**

```js
// append to scripts/build-review.test.mjs
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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/build-review.test.mjs`
Expected: FAIL — `buildReviewPayload` missing.

- [ ] **Step 3: Implement**

```js
// append to scripts/build-review.mjs
const MARKER = '<!-- ai-pr-review-go -->';

function stripSuggestion(body) {
  return body.replace(/```suggestion[\s\S]*?```/gi, '_(suggestion omitted — low confidence)_');
}
function oneLine(s) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function renderCommentBody(f) {
  let b = f.body || '';
  if (f.confidence !== 'High') b = stripSuggestion(b);
  const cat = f.category ? ` ${f.category}` : '';
  return `**[${f.severity}]${cat}** — ${b}`;
}

export function buildReviewPayload(parsed, hunks) {
  const comments = [];
  const folded = [];
  for (const f of parsed.findings) {
    const v = validateFinding(f, hunks);
    if (v.ok) {
      const c = { path: f.path, line: f.line, side: 'RIGHT', body: renderCommentBody(f) };
      if (f.start_line !== undefined && f.start_line !== null) {
        c.start_line = f.start_line;
        c.start_side = 'RIGHT';
      }
      comments.push(c);
    } else {
      folded.push(f);
    }
  }
  let body = `${MARKER}\n\n## 🤖 AI Code Review (Go)\n\n${parsed.summary}\n`;
  if (folded.length) {
    body += `\n### Findings outside the diff\n`;
    for (const f of folded) {
      const cat = f.category ? ` ${f.category}` : '';
      body += `- **[${f.severity}]${cat}** \`${f.path}:${f.line}\` — ${oneLine(f.body)}\n`;
    }
  }
  return { body, event: 'COMMENT', comments };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/build-review.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-review.mjs scripts/build-review.test.mjs
git commit -m "feat: build Reviews API payload with folding + suggestion gating"
```

### Task 8: CLI entry — wire the pipeline for the workflow to call

**Files:**
- Modify: `scripts/build-review.mjs`, `scripts/build-review.test.mjs`

**Interfaces:**
- Produces: `runCli(rawPath, diffPath, outPayloadPath, outSummaryPath): void` — reads files, builds the payload, writes `outPayloadPath` (JSON for `gh api --input`) and `outSummaryPath` (the `body` markdown for the legacy fallback + logs). Throws on total parse failure (workflow catches → fallback). Also a `import.meta`-guarded `main()` that reads argv.

- [ ] **Step 1: Write a failing test (tmp files)**

```js
// append to scripts/build-review.test.mjs
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
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/build-review.test.mjs`
Expected: FAIL — `runCli` missing.

- [ ] **Step 3: Implement**

```js
// append to scripts/build-review.mjs
import { readFileSync, writeFileSync } from 'node:fs';

export function runCli(rawPath, diffPath, outPayloadPath, outSummaryPath) {
  const parsed = parseClaudeResult(readFileSync(rawPath, 'utf8'));
  const hunks = parseDiffHunks(readFileSync(diffPath, 'utf8'));
  const payload = buildReviewPayload(parsed, hunks);
  writeFileSync(outPayloadPath, JSON.stringify(payload));
  writeFileSync(outSummaryPath, payload.body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [raw, diff, outPayload, outSummary] = process.argv.slice(2);
  runCli(raw, diff, outPayload, outSummary);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/build-review.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Run the whole suite**

Run: `node --test scripts/`
Expected: PASS (gate + build-review).

- [ ] **Step 6: Commit**

```bash
git add scripts/build-review.mjs scripts/build-review.test.mjs
git commit -m "feat: build-review CLI entry"
```

---

## Phase 3 — The reusable workflow

Orchestration YAML. No unit test runner; validated with `actionlint` then live dogfood (Phase 4). Each step's bash is thin — the logic lives in the tested `.mjs`.

### Task 9: Reusable workflow — gate, mint, checkout, review, post

**Files:**
- Create: `.github/workflows/ai-pr-review.yml`

**Interfaces:**
- Consumes: `scripts/gate.mjs` (`classifyTrigger`, `isAuthorized` via a tiny inline node `-e` call), `scripts/build-review.mjs` (CLI).
- Produces: a review comment on the PR under `heim-dall[bot]`.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ai-pr-review.yml
name: AI PR Review (Go)

on:
  workflow_call:
    inputs:
      pr_number:
        required: false
        type: string

permissions:
  contents: read

jobs:
  go-review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      ANTHROPIC_BASE_URL: https://opencode.ai/zen/go
      ANTHROPIC_MODEL: qwen3.7-plus
      ANTHROPIC_SMALL_FAST_MODEL: minimax-m2.5
      ANTHROPIC_DEFAULT_OPUS_MODEL: qwen3.7-max
      ANTHROPIC_DEFAULT_SONNET_MODEL: qwen3.7-plus
      ANTHROPIC_DEFAULT_HAIKU_MODEL: minimax-m2.5
      ANTHROPIC_DEFAULT_FABLE_MODEL: minimax-m3
      REVIEW_MODEL_DEFAULT: qwen3.7-plus
      REVIEW_MODEL_SENSITIVE: qwen3.7-max
    steps:
      - name: Checkout heimdall (scripts + workflow)
        uses: actions/checkout@v4

      - name: Mint minimal-scope App token
        id: token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.HEIMDALL_APP_ID }}
          private-key: ${{ secrets.HEIMDALL_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
          permission-pull-requests: write
          permission-contents: read
          permission-issues: write
          permission-checks: write

      - name: Gather trigger facts + gate
        id: gate
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          EVENT_NAME: ${{ github.event_name }}
          ACTION: ${{ github.event.action }}
          COMMENT_BODY: ${{ github.event.comment.body }}
          IS_PR_COMMENT: ${{ github.event.issue.pull_request != null }}
          PR_FROM_INPUT: ${{ inputs.pr_number }}
          PR_FROM_PR: ${{ github.event.pull_request.number }}
          PR_FROM_ISSUE: ${{ github.event.issue.number }}
          REPO: ${{ github.repository }}
          ACTOR: ${{ github.actor }}
        run: |
          set -euo pipefail
          PR="${PR_FROM_PR:-${PR_FROM_ISSUE:-$PR_FROM_INPUT}}"
          if ! [[ "$PR" =~ ^[0-9]+$ ]]; then echo "::error::bad PR number"; exit 1; fi
          # Fork + head SHA (pinned) via API.
          IS_FORK=$(gh api "repos/${REPO}/pulls/${PR}" --jq '.head.repo.full_name != .base.repo.full_name')
          HEAD_SHA=$(gh api "repos/${REPO}/pulls/${PR}" --jq '.head.sha')
          BASE=$(gh api "repos/${REPO}/pulls/${PR}" --jq '.base.ref')
          # Pure decision from the tested module.
          DECISION=$(node -e '
            import("./scripts/gate.mjs").then(g => {
              const d = g.classifyTrigger({
                eventName: process.env.EVENT_NAME,
                action: process.env.ACTION,
                isPullRequestComment: process.env.IS_PR_COMMENT === "true",
                isFork: process.env.IS_FORK === "true",
                commentBody: process.env.COMMENT_BODY || "",
              });
              process.stdout.write(JSON.stringify(d));
            })' )
          RUN=$(echo "$DECISION" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run')
          COMMAND=$(echo "$DECISION" | node -pe 'JSON.parse(require("fs").readFileSync(0)).command')
          REASON=$(echo "$DECISION" | node -pe 'JSON.parse(require("fs").readFileSync(0)).reason')
          echo "gate reason=$REASON run=$RUN command=$COMMAND"
          # Authorization for the comment-command path only.
          if [ "$EVENT_NAME" = "issue_comment" ] && [ "$RUN" = "true" ]; then
            PERM=$(gh api "repos/${REPO}/collaborators/${ACTOR}/permission" --jq '.permission' 2>/dev/null || echo none)
            AUTH=$(node -e "import('./scripts/gate.mjs').then(g=>process.stdout.write(String(g.isAuthorized('${PERM}'))))")
            if [ "$AUTH" != "true" ]; then
              gh pr comment "$PR" --body "@${ACTOR} you need write access to request a review." || true
              RUN=false; REASON=unauthorized
            fi
          fi
          {
            echo "run=$RUN"; echo "command=$COMMAND"; echo "pr=$PR";
            echo "is_fork=$IS_FORK"; echo "head_sha=$HEAD_SHA"; echo "base=$BASE";
          } >> "$GITHUB_OUTPUT"

      - name: Check out pinned PR head + capture diff
        if: ${{ steps.gate.outputs.run == 'true' }}
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          PR: ${{ steps.gate.outputs.pr }}
          HEAD_SHA: ${{ steps.gate.outputs.head_sha }}
          BASE: ${{ steps.gate.outputs.base }}
        run: |
          set -euo pipefail
          git fetch origin "$HEAD_SHA" --depth=1 || git fetch origin "refs/pull/${PR}/head" --force
          LIVE=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha')
          if [ "$LIVE" != "$HEAD_SHA" ]; then
            echo "::notice::head advanced ($HEAD_SHA -> $LIVE); reviewing the pinned SHA the requester saw."
          fi
          git checkout --force "$HEAD_SHA"
          gh pr diff "$PR" > pr-review.diff
          git show "origin/${BASE}:.ai-review/styleguide.md" > styleguide.md 2>/dev/null || : > styleguide.md
          echo "diff_lines=$(wc -l < pr-review.diff)"

      - name: Install Claude Code
        if: ${{ steps.gate.outputs.run == 'true' }}
        run: npm install -g @anthropic-ai/claude-code@2.1.193

      - name: Detect sensitive paths + pick engine
        id: engine
        if: ${{ steps.gate.outputs.run == 'true' }}
        env:
          COMMAND: ${{ steps.gate.outputs.command }}
        run: |
          set -euo pipefail
          SENSITIVE_RE='^(src/db/|src/actions/|src/middleware|middleware\.ts|src/lib/auth|src/lib/services/.*[Aa]uth)|(^|[^a-zA-Z])rls([^a-zA-Z]|$)|step-up|better-auth'
          MODEL="$REVIEW_MODEL_DEFAULT"; NOTE=""
          if grep -Eq "$SENSITIVE_RE" pr-review.diff; then MODEL="$REVIEW_MODEL_SENSITIVE"; NOTE="escalated"; fi
          if [ "$COMMAND" = "review-deep" ]; then MODEL="$REVIEW_MODEL_SENSITIVE"; NOTE="deep"; fi
          echo "model=$MODEL" >> "$GITHUB_OUTPUT"
          echo "note=$NOTE" >> "$GITHUB_OUTPUT"

      # NOTE (spec §8): `review deep` is gated to write/admin above. The optional
      # per-day-per-PR rate limit on deep is a follow-on hardening — implement by
      # counting this bot's prior "deep" summary comments in the last 24h before
      # honoring `review-deep`, else downgrade to REVIEW_MODEL_DEFAULT. Deferred
      # so v1 ships; the auth gate is the primary spend control.
      - name: Run AI review (Go / claude -p)
        id: review
        if: ${{ steps.gate.outputs.run == 'true' }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.OPENCODE_GO_KEY }}
          ANTHROPIC_MODEL: ${{ steps.engine.outputs.model }}
          PR: ${{ steps.gate.outputs.pr }}
        run: |
          set -euo pipefail
          if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "::notice::no Go key (fork?); skipping."; exit 0; fi
          if [ ! -s pr-review.diff ]; then echo "empty diff; nothing to review."; exit 0; fi
          STYLE=""; [ -s styleguide.md ] && STYLE="Repo styleguide (authoritative, from base):\n$(cat styleguide.md)\n"
          PROMPT="You are reviewing pull request #${PR}. The diff is in pr-review.diff — read it first, then read CLAUDE.md and any changed source files WITHIN THIS REPOSITORY ONLY for context (never read paths outside the repo working tree). Review deeply for: correctness/logic bugs; security (multi-tenant RLS, missing organization_id, queries outside withRLS/withRLSForOrg, auth & step-up, input validation); reliability/data; breaking changes & tests. Bias toward disclosure; skip pure style. Cite path:line for every finding and verify it exists. ${STYLE}
          Output ONLY a single JSON object, no prose, no code fences, exactly:
          {\"summary\":\"markdown verdict + coverage + counts\",\"findings\":[{\"path\":\"<repo-relative>\",\"line\":<new-file RIGHT-side line>,\"start_line\":<optional, < line>,\"side\":\"RIGHT\",\"severity\":\"High|Medium|Low\",\"category\":\"<short>\",\"confidence\":\"High|Medium|Low\",\"body\":\"markdown; a \`\`\`suggestion block only if you are highly confident\"}]}
          Use new-file line numbers. If there are no issues, findings is []."
          attempt=0; max=2; ok=false
          while [ $attempt -lt $max ]; do
            set +e
            claude -p "$PROMPT" --allowedTools "Read,Grep,Glob" --output-format json --max-turns 60 > raw.json 2> claude.err
            code=$?
            set -e
            if [ $code -eq 0 ] && [ -s raw.json ] && [ "$(jq -r '.is_error // false' raw.json)" != "true" ]; then ok=true; break; fi
            attempt=$((attempt+1)); [ $attempt -lt $max ] && sleep $((attempt*5))
          done
          if [ "$ok" != "true" ]; then echo "::error::claude failed after retries"; cat claude.err || true; exit 1; fi

      - name: Build payload (tested module) or fall back
        id: build
        if: ${{ steps.gate.outputs.run == 'true' && hashFiles('raw.json') != '' }}
        run: |
          set -euo pipefail
          if node scripts/build-review.mjs raw.json pr-review.diff review.payload.json review.summary.md; then
            echo "mode=inline" >> "$GITHUB_OUTPUT"
          else
            echo "::notice::JSON parse failed; falling back to summary comment."
            jq -r '.result // ""' raw.json > review.summary.md || : > review.summary.md
            if ! grep -qF '<!-- ai-pr-review-go -->' review.summary.md; then
              { printf '<!-- ai-pr-review-go -->\n\n## 🤖 AI Code Review (Go)\n\n'; cat review.summary.md; } > review.summary.md.tmp
              mv review.summary.md.tmp review.summary.md
            fi
            echo "mode=fallback" >> "$GITHUB_OUTPUT"
          fi

      - name: Post review (inline) or summary (fallback)
        if: ${{ steps.gate.outputs.run == 'true' && hashFiles('review.summary.md') != '' }}
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          PR: ${{ steps.gate.outputs.pr }}
          REPO: ${{ github.repository }}
          MODE: ${{ steps.build.outputs.mode }}
        run: |
          set -euo pipefail
          MARKER="<!-- ai-pr-review-go -->"
          # Minimize our prior inline review comments (COMMENT reviews can't be dismissed).
          NODE_IDS=$(gh api "repos/${REPO}/pulls/${PR}/comments" --paginate \
            --jq "[.[] | select(.body | contains(\"${MARKER}\")) | .node_id][]" 2>/dev/null || true)
          for id in $NODE_IDS; do
            gh api graphql -f query='mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){clientMutationId}}' -f id="$id" >/dev/null || true
          done
          if [ "$MODE" = "inline" ] && [ -s review.payload.json ]; then
            gh api -X POST "repos/${REPO}/pulls/${PR}/reviews" --input review.payload.json >/dev/null
            echo "Posted inline review."
          fi
          # Upsert the summary comment (also carries folded findings / fallback body).
          existing=$(gh api "repos/${REPO}/issues/${PR}/comments" --paginate \
            --jq "[.[] | select(.body | contains(\"${MARKER}\"))][0].id // empty")
          if [ -n "$existing" ]; then
            gh api -X PATCH "repos/${REPO}/issues/comments/${existing}" -F "body=@review.summary.md" >/dev/null
          else
            gh pr comment "$PR" --body-file review.summary.md
          fi
```

- [ ] **Step 2: Lint the workflow**

Run: `actionlint .github/workflows/ai-pr-review.yml`
Expected: no errors. (Fix any reported issue before continuing. Remove the placeholder `env_note: ""` line — it is not valid; it's here only to mark that the gate step needs no extra env. If actionlint flags it, delete it.)

- [ ] **Step 3: Sanity-check the gate node call locally**

Run:
```bash
EVENT_NAME=pull_request ACTION=opened node -e 'import("./scripts/gate.mjs").then(g=>console.log(g.classifyTrigger({eventName:process.env.EVENT_NAME,action:process.env.ACTION})))'
```
Expected: `{ run: true, command: 'review', reason: 'pr-event' }`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ai-pr-review.yml
git commit -m "feat: reusable AI PR review workflow (gate, minimal token, inline comments)"
```

- [ ] **Step 5: Push `heimdall` + set the pre-release ref**

```bash
git push origin main
```
(No tag yet — callers will pin `@main` for dogfood, then `@v1` after Phase 4.)

---

## Phase 4 — Caller, cutover, live dogfood, release

### Task 10: File Valet caller + cutover (delete the standalone workflow)

**Files (in the File Valet repo/worktree):**
- Create: `.github/workflows/ai-review.yml`
- Delete: `.github/workflows/ai-pr-review.yml` (the standalone reviewer)
- Keep: `.ai-review/styleguide.md` (already present)

- [ ] **Step 1: Write the caller**

```yaml
# .github/workflows/ai-review.yml
name: AI Review
on:
  pull_request:
    types: [opened, ready_for_review, reopened]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number: { description: 'PR number', required: true, type: string }

concurrency:
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ github.event_name != 'issue_comment' || contains(github.event.comment.body, '@heim-dall') }}
    uses: <ORG>/heimdall/.github/workflows/ai-pr-review.yml@main   # dogfood ref; switch to @v1 after release
    secrets: inherit
    with:
      pr_number: ${{ inputs.pr_number }}
```

- [ ] **Step 2: Delete the standalone workflow (same PR — avoids dual-review)**

```bash
git rm .github/workflows/ai-pr-review.yml
```

- [ ] **Step 3: Lint**

Run: `actionlint .github/workflows/ai-review.yml`
Expected: no errors. Replace `<ORG>` with the real org login first.

- [ ] **Step 4: Commit + open the cutover PR**

```bash
git add .github/workflows/ai-review.yml
git commit -m "feat: adopt org AI reviewer via heimdall; remove standalone workflow"
```
Open a PR to File Valet's default branch. Do **not** push to `main`/`dev` directly.

### Task 11: Live dogfood validation (behavioral — the workflow's real test)

Trigger the reviewer on a real File Valet PR (the cutover PR itself works). Verify each — this is the acceptance gate the spec §10 step 3 requires:

- [ ] Review comment is authored by **`heim-dall[bot]`** (App identity, not `github-actions`).
- [ ] At least one **inline** comment is anchored to the correct changed line.
- [ ] A deliberately out-of-diff finding appears under **"Findings outside the diff"** in the summary, not dropped.
- [ ] Force a bad-JSON run (e.g. temporarily a tiny `--max-turns 1`) → the **fallback** summary posts; restore `--max-turns 60`.
- [ ] From a **fork** PR: automatic run **soft-skips** (no secrets) and `@heim-dall review` in a comment is **refused** (fork-comment-blocked).
- [ ] As a **read-only** actor, `@heim-dall review` gets the "need write access" reply and does not run.
- [ ] `@heim-dall review deep` uses `qwen3.7-max` (check run logs) and a read-only user cannot invoke it.
- [ ] Re-request on the same PR: prior inline comments are **minimized (OUTDATED)** and the summary is **updated in place** (not duplicated).
- [ ] Only **one** review posts (the standalone workflow is gone — no dual-review).

- [ ] **Commit note:** if any check fails, fix in `heimdall` on `main`, push, re-run; the caller's `@main` picks it up immediately.

### Task 12: Cut the release + repoint the caller

- [ ] **Step 1: Tag `heimdall`**

```bash
# in heimdall
git tag v1.0.0 && git push origin v1.0.0
git tag -f v1 v1.0.0 && git push -f origin v1
```

- [ ] **Step 2: Repoint File Valet's caller from `@main` to `@v1`**

Edit `.github/workflows/ai-review.yml`: `...ai-pr-review.yml@v1`. Commit:
```bash
git commit -am "chore: pin heimdall reviewer to @v1"
```

- [ ] **Step 3: Expand** — add the same ~15-line caller (pinned `@v1`) to 1–2 more repos; confirm a review posts. Org-wide rollout (and any org-ruleset + opt-out) is follow-on, out of this plan's scope.

---

## Notes for the executor

- **Two repos, explicit authorization:** Phases 1–3 + Task 12 run in **`heimdall`**; Phase 4 Tasks 10–11 run in the **File Valet** checkout. Each is outside this playbook repo — treat the repo path you're handed as the authorization to work there, and never touch a third repo.
- **No pushing to protected branches:** open PRs; only `heimdall`'s own `main`/tags are pushed directly (it's the source of the reusable workflow and has no protected review flow yet — confirm with its owner).
- **Secrets discipline:** never echo `HEIMDALL_PRIVATE_KEY`, the minted token, or `OPENCODE_GO_KEY` in logs.
```
