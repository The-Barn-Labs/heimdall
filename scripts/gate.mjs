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
