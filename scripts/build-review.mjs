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
