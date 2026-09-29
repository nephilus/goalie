import { randomUUID } from 'node:crypto';
import { migrate, pool } from '../app/server/db.server';
import { executeCommand, readData } from '../app/server/store.server';
import { emptyItem, type Person, type WorkData, type WorkItem } from '../app/shared/model';
import { portfolioExample } from './portfolio-example';

if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.APP_URL ?? '').hostname)) throw new Error('Example seed is restricted to local nonproduction environments.');
try {
  await migrate();
  const existing = await readData();
  if (existing.items.length || existing.workstreams.length) throw new Error('Workspace already contains work. Refusing to add example records.');
  if (existing.people.some(person => !person.email.endsWith('@example.test'))) throw new Error('Workspace contains real identities. Refusing to add example data.');
  let admin = existing.people.find(person => person.email === 'goalie-admin@example.test');
  if (!admin) {
    admin = { id: randomUUID(), name: 'Alex Morgan', email: 'goalie-admin@example.test', team: 'Platform', role: 'admin' };
    await pool.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$2,$3,$4,$5)', [admin.id, admin.name, admin.email, admin.team, admin.role]);
  }
  const people: Person[] = [admin,
    { id: 'sample-sam', name: 'Sam Rivera', email: 'goalie-editor@example.test', team: 'Networking', role: 'editor' },
    { id: 'sample-taylor', name: 'Taylor Chen', email: 'goalie-viewer@example.test', team: 'Leadership', role: 'viewer' },
    { id: 'sample-priya', name: 'Priya Shah', email: 'priya@example.test', team: 'Security', role: 'editor' },
    { id: 'sample-jordan', name: 'Jordan Lee', email: 'jordan@example.test', team: 'Platform', role: 'editor' },
    { id: 'sample-robin', name: 'Robin Okafor', email: 'robin@example.test', team: 'Applications', role: 'editor' },
  ];
  const now = new Date();
  const date = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
  const createdAt = new Date(now.valueOf() - 21 * 86400000).toISOString();
  const data: WorkData = { schemaVersion: 2, revision: 0, demo: true, people: people.filter(person => !existing.people.some(previous => previous.id === person.id)), workstreams: [
    { id: 'sample-network', title: 'Network foundation', description: 'Example workstream: establish cluster connectivity and approved network policy.', ownerId: 'sample-sam', priority: 'high', targetDate: date(8), archived: false },
    { id: 'sample-platform', title: 'Platform readiness', description: 'Example workstream: qualify the new cluster for application workloads.', ownerId: admin.id, priority: 'urgent', targetDate: date(15), archived: false },
    { id: 'sample-release', title: 'Application rollout', description: 'Example workstream: safely release the first workload on the new platform.', ownerId: 'sample-robin', priority: 'high', targetDate: date(24), archived: false },
  ], items: [], dependencies: [], updates: [], changes: [], outcomes: [], capabilities: [], signals: [], opportunities: [], decisions: [], commitments: [] };
  const add = (id: string, title: string, stream: string, owner: string | null, status: WorkItem['status'], start: number | null, end: number | null, extra: Partial<WorkItem> = {}) => {
    data.items.push({ ...emptyItem(stream), id, title, description: `Synthetic pilot work: ${title}. Replace this example with your department's actual work before operational use.`, ownerId: owner, assigneeIds: owner ? [owner] : [], status, plannedStart: start === null ? null : date(start), plannedEnd: end === null ? null : date(end), targetDate: end === null ? null : date(end), sortOrder: data.items.length * 10, createdAt, updatedAt: now.toISOString(), completedAt: status === 'done' ? now.toISOString() : null, ...extra });
  };
  add('sample-ip-plan', 'Approve cluster IP allocation', 'sample-network', 'sample-sam', 'done', -9, -7);
  add('sample-firewall', 'Approve east-west firewall rules', 'sample-network', 'sample-priya', 'in_review', -5, -1, { priority: 'urgent', blocker: 'Security review needs the updated service inventory.' });
  add('sample-routing', 'Validate cluster routing', 'sample-network', 'sample-sam', 'planned', 1, 4, { priority: 'high' });
  add('sample-dns', 'Publish internal DNS records', 'sample-network', 'sample-sam', 'in_progress', -1, 3);
  add('sample-network-ready', 'Network ready for handover', 'sample-network', 'sample-sam', 'planned', 8, 8, { kind: 'milestone' });
  add('sample-images', 'Mirror approved workload images', 'sample-platform', 'sample-jordan', 'in_progress', -2, 5);
  add('sample-hardening', 'Review cluster hardening baseline', 'sample-platform', 'sample-priya', 'in_review', -2, 6);
  add('sample-storage', 'Qualify persistent storage', 'sample-platform', admin.id, 'planned', 5, 9, { assigneeIds: [admin.id, 'sample-jordan'] });
  add('sample-platform-ready', 'Platform acceptance', 'sample-platform', admin.id, 'planned', 15, 15, { kind: 'milestone', priority: 'urgent' });
  add('sample-runbook', 'Write rollout and rollback runbook', 'sample-release', 'sample-robin', 'in_progress', -1, 10);
  add('sample-canary', 'Run first application canary', 'sample-release', 'sample-robin', 'planned', 16, 19, { priority: 'high', assigneeIds: ['sample-robin', 'sample-jordan'] });
  add('sample-alerts', 'Agree application alert ownership', 'sample-release', null, 'planned', null, null, { updatedAt: createdAt });
  add('sample-launch', 'Complete release handover', 'sample-release', 'sample-robin', 'planned', 24, 24, { kind: 'milestone' });
  const edges = [['sample-ip-plan', 'sample-firewall'], ['sample-firewall', 'sample-routing'], ['sample-routing', 'sample-network-ready'], ['sample-dns', 'sample-network-ready'], ['sample-network-ready', 'sample-storage'], ['sample-storage', 'sample-platform-ready'], ['sample-images', 'sample-platform-ready'], ['sample-hardening', 'sample-platform-ready'], ['sample-platform-ready', 'sample-canary'], ['sample-runbook', 'sample-canary'], ['sample-canary', 'sample-launch'], ['sample-alerts', 'sample-launch']];
  data.dependencies = edges.map(([predecessorId, successorId]) => ({ predecessorId, successorId }));
  data.updates = [{ id: randomUUID(), itemId: 'sample-firewall', authorId: 'sample-priya', body: 'Example update: rules reviewed. Waiting for the revised service inventory before final approval.', createdAt: now.toISOString() }];
  const example = portfolioExample(data, admin.id, now);
  data.items.push(...example.items);
  Object.assign(data, { ...example, items: data.items });
  const snapshot = await readData();
  await executeCommand({ expectedRevision: snapshot.revision, command: { type: 'data.import', data } }, admin);
  console.log(`Imported labelled synthetic pilot: 3 connected workstreams, ${data.items.length} work items, 12 dependencies, 3 outcomes, and one temporal coordination comparison. No planning decision is pre-approved.`);
  console.log('Dex admin/editor/viewer identities are provisioned. Credentials remain in .local/credentials.json.');
} finally { await pool.end(); }
