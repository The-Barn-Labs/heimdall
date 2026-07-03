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
