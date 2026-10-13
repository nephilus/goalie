// Optional local acceptance. Requires a fresh migrated demo instance and running Dex/app.
// node tests/browser/workstream-browser.mjs --instance-dir .local/workstream-acceptance-EXAMPLE \
//   --base-url http://127.0.0.1:4328 --playwright-module /absolute/path/to/playwright/index.mjs
// Adds synthetic boundary fixtures, never production dependencies or real identities.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

const options = {};
const allowed = new Set(['--instance-dir', '--base-url', '--playwright-module']);
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  assert(allowed.has(flag) && !(flag in options) && value && !value.startsWith('--'), 'Unknown, duplicate or missing option.');
  options[flag] = value;
}
assert(options['--instance-dir'] && options['--base-url'] && options['--playwright-module'], 'Explicit instance, origin and external Playwright module are required.');
const instance = await realpath(resolve(options['--instance-dir']));
const owned = relative(await realpath(resolve('.local')), instance);
assert(!owned.startsWith('..') && !isAbsolute(owned) && /^workstream-acceptance-[^/]+$/.test(owned), 'Use a dedicated ignored .local/workstream-acceptance-* instance.');
const base = new URL(options['--base-url']);
assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Only explicit loopback HTTP origins accepted.');
const settings = parseEnv(await readFile(resolve(instance, '.env'), 'utf8'));
assert.equal(settings.APP_URL, base.origin);
const database = new URL(settings.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert(database.port && database.port !== '54339', 'Do not use the live database port.');
assert.notEqual(base.port, '4320', 'Do not use the live app.');
assert.equal(new URL(settings.OIDC_ISSUER).hostname, '127.0.0.1');
const users = JSON.parse(await readFile(resolve(instance, 'credentials.json'), 'utf8')).users;
assert(users.length >= 3 && users.every(user => user.email.endsWith('@example.test')), 'Only synthetic demo identities allowed.');
const output = resolve(instance, `browser-${Date.now()}`);
await mkdir(output, { mode: 0o700 });
const results = [], errors = [];
const marker = `workstream-browser-${Date.now()}`;
function safeError(error) {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of [settings.DATABASE_URL, ...users.flatMap(user => [user.email, user.password])].filter(Boolean)) text = text.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]');
  return text;
}
const db = new pg.Client({ connectionString: settings.DATABASE_URL });
await db.connect();
try {
  assert.equal((await db.query("SELECT count(*)::int AS n FROM people WHERE email NOT LIKE '%@example.test'")).rows[0].n, 0);
  assert.equal((await db.query('SELECT demo FROM simple_workspace WHERE id=1')).rows[0]?.demo, true);
  await db.query('BEGIN');
  await db.query("INSERT INTO simple_workstreams(id,title,description,lead_id) VALUES('acceptance-boundaries','Boundary review','Synthetic activity-window and hierarchy acceptance.','demo-viewer') ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO simple_workstream_goals(workstream_id,goal_id) VALUES('acceptance-boundaries','demo-goal-pilot') ON CONFLICT DO NOTHING");
  for (const [suffix, title, days, status, blocker, parent] of [
    ['8d','Boundary 8 days',8,'doing','',null],
    ['15d','Boundary 15 days',15,'doing','',null],
    ['31d','Boundary 31 days',31,'doing','',null],
    ['fresh','Boundary fresh parent',1,'doing','',null],
    ['child','Boundary blocked child',1,'todo','Synthetic blocker','acceptance-fresh'],
    ['done','Boundary completed',31,'done','Historical completed blocker',null],
  ]) {
    await db.query(`INSERT INTO simple_items(id,title,description,workstream_id,parent_id,status,blocker,blocker_baseline,created_at,updated_at)
      VALUES($1,$2,'Synthetic browser boundary fixture','acceptance-boundaries',$3,$4,$5,$5,now()-($6::text || ' days')::interval,now()-($6::text || ' days')::interval)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,blocker=excluded.blocker,blocker_baseline=excluded.blocker_baseline,created_at=excluded.created_at,updated_at=excluded.updated_at`, [`acceptance-${suffix}`,title,parent,status,blocker,days]);
    await db.query("INSERT INTO simple_item_assignees(item_id,person_id) VALUES($1,'demo-admin') ON CONFLICT DO NOTHING", [`acceptance-${suffix}`]);
  }
  // Previous harness updates are retained as evidence. A new unique quiet item makes reruns independent.
  await db.query("INSERT INTO simple_items(id,title,description,workstream_id,status,created_at,updated_at) VALUES($1,$2,'Synthetic quiet retention test','acceptance-boundaries','doing',now()-interval '40 days',now()-interval '40 days')", [marker,marker]);
  await db.query('UPDATE simple_workspace SET revision=revision+1 WHERE id=1');
  await db.query('COMMIT');
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }

