// Optional isolated synthetic acceptance. Uses the same explicit arguments as workstream-browser.mjs.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--instance-dir','--base-url','--playwright-module'].includes(process.argv[i]) && !(process.argv[i] in args) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'));
  args[process.argv[i]] = process.argv[i + 1];
}
assert(Object.keys(args).length === 3);
const instance = await realpath(resolve(args['--instance-dir']));
const owned = relative(await realpath('.local'), instance);
assert(!isAbsolute(owned) && /^workstream-acceptance-[^/]+$/.test(owned));
const base = new URL(args['--base-url']);
assert(base.hostname === '127.0.0.1' && base.protocol === 'http:' && base.port && base.port !== '4320' && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password);
const env = parseEnv(await readFile(resolve(instance,'.env'),'utf8'));
assert.equal(env.APP_URL,base.origin);
assert.equal(new URL(env.DATABASE_URL).hostname,'127.0.0.1');
assert.notEqual(new URL(env.DATABASE_URL).port,'54339');
assert.equal(new URL(env.OIDC_ISSUER).hostname,'127.0.0.1');
const users = JSON.parse(await readFile(resolve(instance,'credentials.json'),'utf8')).users;
assert(users.every(user => user.email.endsWith('@example.test')));
const output = resolve(instance,`view-browser-${Date.now()}`);
await mkdir(output,{mode:0o700});
const { chromium } = await import(pathToFileURL(resolve(args['--playwright-module'])).href);
const browser = await chromium.launch({channel:'chrome',headless:true});
const results = [], errors = [];
let page;
function safe(error) { let text = String(error?.message ?? error); for(const secret of [env.DATABASE_URL,...users.flatMap(u=>[u.email,u.password])]) text=text.replaceAll(secret,'[redacted]'); return text; }
async function check(name,fn) { try { await fn(); results.push({name,pass:true}); console.log(`PASS ${name}`); } catch(error) { results.push({name,pass:false,error:safe(error)}); throw error; } }
async function login(context,role='admin') {
  const target = await context.newPage(); target.setDefaultTimeout(10000); target.on('pageerror',error=>errors.push(safe(error)));
  const user = users.find(u=>u.role===role);
  await target.goto(`${base.origin}/auth/login`);
  await target.locator('input[name="login"]').fill(user.email);
  await target.locator('input[name="password"]').fill(user.password);
  await target.locator('button[type="submit"]').click();
  await target.waitForURL(`${base.origin}/`); await target.waitForLoadState('networkidle'); return target;
}
async function choose(target,label,value) { await target.getByRole('combobox',{name:label,exact:true}).click(); await target.getByRole('option',{name:value,exact:true}).click(); }
async function heading(target,text) { await target.locator('#page-title').filter({hasText:new RegExp(`^${text}$`)}).waitFor(); }
async function capture(name) { assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Viewport overflow'); await page.screenshot({path:resolve(output,`${name}.png`),fullPage:true}); }
async function removedHelp() { assert.equal(await page.locator('.ws-definition, .ws-count-help').count(),0); for(const text of ['Review recent updates, quiet work, and current blockers.','About these counts']) assert.equal(await page.getByText(text,{exact:true}).count(),0); }
const key='goalie:work-default-view:demo-admin';
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  page=await login(context);
  await check('Default All work, footer dropdown and Workstreams-first desktop navigation',async()=>{
    await heading(page,'All work');
    assert.equal(await page.locator('.work-sidebar nav button').first().innerText(),'Workstreams');
    assert.equal(await page.locator('.sidebar-footer').getByRole('combobox',{name:'Default view'}).innerText(),'All work');
    await capture('desktop-default');
  });
  await check('Both default values persist account-scoped and apply only on reload',async()=>{
    await choose(page,'Default view','Workstreams'); await heading(page,'All work');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'streams');
    await page.reload(); await heading(page,'Workstreams');
    await choose(page,'Default view','All work'); await heading(page,'Workstreams');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'all');
    await page.reload(); await heading(page,'All work');
  });
  await check('Cross-tab preference updates do not navigate or discard unsaved task draft',async()=>{
    const other=await context.newPage(); await other.goto(base.origin); await other.waitForLoadState('networkidle');
    await page.getByRole('button',{name:'New work',exact:true}).click();
    await page.getByRole('textbox',{name:'Title',exact:true}).fill('Synthetic unsaved cross-tab preference draft');
    for(const value of ['Workstreams','All work']) {
      await choose(page,'Default view',value); await heading(page,'All work');
      assert.equal(await page.getByRole('textbox',{name:'Title',exact:true}).inputValue(),'Synthetic unsaved cross-tab preference draft');
      assert.equal(await page.getByRole('alertdialog').count(),0);
    }
    await choose(other,'Default view','Workstreams');
    await page.waitForFunction(()=>document.querySelector('.sidebar-footer [role="combobox"]')?.textContent==='Workstreams');
    await heading(page,'All work');
    assert.equal(await page.getByRole('textbox',{name:'Title',exact:true}).inputValue(),'Synthetic unsaved cross-tab preference draft');
    assert.equal(await page.getByRole('alertdialog').count(),0);
    await capture('cross-tab-draft');
    await page.getByRole('button',{name:'Close editor',exact:true}).click();
    await page.getByRole('button',{name:'Discard changes',exact:true}).click();
    await other.close(); await page.reload(); await heading(page,'Workstreams');
  });
  await check('Light/dark desktop/mobile icon cues, removed help copy and no overflow',async()=>{
    for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      for(const theme of ['Light theme','Dark theme']) {
        await choose(page,'Color theme',theme);
        await removedHelp();
        const cues=await page.locator('.ws-metrics').first().locator('dt').evaluateAll(nodes=>nodes.map(node=>({label:node.textContent,color:getComputedStyle(node).color,icon:!!node.querySelector('svg')})));
        assert.deepEqual(cues.map(c=>c.label),['Updated','Quiet','Blocked']); assert(cues.every(c=>c.icon)); assert.equal(new Set(cues.map(c=>c.color)).size,3);
        results.push({name:`Metric colors ${viewport.width} ${theme}`,pass:true,cues});
        await capture(`${viewport.width}-${theme.split(' ')[0].toLowerCase()}-directory`);
        await page.getByRole('button',{name:'Review Network',exact:true}).click();
        await removedHelp();
        await capture(`${viewport.width}-${theme.split(' ')[0].toLowerCase()}-review`);
        await page.locator('.ws-back').click();
      }
    }
  });
  await check('Mobile footer default dropdown is usable and persists both choices',async()=>{
    for(const [label,value] of [['All work','all'],['Workstreams','streams']]) {
      await page.getByRole('button',{name:'Open navigation',exact:true}).click();
      const dialog=page.getByRole('dialog');
      assert.equal(await dialog.locator('nav button').first().innerText(),'Workstreams');
      await dialog.getByRole('combobox',{name:'Default view',exact:true}).click();
      await page.getByRole('option',{name:label,exact:true}).click();
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),value);
      await capture(`mobile-default-${value}`);
      await page.getByRole('button',{name:'Close navigation',exact:true}).click();
      await page.reload(); await heading(page,label);
    }
  });
  await page.setViewportSize({width:1440,height:1000});
  await check('Same-browser account preference isolation',async()=>{
    await page.getByRole('button',{name:'Sign out',exact:true}).click(); await page.locator('#page-title').waitFor({state:'detached'});
    await page.close(); page=await login(context,'editor'); await heading(page,'All work');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'streams');
    await choose(page,'Default view','Workstreams');
    await choose(page,'Default view','All work');
    assert.equal(await page.evaluate(()=>localStorage.getItem('goalie:work-default-view:demo-editor')),'all');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'streams');
  });
  await check('Invalid stored default falls back to All work',async()=>{
    await page.evaluate(()=>localStorage.setItem('goalie:work-default-view:demo-editor','invalid-synthetic'));
    await page.reload(); await heading(page,'All work'); await page.waitForFunction(()=>document.querySelector('.sidebar-footer [role="combobox"]')?.textContent==='All work'); assert.equal(await page.getByRole('combobox',{name:'Default view',exact:true}).innerText(),'All work');
  });
  await check('Unavailable localStorage safely falls back and preference remains usable',async()=>{
    const blocked=await browser.newContext({viewport:{width:1440,height:1000}});
    await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic unavailable storage','SecurityError');}}));
    page=await login(blocked); await heading(page,'All work'); await choose(page,'Default view','Workstreams'); await heading(page,'All work');
    await page.reload(); await heading(page,'All work'); await capture('storage-unavailable'); await blocked.close(); page=null;
  });
  await check('No uncaught browser errors',async()=>assert.deepEqual(errors,[]));
} catch(error) { console.error(safe(error)); process.exitCode=1; if(page&&!page.isClosed()) { await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}); await writeFile(resolve(output,'failure.txt'),await page.locator('body').innerText(),{mode:0o600}); } }
finally { await writeFile(resolve(output,'results.json'),JSON.stringify({results,pageErrors:errors},null,2),{mode:0o600}); await browser.close(); console.log(`Evidence: ${relative(process.cwd(),output)}`); }
