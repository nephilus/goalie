import { readFileSync, writeFileSync } from 'node:fs';
import { integrity } from './assertions.mjs';

const [journal, exportFile, destination] = process.argv.slice(2);
if (!journal || !exportFile || !destination) throw new Error('Usage: node report.mjs JOURNAL PROMPTFOO_EXPORT SUMMARY_JSON');
const exported = JSON.parse(readFileSync(exportFile, 'utf8'));
const rows = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
if (new Set(rows.map(row => row.request)).size !== rows.length) throw new Error('Journal contains duplicate physical request IDs; use a fresh journal for each run');
const contexts = new Map();
const counts = new Map();
const key = (caseId, prompt, output = null) => JSON.stringify([caseId, prompt, output]);
for (const result of exported.results.results) {
  const id = key(result.vars.caseId, result.prompt.label.split(':', 1)[0]);
  const context = { vars: result.vars, metadata: result.testCase.metadata };
  if (contexts.has(id) && JSON.stringify(contexts.get(id)) !== JSON.stringify(context)) throw new Error(`Conflicting exported contexts: ${id}`);
  contexts.set(id, context);
  const outcome = key(result.vars.caseId, result.prompt.label.split(':', 1)[0], result.response.output ?? null);
  counts.set(outcome, (counts.get(outcome) || 0) + 1);
}
const records = rows.map(row => {
  const id = key(row.caseId, row.promptLabel);
  const context = contexts.get(id);
  const outcome = key(row.caseId, row.promptLabel, row.output ?? null);
  if (!context || !counts.get(outcome)) throw new Error(`Journal/export mismatch: ${id}`);
  counts.set(outcome, counts.get(outcome) - 1);
  const complete = !row.error && row.finishReason === 'stop';
  const failureClass = complete ? null : row.finishReason === 'length' ? 'generation-limit' : row.httpStatus === 200 ? 'invalid-generation' : 'transport';
  const shape = integrity(row.output, context);
  let observed = 'invalid';
  if (shape.pass) {
    const output = JSON.parse(row.output);
    observed = context.vars.answerOnly === true ? 'answer' : output.suggestions.length ? 'suggest' : output.questions.length ? 'ask' : 'none';
  }
  return {
    request: row.request, caseId: row.caseId, split: context.metadata.split, category: context.metadata.category, prompt: row.promptLabel,
    complete, failureClass, integrity: shape.pass, observedDisposition: observed,
    reasons: [row.error, !complete && `finishReason=${row.finishReason}`, !shape.pass && shape.reason].filter(Boolean),
    latencyMs: row.latencyMs, tokens: row.usage?.total_tokens ?? null,
  };
});
if ([...counts.values()].some(count => count !== 0)) throw new Error('Export contains attempts missing from the physical request journal');
const groups = [];
for (const prompt of [...new Set(records.map(r => r.prompt))]) {
  for (const split of ['all', 'development', 'holdout']) {
    const selected = records.filter(r => r.prompt === prompt && (split === 'all' || r.split === split));
    if (!selected.length) continue;
    const times = selected.map(r => r.latencyMs).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    groups.push({
      prompt, split, runs: selected.length, completed: selected.filter(r => r.complete).length,
      integrityPass: selected.filter(r => r.complete && r.integrity).length,
      generationLimit: selected.filter(r => r.failureClass === 'generation-limit').length,
      transportErrors: selected.filter(r => r.failureClass === 'transport').length,
      medianLatencyMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
      p95LatencyMs: times[Math.ceil(times.length * 0.95) - 1],
      totalTokens: selected.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    });
  }
}
const summary = {
  note: 'Structural integrity only, not semantic correctness. Evidence may come from workstreams excluded from an action. Latency includes every attempt. Tokens include all journaled upstream usage, including truncated generations. Scripted continuations are not live multi-turn tests.',
  physicalRequests: rows.length, groups, records,
};
writeFileSync(destination, JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ physicalRequests: rows.length, groups }, null, 2));
