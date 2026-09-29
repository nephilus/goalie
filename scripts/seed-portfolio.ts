import { migrate, pool } from '../app/server/db.server';
import { executeCommand, readData } from '../app/server/store.server';
import { type WorkData } from '../app/shared/model';
import { portfolioExample } from './portfolio-example';

if (!process.argv.includes('--confirm-synthetic-demo')) throw new Error('Pass --confirm-synthetic-demo to add the labelled coordination example. Existing work is not reset.');
if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.APP_URL ?? '').hostname)) throw new Error('Example seed is restricted to local nonproduction environments.');
try {
  await migrate();
  const existing = await readData();
  if (!existing.demo || existing.people.some(person => !person.email.endsWith('@example.test'))) throw new Error('Only a labelled synthetic demo with example.test identities may receive this example.');
  const admin = existing.people.find(person => person.email === 'goalie-admin@example.test' && person.role === 'admin');
  if (!admin) throw new Error('The synthetic demo administrator is missing.');
  const example = portfolioExample(existing, admin.id);
  for (const collection of ['items', 'outcomes', 'capabilities', 'signals', 'opportunities'] as const) {
    const previous = new Set(existing[collection].map(record => record.id));
    if (example[collection].some(record => previous.has(record.id))) throw new Error(`Example ${collection} already exist. Refusing to overwrite them.`);
  }
  const data: WorkData = { schemaVersion: 2, revision: existing.revision, demo: true, people: [], workstreams: [], dependencies: [], updates: [], changes: [], ...example };
  await executeCommand({ expectedRevision: existing.revision, command: { type: 'data.import', data } }, admin);
  console.log('Added four labelled tasks, three outcomes, two capabilities, four signals, and one four-option coordination comparison. Existing work and decisions were preserved; no decision or dependency was pre-approved.');
} finally { await pool.end(); }
