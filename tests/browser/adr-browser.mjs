// Optional local browser acceptance. No Playwright production dependency is needed.
// node tests/browser/adr-browser.mjs --instance-dir .local/adr-ui-acceptance-EXAMPLE \
//   --base-url http://127.0.0.1:4318 --playwright-module /absolute/path/to/playwright/index.mjs
// Requires an explicitly prepared synthetic demo instance, migrated app and running Dex.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const options = {};
const allowed = new Set(['--instance-dir', '--base-url', '--playwright-module']);
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  assert(allowed.has(flag) && !(flag in options) && value && !value.startsWith('--'), 'Unknown, duplicated or missing option value.');
  options[flag] = value;
}
assert(options['--instance-dir'] && options['--base-url'], 'Explicit --instance-dir and --base-url are required. There is no live default.');
const instance = resolve(options['--instance-dir']);
const owned = relative(resolve('.local'), instance);
assert(!owned.startsWith('..') && !isAbsolute(owned) && owned.startsWith('adr-ui-acceptance-'), 'Use a dedicated ignored .local/adr-ui-acceptance-* instance.');
const base = new URL(options['--base-url']);
assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port && base.pathname === '/', 'Only explicit loopback HTTP origins are accepted.');
assert(!base.username && !base.password && !base.search && !base.hash, 'Origin must not contain credentials, query or fragment.');
const settings = Object.fromEntries((await readFile(resolve(instance, '.env'), 'utf8')).split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
assert.equal(settings.APP_URL, base.origin, 'Instance APP_URL must match the explicit acceptance origin.');
assert.equal(new URL(settings.DATABASE_URL).hostname, '127.0.0.1', 'Synthetic database must also be loopback.');
assert.equal(new URL(settings.OIDC_ISSUER).hostname, '127.0.0.1', 'Synthetic Dex must be loopback.');
const users = JSON.parse(await readFile(resolve(instance, 'credentials.json'), 'utf8')).users;
assert(users.length >= 3 && users.every(user => user.email.endsWith('@example.test')), 'Only generated synthetic demo identities are accepted.');
function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const user of users) {
    for (const secret of [user.password, user.email].filter(Boolean)) {
      message = message.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]');
    }
  }
  return message;
}
const modulePath = options['--playwright-module'];
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const output = resolve(instance, `browser-${Date.now()}`);
await mkdir(output, { mode: 0o700 });
const results = [];
const marker = `browser-acceptance-${Date.now()}`;
let page;
async function check(name, operation) {
  try { await operation(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, error: safeError(error) }); if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }); throw error; }
}
async function login(role, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const target = await context.newPage();
  target.setDefaultTimeout(10000);
  const user = users.find(candidate => candidate.role === role);
  assert(user, `Missing synthetic role ${role}`);
  await target.goto(`${base.origin}/auth/login`);
  await target.locator('input[name="login"]').fill(user.email);
  await target.locator('input[name="password"]').fill(user.password);
  await target.locator('button[type="submit"]').click();
  await target.waitForURL(`${base.origin}/`);
  await target.waitForLoadState('networkidle');
  return target;
}
async function choose(label, name) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: false }).click();
}
async function startDraft() {
  await page.getByRole('button', { name: 'More actions for Review pilot launch readiness', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click();
  await page.getByRole('button', { name: 'Add ADR', exact: true }).click();
}
try {
  page = await login('admin');
  const author = page;
  await check('Real OIDC, seven required fields, requester default and account selection', async () => {
    await startDraft();
    assert.equal(await page.locator('#adr-editor textarea[required]').count(), 7);
    assert.match(await page.getByRole('combobox', { name: 'Requester', exact: true }).innerText(), /Alex Morgan/);
    for (const field of ['Context', 'Concern', 'Decision', 'Alternatives not chosen', 'Expected consequences', 'Accepted downsides', 'Rationale']) await page.getByLabel(field, { exact: true }).fill(`${marker} ${field}`);
    await choose('Requester', 'Sam Rivera');
    await choose('Requester', 'Alex Morgan');
    await choose('Approver', 'Sam Rivera');
  });
  await check('Dirty Escape and Keep editing preserve exact accessible field value', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await page.getByLabel('Decision', { exact: true }).inputValue(), `${marker} Decision`);
  });
  await check('Create and submit, author cannot verify nominee approval', async () => {
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('button', { name: 'Request approval', exact: true }).click();
    await page.locator('.adr-content > .adr-status').filter({ hasText: 'Pending approval' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
  });
  page = await login('editor');
  await check('Nominee inbox read/unread, source navigation and verified approval', async () => {
    await page.getByRole('button', { name: /Notifications/ }).click();
    const notification = page.locator('.adr-notification').filter({ hasText: 'Approval requested' }).first();
    await notification.getByRole('button', { name: 'Mark read', exact: true }).click();
    await notification.getByRole('button', { name: 'Mark unread', exact: true }).click();
    await notification.getByRole('button', { name: 'Open source', exact: true }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText('Verified approval by Sam Rivera', { exact: false }).waitFor();
    await page.screenshot({ path: resolve(output, 'verified-approval.png'), fullPage: true });
  });
  page = author;
  await page.reload();
  await page.waitForLoadState('networkidle');
  await check('Registry search, edit approval reset and history', async () => {
    await page.getByRole('button', { name: 'ADRs', exact: true }).click();
    await page.getByLabel('Search ADR text or document URL').fill(marker);
    await page.locator('.adr-row').filter({ hasText: marker }).click();
    await page.getByRole('button', { name: 'Edit ADR', exact: true }).click();
    await page.getByLabel('Rationale', { exact: true }).fill(`${marker} revised`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.locator('.adr-content > .adr-status').filter({ hasText: 'Draft' }).waitFor();
    await page.getByRole('button', { name: 'View history', exact: true }).click();
    await page.getByRole('region', { name: 'ADR history' }).getByText('approve · Sam Rivera', { exact: false }).waitFor();
  });
  page = await login('admin', { width: 390, height: 844 });
  await check('390px nested account selector and keyboard discard focus restoration', async () => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await startDraft();
    await choose('Approver', 'Sam Rivera');
    await page.getByLabel('Context', { exact: true }).fill('Synthetic mobile unsaved draft');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Keep editing', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByLabel('Context', { exact: true }).inputValue(), 'Synthetic mobile unsaved draft');
    await page.screenshot({ path: resolve(output, 'mobile-draft.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('Add ADR'));
  });
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ marker, results }, null, 2), { mode: 0o600 });
  await browser.close();
  console.log(`Acceptance evidence: ${relative(process.cwd(), output)}`);
}
