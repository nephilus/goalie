import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = name => fileURLToPath(new URL(name, import.meta.url));
const cases = JSON.parse(readFileSync(file('cases.json'), 'utf8'));

export default {
  description: 'Synthetic workstream advice: baseline versus evidence-first; semantic review remains separate',
  prompts: [
    { id: `file://${file('baseline.txt')}`, label: 'baseline' },
    { id: `file://${file('evidence-first.txt')}`, label: 'evidence-first' },
  ],
  providers: [{ id: `file://${file('provider.mjs')}` }],
  tests: cases.map(c => ({
    description: `${c.id}: ${c.category} (${c.split})`,
    vars: { caseId: c.id, input: c.input, expected: c.expected },
    metadata: { split: c.split, category: c.category, scriptedContinuation: c.input.conversation.length > 0 },
  })),
  defaultTest: {
    assert: [
      { type: 'javascript', value: `file://${file('assertions.mjs')}:integrity`, metric: 'Integrity' },
    ],
  },
  evaluateOptions: { maxConcurrency: 1, repeat: 3, cache: false },
  sharing: false,
};
