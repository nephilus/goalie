import { migrate, pool, withTransaction } from '../app/server/db.server';

if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.APP_URL ?? '').hostname)) throw new Error('Synthetic seed is restricted to local nonproduction environments.');
const date = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
try {
  await migrate();
  await withTransaction(async client => {
    await client.query('SELECT revision FROM simple_workspace WHERE id = 1 FOR UPDATE');
    const existing = await client.query('SELECT 1 FROM simple_items UNION ALL SELECT 1 FROM simple_goals UNION ALL SELECT 1 FROM simple_workstreams UNION ALL SELECT 1 FROM simple_tags LIMIT 1');
    if (existing.rowCount) { console.log('Workspace already contains records; no seed changes made.'); return; }
    if ((await client.query("SELECT 1 FROM people WHERE email NOT LIKE '%@example.test' LIMIT 1")).rowCount) throw new Error('Refusing synthetic records in a workspace with real identities.');
    for (const person of [
      ['demo-admin', 'Alex Morgan', 'goalie-admin@example.test', 'Platform', 'admin'],
      ['demo-editor', 'Sam Rivera', 'goalie-editor@example.test', 'Network', 'editor'],
      ['demo-viewer', 'Taylor Chen', 'goalie-viewer@example.test', 'Leadership', 'viewer'],
    ]) await client.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', person);
    const people = (await client.query<{ id: string; email: string }>('SELECT id,email FROM people')).rows;
    const admin = people.find(person => person.email === 'goalie-admin@example.test')!.id;
    const editor = people.find(person => person.email === 'goalie-editor@example.test')!.id;
    for (const row of [
      ['demo-goal-pilot', 'Launch a dependable pilot', 'Let the first team run its workload with clear operational ownership.', date(30)],
      ['demo-goal-operations', 'Make routine operations repeatable', 'Reduce handoff ambiguity with tested procedures and explicit owners.', date(45)],
    ]) await client.query('INSERT INTO simple_goals(id,title,description,target_date) VALUES($1,$2,$3,$4)', row);
    for (const row of [
      ['demo-stream-platform', 'Platform', 'Persistent ownership of the runtime and access controls.', admin],
      ['demo-stream-network', 'Network', 'Persistent ownership of connectivity and network policy.', editor],
      ['demo-stream-apps', 'Applications', 'Persistent ownership of application delivery and support.', admin],
    ]) {
      await client.query('INSERT INTO simple_workstreams(id,title,description,lead_id) VALUES($1,$2,$3,$4)', row);
      await client.query('INSERT INTO simple_workstream_goals(workstream_id,goal_id) VALUES($1,$2),($1,$3)', [row[0], 'demo-goal-pilot', 'demo-goal-operations']);
    }
    for (const row of [
      ['demo-tag-docs', 'Documentation', 'Writing or updating instructions that another person will use. Not merely reading a document.', null],
      ['demo-tag-review', 'Readiness review', 'Checking explicit acceptance criteria before a handoff or launch.', null],
      ['demo-tag-access', 'Access control', 'Implementing or verifying authentication and authorization for the platform.', 'demo-stream-platform'],
      ['demo-tag-connectivity', 'Connectivity', 'Establishing or validating network reachability and traffic policy.', 'demo-stream-network'],
    ]) await client.query('INSERT INTO simple_tags(id,name,description,workstream_id) VALUES($1,$2,$3,$4)', row);
    const rows: Array<[string, string, string, string, string | null, string, string[], string | null, string, string | null]> = [
      ['demo-access', 'Prepare pilot access', 'Set up sign-in and check the reader/editor access boundary.', 'demo-stream-platform', null, 'doing', [admin, editor], date(5), '', 'demo-tag-access'],
      ['demo-access-reader', 'Verify read-only access', 'Check that a viewer cannot change shared work.', 'demo-stream-platform', 'demo-access', 'todo', [admin], date(3), '', 'demo-tag-access'],
      ['demo-access-editor', 'Verify editor sign-in', 'Confirm that the editor can sign in and update its work.', 'demo-stream-platform', 'demo-access', 'done', [admin], date(1), '', 'demo-tag-access'],
      ['demo-runbook', 'Write the recovery runbook', 'Document restore steps and have another operator follow them.', 'demo-stream-platform', null, 'todo', [admin], date(12), '', 'demo-tag-docs'],
      ['demo-routing', 'Validate pilot routing', 'Test workload reachability using the agreed network policy.', 'demo-stream-network', null, 'doing', [editor], date(4), 'Waiting for the application service inventory.', 'demo-tag-connectivity'],
      ['demo-network-notes', 'Publish network handoff notes', 'Explain addressing, routing ownership, and the escalation contact.', 'demo-stream-network', null, 'todo', [editor], date(7), '', 'demo-tag-docs'],
      ['demo-launch', 'Review pilot launch readiness', 'Check rollback, ownership, and support coverage before launch.', 'demo-stream-apps', null, 'todo', [admin], date(20), '', 'demo-tag-review'],
      ['demo-maintenance', 'Review the support queue', 'Triage ordinary operational requests; no strategic goal is assumed.', 'demo-stream-apps', null, 'todo', [admin, editor], null, '', null],
    ];
    for (const row of rows) {
      await client.query('INSERT INTO simple_items(id,title,description,workstream_id,parent_id,status,due_date,blocker,blocker_baseline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)', [row[0], row[1], row[2], row[3], row[4], row[5], row[7], row[8]]);
      for (const personId of row[6]) await client.query('INSERT INTO simple_item_assignees(item_id,person_id) VALUES($1,$2)', [row[0], personId]);
      if (row[9]) await client.query('INSERT INTO simple_item_tags(item_id,tag_id) VALUES($1,$2)', [row[0], row[9]]);
    }
    await client.query('INSERT INTO simple_updates(id,item_id,author_id,body,assignee_ids) VALUES($1,$2,$3,$4,$5)', ['demo-update-routing', 'demo-routing', editor, 'Synthetic update: route tests are ready; the service inventory is still needed.', [editor]]);
    await client.query("UPDATE simple_workspace SET demo = true, revision = revision + 1 WHERE id = 1");
    await client.query("INSERT INTO simple_changes(id,actor_id,action,entity_id) VALUES('demo-seed',$1,'seed','demo-work')", [admin]);
    console.log('Seeded labelled synthetic work: 2 goals, 3 workstreams, 8 items, 4 defined tags. Existing legacy business records are untouched.');
  });
} finally { await pool.end(); }
