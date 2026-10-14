// Optional isolated synthetic acceptance. No live defaults or committed browser dependency.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--instance-dir', '--base-url', '--playwright-module'].includes(process.argv[i]) && !(process.argv[i] in args) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'));
  args[process.argv[i]] = process.argv[i + 1];
}
assert.equal(Object.keys(args).length, 3);
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 24 || major === 24 && minor >= 14, 'Node 24.14+ required');
const instance = await realpath(resolve(args['--instance-dir']));
const owned = relative(await realpath('.local'), instance);
assert(!isAbsolute(owned) && /^workstream-acceptance-[^/]+$/.test(owned));
const base = new URL(args['--base-url']);
assert(base.hostname === '127.0.0.1' && base.protocol === 'http:' && base.port && base.port !== '4320' && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password);
const env = parseEnv(await readFile(resolve(instance, '.env'), 'utf8'));
assert.equal(env.APP_URL, base.origin);
assert.equal(new URL(env.DATABASE_URL).hostname, '127.0.0.1');
assert.notEqual(new URL(env.DATABASE_URL).port, '54339');
assert.equal(new URL(env.OIDC_ISSUER).hostname, '127.0.0.1');
const users = JSON.parse(await readFile(resolve(instance, 'credentials.json'), 'utf8')).users;
assert(users.length >= 3 && users.every(user => user.email.endsWith('@example.test')));
const output = resolve(instance, `compact-browser-${Date.now()}`);
await mkdir(output, { mode: 0o700 });
const { chromium } = await import(pathToFileURL(resolve(args['--playwright-module'])).href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], errors = [];
let page;
const layoutKey = 'goalie:work-layout:demo-admin', startKey = 'goalie:work-default-view:demo-admin';
function safe(error) { let text = String(error?.message ?? error); for (const secret of [env.DATABASE_URL, ...users.flatMap(u => [u.email, u.password])]) text = text.replaceAll(secret, '[redacted]'); return text; }
async function check(name, fn) { try { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); } catch (error) { results.push({ name, pass: false, error: safe(error) }); throw error; } }
async function login(context, role = 'admin') {
  const target = await context.newPage(); target.setDefaultTimeout(10000); target.on('pageerror', error => errors.push(safe(error)));
  const user = users.find(u => u.role === role); assert(user);
  await target.goto(`${base.origin}/auth/login`);
  await target.locator('input[name="login"]').fill(user.email);
  await target.locator('input[name="password"]').fill(user.password);
  await target.locator('button[type="submit"]').click();
  await target.waitForURL(`${base.origin}/`); await target.waitForLoadState('networkidle'); return target;
}
async function choose(target, label, value) { await target.getByRole('combobox', { name: label, exact: true }).click(); await target.getByRole('option', { name: value, exact: true }).click(); if (label === 'Layout') await target.getByRole('combobox', { name: label, exact: true }).filter({ hasText: value }).waitFor(); }
async function value(target, label, expected) { await target.getByRole('combobox', { name: label, exact: true }).filter({ hasText: expected }).waitFor(); }
async function heading(text) { await page.locator('#page-title').filter({ hasText: new RegExp(`^${text}$`) }).waitFor(); }
async function capture(name) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
    let previous = '', stable = 0;
    while (stable < 3) {
      await new Promise(requestAnimationFrame);
      const current = [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.work-app')).backgroundColor].join('|');
      stable = current === previous ? stable + 1 : 0; previous = current;
    }
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Viewport overflow');
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function closeDraft() { await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await page.getByRole('button', { name: 'Discard changes', exact: true }).click(); }
async function filters() { await page.getByRole('button', { name: /^Filters \(/ }).click(); return page.getByRole('dialog', { name: 'Workstream filters' }); }
async function back() { await page.locator('#page-title').getByRole('button', { name: 'Workstreams', exact: true }).click(); }
try {
  const context = await browser.newContext({ viewport: { width: 1363, height: 1000 } });
  page = await login(context);
  await check('Standard is default and Start page existing storage remains independent', async () => {
    await heading('All work'); await value(page, 'Layout', 'Standard'); await value(page, 'Start page', 'All work');
    await capture('standard-desktop');
    await choose(page, 'Layout', 'Compact'); await heading('All work');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), layoutKey), 'compact');
    await choose(page, 'Start page', 'Workstreams'); await heading('All work');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), startKey), 'streams');
    await page.reload(); await heading('Workstreams'); await value(page, 'Layout', 'Compact');
    await choose(page, 'Layout', 'Standard'); await page.reload(); await heading('Workstreams'); await value(page, 'Layout', 'Standard');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), startKey), 'streams');
  });
  await check('Layout changes and tab synchronization preserve unsaved draft without guard', async () => {
    await page.locator('.work-sidebar').getByRole('button', { name: 'All work', exact: true }).click();
    await page.getByRole('button', { name: 'New work', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Synthetic compact draft not saved');
    const other = await context.newPage(); await other.goto(base.origin); await other.waitForLoadState('networkidle');
    for (const layout of ['Compact', 'Standard']) {
      await choose(page, 'Layout', layout); await value(other, 'Layout', layout);
      assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Synthetic compact draft not saved');
      assert.equal(await page.getByRole('alertdialog').count(), 0);
    }
    await choose(other, 'Layout', 'Compact'); await value(page, 'Layout', 'Compact');
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Synthetic compact draft not saved');
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await choose(page, 'Start page', 'All work');
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Synthetic compact draft not saved');
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await choose(page, 'Start page', 'Workstreams');
    await capture('cross-tab-draft'); await closeDraft(); await other.close();
  });
  await check('Manage destinations stay visible in both layouts; Settings reveals unchanged controls', async () => {
    for (const layout of ['Standard', 'Compact']) {
      await choose(page, 'Layout', layout);
      assert.equal(await page.getByRole('button', { name: 'Manage', exact: true }).count(), 0);
      for (const name of ['ADRs', 'Goals', 'Shared tags', 'People']) assert(await page.locator('.work-sidebar').getByRole('button', { name, exact: true }).isVisible());
    }
    await page.getByRole('button', { name: 'Goals', exact: true }).click(); await heading('Goals');
    await choose(page, 'Layout', 'Standard');
    await page.getByRole('switch', { name: /^AI assistance/ }).waitFor(); await page.getByRole('switch', { name: /^Debug mode/ }).waitFor();
    const before = await page.getByRole('switch').evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), node.getAttribute('aria-checked'), node.disabled]));
    await choose(page, 'Layout', 'Compact'); await heading('Goals');
    const settings = page.getByRole('button', { name: 'Settings', exact: true }); await settings.click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Settings' && node.getAttribute('aria-expanded') === 'true'));
    await page.getByRole('switch', { name: /^AI assistance/ }).waitFor(); await page.getByRole('switch', { name: /^Debug mode/ }).waitFor();
    assert.equal(await page.getByRole('switch').count(), 2); assert.equal(before.length, 2);
    assert.deepEqual(await page.getByRole('switch').evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), node.getAttribute('aria-checked'), node.disabled])), before);
    await capture('manage-settings');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.work-sidebar').getByRole('button', { name: 'Workstreams', exact: true }).click();
  });
  await check('Same-data Standard versus Compact directory, All work and My work density at 1363px', async () => {
    async function measure(selector, titleSelector) {
      return page.locator(selector).evaluateAll((nodes, titleSelector) => nodes.map(node => ({ title: node.querySelector(titleSelector)?.textContent, height: node.getBoundingClientRect().height })), titleSelector);
    }
    for (const destination of ['Workstreams', 'All work', 'My work']) {
      await page.locator('.work-sidebar').getByRole('button', { name: destination, exact: true }).click();
      const directory = destination === 'Workstreams';
      const selector = directory ? '.ws-stream-row' : '.work-list-surface > .item-accordions > .work-item';
      const titleSelector = directory ? 'h3' : '.work-row-copy strong';
      await choose(page, 'Layout', 'Standard');
      const standard = await measure(selector, titleSelector); assert(standard.length > 0);
      const description = directory ? await page.locator('.ws-stream-row').filter({ has: page.getByRole('button', { name: 'Review Network', exact: true }) }).locator('.ws-stream-description').innerText() : null;
      await capture(`1363-standard-${destination.toLowerCase().replaceAll(' ', '-')}`);
      await choose(page, 'Layout', 'Compact');
      const compact = await measure(selector, titleSelector);
      assert.deepEqual(compact.map(row => row.title), standard.map(row => row.title));
      const standardMean = standard.reduce((sum, row) => sum + row.height, 0) / standard.length;
      const compactMean = compact.reduce((sum, row) => sum + row.height, 0) / compact.length;
      const reduction = 1 - compactMean / standardMean;
      results.push({ name: `${destination} same-data row-height comparison`, pass: true, width: 1363, standard, compact, standardMean, compactMean, reduction });
      assert(reduction >= (directory ? .30 : .15), `${destination} reduction ${(reduction * 100).toFixed(1)}% too small`);
      await capture(`1363-compact-${destination.toLowerCase().replaceAll(' ', '-')}`);
      if (directory) {
        assert.equal(await page.locator('.ws-stream-description').count(), 0);
        await page.getByRole('button', { name: 'Review Network', exact: true }).click();
        assert.equal(await page.locator('.ws-description').innerText(), description);
        assert.match(await page.locator('.ws-heading .ws-meta').innerText(), /Make routine operations repeatable/);
        await back();
      } else {
        const trigger = page.locator(selector).first().getByRole('button', { name: /^Expand work / });
        await trigger.click();
        for (const layout of ['Standard', 'Compact']) { await choose(page, 'Layout', layout); assert.equal(await trigger.getAttribute('aria-expanded'), 'true'); }
        await trigger.click();
        const controls = await page.locator(`${selector} > .work-item-heading .work-item-actions button`).evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        assert(controls.length > 0 && controls.every(control => control.width >= 44 && control.height >= 44));
      }
    }
    await page.locator('.work-sidebar').getByRole('button', { name: 'Workstreams', exact: true }).click();
  });
  await check('Compact filters retain all four controls, functional filters, count and clear', async () => {
    await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).fill('Network');
    assert.equal(await page.getByRole('button', { name: /^Review / }).count(), 1);
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    const dialog = await filters();
    for (const label of ['Workstream lead', 'Linked goal', 'Workstream attention', 'Sort workstreams']) await dialog.getByRole('combobox', { name: label, exact: true }).waitFor();
    await choose(page, 'Workstream lead', 'Taylor Chen');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /^Review / }).count(), 1);
    await page.getByRole('button', { name: 'Filters (1)', exact: true }).waitFor();
    await filters(); await choose(page, 'Linked goal', 'Make routine operations repeatable'); await choose(page, 'Workstream attention', 'Blocked'); await choose(page, 'Sort workstreams', 'Quiet count');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Filters (3)', exact: true }).waitFor();
    await filters(); await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click();
    for (const [label, expected] of [['Workstream lead', 'All leads'], ['Linked goal', 'All goals'], ['Workstream attention', 'Any attention'], ['Sort workstreams', 'Name']]) await value(page, label, expected);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Filters (0)', exact: true }).waitFor();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === 'Filters (0)');
    await filters(); await choose(page, 'Workstream attention', 'Blocked'); await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    assert((await page.getByRole('button', { name: /^Review / }).allTextContents()).includes('Network'));
    await filters(); await choose(page, 'Linked goal', 'Make routine operations repeatable'); await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Review Boundary review', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Review Network', exact: true }).waitFor();
    await filters(); await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click(); await choose(page, 'Sort workstreams', 'Quiet count'); await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Filters (0)', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Review / }).first().getAttribute('aria-label'), 'Review Boundary review');
    await filters(); await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click(); await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  });
  await check('Keyboard dialog traps focus, Escape restores trigger, cross-tab Standard closes to search', async () => {
    const trigger = page.getByRole('button', { name: 'Filters (0)', exact: true }); await trigger.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Workstream filters' }); await dialog.waitFor();
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); assert(await dialog.evaluate(node => node.contains(document.activeElement))); }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.activeElement?.textContent === 'Filters (0)');
    await filters(); const other = await context.newPage(); await other.goto(base.origin); await other.waitForLoadState('networkidle');
    await choose(other, 'Layout', 'Standard'); await value(page, 'Layout', 'Standard'); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search workstreams');
    await choose(other, 'Layout', 'Compact'); await value(page, 'Layout', 'Compact'); await other.close();
  });
  await check('Layout toggles preserve directory search, selected stream, task search, mode and window', async () => {
    await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).fill('Network'); await choose(page, 'Activity window', 'Last 30 days');
    await choose(page, 'Layout', 'Standard'); assert.equal(await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).inputValue(), 'Network');
    await choose(page, 'Layout', 'Compact'); await page.getByRole('button', { name: 'Review Network', exact: true }).click();
    await page.getByRole('button', { name: 'All tasks', exact: true }).click(); await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('router');
    for (const layout of ['Standard', 'Compact']) {
      await choose(page, 'Layout', layout); await value(page, 'Activity window', 'Last 30 days');
      assert.equal(await page.getByRole('textbox', { name: 'Search tasks', exact: true }).inputValue(), 'router');
      assert.equal(await page.getByRole('button', { name: 'All tasks', exact: true }).getAttribute('aria-pressed'), 'true');
    }
    assert.equal(await page.locator('h1').count(), 1); assert.match(await page.locator('h1').innerText(), /Workstreams.*Network/s);
    await back(); assert.equal(await page.getByRole('textbox', { name: 'Search workstreams', exact: true }).inputValue(), 'Network');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  });
  await check('Compact breadcrumb Back respects dirty draft guard', async () => {
    await page.getByRole('button', { name: 'Review Network', exact: true }).click(); await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Synthetic breadcrumb dirty draft'); await back();
    const guard = page.getByRole('alertdialog'); await guard.waitFor(); await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Synthetic breadcrumb dirty draft');
    await back(); await guard.getByRole('button', { name: 'Discard changes', exact: true }).click(); await heading('Workstreams');
  });
  await check('Desktop and 390px light/dark screenshots, neutral zero and semantic nonzero metric icons', async () => {
    for (const viewport of [{ width: 1363, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['Light theme', 'Dark theme']) {
        await choose(page, 'Color theme', theme);
        await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme.startsWith('Dark') ? 'dark' : 'light');
        const cues = await page.locator('.ws-metrics dt').evaluateAll(nodes => nodes.map(node => ({ label: node.textContent, color: getComputedStyle(node).color, zero: node.classList.contains('ws-metric-zero'), icon: !!node.querySelector('svg') })));
        assert(cues.every(cue => cue.icon)); assert(cues.some(cue => cue.zero)); assert(cues.some(cue => !cue.zero));
        const zeros = new Set(cues.filter(cue => cue.zero).map(cue => cue.color)); assert.equal(zeros.size, 1);
        assert(cues.filter(cue => !cue.zero).every(cue => !zeros.has(cue.color)));
        results.push({ name: `Metric evidence ${viewport.width} ${theme}`, pass: true, cues });
        await capture(`${viewport.width}-${theme.split(' ')[0].toLowerCase()}-directory`);
        const dialog = await filters(); await capture(`${viewport.width}-${theme.split(' ')[0].toLowerCase()}-filters`);
        assert(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }));
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Review Network', exact: true }).click(); assert.equal(await page.locator('h1').count(), 1);
        await capture(`${viewport.width}-${theme.split(' ')[0].toLowerCase()}-review`); await back();
        for (const destination of ['All work', 'My work', 'Workstreams']) {
          if (viewport.width === 390) {
            await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
            const navigation = page.getByRole('dialog');
            await navigation.getByRole('button', { name: destination, exact: true }).click();
            await navigation.waitFor({ state: 'hidden' });
          } else await page.locator('.work-sidebar').getByRole('button', { name: destination, exact: true }).click();
          if (destination === 'Workstreams') break;
          const titles = await page.locator('.work-row-copy strong').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return { text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1 && style.overflow === 'hidden', ellipsis: style.textOverflow === 'ellipsis' }; }));
          assert(titles.length > 0 && titles.every(title => !title.clipped && !title.ellipsis));
          await capture(`${viewport.width}-${theme.split(' ')[0].toLowerCase()}-${destination.toLowerCase().replaceAll(' ', '-')}`);
        }
      }
    }
  });
  await check('Mobile drawer Layout choices persist independently from Start page', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const layout of ['Standard', 'Compact']) {
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      const navigation = page.getByRole('dialog');
      await navigation.getByRole('combobox', { name: 'Start page', exact: true }).waitFor();
      await navigation.getByRole('combobox', { name: 'Layout', exact: true }).click(); await page.getByRole('option', { name: layout, exact: true }).click();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), layoutKey), layout.toLowerCase());
      await capture(`390-navigation-${layout.toLowerCase()}`);
      await page.getByRole('button', { name: 'Close navigation', exact: true }).click(); await page.reload(); await heading('Workstreams');
    }
    await page.setViewportSize({ width: 1363, height: 1000 }); await value(page, 'Layout', 'Compact');
  });
  await page.setViewportSize({ width: 1363, height: 1000 });
  await check('Account-scoped Layout is isolated while prior account values survive', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.locator('#page-title').waitFor({ state: 'detached' }); await page.close();
    page = await login(context, 'editor'); await value(page, 'Layout', 'Standard'); await heading('All work');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), layoutKey), 'compact');
    await choose(page, 'Layout', 'Compact'); await choose(page, 'Layout', 'Standard');
    assert.equal(await page.evaluate(() => localStorage.getItem('goalie:work-layout:demo-editor')), 'standard');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), layoutKey), 'compact');
    await page.reload(); await value(page, 'Layout', 'Standard');
    await page.evaluate(() => localStorage.setItem('goalie:work-layout:demo-editor', 'invalid-synthetic'));
    await page.reload(); await value(page, 'Layout', 'Standard'); await heading('All work');
  });
  await check('Viewer Compact controls remain read-only and usable', async () => {
    const viewer = await browser.newContext({ viewport: { width: 1363, height: 1000 } }); page = await login(viewer, 'viewer'); await choose(page, 'Layout', 'Compact');
    assert(await page.getByRole('button', { name: 'New work', exact: true }).isDisabled());
    await page.locator('.work-sidebar').getByRole('button', { name: 'Workstreams', exact: true }).click(); assert(await page.getByRole('button', { name: 'New workstream', exact: true }).isDisabled());
    const dialog = await filters(); await choose(page, 'Workstream attention', 'Blocked'); await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Review Network', exact: true }).click();
    for (const name of ['Edit workstream', 'Add task', 'Add update', 'Add subtask']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    await page.getByRole('button', { name: 'View updates', exact: true }).first().waitFor(); await capture('viewer-compact'); await viewer.close(); page = null;
  });
  await check('No uncaught browser errors', async () => assert.deepEqual(errors, []));
} catch (error) {
  console.error(safe(error)); process.exitCode = 1;
  if (page && !page.isClosed()) { await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }); await writeFile(resolve(output, 'failure.txt'), await page.locator('body').innerText(), { mode: 0o600 }); }
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, pageErrors: errors }, null, 2), { mode: 0o600 }); await browser.close(); console.log(`Evidence: ${relative(process.cwd(), output)}`);
}
