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

// Long-lived integration branches. A PR *from* one of these is a promotion of
// already-merged work, not a unit of new work.
const RELEASE_TRAIN_HEADS = new Set(['dev', 'develop', 'staging']);

// A promote / release-train PR (dev -> staging -> main) aggregates commits that
// were each already reviewed on their way into the integration branch, so a
// second full review re-reads work that is already covered. At release-train
// size it also cannot finish: file-valet #1797 was 453 files / ~778k tokens
// even after generated files were excluded, and the job hit its 15m timeout
// without producing a review at all.
//
// Keyed on the PR's SHAPE, not its size — so a small promote PR is skipped too
// (file-valet #1463 was 14 files, #1229 was 2). That is a deliberate trade:
// those would review fine, but the convention is "promotions are not review
// surfaces". The escape hatch is explicit intent — see classifyTrigger, where
// an `@heim-dall review` comment or a workflow_dispatch still runs in full.
export function isReleaseTrain({ title, headRef } = {}) {
  // ANCHORED, and \b-terminated. A title that merely mentions a promotion
  // ("docs(inbox): triage 2026-07-14 — promote 4 items to dev",
  // "ci(staging): add served-vs-promoted commit gate") is ordinary work that
  // must still be reviewed; only a title that *starts* "promote:" / "Promote "
  // is the release-train convention. \b also stops "Promoted ..." matching.
  if (typeof title === 'string' && /^\s*promote\b/i.test(title)) return true;
  if (typeof headRef === 'string' && RELEASE_TRAIN_HEADS.has(headRef.trim())) return true;
  return false;
}

export function classifyTrigger(ctx) {
  if (ctx.eventName === 'workflow_dispatch') {
    return { run: true, command: 'review', reason: 'dispatch' };
  }
  if (ctx.eventName === 'pull_request') {
    if (['opened', 'ready_for_review', 'reopened'].includes(ctx.action)) {
      // Automatic triggers only. A human asking for it by name (issue_comment
      // below) or by hand (workflow_dispatch above) has opted in knowingly and
      // still gets the full review.
      if (isReleaseTrain(ctx)) return { run: false, command: null, reason: 'release-train' };
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
