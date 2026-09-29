import assert from 'node:assert/strict';
import test from 'node:test';
import { withContextEvidence } from './context-evidence.mjs';
import { integrity } from './assertions.mjs';

const fixture = () => ({
  workstreams: [{ id: 'producer', name: 'Producer' }, { id: 'consumer', name: 'Consumer' }],
  sources: [{ id: 'note', workstreamId: 'producer', text: 'The format is unchanged.' }],
  priorDecisions: [{ id: 'decision-record', text: 'No joint review while the format is unchanged.', sourceIds: ['note'] }],
  conversation: [{ role: 'user', content: 'Does the prior decision still hold?' }],
});

// Exercise the model-facing record ID through the real citation validator.
test('a decision keeps one citable identity through context projection', () => {
  const original = fixture();
  const untouched = structuredClone(original);
  const input = withContextEvidence(original);
  const decision = input.priorDecisions[0];
  const output = { answer: { text: 'The unchanged format does not reopen the decision.', evidence: [{ sourceId: decision.id, quote: decision.text }] }, suggestions: [], questions: [] };
  const context = { vars: { input, extendedEvidence: true, requireAnswer: true } };
  assert.equal(integrity(JSON.stringify(output), context).pass, true);
  assert.deepEqual(original, untouched);
  output.answer.evidence[0].sourceId = 'invented-record';
  assert.equal(integrity(JSON.stringify(output), context).pass, false);
});

test('distinct facts cannot silently share a citation identifier', () => {
  const input = fixture();
  input.priorDecisions[0].id = input.sources[0].id;
  assert.throws(() => withContextEvidence(input), /ID collision/);
});

test('answer-only advice rejects action payloads without bypassing citation checks', () => {
  const input = withContextEvidence(fixture());
  const context = { vars: { input, extendedEvidence: true, requireAnswer: true, answerOnly: true } };
  const output = { answer: { text: 'No additional review is needed.', evidence: [{ sourceId: input.priorDecisions[0].id, quote: input.priorDecisions[0].text }] } };
  assert.equal(integrity(JSON.stringify(output), context).pass, true);
  assert.equal(integrity(JSON.stringify({ ...output, suggestions: [], questions: [] }), context).pass, false);
  const misplacedEvidence = { answer: { text: output.answer.text }, evidence: output.answer.evidence };
  assert.equal(integrity(JSON.stringify(misplacedEvidence), context).pass, false);
  assert.equal(integrity(JSON.stringify(output), { vars: { ...context.vars, requireAnswer: false } }).pass, false);
  const wrongNamespace = structuredClone(output);
  wrongNamespace.answer.evidence[0].sourceId = `decision:${input.priorDecisions[0].id}`;
  assert.equal(integrity(JSON.stringify(wrongNamespace), context).pass, false);
  const inventedQuote = structuredClone(output);
  inventedQuote.answer.evidence[0].quote += ' Approval was granted.';
  assert.equal(integrity(JSON.stringify(inventedQuote), context).pass, false);
});
