/* 已批准设置改造的真实隔离服务测试；不会连接正在使用的赛事数据库。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataRoot = process.env.STSS_SETUP_DATA_ROOT || path.resolve(root, '../tmp/setup-usability-20261013/test-data');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.resolve(root, '../tmp/setup-usability-20261013/artifacts');
await mkdir(dataRoot, { recursive: true }); await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(path.join(dataRoot, 'setup-'));
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db, security
from app.http_server import Handler, load_routes, create_server
db.init_db()
conn = db.connect()
security.ensure_default_users(conn)
conn.close()
load_routes()
class QuietHandler(Handler):
    def log_message(self, *args): pass
server = create_server(('127.0.0.1', 0), QuietHandler)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'SetupTest123', PYTHONUTF8: '1' },
});
let browser, page, stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const cases = process.env.STSS_SETUP_CASES || 'integration';
const checks = [];
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Server startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exit ${code}: ${stderr}`)); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token, identity;
  const api = async (method, url, body, scope = identity) => {
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(scope ? { 'X-Event-ID': String(scope.event_id), 'X-Event-UUID': scope.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'SetupTest123' })).token;
  identity = await api('POST', '/api/events', { name: '设置易用性实际回归' });
  const groups = [];
  const combinations = [['team', 'male', '男子三人赛'], ['team', 'female', '女子三人赛'], ['individual', 'male', '男子个人赛'], ['individual', 'female', '女子个人赛']];
  for (const [index, name] of ['甲组', '乙组'].entries()) {
    const id = (await api('POST', `/api/events/${identity.event_id}/groups`, { name, code: name[0], seq: index + 1 })).group_id;
    const categories = [];
    for (const [kind, gender, categoryName] of combinations.filter((_c, j) => index === 0 || [0, 2].includes(j))) {
      const categoryId = (await api('POST', `/api/groups/${id}/categories`, { name: categoryName, kind, gender })).category_id;
      categories.push({ id: categoryId, kind, gender, name: categoryName, group_id: id });
    }
    groups.push({ id, name, categories });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('dialog', dialog => dialog.accept());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let navigationNumber = 0;
  const route = async suffix => {
    if (!suffix.includes('event=')) suffix += `${suffix.includes('?') ? '&' : '?'}event=${identity.event_id}`;
    // Load the requested document completely; a hash-only goto can return before
    // the queued SPA render starts, while networkidle still describes the old page.
    await page.goto(`${base}/?setup_check=${++navigationNumber}#/${suffix}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  };
  const screenshot = async name => {
    await page.waitForFunction(() => {
      const toast = document.querySelector('#toast');
      return !toast || (!toast.classList.contains('show') && Number(getComputedStyle(toast).opacity) < 0.01);
    });
    await page.evaluate(() => { window.scrollTo(0, 0); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: path.join(artifacts, name), fullPage: true });
  };
  await route('setup');
  for (const url of ['/js/setupModel.js', '/js/views/setup.js', '/css/app.css', '/sw.js']) {
    assert.equal((await fetch(base + url)).status, 200, `${url} served by real server`);
  }
  checks.push('real service login and setup assets load');
  const eventPanel = page.locator('#setup-event');
  assert.equal(await eventPanel.getByLabel('赛事名称', { exact: true }).count(), 1);
  assert.equal(await eventPanel.getByLabel('赛事名称', { exact: true }).isVisible(), false, 'saved event starts with a summary');
  assert.match(await page.locator('#setup-status-structure').textContent(), /2 个组别 · 6 个项目/);
  assert.match(await page.locator('#setup-status-venues').textContent(), /可后补/);
  assert.doesNotMatch(await page.locator('.setup-page').innerText(), /可开赛|100%/);
  for (const id of ['setup-event', 'setup-structure', 'setup-venues', 'setup-rules']) assert.equal(await page.locator(`#${id}`).isVisible(), true);
  await eventPanel.getByRole('button', { name: '修改资料', exact: true }).click();
  const eventName = eventPanel.getByLabel('赛事名称', { exact: true });
  await eventName.fill('尚未保存的赛事资料');
  const requests = [];
  const watcher = request => { if (request.url().startsWith(`${base}/api/`)) requests.push(request.url()); };
  page.on('request', watcher); const beforeUrl = page.url();
  for (const [label, id] of [['组别与项目', 'setup-structure'], ['比赛场地', 'setup-venues'], ['三人赛规则', 'setup-rules'], ['赛事资料', 'setup-event']]) {
    const beforeSection = page.url();
    await page.getByRole('navigation', { name: '赛事设置导航', exact: true }).getByRole('button', { name: label, exact: true }).click();
    if (label !== '三人赛规则') assert.equal(page.url(), beforeSection);
    assert.equal(await page.evaluate(id => document.activeElement.tagName === 'H3' && !!document.activeElement.closest(`#${id}`), id), true);
    assert.equal(await eventName.inputValue(), '尚未保存的赛事资料');
  }
  page.off('request', watcher); assert.deepEqual(requests, [], 'section navigation does not access API');
  checks.push('saved-only summaries, optional fields and same-page navigation preserve input');
  await eventName.fill('赛事资料实际已保存');
  await eventPanel.getByRole('button', { name: '保存赛事资料', exact: true }).click();
  await eventPanel.locator('.setup-save-feedback').filter({ hasText: '赛事资料已保存' }).waitFor();
  assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).event.name, '赛事资料实际已保存');
  assert.equal(await eventName.isVisible(), false);
  assert.match(await page.locator('#event-line').textContent(), /赛事资料实际已保存/);
  checks.push('event save updates actual database and shell, then returns to summary');
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await screenshot(`setup-${cases}-${width}.png`);
  }
  if (['projects', 'integration'].includes(cases)) {
    await page.setViewportSize({ width: 1365, height: 950 });
    const rows = () => page.locator('.setup-entity-row');
    assert.equal(await rows().count(), 4);
    assert.equal(await rows().first().getByLabel('项目名称', { exact: true }).count(), 1);
    assert.equal(await rows().first().getByLabel('项目名称', { exact: true }).isVisible(), false);
    assert.match(await rows().nth(0).innerText(), /0 队已报名/);
    assert.match(await rows().nth(2).innerText(), /0 人已报名/);
    const firstRow = rows().nth(0), secondRow = rows().nth(1);
    await firstRow.getByRole('button', { name: '修改名称', exact: true }).click();
    await secondRow.getByRole('button', { name: '修改名称', exact: true }).click();
    await firstRow.getByLabel('项目名称', { exact: true }).fill('已保存的自定义三人赛');
    await secondRow.getByLabel('项目名称', { exact: true }).fill('另一项目尚未保存');
    await firstRow.getByRole('button', { name: '保存名称', exact: true }).click();
    await firstRow.locator('.setup-save-feedback').filter({ hasText: '项目名称已保存' }).waitFor();
    assert.equal(await firstRow.locator('.setup-project-name').textContent(), '已保存的自定义三人赛');
    assert.equal(await firstRow.getByLabel('项目名称', { exact: true }).isVisible(), false);
    assert.equal(await secondRow.getByLabel('项目名称', { exact: true }).inputValue(), '另一项目尚未保存');
    const afterRename = await api('GET', `/api/events/${identity.event_id}/structure`);
    assert.equal(afterRename.groups[0].categories[0].name, '已保存的自定义三人赛');
    assert.equal(afterRename.groups[0].categories[1].name, '女子三人赛');
    await secondRow.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '取消修改项目名称', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
    assert.equal(await secondRow.getByLabel('项目名称', { exact: true }).inputValue(), '女子三人赛');
    assert.equal(await secondRow.getByLabel('项目名称', { exact: true }).isVisible(), false);
    await firstRow.getByRole('button', { name: '进入项目工作台', exact: true }).click();
    await page.waitForURL(new RegExp(`group=${groups[0].id}.*category=${groups[0].categories[0].id}`));
    await route('setup');
    checks.push('project summaries, team/person units, independent save/cancel and workspace identity');

    await page.locator('.setup-group-choice').filter({ hasText: '乙组' }).click();
    const projectPanel = page.locator('.setup-category-list');
    await projectPanel.getByRole('button', { name: '添加项目', exact: true }).click();
    const form = projectPanel.locator('.setup-add-form');
    assert.equal(await form.getByRole('radio', { name: '男子三人赛', exact: true }).isDisabled(), true);
    const writes = [];
    const watchWrites = request => { if (request.method() !== 'GET' && request.url().startsWith(base + '/api/')) writes.push(request.url()); };
    page.on('request', watchWrites);
    await form.getByRole('radio', { name: '女子三人赛', exact: true }).check();
    assert.equal(await form.getByLabel('项目名称', { exact: true }).inputValue(), '女子三人赛');
    await form.getByRole('radio', { name: '女子个人赛', exact: true }).check();
    assert.equal(await form.getByLabel('项目名称', { exact: true }).inputValue(), '女子个人赛');
    await form.getByLabel('项目名称', { exact: true }).fill('用户自定义女子项目');
    await form.getByRole('radio', { name: '女子三人赛', exact: true }).check();
    assert.equal(await form.getByLabel('项目名称', { exact: true }).inputValue(), '用户自定义女子项目');
    assert.deepEqual(writes, [], 'selection and preview do not write');
    const added = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/groups/${groups[1].id}/categories`));
    await form.getByRole('button', { name: '确认添加项目', exact: true }).click();
    assert.equal((await added).ok(), true);
    await rows().filter({ hasText: '用户自定义女子项目' }).waitFor();
    assert.equal(writes.length, 1);
    page.off('request', watchWrites);
    const beta = (await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(g => g.id === groups[1].id);
    const created = beta.categories.find(c => c.gender === 'female' && c.kind === 'team');
    assert.equal(created.name, '用户自定义女子项目');
    await projectPanel.getByRole('button', { name: '添加项目', exact: true }).click();
    assert.equal(await form.getByRole('radio', { name: '女子三人赛', exact: true }).isDisabled(), true);
    assert.match(await form.innerText(), /已添加/);
    await form.getByRole('radio', { name: '女子个人赛', exact: true }).check();
    await eventPanel.getByRole('button', { name: '修改资料', exact: true }).click();
    await eventName.fill('其他区域未保存的赛事名称');
    const venueName = page.locator('#setup-venues').getByLabel('场地名称', { exact: true });
    if (!await venueName.isVisible()) await page.locator('#setup-venues').getByRole('button', { name: '添加场地', exact: true }).click();
    await venueName.fill('其他区域未添加的场地');
    await page.locator('.setup-group-choice').filter({ hasText: '甲组' }).click();
    await page.getByRole('dialog', { name: '切换组别', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await form.getByLabel('项目名称', { exact: true }).inputValue(), '女子个人赛');
    await page.locator('.setup-group-list').getByRole('button', { name: '添加组别', exact: true }).click();
    const groupForm = page.locator('.setup-group-list .setup-add-form');
    await groupForm.getByLabel('组别名称', { exact: true }).fill('丙组');
    await groupForm.getByLabel('组别标识', { exact: true }).fill('丙');
    await groupForm.getByRole('button', { name: '保存新组别', exact: true }).click();
    await page.locator('.setup-group-choice').filter({ hasText: '丙组' }).waitFor();
    assert.match(await page.locator('.setup-group-choice[aria-current="true"]').innerText(), /乙组/);
    assert.equal(await form.getByLabel('项目名称', { exact: true }).inputValue(), '女子个人赛');
    assert.equal(await eventName.inputValue(), '其他区域未保存的赛事名称');
    await page.locator('.setup-group-choice').filter({ hasText: '甲组' }).click();
    await page.getByRole('dialog', { name: '切换组别', exact: true }).getByRole('button', { name: '放弃并切换', exact: true }).click();
    assert.equal(await venueName.inputValue(), '其他区域未添加的场地');
    assert.equal(await eventName.inputValue(), '其他区域未保存的赛事名称');
    checks.push('actual preset creation, automatic/custom names, duplicates and cross-area/new-group input preservation');
  }
  if (cases === 'integration') {
    const venuePanel = page.locator('#setup-venues');
    const venueInput = venuePanel.getByLabel('场地名称', { exact: true });
    const openVenue = async () => { if (!await venueInput.isVisible()) await venuePanel.getByRole('button', { name: '添加场地', exact: true }).click(); };
    const row = id => page.locator(`.setup-entity-row[data-category-id="${id}"]`);
    const editRow = async id => { if (!await row(id).getByLabel('项目名称', { exact: true }).isVisible()) await row(id).getByRole('button', { name: '修改名称', exact: true }).click(); };
    const structureUrl = `${base}/api/events/${identity.event_id}/structure`;
    const personalId = groups[0].categories.find(c => c.kind === 'individual' && c.gender === 'male').id;
    const personalUrl = `${base}/api/categories/${personalId}`;
    await editRow(personalId);
    await row(personalId).getByLabel('项目名称', { exact: true }).fill('拒绝后仍保留的名称');
    await page.route(personalUrl, handler => handler.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: '测试拒绝保存', outcome: 'not_committed' }) }));
    await row(personalId).getByRole('button', { name: '保存名称', exact: true }).click();
    await row(personalId).locator('.setup-save-feedback[role="alert"]').filter({ hasText: '测试拒绝保存' }).waitFor();
    assert.equal(await row(personalId).getByLabel('项目名称', { exact: true }).inputValue(), '拒绝后仍保留的名称');
    assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(g => g.id === groups[0].id).categories.find(c => c.id === personalId).name, '男子个人赛');
    await page.unroute(personalUrl);
    checks.push('rejected write preserves input and does not alter actual data');

    await openVenue(); await venueInput.fill('体育馆 1 号场');
    const venueWrites = [];
    const watchVenueWrites = request => { if (request.method() === 'POST' && request.url().endsWith(`/events/${identity.event_id}/venues`)) venueWrites.push(request); };
    page.on('request', watchVenueWrites);
    await page.route(structureUrl, handler => handler.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试列表刷新失败' }) }));
    await venuePanel.getByRole('button', { name: '确认添加场地', exact: true }).click();
    await venuePanel.locator('.setup-save-feedback[role="alert"]').filter({ hasText: '已保存，列表待同步' }).waitFor();
    assert.equal(await venueInput.inputValue(), '体育馆 1 号场');
    assert.equal(await venuePanel.getByRole('button', { name: '确认添加场地', exact: true }).isDisabled(), true);
    assert.equal((await api('GET', `/api/events/${identity.event_id}/venues`)).venues.length, 1, 'POST committed despite GET failure');
    assert.equal(venueWrites.length, 1);
    await page.unroute(structureUrl);
    await page.route(structureUrl, handler => handler.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: '模拟不完整结构' }) }));
    await venuePanel.getByRole('button', { name: '重新读取状态', exact: true }).click();
    await venuePanel.locator('.setup-save-feedback').filter({ hasText: '赛事设置读取不完整' }).waitFor();
    assert.equal(await venueInput.inputValue(), '体育馆 1 号场');
    assert.equal(venueWrites.length, 1);
    await page.unroute(structureUrl);
    await venuePanel.getByRole('button', { name: '重新读取状态', exact: true }).click();
    await venuePanel.locator('.setup-venue-items').getByText('体育馆 1 号场', { exact: true }).waitFor();
    assert.equal(venueWrites.length, 1, 'recovery only reads and never reposts a committed venue');
    assert.equal(await eventName.inputValue(), '其他区域未保存的赛事名称');
    assert.equal(await row(personalId).getByLabel('项目名称', { exact: true }).inputValue(), '拒绝后仍保留的名称');
    page.off('request', watchVenueWrites);
    checks.push('committed write with failed refresh is explicitly marked and recovery never repeats POST');

    const personalWrites = [];
    const watchPersonalWrites = request => { if (request.method() === 'PUT' && request.url() === personalUrl) personalWrites.push(request); };
    page.on('request', watchPersonalWrites);
    await row(personalId).getByLabel('项目名称', { exact: true }).fill('已写入但响应丢失的名称');
    await page.route(personalUrl, async handler => { await handler.fetch(); await handler.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: '测试成功响应中断' }) }); });
    await row(personalId).getByRole('button', { name: '保存名称', exact: true }).click();
    await row(personalId).locator('.setup-save-feedback').filter({ hasText: '保存结果尚未确认' }).waitFor();
    await page.unroute(personalUrl);
    await row(personalId).getByLabel('项目名称', { exact: true }).fill('读回期间继续输入的名称');
    await row(personalId).getByRole('button', { name: '重新读取状态', exact: true }).click();
    await row(personalId).locator('.setup-save-feedback').filter({ hasText: '项目名称已保存' }).waitFor();
    assert.equal(await row(personalId).getByLabel('项目名称', { exact: true }).inputValue(), '读回期间继续输入的名称');
    assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(g => g.id === groups[0].id).categories.find(c => c.id === personalId).name, '已写入但响应丢失的名称');
    assert.equal(personalWrites.length, 1, 'lost receipt is reconciled by reading, not by another PUT');
    page.off('request', watchPersonalWrites);
    await row(personalId).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '取消修改项目名称', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
    checks.push('unknown committed result reconciles, preserving newer typing without replaying PUT');

    await page.locator('.setup-group-choice').filter({ hasText: '乙组' }).click();
    const betaPanel = page.locator('.setup-category-list'), betaForm = betaPanel.locator('.setup-add-form');
    await betaPanel.getByRole('button', { name: '添加项目', exact: true }).click();
    await betaForm.getByRole('radio', { name: '女子个人赛', exact: true }).check();
    await betaForm.getByLabel('项目名称', { exact: true }).fill('网络失败仍保留的名称');
    const categoryUrl = `${base}/api/groups/${groups[1].id}/categories`, categoryWrites = [];
    const watchCategoryWrites = request => { if (request.method() === 'POST' && request.url() === categoryUrl) categoryWrites.push(request); };
    page.on('request', watchCategoryWrites);
    await page.route(categoryUrl, handler => handler.abort('failed'));
    await betaForm.getByRole('button', { name: '确认添加项目', exact: true }).click();
    await betaForm.locator('.setup-save-feedback').filter({ hasText: '保存结果尚未确认' }).waitFor();
    assert.equal(await betaForm.getByLabel('项目名称', { exact: true }).inputValue(), '网络失败仍保留的名称');
    await page.unroute(categoryUrl);
    await betaForm.getByRole('button', { name: '重新读取状态', exact: true }).click();
    await betaForm.locator('.setup-save-feedback').filter({ hasText: '未找到本次提交结果' }).waitFor();
    assert.equal(categoryWrites.length, 1, 'checking unknown result has not replayed POST');
    assert.equal(await betaForm.getByRole('button', { name: '确认添加项目', exact: true }).isEnabled(), true);
    await betaForm.getByRole('button', { name: '确认添加项目', exact: true }).click();
    const betaPersonal = () => page.locator('.setup-entity-row').filter({ hasText: '网络失败仍保留的名称' });
    await betaPersonal().waitFor();
    assert.equal(categoryWrites.length, 2);
    page.off('request', watchCategoryWrites);
    checks.push('uncommitted network failure retains input and explicit retry is allowed only after reconciliation');

    await openVenue(); await venueInput.fill('体育馆 2 号场');
    await venuePanel.getByRole('button', { name: '确认添加场地', exact: true }).click();
    await venuePanel.locator('.setup-venue-items').getByText('体育馆 2 号场', { exact: true }).waitFor();
    let venues = (await api('GET', `/api/events/${identity.event_id}/venues`)).venues;
    assert.deepEqual(venues.map(v => v.seq), [1, 2]);
    await openVenue(); await venueInput.fill('优先比赛场');
    await venuePanel.locator('summary').filter({ hasText: '手动设置顺序' }).click();
    await venuePanel.getByLabel('顺序', { exact: true }).fill('0');
    await venuePanel.getByRole('button', { name: '确认添加场地', exact: true }).click();
    await venuePanel.locator('.setup-venue-items').getByText('优先比赛场', { exact: true }).waitFor();
    venues = (await api('GET', `/api/events/${identity.event_id}/venues`)).venues;
    assert.equal(venues[0].name, '优先比赛场');
    await openVenue(); await venueInput.fill('体育馆 1 号场');
    await venuePanel.getByRole('button', { name: '确认添加场地', exact: true }).click();
    await venuePanel.getByText('已有同名场地，请填写其他名称', { exact: true }).waitFor();
    assert.equal(venues.length, (await api('GET', `/api/events/${identity.event_id}/venues`)).venues.length);
    checks.push('venue default last order, explicit zero order and readable duplicate validation');

    const teamId = groups[0].categories.find(c => c.kind === 'team' && c.gender === 'male').id;
    const schoolId = (await api('POST', `/api/events/${identity.event_id}/schools`, { name: '独立测试学校', group_id: groups[0].id })).school_id;
    await api('POST', `/api/categories/${teamId}/enrollments`, { school_id: schoolId, captain_index: 0,
      members: [1, 2, 3].map(n => ({ name: `匿名测试队员${n}`, gender: 'male', jersey_no: String(n) })) });
    await route(`setup?group=${groups[0].id}`);
    assert.match(await row(teamId).innerText(), /1 队已报名/);
    await editRow(teamId);
    const denied = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/categories/${teamId}`));
    await row(teamId).getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('dialog', { name: '删除项目', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
    assert.equal((await denied).status(), 409);
    await row(teamId).locator('.setup-save-feedback[role="alert"]').waitFor();
    assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(g => g.id === groups[0].id).categories.some(c => c.id === teamId), true);
    await row(teamId).getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.setup-group-choice').filter({ hasText: '乙组' }).click();
    const disposable = (await api('GET', `/api/events/${identity.event_id}/structure`)).groups.find(g => g.id === groups[1].id).categories.find(c => c.gender === 'female' && c.kind === 'individual');
    await editRow(disposable.id);
    await row(disposable.id).getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('dialog', { name: '删除项目', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await row(disposable.id).count(), 1, 'canceling confirmation retains project');
    await row(disposable.id).getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('dialog', { name: '删除项目', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
    await row(disposable.id).waitFor({ state: 'detached' });
    checks.push('actual enrollment count, destructive confirmation and backend deletion restrictions');

    const other = await api('POST', '/api/events', { name: '切换后的对照赛事' });
    await route(`setup?group=${groups[0].id}`);
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.locator(`#event-select option[value="${other.event_id}"]`).waitFor({ state: 'attached' });
    await page.locator('.setup-group-list').getByRole('button', { name: '添加组别', exact: true }).click();
    const delayedForm = page.locator('.setup-group-list .setup-add-form');
    await delayedForm.getByLabel('组别名称', { exact: true }).fill('延迟写入的丁组');
    await delayedForm.getByLabel('组别标识', { exact: true }).fill('丁');
    const groupUrl = `${base}/api/events/${identity.event_id}/groups`;
    let releaseResponse, requestArrived;
    const arrived = new Promise(resolve => { requestArrived = resolve; });
    const release = new Promise(resolve => { releaseResponse = resolve; });
    await page.route(groupUrl, async handler => { const response = await handler.fetch(); requestArrived(); await release; await handler.fulfill({ response }); });
    await delayedForm.getByRole('button', { name: '保存新组别', exact: true }).click(); await arrived;
    // 保存进行中：整页聚合离开保护阻止切换赛事，顶栏恢复为当前赛事。
    await page.locator('#event-select').selectOption(String(other.event_id));
    await page.getByText('请先完成保存或核对保存结果', { exact: true }).waitFor();
    assert.equal(await page.locator('#event-select').inputValue(), String(identity.event_id));
    assert.ok(page.url().includes(`event=${identity.event_id}`));
    releaseResponse();
    await page.getByRole('status').filter({ hasText: /组别已添加/ }).waitFor();
    await page.locator('#event-select').selectOption(String(other.event_id));
    await page.waitForFunction(() => document.querySelector('#event-line')?.textContent === '切换后的对照赛事'
      && !document.querySelector('.content .spinner'));
    assert.equal(await page.locator('#event-line').textContent(), '切换后的对照赛事');
    assert.equal((await api('GET', `/api/events/${other.event_id}/structure`, undefined, other)).groups.length, 0);
    await page.unroute(groupUrl);
    checks.push('saving blocks event switch; late save response cannot replace another event or its route');

    await page.locator('.sidenav a[data-view="setup"]').click();
    await page.locator('#setup-status-structure').filter({ hasText: '先添加组别，再开设项目' }).waitFor();
    assert.equal(await page.locator('.setup-entity-row').count(), 0);
    assert.match(await page.locator('#setup-status-venues').textContent(), /可后补/);
    for (const width of [1365, 390]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await screenshot(`setup-empty-${width}.png`);
    }
    checks.push('empty event gives group-first guidance with optional venues');

    await page.locator('#event-select').selectOption(String(identity.event_id));
    await page.waitForFunction(id => document.querySelector('#event-select')?.value === String(id)
      && !document.querySelector('.content .spinner'), identity.event_id);

    for (const [step, section] of [['groups', 'structure'], ['categories', 'structure'], ['event', 'event'], ['venues', 'venues'], ['rules', 'rules']]) {
      await route(`setup?step=${step}&group=${groups[0].id}`);
      await page.waitForFunction(id => document.activeElement.tagName === 'H3'
        && !!document.activeElement.closest(`#setup-${id}`), section);
      assert.equal(await page.evaluate(id => document.activeElement.tagName === 'H3' && !!document.activeElement.closest(`#setup-${id}`), section), true, `${step} legacy link focuses ${section}`);
    }
    await route('setup?group=999999');
    assert.equal(await page.locator('.setup-group-choice[aria-current="true"]').count(), 1);
    checks.push('old links locate sections and invalid group links recover to existing structure');

    const literalName = '<img src=x onerror=alert(1)> 字面名称';
    await api('PUT', `/api/categories/${personalId}`, { name: literalName });
    await route(`setup?group=${groups[0].id}`);
    assert.equal(await row(personalId).locator('.setup-project-name').textContent(), literalName);
    assert.equal(await row(personalId).locator('img').count(), 0);
    const assertBounds = async label => {
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('.setup-page *')].filter(el => {
          if (!el.getClientRects().length) return false;
          const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < -1 || b.right > innerWidth + 1);
        }).map(el => el.className).slice(0, 8) }));
      assert.ok(geometry.scroll <= geometry.width + 1, `${label}: ${JSON.stringify(geometry)}`);
      assert.deepEqual(geometry.outside, [], label);
    };
    for (const width of [320, 390, 768, 1365, 2539]) {
      await page.setViewportSize({ width, height: 950 }); await assertBounds(`summary ${width}`);
      const sections = await Promise.all(['event', 'structure', 'venues', 'rules'].map(s => page.locator(`#setup-${s}`).boundingBox()));
      assert.ok(sections[1].y >= sections[0].y + sections[0].height - 1 && sections[2].y >= sections[1].y + sections[1].height - 1
        && sections[3].y >= sections[2].y + sections[2].height - 1, 'visual sequence matches DOM order');
      await screenshot(`setup-summary-${width}.png`);
    }
    await page.setViewportSize({ width: 390, height: 950 });
    await page.locator('.setup-group-choice').filter({ hasText: '丙组' }).click();
    await page.locator('.setup-category-list').getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('radio', { name: '男子三人赛', exact: true }).focus();
    await page.getByRole('radio', { name: '男子三人赛', exact: true }).press('Space');
    const narrowForm = page.locator('.setup-category-list .setup-add-form');
    assert.equal(await narrowForm.getByLabel('项目名称', { exact: true }).inputValue(), '男子三人赛');
    await narrowForm.getByLabel('项目名称', { exact: true }).fill('键盘添加的项目');
    await narrowForm.getByRole('button', { name: '确认添加项目', exact: true }).focus();
    await narrowForm.getByRole('button', { name: '确认添加项目', exact: true }).press('Enter');
    await page.locator('.setup-project-name').filter({ hasText: '键盘添加的项目' }).waitFor();
    await page.locator('.setup-category-list').getByRole('button', { name: '添加项目', exact: true }).click();
    for (const width of [320, 390, 768, 1365, 2539]) {
      await page.setViewportSize({ width, height: 950 }); await assertBounds(`expanded ${width}`); await screenshot(`setup-expanded-${width}.png`);
    }
    checks.push('safe literal-name rendering, five-width default/expanded layouts and native keyboard creation');

    await route('setup?action=new');
    assert.equal(await page.locator('.wizard-steps li').count(), 5);
    const eventCount = (await api('GET', '/api/events')).events.length;
    await page.getByLabel('赛事名称').fill('未确认的向导测试');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByRole('heading', { name: '第 2 步 · 组别', exact: true }).waitFor();
    assert.equal((await api('GET', '/api/events')).events.length, eventCount);
    checks.push('wizard terminology consistent and no event is created before final confirmation');

    for (const role of ['organizer', 'recorder', 'viewer']) {
      const username = `setup-readonly-${role}`;
      await api('POST', '/api/users', { username, display_name: '只读设置回归', password: 'ReadonlySetup123', role, event_ids: [identity.event_id] });
      const readonlyToken = (await api('POST', '/api/login', { username, password: 'ReadonlySetup123' })).token;
      const readonlyContext = await browser.newContext({ viewport: { width: 390, height: 950 }, locale: 'zh-CN' });
      await readonlyContext.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token: readonlyToken, event: identity.event_id });
      const readonly = await readonlyContext.newPage(); readonly.on('pageerror', error => errors.push(error.message));
      readonly.setDefaultTimeout(10000);
      await readonly.goto(`${base}/#/setup`);
      // The existing permission baseline lets all three roles inspect settings.
      await readonly.getByText('赛事结构由管理员维护。', { exact: true }).waitFor();
      assert.equal(await readonly.locator('.setup-page input,.setup-page select,.setup-page textarea').count(), 0);
      assert.equal(await readonly.locator('.setup-page').getByRole('button', { name: /修改|保存|添加|删除|新建/ }).count(), 0);
      assert.equal(await readonly.locator('.sidenav a[data-view="setup"]').count(), 1);
      const forbidden = await fetch(`${base}/api/events/${identity.event_id}`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', Authorization: `Bearer ${readonlyToken}`,
          'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid },
        body: JSON.stringify({ name: '应被权限阻止的名称' }) });
      assert.equal(forbidden.status, 403, `${role} cannot write event settings through the API`);
      await readonly.screenshot({ path: path.join(artifacts, `setup-readonly-${role}.png`), fullPage: true }); await readonlyContext.close();
    }
    assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).event.name, '赛事资料实际已保存');
    checks.push('organizer/recorder/viewer retain existing read-only settings access; all three APIs deny writes');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `setup-${cases}-report.json`), JSON.stringify({ status: 'PASS', cases, checks, dataDir, browser: await browser.version() }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', cases, checks }));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(artifacts, `setup-${cases}-failure.png`), fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  if (browser) await browser.close(); child.kill();
}
