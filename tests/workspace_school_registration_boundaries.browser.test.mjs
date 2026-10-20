/* 真实浏览器验证：报名页校验失败可见/聚焦，可预见的 400 在预览前被拦截。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'workspace-school-feedback-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db()
c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class QuietHandler(Handler):
    def log_message(self,*args): pass
s=create_server(('127.0.0.1',0),QuietHandler)
print(json.dumps({'port':s.server_port}),flush=True)
s.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_ADMIN_PASSWORD: 'WorkspaceSchoolFeedback123', PYTHONUTF8: '1' } });
let browser, serverErrors = '';
const checks = [];
child.stderr.on('data', chunk => { serverErrors += chunk; });
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server ${code}: ${serverErrors}`)); });
    let output = ''; child.stdout.on('data', chunk => {
      output += chunk; try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'WorkspaceSchoolFeedback123' })).token;
  identity = await api('POST', '/api/events', { name: '2026 报名页反馈修复验证' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  const group = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '甲组', code: 'A' })).group_id;
  const team = (await api('POST', `/api/groups/${group}/categories`, { name: '男子三人赛', kind: 'team', gender: 'male' })).category_id;
  const individual = (await api('POST', `/api/groups/${group}/categories`, { name: '男子个人赛', kind: 'individual', gender: 'male' })).category_id;
  const school = (await api('POST', `/api/events/${identity.event_id}/schools`, { name: '报名反馈测试大学', group_id: group })).school_id;
  const seeded = (await api('POST', `/api/schools/${school}/athletes`, { name: '原有甲', gender: 'male', jersey_no: '8' })).athlete_id;
  const seededPeer = (await api('POST', `/api/schools/${school}/athletes`, { name: '原有乙', gender: 'male', jersey_no: '9' })).athlete_id;
  pass('隔离服务、赛事与报名页资源启动');
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH,
    args: ['--host-resolver-rules=MAP registration.test 127.0.0.1', '--no-proxy-server'] });
  const failures = [];
  let page, context;
  const open = async (http = false) => {
    if (context) await context.close();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(({ token, event }) => {
      localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
    }, { token, event: identity.event_id });
    page = await context.newPage(); page.setDefaultTimeout(4000);
    page.on('dialog', d => d.accept());
    await page.goto(`${http ? `http://registration.test:${port}` : base}/#/workspace?${new URLSearchParams({ event: identity.event_id, group, category: team, tab: 'registration', school })}`);
    await page.locator('.school-registration-detail-head').waitFor();
  };
  const run = async (name, fn) => {
    if (process.env.STSS_BOUNDARIES_CASES && !process.env.STSS_BOUNDARIES_CASES.split(',').includes(name)) return;
    try { await fn(); pass(name); }
    catch (e) { failures.push({ name, error: e.stack }); console.error('FAIL ' + name + ': ' + e.message); }
  };
  const tab = name => page.getByRole('tab', { name, exact: true }).click();
  const card = id => page.locator(`[data-category="${id}"]`);
  const choice = (id, value) => card(id).locator('[data-edit="entry"]').first().selectOption(value);
  const preview = () => page.locator('[data-action="school-preview"]');
  const people = () => page.locator('.school-registration-person');
  const row = name => people().filter({ has: page.locator(`input[value="${name}"]`) });
  const add = async (name, category = null) => {
    if (!category) await tab('人员名单');
    const scope = category ? card(category) : page.locator('.school-registration-content');
    const form = scope.locator('.school-registration-add');
    await form.locator('..').evaluate(d => { d.open = true; });
    await form.getByLabel('新增人员姓名', { exact: true }).fill(name);
    await form.locator('select').selectOption('male');
    await form.getByRole('button', { name: /添加人员|添加到学校/ }).click();
  };
  const waitReview = async () => {
    await preview().click();
    await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '确认整批提交');
  };
  await run('NAME-REVIEW', async () => {
    await open(); await add('临时甲'); await tab('人员名单');
    const person = people().last();
    await person.locator('input').first().fill('原有甲');
    await person.locator('input').nth(2).fill('另一班');
    await person.getByRole('checkbox').check();
    await waitReview();
    await tab('人员名单');
    await people().last().locator('input').first().fill('唯一改名');
    await waitReview();
  });
  await run('HTTP-ID', async () => {
    await open(true);
    assert.equal(await page.evaluate(() => isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    await add('HTTP人员');
    assert.equal(await people().count(), 3);
    await waitReview(); await preview().click();
    await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '预览整批变更');
    const saved = await api('GET', `/api/schools/${school}/registration-workspace`);
    assert.equal(saved.people.filter(p => p.name === 'HTTP人员').length, 1);
    await open();
    let sent = 0;
    page.on('request', r => { if (/registration-(preview|commit)$/.test(r.url())) sent++; });
    await page.evaluate(() => Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true }));
    await add('随机源缺失');
    assert.match(await page.locator('.form-errors').innerText(), /浏览器无法生成报名标识/);
    assert.equal(await page.getByLabel('新增人员姓名', { exact: true }).inputValue(), '随机源缺失');
    assert.equal(sent, 0);
  });
  await run('PARTIAL-FORM', async () => {
    await open(); await tab('人员名单');
    const form = page.locator('.school-registration-add');
    await form.locator('..').evaluate(d => { d.open = true; });
    await form.getByLabel('新增人员区分信息').fill('仅备注');
    await tab('项目报名'); await tab('人员名单');
    assert.equal(await form.getByLabel('新增人员区分信息').isVisible(), true);
    await form.getByRole('button', { name: '清空新增输入' }).click();
    await form.locator('..').evaluate(d => { d.open = true; });
    await form.locator('select').selectOption('female');
    await tab('项目报名'); await tab('人员名单');
    assert.equal(await form.locator('select').isVisible(), true);
    await preview().click();
    assert.match(await page.locator('.form-errors').innerText(), /尚未添加|新增人员/);
    await form.getByRole('button', { name: '清空新增输入' }).click();
    await tab('项目报名'); await choice(team, 'participate');
    await card(team).locator('.school-registration-add').locator('..').evaluate(d => { d.open = true; });
    await card(team).getByLabel('新增人员常用号码').fill('8');
    await choice(team, 'not_participating');
    assert.equal(await card(team).getByLabel('新增人员常用号码').isVisible(), true);
    await preview().click();
    await card(team).getByRole('button', { name: '清空新增输入' }).click();
  });
  await run('REMOVE-REFERENCES', async () => {
    await open(); await choice(team, 'participate'); await add('待删队长', team);
    await card(team).locator('label.field', { hasText: '队长' }).locator('select').selectOption({ label: '待删队长' });
    await choice(team, 'not_participating'); await tab('人员名单');
    await people().last().getByRole('button', { name: '移除新增人员' }).click();
    await tab('项目报名'); await choice(team, 'participate');
    assert.equal(await card(team).getByText('人员档案已删除，请核对最新名单').count(), 0);
    assert.equal(await card(team).locator('.school-registration-member').count(), 0);
  });
  await run('INDIVIDUAL-ADD', async () => {
    await open(); await choice(individual, 'participate');
    await card(individual).getByLabel('男子个人赛选人').selectOption(`a:${seeded}`);
    await add('只建名单', individual);
    assert.equal(await card(individual).locator('.school-registration-member strong').innerText(), '原有甲');
    await tab('人员名单');
    assert.equal(await people().last().locator('input').first().inputValue(), '只建名单');
    await tab('项目报名'); await card(individual).getByRole('button', { name: '移除', exact: true }).click();
    await add('空位自动加入', individual);
    assert.equal(await card(individual).locator('.school-registration-member strong').innerText(), '空位自动加入');
  });
  await run('IMPORT-BASELINE', async () => {
    await open(); await page.getByRole('button', { name: '粘贴 / 导入学校报名表' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('textarea').fill('项目,参赛选择,运动员,性别\n男子个人赛,参加,导入甲,男');
    await api('PUT', `/api/athletes/${seededPeer}`, { note: '基线更新' + Date.now() });
    await dlg.getByRole('button', { name: '核对表格', exact: true }).click();
    await page.waitForTimeout(250);
    await dlg.getByRole('button', { name: '核对表格', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('dialog button,[role="dialog"] button')].some(b => b.textContent === '应用到报名表' && !b.disabled));
    await dlg.getByRole('button', { name: '应用到报名表', exact: true }).click();
    await tab('项目报名');
    assert.equal(await card(individual).locator('.school-registration-member strong').innerText(), '导入甲');
    await tab('人员名单');
    await page.getByRole('button', { name: '粘贴 / 导入学校报名表' }).click();
    await dlg.locator('textarea').fill('项目,参赛选择,运动员,性别\n男子个人赛,参加,导入乙,男');
    await dlg.getByRole('button', { name: '核对表格', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('dialog button,[role="dialog"] button')].some(b => b.textContent === '应用到报名表' && !b.disabled));
    await page.evaluate(() => {
      const input = document.querySelector('.school-registration-person input');
      input.value = '后台界面新输入'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await dlg.getByRole('button', { name: '应用到报名表', exact: true }).click();
    assert.match(await dlg.innerText(), /报名内容已变化/);
    assert.match(await dlg.locator('textarea').inputValue(), /导入乙/);
    assert.equal(await people().first().locator('input').first().inputValue(), '后台界面新输入');
    await context.close(); context = null;
    await open();
    let releaseResponse;
    const waiting = new Promise(resolve => { releaseResponse = resolve; });
    let requested;
    const started = new Promise(resolve => { requested = resolve; });
    await page.route('**/registration-import-preview', async r => {
      const response = await r.fetch(); requested(); await waiting; await r.fulfill({ response });
    });
    // A busy modal intentionally refuses Escape. Exercise its lifecycle close API
    // to represent the owner being disposed while a response is in flight.
    await page.evaluate(async school => {
      const { api } = await import('/js/api.js');
      const { submission } = await import('/js/schoolRegistrationModel.js');
      const { openSchoolImport } = await import('/js/schoolRegistrationImport.js');
      const formal = await api.get(`/api/schools/${school}/registration-workspace`);
      window.lateApplied = false;
      window.lateDialog = openSchoolImport({ path: `/api/schools/${school}`, getPayload: () => submission(formal, formal),
        onText: () => {}, onApply: () => { window.lateApplied = true; }, onConflict: () => {} });
    }, school);
    const lateDialog = page.getByRole('dialog');
    await lateDialog.locator('textarea').fill('项目,参赛选择,运动员,性别\n男子个人赛,参加,迟到人员,男');
    const checking = lateDialog.getByRole('button', { name: '核对表格', exact: true }).click();
    await started;
    await page.keyboard.press('Escape'); assert.equal(await lateDialog.isVisible(), true);
    await page.evaluate(() => window.lateDialog.close()); releaseResponse(); await checking;
    await page.waitForTimeout(100);
    await tab('人员名单');
    assert.equal(await page.evaluate(() => window.lateApplied), false);
    assert.equal(await people().evaluateAll(rows => rows.some(row => row.querySelector('input')?.value === '迟到人员')), false);
  });
  await run('PENDING-LIFECYCLE', async () => {
    await open(); await add('未知后成功'); await waitReview();
    const packets = [];
    await page.route('**/registration-commit', async route => {
      packets.push(route.request().postDataJSON());
      if (packets.length === 1) { await route.fetch(); await route.abort('failed'); }
      else if (packets.length === 2) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '重试被拒绝', outcome: 'not_committed' }) });
      else await route.continue();
    });
    await preview().click();
    await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '核实并重试原提交');
    await preview().click();
    await page.waitForFunction(() => document.querySelector('.form-errors')?.textContent.includes('重试被拒绝'));
    assert.equal(await preview().innerText(), '核实并重试原提交');
    await preview().click();
    await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '预览整批变更');
    assert.deepEqual(packets[0], packets[1]);
    assert.deepEqual(packets[0], packets[2]);
    const saved = await api('GET', `/api/schools/${school}/registration-workspace`);
    assert.equal(saved.people.filter(p => p.name === '未知后成功').length, 1);
    await page.unroute('**/registration-commit');
    await add('第二笔拒绝'); await waitReview();
    await page.route('**/registration-commit', r => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '明确拒绝', outcome: 'not_committed' }) }));
    await preview().click();
    await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '预览整批变更');
    await tab('人员名单'); assert.equal(await people().last().locator('input').first().isEnabled(), true);
    await open(); await add('存储拒绝'); await waitReview();
    let commitPosts = 0;
    page.on('request', r => { if (r.url().endsWith('/registration-commit')) commitPosts++; });
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage denied'); }; });
    await preview().click();
    assert.match(await page.locator('.form-errors').innerText(), /原提交未能保存/);
    assert.equal(commitPosts, 0);
  });
  await run('POSTSAVE', async () => {
    await open(); await add('保存落点'); await waitReview(); await preview().click();
    await page.waitForFunction(() => document.querySelector('[data-action="school-preview"]')?.textContent === '预览整批变更');
    assert.equal(await page.getByRole('tab', { name: '项目报名', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await preview().isDisabled(), true);
    await add('读取失败仍已保存'); await waitReview();
    let posts = 0;
    page.on('request', r => { if (r.url().endsWith('/registration-commit')) posts++; });
    await page.route('**/registration-workspace', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '读取暂不可用' }) }));
    await preview().click();
    await page.getByRole('button', { name: '读取最新正式名单' }).waitFor();
    assert.match(await page.locator('.form-errors').innerText(), /报名已保存/);
    assert.equal(await preview().isDisabled(), true);
    await page.unroute('**/registration-workspace');
    await page.getByRole('button', { name: '读取最新正式名单' }).click();
    await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === '项目报名');
    assert.equal(posts, 1);
  });
  await run('CACHE-UPDATE', async () => {
    await context.close();
    context = await browser.newContext(); page = await context.newPage();
    await page.goto(base + '/favicon.svg');
    await page.evaluate(async () => {
      const old = await caches.open('stss-shell-v79'); await old.put('/old-marker', new Response('old'));
      await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(async () => !(await caches.keys()).includes('stss-shell-v79'));
    assert.equal(await page.evaluate(async () => !!await (await caches.open('stss-shell-v80')).match('/js/registrationId.js')), true);
    await context.setOffline(true);
    await page.goto(base + '/');
    assert.match(await page.evaluate(async () => (await import('/js/registrationId.js')).registrationId()), /^[a-f0-9-]{36}$/);
  });
  console.log(JSON.stringify({ failures, passed: checks, mode: process.env.STSS_BOUNDARIES_REPRO === '1' ? 'REPRODUCTION' : 'REGRESSION' }, null, 2));
  if (failures.length && process.env.STSS_BOUNDARIES_REPRO !== '1') process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error); console.error(serverErrors.slice(-3000)); process.exitCode = 1;
} finally {
  if (browser) await browser.close(); child.kill();
}


