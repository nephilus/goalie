import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { startSystemOneFixture } from './helpers/systemone-fixture';
import { DEFAULT_ASSESSMENT_SCOPE, assessmentInputKey, buildAssessmentInput, type AssessmentLabels, type AssessmentScope } from '../app/shared/work-assessment';
import type { Person } from '../app/shared/work';

function hasError(error: unknown, code: string, status: number): boolean {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && 'status' in error && error.code === code && error.status === status;
}


test('saved assessments enforce consent, share valid results, preserve privacy, and handle provider failures', { skip: !process.env.WORK_TEST_DATABASE_URL }, async () => {
  const originalEnv = { ...process.env };
  const baseUrl = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `assessment_test_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: baseUrl.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  baseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const keyDir = await mkdtemp(join(tmpdir(), 'goalie-assessment-'));
  const keyPath = join(keyDir, 'fixture-key');
  await writeFile(keyPath, 'fixture-secret');
  await chmod(keyPath, 0o600);
  const fixture = await startSystemOneFixture({ port: 0, apiKey: 'fixture-secret' });
  process.env.DATABASE_URL = baseUrl.toString();
  process.env.OPENJEV_ENABLED = 'true';
  process.env.OPENJEV_BASE_URL = fixture.origin;
  process.env.OPENJEV_MODEL = 'openjev-fixture';
  process.env.OPENJEV_API_KEY_FILE = keyPath;
  process.env.OPENJEV_TIMEOUT_MS = '2000';
  delete process.env.OPENJEV_API_KEY;
  const { migrate, pool } = await import('../app/server/db.server');
  const { readWork } = await import('../app/server/work.server');
  const { assessWorkItem, readWorkAssessments, setWorkAssessmentsEnabled, setWorkAssessmentScope } = await import('../app/server/work-assessment.server');
  const editor: Person = { id: 'editor', name: 'Editor', email: 'editor@example.test', role: 'editor' };
  const secondEditor: Person = { id: 'second-editor', name: 'Second Editor', email: 'second-editor@example.test', role: 'editor' };
  const viewer: Person = { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', role: 'viewer' };
  const labels: AssessmentLabels = { decision: 'needed' };
  const insertItem = async (id: string, description: string, status = 'doing') => {
    await pool.query('INSERT INTO simple_items(id,title,description,workstream_id,parent_id,status,assignee_id,due_date,blocker) VALUES($1,$2,$3,$4,NULL,$5,NULL,NULL,$6)', [id, id, description, 'stream', status, description ? 'A blocker' : '']);
  };
  const keyFor = async (itemId: string, asOf = new Date().toISOString().slice(0, 10)) => {
    const snapshot = await readWork(editor);
    return assessmentInputKey(buildAssessmentInput(snapshot, itemId, asOf)!, 'openjev-fixture');
  };
  try {
    await migrate();
    await pool.query("INSERT INTO people(id,name,email,team,role) VALUES ('editor','Editor','editor@example.test','', 'editor'), ('second-editor','Second Editor','second-editor@example.test','', 'editor'), ('viewer','Viewer','viewer@example.test','', 'viewer')");
    await pool.query("INSERT INTO simple_workstreams(id,title,description,lead_id) VALUES ('stream','Stream','Stream context','editor')");
    await insertItem('model-item', 'Model context with a pending approval.');
    await insertItem('thin-item', '');
    await insertItem('done-item', 'Completed context', 'done');
    await insertItem('busy-one', 'Busy context one');
    await insertItem('busy-two', 'Busy context two');
    await insertItem('busy-three', 'Busy context three');
    await insertItem('race-item', 'Race context');
    await insertItem('scope-race-item', 'Scope race context');
    await insertItem('joiner-item', 'Joiner revoke context');
    await insertItem('demotion-item', 'Demotion race context');
    await insertItem('oversize-item', 'Oversize context');
    for (let index = 0; index < 7; index += 1) {
      await pool.query('INSERT INTO simple_updates(id,item_id,author_id,body,kind,assignee_ids,created_at) VALUES($1,$2,$3,$4,$5,NULL,$6)', [`oversize-update-${index}`, 'oversize-item', 'editor', 'x'.repeat(10_000), 'note', '2026-09-28T00:00:00Z']);
    }
    await pool.query("INSERT INTO simple_updates(id,item_id,author_id,body,kind,assignee_ids,created_at) VALUES ('model-update','model-item','editor','Approval remains open.','note',ARRAY['editor']::text[],'2026-09-28T00:00:00Z')");
    const revisionBefore = Number((await pool.query('SELECT revision FROM simple_workspace WHERE id = 1')).rows[0].revision);
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T23:59:59.000Z') });
    try {
      const dayBefore = (await readWorkAssessments(editor) as { asOf: string }).asOf;
      mock.timers.setTime(Date.parse('2026-09-29T00:00:01.000Z'));
      const dayAfter = (await readWorkAssessments(editor) as { asOf: string }).asOf;
      assert.notEqual(dayBefore, dayAfter);
    } finally {
      mock.timers.reset();
    }

    const offIndex = await readWorkAssessments(editor) as { enabled: boolean; provider: { enabled: boolean }; entries: unknown[] };
    assert.equal(offIndex.enabled, false);
    assert.equal(offIndex.provider.enabled, true);
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'model-item', inputKey: 'a'.repeat(64) }), error => hasError(error, 'assessment_disabled', 403));
    await assert.rejects(() => setWorkAssessmentsEnabled(editor, true), error => hasError(error, 'assessment_scope_required', 409));
    await assert.rejects(() => setWorkAssessmentScope(viewer, DEFAULT_ASSESSMENT_SCOPE), error => hasError(error, 'forbidden', 403));
    await assert.rejects(() => setWorkAssessmentsEnabled(viewer, true), error => hasError(error, 'forbidden', 403));
    assert.equal((await fixture.requests()).length, 0);

    assert.deepEqual(await setWorkAssessmentScope(editor, DEFAULT_ASSESSMENT_SCOPE), { scope: DEFAULT_ASSESSMENT_SCOPE });
    assert.deepEqual(await setWorkAssessmentScope(secondEditor, DEFAULT_ASSESSMENT_SCOPE), { scope: DEFAULT_ASSESSMENT_SCOPE });
    assert.deepEqual(await setWorkAssessmentsEnabled(editor, true), { enabled: true });
    assert.deepEqual(await setWorkAssessmentsEnabled(secondEditor, true), { enabled: true });
    assert.deepEqual(await setWorkAssessmentsEnabled(secondEditor, false), { enabled: false });
    assert.equal((await readWorkAssessments(secondEditor) as { enabled: boolean }).enabled, false);
    assert.equal((await readWorkAssessments(viewer) as { enabled: boolean }).enabled, false);

    const thinKey = await keyFor('thin-item');
    const thinDetails = await assessWorkItem(editor, { itemId: 'thin-item', inputKey: thinKey });
    assert.equal(thinDetails.record?.origin, 'rules');
    assert.deepEqual(thinDetails.record?.labels, { decision: 'unclear' });
    const doneKey = await keyFor('done-item');
    const doneDetails = await assessWorkItem(editor, { itemId: 'done-item', inputKey: doneKey });
    assert.equal(doneDetails.entry.state, 'not_applicable');
    assert.equal(doneDetails.record, null);
    assert.equal((await fixture.requests()).length, 0, 'completed work must not call the provider');
    const oversizeKey = await keyFor('oversize-item');
    const oversizeBaseline = (await fixture.requests()).length;
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'oversize-item', inputKey: oversizeKey }), error => hasError(error, 'assessment_context_too_large', 422));
    assert.equal((await fixture.requests()).length, oversizeBaseline, 'oversized context must not reach the provider');

    await fixture.control({ mode: 'valid', labelsByItemTitle: { 'model-item': labels } });
    const modelKey = await keyFor('model-item');
    const modelDetails = await assessWorkItem(editor, { itemId: 'model-item', inputKey: modelKey });
    assert.equal(modelDetails.record?.origin, 'model');
    assert.deepEqual(modelDetails.record?.labels, labels);
    assert.equal((await fixture.requests()).length, 1);
    const storedJson = JSON.stringify(modelDetails.record);
    assert.equal(storedJson.includes('Approval remains open.'), false);
    const reused = await assessWorkItem(editor, { itemId: 'model-item', inputKey: modelKey });
    assert.equal(reused.record?.assessedAt, modelDetails.record?.assessedAt);
    assert.equal((await fixture.requests()).length, 1, 'same input key must reuse the shared result');
    const viewerDetails = await readWorkAssessments(viewer, 'model-item') as { record: { labels: AssessmentLabels } };
    assert.deepEqual(viewerDetails.record.labels, labels);

    const editorMultiScope: AssessmentScope = { ...DEFAULT_ASSESSMENT_SCOPE, workstreamIds: ['stream', 'missing-stream'], statuses: ['todo', 'doing'] };
    assert.deepEqual(await setWorkAssessmentScope(editor, editorMultiScope), { scope: editorMultiScope });
    const editorScopeIndex = await readWorkAssessments(editor) as { scope: typeof editorMultiScope; scopeItemIds: string[] };
    assert.deepEqual(editorScopeIndex.scope, editorMultiScope);
    assert.equal(editorScopeIndex.scopeItemIds.includes('model-item'), true);
    const secondScopeIndex = await readWorkAssessments(secondEditor) as { scope: typeof DEFAULT_ASSESSMENT_SCOPE | null };
    assert.deepEqual(secondScopeIndex.scope, DEFAULT_ASSESSMENT_SCOPE);
    const viewerScopeIndex = await readWorkAssessments(viewer) as { scope: unknown };
    assert.equal(viewerScopeIndex.scope, null);
    const editorNarrowScope = { ...editorMultiScope, workstreamIds: ['missing-stream'] as string[] };
    assert.deepEqual(await setWorkAssessmentScope(editor, editorNarrowScope), { scope: editorNarrowScope });
    const narrowedIndex = await readWorkAssessments(editor) as { scopeItemIds: string[] };
    assert.equal(narrowedIndex.scopeItemIds.includes('model-item'), false);
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'model-item', inputKey: modelKey }), error => hasError(error, 'assessment_out_of_scope', 403));
    assert.equal((await fixture.requests()).length, 1, 'out-of-scope cached results must not trigger a provider call');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['model-item'])).rows[0].count, 1, 'narrowing scope must not delete shared results');
    await setWorkAssessmentScope(editor, editorMultiScope);
    const widenedIndex = await readWorkAssessments(editor) as { scopeItemIds: string[] };
    assert.equal(widenedIndex.scopeItemIds.includes('model-item'), true);
    const unchangedAfterScope = await readWorkAssessments(viewer, 'model-item') as { record: { assessedAt: string } };
    assert.equal(unchangedAfterScope.record.assessedAt, modelDetails.record?.assessedAt, 'scope changes do not invalidate shared results');
    const missingReferenceScope = { ...editorMultiScope, workstreamIds: ['deleted-workstream'] as string[] };
    await setWorkAssessmentScope(editor, missingReferenceScope);
    const missingReferenceIndex = await readWorkAssessments(editor) as { scopeItemIds: string[] };
    assert.deepEqual(missingReferenceIndex.scopeItemIds, []);
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'model-item', inputKey: modelKey }), error => hasError(error, 'assessment_out_of_scope', 403));

    await setWorkAssessmentScope(editor, DEFAULT_ASSESSMENT_SCOPE);
    await fixture.control({ mode: 'hold' });
    const scopeRaceBaseline = (await fixture.requests()).length;
    const scopeRaceKey = await keyFor('scope-race-item');
    const scopeRaceRun = assessWorkItem(editor, { itemId: 'scope-race-item', inputKey: scopeRaceKey });
    const scopeRaceRejected = assert.rejects(scopeRaceRun, error => hasError(error, 'assessment_out_of_scope', 403));
    await fixture.waitForRequests(scopeRaceBaseline + 1);
    await setWorkAssessmentScope(editor, missingReferenceScope);
    await fixture.release();
    await scopeRaceRejected;
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['scope-race-item'])).rows[0].count, 0);
    await setWorkAssessmentScope(editor, DEFAULT_ASSESSMENT_SCOPE);
    await pool.query("INSERT INTO simple_item_stars(item_id, person_id) VALUES ('scope-race-item', 'editor')");
    const starredScope = { ...DEFAULT_ASSESSMENT_SCOPE, starredOnly: true };
    await setWorkAssessmentScope(editor, starredScope);
    await fixture.control({ mode: 'hold' });
    const starRaceBaseline = (await fixture.requests()).length;
    const starRaceKey = await keyFor('scope-race-item');
    const starRaceRun = assessWorkItem(editor, { itemId: 'scope-race-item', inputKey: starRaceKey });
    const starRaceRejected = assert.rejects(starRaceRun, error => hasError(error, 'assessment_out_of_scope', 403));
    await fixture.waitForRequests(starRaceBaseline + 1);
    await pool.query("DELETE FROM simple_item_stars WHERE item_id = 'scope-race-item' AND person_id = 'editor'");
    await fixture.release();
    await starRaceRejected;
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['scope-race-item'])).rows[0].count, 0);
    await pool.query("UPDATE simple_work_assessment_preferences SET scope = '{\"unexpected\":true}'::jsonb WHERE person_id = 'editor'");
    await assert.rejects(() => readWorkAssessments(editor), error => hasError(error, 'assessment_scope_invalid', 500));
    await setWorkAssessmentScope(editor, DEFAULT_ASSESSMENT_SCOPE);
    mock.timers.enable({ apis: ['Date'], now: Date.parse(`${modelDetails.record!.asOf}T12:00:00.000Z`) + 86_400_000 });
    try {
      const priorDayDetails = await readWorkAssessments(viewer, 'model-item') as { sourceContext: { asOf: string } | null };
      assert.equal(priorDayDetails.sourceContext?.asOf, modelDetails.record?.asOf);
    } finally {
      mock.timers.reset();
    }
    await pool.query("DELETE FROM simple_updates WHERE id = 'model-update'");
    const deletedUpdateDetails = await readWorkAssessments(viewer, 'model-item') as { sourceContext: unknown; record: unknown };
    assert.equal(deletedUpdateDetails.sourceContext, null);
    assert.equal(JSON.stringify(deletedUpdateDetails.record).includes('Approval remains open.'), false);

    await pool.query("UPDATE simple_items SET description = 'Changed source body' WHERE id = 'model-item'");
    const changedDetails = await readWorkAssessments(viewer, 'model-item') as { entry: { state: string }; record: { inputKey: string }; sourceContext: unknown };
    assert.equal(changedDetails.entry.state, 'stale');
    assert.equal(changedDetails.sourceContext, null);
    assert.equal(changedDetails.record.inputKey, modelKey);
    await fixture.control({ mode: 'malformed' });
    const changedKey = await keyFor('model-item');
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'model-item', inputKey: changedKey }), error => hasError(error, 'assist_provider_malformed', 502));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['model-item'])).rows[0].count, 1);
    await setWorkAssessmentsEnabled(secondEditor, true);
    await fixture.control({ mode: 'invalid_choice' });
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'model-item', inputKey: changedKey }), error => hasError(error, 'assist_output_invalid', 502));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['model-item'])).rows[0].count, 1);
    await fixture.control({ mode: 'http_error' });
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'model-item', inputKey: changedKey }), error => hasError(error, 'assist_unavailable', 503));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['model-item'])).rows[0].count, 1);
    await fixture.control({ mode: 'valid', labelsByItemTitle: { 'model-item': labels } });

    await fixture.control({ mode: 'valid', labelsByItemTitle: { 'busy-one': labels, 'busy-two': labels, 'busy-three': labels, 'race-item': labels, 'demotion-item': labels, 'joiner-item': labels } });
    const coalescedBaseline = (await fixture.requests()).length;
    const coalescedKey = await keyFor('busy-one');
    const coalesced = await Promise.all([
      assessWorkItem(editor, { itemId: 'busy-one', inputKey: coalescedKey }),
      assessWorkItem(editor, { itemId: 'busy-one', inputKey: coalescedKey }),
      assessWorkItem(editor, { itemId: 'busy-one', inputKey: coalescedKey }),
    ]);
    assert.equal(new Set(coalesced.map(result => result.record?.assessedAt)).size, 1, 'coalesced callers receive one saved record');
    assert.equal((await fixture.requests()).length, coalescedBaseline + 1, 'identical keys share one provider call');

    await fixture.control({ mode: 'hold' });
    const demotionBaseline = (await fixture.requests()).length;
    const demotionKey = await keyFor('demotion-item');
    const starter = assessWorkItem(editor, { itemId: 'demotion-item', inputKey: demotionKey });
    const starterRejected = assert.rejects(starter, error => hasError(error, 'forbidden', 403));
    const joiner = assessWorkItem(secondEditor, { itemId: 'demotion-item', inputKey: demotionKey });
    const joinedResult = joiner.then(result => result).catch(error => { throw error; });
    await fixture.waitForRequests(demotionBaseline + 1);
    await pool.query("UPDATE people SET role = 'viewer' WHERE id = 'editor'");
    await fixture.release();
    await starterRejected;
    const joined = await joinedResult;
    assert.deepEqual(joined.record?.labels, labels);
    await pool.query("UPDATE people SET role = 'editor' WHERE id = 'editor'");
    await fixture.control({ mode: 'hold' });
    const joinerRevokeBaseline = (await fixture.requests()).length;
    const joinerRevokeKey = await keyFor('joiner-item');
    const authorizedStarter = assessWorkItem(editor, { itemId: 'joiner-item', inputKey: joinerRevokeKey });
    const authorizedResult = authorizedStarter.then(result => result).catch(error => { throw error; });
    const revokedJoiner = assessWorkItem(secondEditor, { itemId: 'joiner-item', inputKey: joinerRevokeKey });
    const revokedJoinerRejected = assert.rejects(revokedJoiner, error => hasError(error, 'forbidden', 403));
    await fixture.waitForRequests(joinerRevokeBaseline + 1);
    await pool.query("UPDATE people SET role = 'viewer' WHERE id = 'second-editor'");
    await fixture.release();
    assert.deepEqual((await authorizedResult).record?.labels, labels);
    await revokedJoinerRejected;
    await pool.query("UPDATE people SET role = 'editor' WHERE id = 'second-editor'");
    await pool.query("UPDATE people SET role = 'viewer' WHERE id = 'editor'");
    process.env.OPENJEV_ENABLED = 'false';
    assert.deepEqual(await setWorkAssessmentsEnabled(editor, false), { enabled: false });
    process.env.OPENJEV_ENABLED = 'true';
    await pool.query("UPDATE people SET role = 'editor' WHERE id = 'editor'");
    await setWorkAssessmentsEnabled(editor, true);

    await fixture.control({ mode: 'hold' });
    const busyBaseline = (await fixture.requests()).length;
    const busyTwoKey = await keyFor('busy-two');
    const busyThreeKey = await keyFor('busy-three');
    const raceKey = await keyFor('race-item');
    const busyTwo = assessWorkItem(editor, { itemId: 'busy-two', inputKey: busyTwoKey });
    const busyTwoResult = busyTwo.then(result => result);
    const busyThree = assessWorkItem(editor, { itemId: 'busy-three', inputKey: busyThreeKey });
    const busyThreeResult = busyThree.then(result => result);
    await fixture.waitForRequests(busyBaseline + 2);
    await assert.rejects(() => assessWorkItem(editor, { itemId: 'race-item', inputKey: raceKey }), error => hasError(error, 'assessment_busy', 429));
    assert.equal((await fixture.requests()).slice(busyBaseline).filter(row => row.held).length, 2);
    await fixture.release();
    await Promise.all([busyTwoResult, busyThreeResult]);

    await fixture.control({ mode: 'hold' });
    const staleBaseline = (await fixture.requests()).length;
    const staleKey = await keyFor('race-item');
    const staleRun = assessWorkItem(editor, { itemId: 'race-item', inputKey: staleKey });
    const staleRejected = assert.rejects(staleRun, error => hasError(error, 'assessment_source_changed', 409));
    await fixture.waitForRequests(staleBaseline + 1);
    await pool.query("UPDATE simple_items SET description = 'Changed while provider was held' WHERE id = 'race-item'");
    await fixture.release();
    await staleRejected;
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['race-item'])).rows[0].count, 0);
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T23:59:59.000Z') });
    try {
      await fixture.control({ mode: 'hold' });
      const midnightBaseline = (await fixture.requests()).length;
      const midnightKey = await keyFor('race-item');
      const midnightRun = assessWorkItem(editor, { itemId: 'race-item', inputKey: midnightKey });
      const midnightRejected = assert.rejects(midnightRun, error => hasError(error, 'assessment_source_changed', 409));
      await fixture.waitForRequests(midnightBaseline + 1);
      mock.timers.setTime(Date.parse('2026-09-29T00:00:01.000Z'));
      await fixture.release();
      await midnightRejected;
    } finally {
      mock.timers.reset();
    }
    await pool.query("UPDATE simple_items SET description = 'Changed before disable' WHERE id = 'busy-three'");
    await fixture.control({ mode: 'hold' });
    const disableBaseline = (await fixture.requests()).length;
    const disableKey = await keyFor('busy-three');
    const disableRun = assessWorkItem(editor, { itemId: 'busy-three', inputKey: disableKey });
    const disableRejected = assert.rejects(disableRun, error => hasError(error, 'assessment_disabled', 403), 'disable race should reject the held assessment');
    await fixture.waitForRequests(disableBaseline + 1);
    await setWorkAssessmentsEnabled(editor, false);
    await fixture.release();
    await disableRejected;
    await setWorkAssessmentsEnabled(editor, true);

    await pool.query("UPDATE simple_work_assessments SET input_key = $1 WHERE item_id = 'model-item'", ['b'.repeat(64)]);
    await assert.rejects(() => readWorkAssessments(viewer), error => hasError(error, 'assessment_record_invalid', 500));
    await pool.query("UPDATE simple_work_assessments SET input_key = $1 WHERE item_id = 'model-item'", [modelKey]);
    await pool.query("INSERT INTO simple_work_assessments(item_id,input_key,record) VALUES ('race-item',$1,'{}'::jsonb)", ['a'.repeat(64)]);
    await assert.rejects(() => readWorkAssessments(viewer), error => hasError(error, 'assessment_record_invalid', 500));
    await pool.query("DELETE FROM simple_work_assessments WHERE item_id = 'race-item'");
    const revisionAfter = Number((await pool.query('SELECT revision FROM simple_workspace WHERE id = 1')).rows[0].revision);
    assert.equal(revisionAfter, revisionBefore, 'consent and assessment cache writes do not advance authored-work revision');
    await pool.query("DELETE FROM simple_items WHERE id = 'model-item'");
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_work_assessments WHERE item_id = $1', ['model-item'])).rows[0].count, 0, 'derived record follows item deletion');
  } finally {
    await fixture.close();
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
    await rm(keyDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  }
});

