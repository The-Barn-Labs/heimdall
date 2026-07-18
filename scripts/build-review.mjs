export function stripFences(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}

const ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

// Escape raw (unescaped) control characters (0x00-0x1F) that appear INSIDE a
// JSON string literal -- invalid per the JSON spec, but a common LLM mistake
// (emitting a literal newline instead of the \n escape sequence). Control
// characters used as insignificant whitespace BETWEEN tokens (e.g. in
// pretty-printed JSON) are left untouched -- only tracks in/out of a string
// literal, toggled by unescaped double-quotes.
export function sanitizeControlChars(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch.charCodeAt(0) < 0x20) {
        out += ESCAPES[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

export function parseClaudeResult(rawStdout) {
  const envelope = JSON.parse(rawStdout); // throws on non-JSON envelope
  if (envelope.is_error) throw new Error('claude reported is_error');
  const resultStr = envelope.result;
  if (typeof resultStr !== 'string' || resultStr.length === 0) {
    throw new Error('envelope has no .result string');
  }
  // Prefer parsing the result as-is: the common case is unfenced raw JSON,
  // which may itself contain embedded code fences inside a finding's `body`
  // text. Only fall back to fence-stripping if direct parsing fails. Raw
  // control characters inside string values (another common LLM mistake) are
  // sanitized up front, before either parse attempt.
  const sanitized = sanitizeControlChars(resultStr);
  let obj;
  try {
    obj = JSON.parse(sanitized.trim());
  } catch {
    obj = JSON.parse(stripFences(sanitized)); // throws on non-JSON result
  }
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
// Collapse to a single line for a preview. Cut on a word boundary (not
// mid-word) and append an ellipsis when truncated, so the collapsed <summary>
// never ends in a severed token. The preview sits inside <summary> (an HTML
// context), so after truncating we strip backticks — a mid-span cut would
// otherwise leave an unclosed code span that swallows the rest of the line —
// and escape HTML-sensitive chars so a literal <Type> isn't parsed as a tag.
// Sanitizing AFTER truncation (not before) guarantees we never sever an escape
// entity like &lt; into a broken &l….
export function oneLine(s, max = 200) {
  const flat = (s || '').replace(/\s+/g, ' ').trim();
  let cut;
  if (flat.length <= max) {
    cut = flat;
  } else {
    const slice = flat.slice(0, max);
    const lastSpace = slice.lastIndexOf(' ');
    // Guard lastSpace !== -1: with a small max, `max - 40` goes negative and a
    // no-space slice (lastSpace === -1) would satisfy `-1 > max-40` and chop the
    // last real char. Unreachable at the default max=200, but robust if callers
    // ever pass a smaller budget.
    cut = (lastSpace !== -1 && lastSpace > max - 40 ? slice.slice(0, lastSpace) : slice) + '…';
  }
  return cut
    // Strip inline-markdown markers: the preview lands in a <summary> where they
    // render literally (ugly `**bold**`), and a truncated pair would leave an
    // unclosed marker. Backtick + asterisk are what this bot actually emits.
    .replace(/[`*]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function renderCommentBody(f) {
  let b = f.body || '';
  if (f.confidence !== 'High') b = stripSuggestion(b);
  const cat = f.category ? ` ${f.category}` : '';
  return `**[${f.severity}]${cat}** — ${b}`;
}
// Pick a line GitHub will definitely accept for an inline comment, so a finding
// whose true location is not in the diff can still be posted as a RESOLVABLE
// review thread (folded prose is not — a required thread-resolution ruleset
// can't gate on it). Prefer the finding's OWN file (right file, just a line
// outside the diff hunks); fall back to the first changed file in the diff.
// `hunks` is a Map in diff order, so the fallback is deterministic. Returns
// null only when the diff has no commentable line anywhere — then fold.
export function pickAnchor(hunks, preferredPath) {
  const firstLine = (ranges) => (ranges && ranges.length ? ranges[0][0] : null);
  const own = firstLine(hunks.get(preferredPath));
  if (own !== null) return { path: preferredPath, line: own, sameFile: true };
  for (const [path, ranges] of hunks) {
    const line = firstLine(ranges);
    if (line !== null) return { path, line, sameFile: false };
  }
  return null;
}
// A well-formed finding GitHub can't anchor at its true location, re-homed onto
// an in-diff line (the `anchor`) so it becomes a resolvable thread. A banner
// names the real location; ANY ```suggestion block is stripped unconditionally
// — "Apply suggestion" would patch the anchor line, which is the wrong line by
// construction (unlike renderCommentBody, which keeps High-confidence
// suggestions because there the comment sits on the correct line).
function renderRelocatedBody(f, anchor) {
  const where = anchor.sameFile
    ? `line ${f.line} of \`${f.path}\`, which falls outside this PR's diff hunks`
    : `\`${f.path}:${f.line}\`, which has no line in this PR's diff to anchor to`;
  const banner =
    `> ⚠️ **This comment is really about ${where}.** ` +
    `GitHub can't anchor it there, so it's pinned to this line only to stay a resolvable thread.`;
  const stripped = (f.body || '').replace(
    /```suggestion[\s\S]*?```/gi,
    '_(suggestion omitted — this comment is pinned to a different line than the finding)_',
  );
  const cat = f.category ? ` ${f.category}` : '';
  return `${banner}\n\n**[${f.severity}]${cat}** — ${stripped}`;
}
// Folded findings fall outside the diff hunks GitHub accepts for inline review
// comments, so the summary body is their ONLY surface. Render the FULL body
// inside a collapsible <details> — the previous one-line preview hard-sliced
// each finding at 200 chars, silently dropping its reasoning and suggested fix
// (and cutting mid-word). The <summary> keeps a scannable severity/path header
// plus a clean preview; the full text is one click away.
function renderFoldedFinding(f) {
  let b = f.body || '';
  if (f.confidence !== 'High') b = stripSuggestion(b);
  const cat = f.category ? ` ${f.category}` : '';
  // GitHub renders NO markdown inside <summary> — `**bold**` and `` `code` ``
  // show up as literal asterisks/backticks. Keep the summary PLAIN TEXT
  // ("[Sev] category path:line — preview"); the full body below <summary> is
  // normal markdown and renders bold/code/fences correctly.
  const header = `[${f.severity}]${cat} ${f.path}:${f.line}`
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const preview = oneLine(b);
  const summaryText = preview ? `${header} — ${preview}` : header;
  return `<details>\n<summary>${summaryText}</summary>\n\n${b}\n\n</details>`;
}

export function buildReviewPayload(parsed, hunks) {
  const folded = [];
  // Collect comments keyed by their (path, line). GitHub's review-thread
  // validation is finicky about two comments sharing a position in one payload,
  // and a single bad entry 422s the ENTIRE review — losing every finding. This
  // happens for real: when several findings relocate to the same fallback
  // anchor (e.g. two findings on files absent from the diff — file-valet #1806),
  // they'd otherwise stack on one line. Merge same-position comments into a
  // single thread instead; the first entry keeps its positional fields (range
  // and all), later bodies are appended under a rule.
  const byPos = new Map();
  const order = [];
  const addComment = (c) => {
    const key = `${c.path} ${c.line}`;
    const existing = byPos.get(key);
    if (existing) {
      existing.body += `\n\n---\n\n${c.body}`;
    } else {
      byPos.set(key, c);
      order.push(key);
    }
  };
  for (const f of parsed.findings) {
    const v = validateFinding(f, hunks);
    if (v.ok) {
      const c = { path: f.path, line: f.line, side: 'RIGHT', body: renderCommentBody(f) };
      if (f.start_line !== undefined && f.start_line !== null) {
        c.start_line = f.start_line;
        c.start_side = 'RIGHT';
      }
      addComment(c);
    } else if (v.reason === 'out-of-diff' || v.reason === 'start-out-of-diff') {
      // Well-formed finding, just not anchorable at its true location (line
      // outside the diff hunks, or the file isn't in the diff at all). Re-home
      // it onto a proven in-diff line so it posts as a resolvable review thread
      // instead of ignorable folded prose. Fold only as a last resort, when the
      // diff exposes no commentable line anywhere (guards against a whole-review
      // 422 from an invalid anchor).
      const anchor = pickAnchor(hunks, f.path);
      if (anchor) {
        addComment({ path: anchor.path, line: anchor.line, side: 'RIGHT', body: renderRelocatedBody(f, anchor) });
      } else {
        folded.push(f);
      }
    } else {
      // Malformed (bad shape/side/severity/range) — untrustworthy on any line.
      folded.push(f);
    }
  }
  const comments = order.map((k) => byPos.get(k));
  let body = `${MARKER}\n\n## 🤖 AI Code Review (Go)\n\n${parsed.summary}\n`;
  if (folded.length) {
    body += `\n### Findings outside the diff\n`;
    for (const f of folded) {
      body += `\n${renderFoldedFinding(f)}\n`;
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
