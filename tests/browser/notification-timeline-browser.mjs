// Optional synthetic loopback acceptance. Reuses the documented isolated workstream setup.
// node tests/browser/notification-timeline-browser.mjs --instance-dir .local/workstream-acceptance-EXAMPLE \
//   --base-url http://127.0.0.1:4338 --playwright-module /absolute/path/to/playwright/index.mjs
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
assert([...allowed].every(flag => options[flag]), 'Explicit instance, origin and external Playwright module required.');
const instance = await realpath(resolve(options['--instance-dir']));
const owned = relative(await realpath(resolve('.local')), instance);
assert(!owned.startsWith('..') && !isAbsolute(owned) && /^workstream-acceptance-[^/]+$/.test(owned), 'Use a dedicated ignored workstream acceptance instance.');
const base = new URL(options['--base-url']);
assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port && base.port !== '4320' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
const settings = parseEnv(await readFile(resolve(instance, '.env'), 'utf8'));
assert.equal(settings.APP_URL, base.origin);
const database = new URL(settings.DATABASE_URL);
assert(database.hostname === '127.0.0.1' && database.port && database.port !== '54339');
assert.equal(new URL(settings.OIDC_ISSUER).hostname, '127.0.0.1');
const users = JSON.parse(await readFile(resolve(instance, 'credentials.json'), 'utf8')).users;
assert(users.length >= 3 && users.every(user => user.email.endsWith('@example.test')));
const db = new pg.Client({ connectionString: settings.DATABASE_URL });
await db.connect();
try {
  assert.equal((await db.query("SELECT count(*)::int AS n FROM people WHERE email NOT LIKE '%@example.test'")).rows[0].n, 0);
  assert.equal((await db.query('SELECT demo FROM simple_workspace WHERE id=1')).rows[0]?.demo, true);
} finally { await db.end(); }
const output = resolve(instance, `browser-notifications-${Date.now()}`);
await mkdir(output, { mode: 0o700 });
const results = [], errors = [];
const marker = `notifications-${Date.now()}`;
const task = 'Review pilot launch readiness';
const plain = `${marker} plain @Alex Morgan`;
const selected = `${marker} selected self identity`;
function safeError(error) {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of [settings.DATABASE_URL, ...users.flatMap(user => [user.email, user.password])].filter(Boolean)) text = text.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]');
  return text;
}
const { chromium } = await import(pathToFileURL(resolve(options['--playwright-module'])).href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page, itemId, updateId, adrId, activities;
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
  target.setDefaultTimeout(15000);
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
async function api(path) {
  const response = await page.request.get(`${base.origin}${path}`);
  assert.equal(response.status(), 200);
  return (await response.json()).data;
}
async function inbox() { return (await api('/api/work/notifications?limit=100&unreadOnly=false')).items; }
async function snapshot() { return api('/api/work'); }
async function updates() {
  await page.getByRole('button', { name: `More actions for ${task}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click();
}
async function choose(label, name) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: false }).click();
}
async function capture(name) { await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true }); }
async function assertActivities(container) {
  for (const activity of activities) {
    const row = container.locator(`[data-adr-history-id="${activity.id}"]`);
    await row.waitFor();
    await row.getByText(activity.action === 'adr.approve' ? 'ADR approved (verified)' : 'ADR created', { exact: true }).waitFor();
    await row.getByText(`${marker} Decision`, { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: /edit|delete/i }).count(), 0);
  }
}
async function workstreamRow() {
  const desktop = page.locator('.work-sidebar').getByRole('button', { name: 'Workstreams', exact: true });
  if (await desktop.isVisible()) await desktop.click();
  else {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.locator('.mobile-nav-dialog').getByRole('button', { name: 'Workstreams', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Review Applications', exact: true }).click();
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  return page.getByRole('article', { name: `Task: ${task}`, exact: true });
}
try {
  page = await login('admin');
  itemId = (await snapshot()).items.find(item => item.title === task).id;
  await check('Plain @text creates no notification, selected self identity creates exact update notification', async () => {
    const before = await inbox();
    await updates();
    await page.getByRole('textbox', { name: 'Write a note', exact: true }).fill(plain);
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.locator('.update-note').filter({ hasText: plain }).waitFor();
    assert.deepEqual((await inbox()).map(item => item.id), before.map(item => item.id));
    await page.getByRole('textbox', { name: 'Write a note', exact: true }).fill(selected);
    await page.locator('.update-form .adr-mentions summary').click();
    await page.locator('.update-form .adr-mentions').getByRole('checkbox', { name: /Alex Morgan/ }).check();
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.locator('.update-note').filter({ hasText: selected }).waitFor();
    updateId = (await snapshot()).updates.find(update => update.body === selected).id;
    const notification = (await inbox()).find(item => item.updateId === updateId);
    assert(notification && notification.itemId === itemId && notification.actorId === 'demo-admin');
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.locator('.adr-notification').filter({ hasText: 'You were mentioned' }).first().getByRole('button', { name: 'Open source', exact: true }).click();
    await page.locator('.update-note').filter({ hasText: selected }).waitFor();
    await page.waitForFunction(id => document.activeElement?.id === `update-${id}`, updateId);
    await capture('self-mention-source');
  });
  await check('Self-approver draft requires explicit Request approval and submit creates inbox', async () => {
    const before = await inbox();
    await page.getByRole('button', { name: 'Add ADR', exact: true }).click();
    for (const field of ['Context', 'Concern', 'Decision', 'Alternatives not chosen', 'Expected consequences', 'Accepted downsides', 'Rationale']) await page.getByLabel(field, { exact: true }).fill(`${marker} ${field}`);
    await choose('Approver', 'Alex Morgan');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('button', { name: 'Request approval', exact: true }).waitFor();
    await page.getByText('This is a draft. Choose Request approval to send an inbox notification to the approver, including yourself.', { exact: true }).waitFor();
    assert.deepEqual((await inbox()).map(item => item.id), before.map(item => item.id));
    await capture('self-approver-draft');
    await page.getByRole('button', { name: 'Request approval', exact: true }).click();
    await page.locator('.adr-content > .adr-status').filter({ hasText: 'Pending approval' }).waitFor();
    const notification = (await inbox()).find(item => item.kind === 'approval_requested' && item.itemId === itemId && !before.some(old => old.id === item.id));
    assert(notification);
    adrId = notification.adrId;
    await page.getByRole('button', { name: 'Close ADR', exact: true }).click();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.locator('.adr-notification').filter({ hasText: 'Approval requested' }).first().getByRole('button', { name: 'Open source', exact: true }).click();
    await page.locator('.adr-content').getByText(`${marker} Decision`, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText('Verified approval by Alex Morgan', { exact: false }).waitFor();
    await capture('self-approved');
    await page.getByRole('button', { name: 'Close ADR', exact: true }).click();
  });
  await check('Immutable created and approved activities render in Updates panel', async () => {
    activities = (await snapshot()).adrActivities.filter(activity => activity.adrId === adrId && ['adr.create', 'adr.approve'].includes(activity.action));
    assert.equal(activities.length, 2);
    if (!(await page.getByRole('button', { name: 'Close updates', exact: true }).count())) await updates();
    await assertActivities(page);
    await capture('updates-activities');
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
  });
  await check('Workstreams latest and history include ADR activity and open exact source', async () => {
    const row = await workstreamRow();
    await row.locator('.ws-latest').getByText('ADR approved (verified)', { exact: true }).waitFor();
    await row.locator('.ws-history summary').click();
    await assertActivities(row);
    await capture('workstream-activities');
    await row.locator('.ws-latest').getByRole('button', { name: 'Open ADR', exact: true }).click();
    await page.locator('.adr-content').getByText(`${marker} Decision`, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close ADR', exact: true }).click();
  });
  await check('Reload persists the same immutable activity identifiers and content', async () => {
    await page.reload();
    await page.waitForLoadState('networkidle');
    assert.deepEqual((await snapshot()).adrActivities.filter(activity => activity.adrId === adrId && ['adr.create', 'adr.approve'].includes(activity.action)), activities);
    await updates();
    await assertActivities(page);
    await page.getByRole('button', { name: 'Close updates', exact: true }).click();
  });
  page = await login('viewer', { width: 390, height: 844 });
  await check('Viewer sees activities read only and 390px Updates and Workstreams do not overflow', async () => {
    await updates();
    await assertActivities(page);
    assert.equal(await page.getByRole('button', { name: 'Add note', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add ADR', exact: true }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture('mobile-viewer-updates');
    await page.locator(`[data-adr-history-id="${activities[0].id}"]`).getByRole('button', { name: 'Open ADR', exact: true }).click();
    await page.locator('.adr-content').getByText(`${marker} Decision`, { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^(Edit ADR|Approve|Request approval)$/ }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Close ADR', exact: true }).click();
    if (await page.getByRole('button', { name: 'Close updates', exact: true }).count()) await page.getByRole('button', { name: 'Close updates', exact: true }).click();
    const row = await workstreamRow();
    await row.locator('.ws-history summary').click();
    await assertActivities(row);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture('mobile-viewer-workstream');
  });
  await check('No browser runtime errors', async () => assert.deepEqual(errors, []));
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ marker, itemId, updateId, adrId, activities, results, errors }, null, 2), { mode: 0o600 });
  await browser.close();
  console.log(`Acceptance evidence: ${relative(process.cwd(), output)}`);
}
