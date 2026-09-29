import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withContextEvidence } from './context-evidence.mjs';

const file = name => fileURLToPath(new URL(name, import.meta.url));
const variants = (process.env.GOALIE_EVAL_VARIANTS || 'attention,skilled').split(',');
const ids = (process.env.GOALIE_EVAL_CASE_IDS || 'c01,c03,c08,c13,c19,c22').split(',');
const cases = JSON.parse(readFileSync(file(process.env.GOALIE_EVAL_CASES || 'cases.json'), 'utf8'));
if (variants.some(name => !['attention', 'skilled', 'refined', 'optionalStep', 'answerFirst', 'conciseAnswer', 'advisor'].includes(name)) || new Set(variants).size !== variants.length) throw new Error('Unknown or duplicate prompt variants');
if (variants.some(name => ['optionalStep', 'answerFirst', 'conciseAnswer', 'advisor'].includes(name)) && variants.length !== 1) throw new Error('Run different output contracts separately');
if (new Set(ids).size !== ids.length || ids.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown or duplicate case IDs');
const extendedEvidence = process.env.GOALIE_EVAL_CONTEXT_EVIDENCE === '1';
const basePrompt = process.env.GOALIE_EVAL_BASE_PROMPT || 'skilled';
if (!['attention', 'skilled', 'refined'].includes(basePrompt)) throw new Error('Unknown base prompt for nullable-action comparison');
const selected = cases.filter(c => ids.includes(c.id));

export default {
  description: 'Controlled prompt/skill/contract iteration; integrity is not a semantic quality score',
  prompts: variants.map(name => ({ id: `file://${file('iteration-prompts.mjs')}:${name}`, label: name })),
  providers: [{ id: `file://${file('provider.mjs')}` }],
  tests: selected.map(c => ({
    description: `${c.id}: ${c.category} (${c.split})`,
    vars: { caseId: c.id, input: extendedEvidence ? withContextEvidence(c.input) : c.input, expected: c.expected, extendedEvidence, basePrompt, allowNullNextStep: variants[0] === 'optionalStep', requireAnswer: ['answerFirst', 'conciseAnswer', 'advisor'].includes(variants[0]), conciseAdvice: variants[0] === 'conciseAnswer', answerOnly: variants[0] === 'advisor' },
    metadata: { split: c.split, category: c.category, scriptedContinuation: c.input.conversation.length > 0 },
  })),
  defaultTest: { assert: [{ type: 'javascript', value: `file://${file('assertions.mjs')}:integrity`, metric: 'Integrity' }] },
  evaluateOptions: { maxConcurrency: 1, repeat: 2, cache: false },
  sharing: false,
};
