export function parseCommand(body) {
  if (!body) return null;
  const m = body.match(/@heimdall\s+(review\s+deep|review|explain)\b/i);
  if (!m) return null;
  const c = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (c === 'review deep') return 'review-deep';
  if (c === 'review') return 'review';
  if (c === 'explain') return 'explain';
  return null;
}