const { chromium } = await import(pathToFileURL(resolve(options['--playwright-module'])).href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page;
async function check(name, operation) {
  try { await operation(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) {
    results.push({ name, pass: false, error: safeError(error) });
    if (page && new URL(page.url()).origin === base.origin) {
      await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
      await writeFile(resolve(output, 'failure.txt'), await page.locator('body').innerText(), { mode: 0o600 });
    }
    throw error;
  }
}
async function login(role, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const target = await context.newPage();
  target.setDefaultTimeout(10000);
  target.on('pageerror', error => errors.push(safeError(error)));
  const user = users.find(candidate => candidate.role === role);
  assert(user);
  await target.goto(`${base.origin}/auth/login`);
  await target.locator('input[name="login"]').fill(user.email);
  await target.locator('input[name="password"]').fill(user.password);
  await target.locator('button[type="submit"]').click();
  await target.waitForURL(`${base.origin}/`);
  await target.waitForLoadState('networkidle');
  return target;
}
async function choose(label, text) {
  const control = page.getByRole('combobox', { name: label, exact: true });
  if (await control.evaluate(el => el.tagName === 'SELECT')) await control.selectOption({ label: text });
  else { await control.click(); await page.getByRole('option', { name: text, exact: true }).click(); }
}
async function directory() {
  if (await page.locator('.ws-back').count()) await page.locator('.ws-back').click();
  else await page.locator('.work-sidebar').getByRole('button', { name: 'Workstreams', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).waitFor();
}
async function review(title) { await page.getByRole('button', { name: `Review ${title}`, exact: true }).click(); }
async function capture(name) { await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true }); }
try {
  page = await login('admin');
  await check('Directory navigation is independent from All work filters', async () => {
    await page.getByRole('textbox', { name: /Search work/ }).fill('no-work-matches-acceptance');
    await directory();
    for (const title of ['Applications','Boundary review','Network','Platform']) await page.getByRole('button', { name: `Review ${title}`, exact: true }).waitFor();
    await capture('directory');
  });
  await check('Searchable directory supports lead, goal, attention and sort controls', async () => {
    await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).fill('Boundary');
    assert.equal(await page.getByRole('button', { name: /^Review / }).count(), 1);
    await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).fill('');
    for (const label of ['Workstream lead','Linked goal','Workstream attention','Sort workstreams']) await page.getByRole('combobox', { name: label, exact: true }).waitFor();
    await choose('Workstream lead', 'Taylor Chen');
    assert.equal(await page.getByRole('button', { name: /^Review / }).count(), 1);
    await choose('Workstream lead', 'All leads');
    await choose('Linked goal', 'Make routine operations repeatable');
    assert.equal(await page.getByRole('button', { name: 'Review Boundary review', exact: true }).count(), 0);
    await choose('Linked goal', 'All goals');
    await choose('Workstream attention', 'Blocked');
    assert.deepEqual(await page.getByRole('button', { name: /^Review / }).allTextContents(), ['Boundary review','Network']);
    await choose('Workstream attention', 'Any attention');
    await choose('Sort workstreams', 'Quiet count');
    assert.equal(await page.getByRole('button', { name: /^Review / }).first().getAttribute('aria-label'), 'Review Boundary review');
    await choose('Sort workstreams', 'Latest timeline');
    const snapshot = (await (await page.request.get(`${base.origin}/api/work`)).json()).data;
    const latest = new Map(snapshot.workstreams.map(stream => [stream.id, -Infinity]));
    for (const update of [...snapshot.updates, ...(snapshot.adrActivities ?? [])]) {
      const item = snapshot.items.find(item => item.id === update.itemId);
      if (item) latest.set(item.workstreamId, Math.max(latest.get(item.workstreamId), Date.parse(update.createdAt)));
    }
    const newest = [...snapshot.workstreams].sort((a, b) => (latest.get(b.id) - latest.get(a.id) || a.title.localeCompare(b.title)))[0];
    assert.equal(await page.getByRole('button', { name: /^Review / }).first().getAttribute('aria-label'), `Review ${newest.title}`);
    await choose('Sort workstreams', 'Name');
  });
  await review('Boundary review');
  await check('Attention defaults to active blocked and quiet tasks, excluding completed', async () => {
    assert.equal(await page.getByRole('button', { name: /^Attention(?: \(\d+\))?$/ }).getAttribute('aria-pressed'), 'true');
    await page.getByText('Boundary blocked child', { exact: true }).waitFor();
    await page.getByText('Boundary 31 days', { exact: true }).waitFor();
    assert.equal(await page.getByText('Boundary completed', { exact: true }).count(), 0);
    await capture('attention');
    const snapshot = (await (await page.request.get(`${base.origin}/api/work`)).json()).data;
    const items = snapshot.items.filter(item => item.workstreamId === 'acceptance-boundaries');
    const cutoff = Date.now() - 7 * 86400000;
    const latest = item => [...snapshot.updates, ...(snapshot.adrActivities ?? [])].filter(update => update.itemId === item.id).map(update => Date.parse(update.createdAt)).sort((a,b) => b-a)[0];
    for (const [label, selected] of [
      ['Updated', items.filter(item => latest(item) >= cutoff)],
      ['Quiet', items.filter(item => item.status === 'doing' && (latest(item) ?? Date.parse(item.createdAt)) < cutoff)],
      ['Blocked', items.filter(item => item.status !== 'done' && item.blocker.trim())],
    ]) {
      const metric = page.locator('.ws-overview .ws-metrics > div').filter({ has: page.locator('dt', { hasText: label }) });
      const tasks = selected.filter(item => !item.parentId).length, subtasks = selected.filter(item => item.parentId).length;
      assert.match(await metric.locator('dd').innerText(), new RegExp(`^${tasks} tasks? .* ${subtasks} subtasks?$`));
    }
  });
  await check('7/14/30 day windows recompute quiet membership', async () => {
    await choose('Activity window', 'Last 7 days');
    await page.getByText('Boundary 8 days', { exact: true }).waitFor();
    await choose('Activity window', 'Last 14 days');
    assert.equal(await page.getByText('Boundary 8 days', { exact: true }).count(), 0);
    await page.getByText('Boundary 15 days', { exact: true }).waitFor();
    await choose('Activity window', 'Last 30 days');
    assert.equal(await page.getByText('Boundary 15 days', { exact: true }).count(), 0);
    await page.getByText('Boundary 31 days', { exact: true }).waitFor();
  });
  await capture('window-30');
  await check('Quiet update plus mention uses shared overlay and retains task until explicit refresh', async () => {
    const row = page.getByRole('article', { name: `Task: ${marker}`, exact: true });
    await row.getByRole('button', { name: 'Add update', exact: true }).click();
    await page.getByRole('textbox', { name: 'Write a note', exact: true }).fill(`${marker} resolved quiet with @Sam`);
    await page.locator('.update-form .adr-mentions summary').click();
    await page.locator('.update-form .adr-mentions').getByRole('checkbox', { name: /Sam Rivera/ }).check();
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.locator('.update-note').filter({ hasText: `${marker} resolved quiet` }).waitFor();
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
    await row.getByText(/No longer flagged/).waitFor();
    await row.getByText(`${marker} resolved quiet with @Sam`, { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: 'Add update', exact: true }).evaluate(el => el === document.activeElement), true);
    await capture('quiet-retained');
    await page.getByRole('button', { name: 'Refresh attention list', exact: true }).click();
    assert.equal(await page.getByRole('article', { name: `Task: ${marker}`, exact: true }).count(), 0);
  });
  await check('Dirty back-to-directory offers Keep editing and Discard changes', async () => {
    await page.getByRole('article', { name: 'Task: Boundary 31 days', exact: true }).getByRole('button', { name: 'Add update', exact: true }).click();
    await page.getByRole('textbox', { name: 'Write a note', exact: true }).fill(`${marker} unsaved`);
    await page.locator('.ws-back').click();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Write a note', exact: true }).inputValue(), `${marker} unsaved`);
    await page.locator('.ws-back').click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).waitFor();
  });
  await check('All tasks preserves nested hierarchy and subtask-only search parent context without sibling leak', async () => {
    await review('Platform');
    await page.getByRole('button', { name: 'All tasks', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Hide completed', exact: true }).uncheck();
    await page.getByRole('article', { name: 'Subtask: Verify editor sign-in', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('Verify read-only access');
    await page.getByRole('article', { name: 'Task: Prepare pilot access', exact: true }).getByText('Parent context, outside current filters', { exact: true }).waitFor();
    await page.getByRole('article', { name: 'Subtask: Verify read-only access', exact: true }).waitFor();
    assert.equal(await page.getByRole('article', { name: 'Subtask: Verify editor sign-in', exact: true }).count(), 0);
    assert.equal(await page.locator('.ws-subtasks .ws-task-row').count(), 1);
    await capture('hierarchy-subtask-search');
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('');
  });
  await check('Create and edit task through existing shared editor keeps selected workstream', async () => {
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    assert.match(await page.getByRole('combobox', { name: 'Workstream', exact: true }).innerText(), /Platform/);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`${marker} created`);
    await choose('Task type', 'Main task');
    await page.getByRole('button', { name: 'Create work', exact: true }).click();
    await page.getByRole('button', { name: `${marker} created`, exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`${marker} edited`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('button', { name: `${marker} edited`, exact: true }).waitFor();
    await capture('task-edit');
  });
  await check('ADR creation and approval request remain available from a workstream task', async () => {
    await page.getByRole('article', { name: `Task: ${marker} edited`, exact: true }).getByRole('button', { name: 'Add update', exact: true }).click();
    await page.getByRole('button', { name: 'Add ADR', exact: true }).click();
    for (const field of ['Context','Concern','Decision','Alternatives not chosen','Expected consequences','Accepted downsides','Rationale']) await page.getByLabel(field, { exact: true }).fill(`${marker} ${field}`);
    await page.getByRole('combobox', { name: 'Approver', exact: true }).click();
    await page.getByRole('option', { name: /Sam Rivera/ }).click();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('button', { name: 'Request approval', exact: true }).click();
    await page.locator('.adr-content > .adr-status').filter({ hasText: 'Pending approval' }).waitFor();
    await page.getByRole('button', { name: 'Close ADR', exact: true }).click();
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
  });
  const admin = page;
  await check('Real OIDC editor mention inbox source remains in Workstreams', async () => {
    page = await login('editor');
    await directory();
    await review('Boundary review');
    await page.getByRole('button', { name: /Notifications/ }).click();
    const notification = page.locator('.adr-notification').filter({ hasText: marker }).filter({ hasText: 'You were mentioned' }).first();
    await notification.getByRole('button', { name: 'Open source', exact: true }).click();
    await page.locator('.update-note').filter({ hasText: `${marker} resolved quiet` }).waitFor();
    assert.equal(await page.locator('#page-title').innerText(), 'Workstreams');
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
  });
  await check('ADR nominee inbox verifies approval without leaving Workstreams', async () => {
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.locator('.adr-notification').filter({ hasText: `${marker} edited` }).first().getByRole('button', { name: 'Open source', exact: true }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText('Verified approval by Sam Rivera', { exact: false }).waitFor();
    assert.equal(await page.locator('#page-title').innerText(), 'Workstreams');
    await capture('adr-approved');
    await page.getByRole('button', { name: 'Close ADR', exact: true }).click();
  });
  await check('Real OIDC viewer can review but not mutate', async () => {
    page = await login('viewer');
    await directory();
    assert(await page.getByRole('button', { name: 'New workstream', exact: true }).isDisabled());
    await review('Boundary review');
    assert.equal(await page.getByRole('button', { name: 'Add task', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit workstream', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add update', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'View updates', exact: true }).first().click();
    await page.getByText('Viewer access is read-only. You can review the saved timeline.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Write a note', exact: true }).count(), 0);
    await capture('viewer');
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
  });
  page = admin;
  await check('390px mobile keyboard interaction retains draft, restores focus and avoids viewport overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('article', { name: 'Task: Prepare pilot access', exact: true }).getByRole('button', { name: 'Add update', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Write a note', exact: true }).fill(`${marker} mobile draft`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Write a note', exact: true }).inputValue(), `${marker} mobile draft`);
    await capture('mobile-draft');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    assert.equal(await page.getByRole('article', { name: 'Task: Prepare pilot access', exact: true }).getByRole('button', { name: 'Add update', exact: true }).evaluate(el => el === document.activeElement), true);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture('mobile-review');
    await page.locator('.ws-back').click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture('mobile-directory');
  });
  await check('Create/edit workstream and add nested subtask reuse shared editors', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Refresh shared work', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'New workstream', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`zz ${marker}`);
    await page.getByRole('button', { name: 'Create workstream', exact: true }).click();
    await review(`zz ${marker}`);
    await page.getByRole('button', { name: 'Edit workstream', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill(`Long synthetic record ${'x'.repeat(2200)}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`Long ${'y'.repeat(170)}`);
    await choose('Task type', 'Main task');
    await page.getByRole('button', { name: 'Create work', exact: true }).click();
    await page.getByRole('button', { name: 'All tasks', exact: true }).click();
    await page.getByRole('article', { name: `Task: Long ${'y'.repeat(170)}`, exact: true }).getByRole('button', { name: 'Add subtask', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`${marker} nested child`);
    await page.getByRole('button', { name: 'Create work', exact: true }).click();
    await page.locator('.ws-subtasks').getByRole('article', { name: `Subtask: ${marker} nested child`, exact: true }).waitFor();
    await page.getByRole('article', { name: `Subtask: ${marker} nested child`, exact: true }).getByRole('button', { name: 'Add update', exact: true }).click();
    await page.getByRole('textbox', { name: 'Write a note', exact: true }).fill(`Long timeline ${'z'.repeat(2500)}`);
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.locator('.update-note').filter({ hasText: 'Long timeline' }).waitFor();
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(output, 'mobile-long-text.png'), fullPage: true });
  });
  await check('No uncaught browser errors', async () => assert.deepEqual(errors, []));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ marker, results, pageErrors: errors }, null, 2), { mode: 0o600 });
  await browser.close();
  console.log(`Evidence: ${relative(process.cwd(), output)}`);
}
