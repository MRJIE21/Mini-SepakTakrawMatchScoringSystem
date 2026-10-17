/* Real isolated HTTP/SQLite and browser verification for configurable competition rules. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'team-rules-browser-'));
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
  STSS_ADMIN_PASSWORD: 'TeamRulesTest123', PYTHONUTF8: '1' } });
let browser, page, serverErrors = '';
const checks = [], errors = [];
child.stderr.on('data', chunk => { serverErrors += chunk; });
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Isolated startup timeout')), 10000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server ${code}: ${serverErrors}`)); });
    let output = ''; child.stdout.on('data', chunk => {
      output += chunk; try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity;
  const api = async (method, url, body, expected = 200, alternateToken = token) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(alternateToken ? { Authorization: `Bearer ${alternateToken}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'TeamRulesTest123' })).token;
  for (const resource of ['/js/teamRules.js', '/js/teamRulesEditor.js', '/js/scoring.js', '/sw.js', '/css/app.css']) {
    const response = await fetch(base + resource); assert.equal(response.status, 200); assert.ok((await response.text()).length > 100);
  }
  const sw = await (await fetch(base + '/sw.js')).text(); assert.ok(sw.includes("'/js/teamRules.js'"));
  pass('真实HTTP启动与新版规则/编辑器/缓存资源');
  if (process.env.STSS_TEAM_RULES_SUITE !== 'startup') {
    browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
    const emptyContext = await browser.newContext();
    await emptyContext.addInitScript(token => localStorage.setItem('stss_token', token), token);
    const emptyPage = await emptyContext.newPage();
    await emptyPage.goto(`${base}/#/teamRules`);
    await emptyPage.getByText('还没有赛事。请先创建赛事，再配置组别与项目。', { exact: true }).waitFor();
    await emptyPage.getByRole('heading', { name: '创建首个赛事', exact: true }).waitFor();
    assert.equal(await emptyPage.locator('#setup-rules').count(), 0);
    await emptyContext.close(); pass('无赛事时旧链接给出明确创建赛事提示');
    identity = await api('POST', '/api/events', { name: '三人赛规则测试赛事' });
    identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
    const group = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '甲组', code: '甲' })).group_id;
    const team = (await api('POST', `/api/groups/${group}/categories`, { name: '男子三人赛', gender: 'male', kind: 'team' })).category_id;
    const personal = (await api('POST', `/api/groups/${group}/categories`, { name: '男子个人赛', gender: 'male', kind: 'individual' })).category_id;
    const peerTeam = (await api('POST', `/api/groups/${group}/categories`, { name: '女子三人赛', gender: 'female', kind: 'team' })).category_id;
    const parts = [];
    for (let i = 0; i < 2; i++) {
      const school = (await api('POST', `/api/events/${identity.event_id}/schools`, { name: `测试学校${i + 1}`, group_id: group })).school_id;
      const enrolled = await api('POST', `/api/categories/${team}/enrollments`, { school_id: school, captain_index: 0,
        members: [1, 2, 3].map(j => ({ name: `队员${i + 1}-${j}`, gender: 'male', jersey_no: String(j) })) });
      const participation = (await api('GET', `/api/categories/${team}/participations`)).participations.find(p => p.team_id === enrolled.team_id);
      parts.push(participation.id);
    }
    const makeMatch = async () => (await api('POST', '/api/matches', { category_id: team, home_participation: parts[0], away_participation: parts[1] })).match_id;
    const pathRules = `/api/events/${identity.event_id}/team-rules`;
    const firstMatch = await makeMatch();
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN' });
    await context.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token, event: identity.event_id });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/#/setup?event=${identity.event_id}&group=${group}`);
    await page.locator('article[data-category-id]').first().waitFor();
    const navigation = page.locator('#sidenav a');
    const labels = await navigation.allTextContents();
    assert.equal(labels.includes('三人赛规则设置'), false);
    assert.equal(await page.locator('.setup-page-nav .setup-nav-choice').count(), 4);
    assert.equal(await page.locator('.team-rules').count(), 1, '规则作为设置第 4 分区同页呈现');
    const setupNavigation = page.getByRole('navigation', { name: '赛事设置导航', exact: true });
    await setupNavigation.getByRole('button', { name: '三人赛规则', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.tagName === 'H3'
      && !!document.activeElement.closest('#setup-rules')), true);
    assert.ok(new URL(page.url()).hash.includes('step=rules'));
    assert.equal(await page.locator('#sidenav a.active').textContent(), '赛事设置');
    const editor = () => page.locator(`section.team-rules[data-event-id="${identity.event_id}"]`);
    await editor().waitFor();
    assert.equal(await page.locator(`.setup-rules-panel article[data-category-id="${personal}"]`).count(), 0);
    assert.equal(await page.locator(`article[data-category-id="${personal}"] .team-rules`).count(), 0);
    const open = async () => { const detail = editor().locator('.team-rules-details').first(); if (!await detail.evaluate(el => el.open)) await detail.locator('summary').click(); };
    const waitSaved = () => page.waitForFunction(id => { const root = document.querySelector(`section.team-rules[data-event-id="${id}"]`); return root && !root.querySelector('.team-rules-save').disabled && root.querySelector('.setup-save-feedback')?.textContent.includes('比赛规则已保存'); }, identity.event_id);
    assert.equal(await page.locator('.rules-project-card').count(), 1);
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `team-rules-normal-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1365, height: 1000 });
    assert.equal(await page.locator('.rules-context').count(), 0);
    assert.equal(await page.getByLabel('规则参赛组别', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('三人赛规则项目', { exact: true }).count(), 0);
    assert.ok((await page.locator('.rules-project-path').innerText()).includes('本赛事所有组别'));
    assert.equal(new URL(page.url()).hash.includes('category='), false);
    pass('赛事统一表单、无组别项目选择及四宽度常用布局');
    const save = () => editor().getByRole('button', { name: '保存规则', exact: true }).click();
    const confirm = () => page.getByRole('dialog', { name: '确认修改比赛规则', exact: true }).getByRole('button', { name: '确认保存规则', exact: true }).click();
    let puts = 0; page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith(pathRules)) puts++; });
    await open();
    await editor().getByLabel('比赛局制', { exact: true }).selectOption('5');
    await editor().getByLabel('普通局常用规则', { exact: true }).selectOption('2');
    await editor().getByLabel('决胜局沿用普通局', { exact: true }).uncheck();
    await editor().getByLabel('决胜局常用规则', { exact: true }).selectOption('1');
    await editor().getByLabel('决胜局目标分', { exact: true }).fill('11');
    await editor().getByLabel('决胜局封顶分', { exact: true }).fill('13');
    await save();
    const dialog = page.getByRole('dialog', { name: '确认修改比赛规则', exact: true });
    await dialog.waitFor(); assert.ok((await dialog.innerText()).includes('1 场未开始'));
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
    await page.keyboard.press('Escape'); assert.equal(puts, 0);
    assert.equal(await editor().getByLabel('比赛局制', { exact: true }).inputValue(), '5');
    await save(); await confirm();
    await waitSaved();
    assert.equal((await api('GET', `/api/categories/${peerTeam}/team-rules`)).rules.max_sets, 5);
    let state = await api('GET', pathRules);
    assert.equal(state.rules.max_sets, 5); assert.equal(state.rules.regular.mode, 'fixed_deuce'); assert.equal(state.rules.deciding.target_points, 11);
    pass('侧栏唯一规则入口及高亮，旧位置无编辑器；五局/独立决胜局实际保存，男女三人赛共享');
    await open(); await editor().getByLabel('普通局目标分', { exact: true }).fill('16');
    await editor().getByRole('button', { name: '取消修改规则', exact: true }).click();
    await page.getByRole('dialog', { name: '取消修改比赛规则' }).getByRole('button', { name: '放弃修改', exact: true }).click();
    await open(); assert.equal(await editor().getByLabel('普通局目标分', { exact: true }).inputValue(), '15');
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 1000 });
      await editor().scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('.team-rules input,.team-rules select,.team-rules button')]
          .filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect()).filter(r => r.left < -1 || r.right > innerWidth + 1).length }));
      assert.ok(geometry.scroll <= width + 1, JSON.stringify(geometry)); assert.equal(geometry.outside, 0);
      assert.equal(await page.locator('#sidenav a.active').textContent(), '赛事设置');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(artifacts, `team-rules-settings-${width}.png`), fullPage: true });
    }
    pass('取消恢复已保存参数，四种宽度控件及页面无横向溢出');
    await page.setViewportSize({ width: 1365, height: 1000 });
    await open();
    await editor().getByLabel('普通局常用规则', { exact: true }).selectOption('1');
    await page.route('**' + pathRules, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      await route.fetch(); await route.abort('failed');
    });
    const beforePuts = puts;
    await save(); await confirm();
    const feedback = editor().locator('.setup-save-feedback'); await feedback.getByRole('button', { name: '重新读取状态' }).waitFor();
    assert.equal(puts, beforePuts + 1); assert.equal(await editor().getByRole('button', { name: '保存规则', exact: true }).isDisabled(), true);
    await page.unroute('**' + pathRules);
    await page.route('**' + pathRules, async route => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
    await feedback.getByRole('button', { name: '重新读取状态' }).click();
    await feedback.getByText(/保存结果尚未确认/).waitFor();
    assert.equal(puts, beforePuts + 1);
    assert.equal(await page.locator('.rules-context').count(), 0);
    assert.equal(await editor().getByLabel('比赛局制', { exact: true }).isDisabled(), true);
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    await page.getByText('请先完成保存或核对保存结果', { exact: true }).waitFor();
    assert.ok(new URL(page.url()).hash.includes('step=rules'));
    await page.unroute('**' + pathRules);
    await feedback.getByRole('button', { name: '重新读取状态' }).click();
    await waitSaved();
    assert.equal(puts, beforePuts + 1); assert.equal((await api('GET', pathRules)).rules.regular.mode, 'target');
    pass('保存已写入但丢响应：只读核对恢复、没有自动重发PUT');
    await open(); await editor().getByLabel('普通局目标分', { exact: true }).fill('16');
    await page.route('**' + pathRules, async route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'busy', message: '测试拒绝保存', outcome: 'not_committed' }) }) : route.continue());
    await save(); await confirm(); await feedback.getByText('测试拒绝保存', { exact: true }).waitFor();
    assert.equal(await editor().getByLabel('普通局目标分', { exact: true }).inputValue(), '16');
    assert.equal((await api('GET', pathRules)).rules.regular.target_points, 15);
    await page.unroute('**' + pathRules);
    pass('明确未写入失败保留参数、后台规则不变');
    await editor().getByLabel('普通局目标分', { exact: true }).fill('15');
    await save(); await page.getByRole('dialog', { name: '确认修改比赛规则' }).waitFor();
    await api('POST', `/api/recording/match/${firstMatch}/claim`, {});
    await confirm(); await feedback.getByText(/适用场次范围已变化/).waitFor();
    assert.equal(await editor().getByLabel('比赛局制', { exact: true }).inputValue(), '5');
    pass('确认后另一设备领取比赛使范围token过期，保留输入并拒绝旧确认');
    await save(); await confirm(); await waitSaved();
    state = await api('GET', pathRules);
    const quick = { schema_version: 1, max_sets: 1, regular: { mode: 'target', target_points: 2, win_by: 1, point_cap: 2 }, deciding: null };
    await api('PUT', pathRules, { rules: quick, expected_revision: state.rules_revision, impact_token: state.impact_token });
    const mid = await makeMatch();
    await page.goto(`${base}/#/scoring?match=${mid}`);
    await page.getByRole('button', { name: '开始第 1 局记录', exact: true }).click();
    const homePoint = page.getByRole('button', { name: '＋ 主队得 1 分', exact: true });
    await homePoint.click(); await homePoint.click();
    await page.getByRole('button', { name: '核对无误，提交成绩', exact: true }).waitFor();
    assert.equal(await homePoint.isDisabled(), true);
    await page.getByRole('button', { name: '撤回上一次记分', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.add-btn.home')?.disabled === false);
    assert.equal(await homePoint.isEnabled(), true);
    await homePoint.click();
    await page.getByRole('button', { name: '核对无误，提交成绩', exact: true }).click();
    await page.getByRole('button', { name: '查看成绩', exact: true }).waitFor();
    const finished = (await api('GET', `/api/matches/${mid}`)).match;
    assert.equal(finished.status, 'finished'); assert.equal(finished.sets.length, 1); assert.equal(finished.sets[0].home_points, 2);
    assert.equal((await api('GET', `/api/matches/${firstMatch}`)).match.rules.max_sets, 5);
    pass('真实记录页按一局2分结束、撤回重开、不可变包提交、原领取场次保持五局规则');
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}`); await editor().waitFor();
    assert.ok((await editor().innerText()).includes('1局1胜'));
    // A confirmed write followed by a failed read remains blocked until a read-only recovery.
    await open(); await editor().getByLabel('比赛局制', { exact: true }).selectOption('3');
    let wrote = false;
    await page.route('**' + pathRules, async route => {
      if (route.request().method() === 'PUT') { const response = await route.fetch(); wrote = true; return route.fulfill({ response }); }
      if (wrote) return route.abort('failed');
      return route.continue();
    });
    const syncPuts = puts;
    await save(); await confirm();
    await editor().locator('.setup-save-feedback').getByText(/已保存，列表待同步/).waitFor();
    assert.equal((await api('GET', pathRules)).rules.max_sets, 3);
    await page.unroute('**' + pathRules);
    await editor().locator('.setup-save-feedback').getByRole('button', { name: '重新读取状态' }).click();
    await waitSaved();
    assert.equal(puts, syncPuts + 1);
    pass('保存确认后读取失败：列表待同步，只读恢复且没有第二次PUT');
    const otherGroup = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '乙组', code: '乙' })).group_id;
    const otherTeam = (await api('POST', `/api/groups/${otherGroup}/categories`, { name: '女子三人赛', gender: 'female', kind: 'team' })).category_id;
    await page.reload(); await editor().waitFor();
    await open(); await editor().getByLabel('比赛局制', { exact: true }).selectOption('custom');
    await editor().getByLabel('自定义最多局数', { exact: true }).fill('9');
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    await page.getByRole('dialog', { name: '离开赛事设置' }).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor().getByLabel('自定义最多局数', { exact: true }).inputValue(), '9');
    const lateEvent = await api('POST', '/api/events', { name: '迟到响应隔离赛事' });
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const posted = new Promise(resolve => { entered = resolve; });
    await page.route('**' + pathRules, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch(); entered(); await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await save(); await confirm(); await posted;
    // Local navigation correctly blocks while saving. An explicit browser navigation
    // can still replace the document; accept its beforeunload prompt in this fixture.
    page.once('dialog', dialog => dialog.accept());
    await page.goto(`${base}/?late_response_test=1#/teamRules?event=${lateEvent.event_id}`);
    const otherEditor = page.locator(`section.team-rules[data-event-id="${lateEvent.event_id}"]`);
    await otherEditor.waitFor(); release(); await page.unroute('**' + pathRules);
    assert.ok((await otherEditor.innerText()).includes('3局2胜'));
    assert.equal((await api('GET', `/api/categories/${otherTeam}/team-rules`)).rules.max_sets, 9);
    assert.equal((await api('GET', pathRules)).rules.max_sets, 9);
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}`); await editor().waitFor();
    assert.ok((await editor().innerText()).includes('9局5胜'));
    pass('延迟保存响应不污染另一赛事，新组别女子三人赛自动继承九局规则');
    const nineMatch = await makeMatch();
    const printable = await fetch(`${base}/api/exports/record-sheet.html?match_id=${nineMatch}`, { headers: {
      Authorization: `Bearer ${token}`, 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid, 'X-Client-Protocol': '2' } });
    assert.equal(printable.status, 200);
    const printPage = await context.newPage(); await printPage.setContent(await printable.text());
    await printPage.emulateMedia({ media: 'print' });
    assert.equal(await printPage.locator('table').first().locator('th').count(), 12);
    assert.ok((await printPage.innerText('body')).includes('第9局'));
    assert.ok((await printPage.content()).includes('size:A4 landscape'));
    await printPage.screenshot({ path: path.join(artifacts, 'team-rules-nine-set-print.png'), fullPage: true });
    await printPage.close(); pass('九局实际记录表横向打印列、规则摘要和签字区');
    await api('POST', '/api/users', { username: 'rules-viewer', display_name: '规则只读', password: 'ViewerRules123', role: 'viewer', event_ids: [identity.event_id] });
    const viewer = (await api('POST', '/api/login', { username: 'rules-viewer', password: 'ViewerRules123' })).token;
    const readonly = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await readonly.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token: viewer, event: identity.event_id });
    const readPage = await readonly.newPage(); await readPage.goto(`${base}/#/teamRules?event=${identity.event_id}`);
    await readPage.locator('#setup-rules .rules-readonly').waitFor();
    assert.ok((await readPage.locator('#setup-rules').innerText()).includes('9局5胜'));
    assert.equal(await readPage.getByRole('button', { name: '保存规则', exact: true }).count(), 0);
    assert.equal(await readPage.locator('#setup-rules .team-rules input, #setup-rules .team-rules select').count(), 0);
    await readPage.getByRole('link', { name: '赛事设置', exact: true }).click();
    await readPage.locator('.setup-readonly-group').first().waitFor();
    assert.equal(await readPage.locator('#setup-rules .rules-readonly').count(), 1);
    assert.ok((await readPage.locator('#setup-rules').innerText()).includes('9局5胜'));
    await readonly.close(); pass('查看角色在赛事设置第 4 分区只读显示摘要且无编辑入口');
    for (const role of ['organizer', 'recorder']) {
      await api('POST', '/api/users', { username: `rules-${role}`, display_name: `规则${role}`, password: 'ViewerRules123', role, event_ids: [identity.event_id] });
      const roleToken = (await api('POST', '/api/login', { username: `rules-${role}`, password: 'ViewerRules123' })).token;
      const roleContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
      await roleContext.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token: roleToken, event: identity.event_id });
      const rolePage = await roleContext.newPage();
      await rolePage.goto(`${base}/#/teamRules?event=${identity.event_id}`);
      await rolePage.locator('#setup-rules .rules-readonly').waitFor();
      assert.ok((await rolePage.locator('#setup-rules').innerText()).includes('9局5胜'));
      assert.equal(await rolePage.locator('#setup-rules .rules-project-card input, #setup-rules .rules-project-card select, #setup-rules .rules-project-card button').count(), 0);
      await rolePage.getByRole('link', { name: '赛事设置', exact: true }).click();
      await rolePage.locator('.setup-readonly-group').first().waitFor();
      assert.equal(await rolePage.locator('#setup-rules .rules-readonly').count(), 1);
      await roleContext.close();
    }
    pass('编排和记录角色在赛事设置第 4 分区只读且无编辑入口');
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}`); await editor().waitFor();
    const detail = editor().locator('.team-rules-details').first();
    if (await detail.evaluate(el => el.open)) await detail.locator('summary').click();
    await detail.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await detail.evaluate(el => el.open), true);
    pass('比赛规则折叠区可键盘打开');
    await editor().getByLabel('普通局常用规则', { exact: true }).selectOption('0');
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    const leave = page.getByRole('dialog', { name: '离开赛事设置', exact: true });
    await leave.waitFor();
    await leave.getByRole('button', { name: '取消', exact: true }).click();
    assert.ok(new URL(page.url()).hash.startsWith('#/teamRules'));
    assert.equal(await editor().getByLabel('普通局常用规则', { exact: true }).inputValue(), '0');
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    await leave.getByRole('button', { name: '放弃并离开', exact: true }).click();
    await page.locator('.setup-basic-panel').waitFor();
    assert.equal(await page.locator('#setup-rules .team-rules').count(), 1);
    assert.equal(await page.locator('#setup-rules .team-rules-state').innerText(), '已保存');
    await page.getByRole('button', { name: '修改资料', exact: true }).click();
    const eventName = page.getByLabel('赛事名称', { exact: true });
    await eventName.fill('资料输入仍可取消');
    await page.locator('.setup-basic-panel').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('navigation', { name: '赛事设置导航', exact: true }).getByRole('button', { name: '三人赛规则', exact: true }).click();
    await editor().waitFor(); await open();
    pass('未保存规则离开取消保留输入，放弃后同页恢复已保存值且赛事资料仍可编辑取消');

    // 聚合离开保护：规则草稿与其它分区草稿由同一个页面级确认覆盖。
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}`); await editor().waitFor(); await open();
    await editor().getByLabel('比赛局制', { exact: true }).selectOption('3');
    await page.locator('#setup-event').getByRole('button', { name: '修改资料', exact: true }).click();
    const combinedName = page.locator('#setup-event').getByLabel('赛事名称', { exact: true });
    await combinedName.fill('聚合保护暂存名称');
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    const combinedLeave = page.getByRole('dialog', { name: '离开赛事设置', exact: true });
    await combinedLeave.waitFor();
    await combinedLeave.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor().getByLabel('比赛局制', { exact: true }).inputValue(), '3');
    assert.equal(await combinedName.inputValue(), '聚合保护暂存名称');
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    await page.getByRole('dialog', { name: '离开赛事设置', exact: true }).getByRole('button', { name: '放弃并离开', exact: true }).click();
    await page.locator('.setup-basic-panel').waitFor();
    assert.equal(await page.locator('#setup-rules .team-rules-state').innerText(), '已保存');
    pass('规则与其它分区草稿由同一离开确认聚合：取消保留双方输入，放弃后恢复已保存值');

    // 保存规则只提交规则分区，未提交的赛事资料草稿保持。
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}`); await editor().waitFor(); await open();
    const beforeIndependent = await api('GET', pathRules);
    await page.locator('#setup-event').getByRole('button', { name: '修改资料', exact: true }).click();
    const pendingName = page.locator('#setup-event').getByLabel('赛事名称', { exact: true });
    await pendingName.fill('规则保存时不提交的资料草稿');
    let independentEventPuts = 0;
    const watchIndependentPuts = request => { if (request.method() === 'PUT' && request.url() === `${base}/api/events/${identity.event_id}`) independentEventPuts++; };
    page.on('request', watchIndependentPuts);
    await editor().getByLabel('普通局常用规则', { exact: true }).selectOption('0');
    await save(); await confirm(); await waitSaved();
    page.off('request', watchIndependentPuts);
    assert.equal(independentEventPuts, 0);
    assert.equal((await api('GET', `/api/events/${identity.event_id}/structure`)).event.name, '三人赛规则测试赛事');
    assert.equal(await pendingName.inputValue(), '规则保存时不提交的资料草稿');
    const changedRules = await api('GET', pathRules);
    assert.equal(changedRules.rules.regular.target_points, 15);
    await page.locator('#setup-event').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '取消修改赛事资料', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
    // 还原测试夹具规则，后续既有用例按原后台状态继续。
    await api('PUT', pathRules, { rules: beforeIndependent.rules, expected_revision: changedRules.rules_revision, impact_token: changedRules.impact_token });
    pass('保存规则不提交其它分区草稿，赛事资料仍保持未保存输入');

    // 规则元数据非法：只在规则分区报错并禁写，其它设置保持可用。
    const structurePath = `**/api/events/${identity.event_id}/structure`;
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}`); await editor().waitFor();
    await page.route(structurePath, async route => {
      const response = await route.fetch(); const payload = await response.json();
      payload.team_rules = { ...payload.team_rules, rules_revision: 0 };
      await route.fulfill({ response, json: payload });
    });
    await page.reload();
    await page.locator('#setup-rules .setup-rules-error').waitFor();
    assert.equal(await page.locator('#setup-rules').getByRole('button', { name: '保存规则', exact: true }).count(), 0);
    await page.unroute(structurePath);
    await page.locator('#setup-event').getByRole('button', { name: '修改资料', exact: true }).click();
    assert.equal(await page.locator('#setup-event').getByLabel('赛事名称', { exact: true }).isVisible(), true);
    await page.locator('#setup-event').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#setup-rules').getByRole('button', { name: '重新读取状态', exact: true }).click();
    await editor().waitFor();
    pass('规则元数据非法时规则分区局部报错禁写，其它设置可用并可重新核对');

    // 显式赛事参数非法时不静默回退当前赛事。
    await page.goto(`${base}/#/setup?event=999999`);
    await page.getByText('链接中的赛事不存在或当前账号不可访问。', { exact: true }).waitFor();
    assert.equal(await page.locator('.setup-page').count(), 0);
    await page.goto(`${base}/#/teamRules?event=999999`);
    await page.getByText('链接中的赛事不存在或当前账号不可访问。', { exact: true }).waitFor();
    pass('非法赛事参数明确报错，不回退到当前赛事');

    // 旧链接的过期组别/项目参数不再缩小规则范围。
    await page.goto(`${base}/#/teamRules?event=${identity.event_id}&group=999999&category=888`);
    await editor().waitFor();
    assert.equal(new URL(page.url()).hash.includes('group='), false);
    assert.equal(new URL(page.url()).hash.includes('category='), false);
    pass('旧 teamRules 链接保留兼容并清理过期组别/项目参数');

    const originalIdentity = identity;
    const otherEvent = await api('POST', '/api/events', { name: '规则切换空赛事' });
    identity = otherEvent;
    const emptyGroup = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '仅个人组', code: '个' })).group_id;
    await api('POST', `/api/groups/${emptyGroup}/categories`, { name: '男子个人赛', gender: 'male', kind: 'individual' });
    identity = originalIdentity;
    await page.reload(); await editor().waitFor();
    await page.locator('#event-select').selectOption(String(otherEvent.event_id));
    const emptyEventEditor = page.locator(`section.team-rules[data-event-id="${otherEvent.event_id}"]`);
    await emptyEventEditor.waitFor();
    assert.ok(new URL(page.url()).hash.startsWith('#/setup'));
    assert.ok(new URL(page.url()).hash.includes('step=rules'));
    assert.equal(await page.locator('.team-rules').count(), 1);
    assert.ok((await page.locator('.rules-project-count').innerText()).includes('可以先保存规则'));
    assert.ok((await emptyEventEditor.innerText()).includes('3局2胜'));
    assert.equal(await page.locator('#sidenav a.active').textContent(), '赛事设置');
    await page.locator('#event-select').selectOption(String(identity.event_id));
    await editor().waitFor(); await open();
    assert.equal(await page.locator('#sidenav a.active').textContent(), '赛事设置');
    pass('刷新直达规则页，切换赛事保留专页，无三人赛项目也能预配置且规则独立');

    let releaseStructure, arrivedStructure;
    const structureHeld = new Promise(resolve => { releaseStructure = resolve; });
    const structureArrived = new Promise(resolve => { arrivedStructure = resolve; });
    const otherStructure = `**/api/events/${otherEvent.event_id}/structure`;
    await page.route(otherStructure, async route => {
      const response = await route.fetch(); arrivedStructure(); await structureHeld;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.locator('#event-select').selectOption(String(otherEvent.event_id));
    await structureArrived;
    await page.locator('#event-select').selectOption(String(identity.event_id));
    releaseStructure(); await page.unroute(otherStructure);
    await editor().waitFor();
    assert.ok((await page.locator('.setup-page-head .setup-current-event').innerText()).includes('三人赛规则测试赛事'));
    assert.equal(await page.getByRole('heading', { name: '仅个人组', exact: true }).count(), 0);
    assert.equal(await page.locator('#sidenav a.active').textContent(), '赛事设置');
    pass('切换赛事时迟到结构响应不污染新页面');
    await open();

    await editor().getByLabel('普通局常用规则', { exact: true }).selectOption('0');
    let releaseRead, arrivedRead, finishedRead;
    const readRelease = new Promise(resolve => { releaseRead = resolve; });
    const readArrived = new Promise(resolve => { arrivedRead = resolve; });
    const readFinished = new Promise(resolve => { finishedRead = resolve; });
    await page.route('**' + pathRules, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); arrivedRead(); await readRelease;
      await route.fulfill({ response }).catch(() => {}); finishedRead();
    });
    const accountPuts = puts;
    await save(); await readArrived;
    assert.equal(await editor().getByRole('button', { name: '保存规则', exact: true }).isDisabled(), true);
    await page.getByRole('link', { name: '赛事设置', exact: true }).click();
    await page.getByText('请先完成保存或核对保存结果', { exact: true }).waitFor();
    assert.ok(new URL(page.url()).hash.includes('step=rules'));
    await page.evaluate(async () => { const client = await import('/js/api.js'); client.setToken('changed-session-for-test'); });
    releaseRead(); await readFinished; await page.unroute('**' + pathRules);
    assert.equal(await page.getByRole('dialog', { name: '确认修改比赛规则' }).count(), 0);
    assert.equal(puts, accountPuts);
    await page.evaluate(async token => { const client = await import('/js/api.js'); client.setToken(token); }, token);
    page.once('dialog', dialog => dialog.accept());
    await page.reload(); await editor().waitFor();
    assert.equal(await page.locator('.rules-project-card').count(), 1);
    assert.equal(await page.locator('#sidenav a.active').textContent(), '赛事设置');
    await open();
    assert.equal(await editor().getByRole('button', { name: '保存规则', exact: true }).isEnabled(), true);
    assert.equal(await editor().getByLabel('普通局目标分', { exact: true }).inputValue(), '2');
    await editor().locator('.team-rules-details').first().locator('summary').click();
    pass('同页面账号令牌变化使延迟规则预检失效，不打开确认且不发送PUT');
    const presetRules = [
      { mode: 'target', target_points: 15, win_by: 1, point_cap: 15 },
      { mode: 'target', target_points: 15, win_by: 2, point_cap: 17 },
      { mode: 'fixed_deuce', target_points: 15, deuce_points: 17 },
      { mode: 'target', target_points: 21, win_by: 2, point_cap: 25 },
    ];
    for (const index of [0, 2]) {
      const label = index === 0 ? '15 分直接获胜' : '15 分 · 14 平后到 17';
      await editor().getByRole('button', { name: label, exact: true }).first().click();
      await save(); await confirm(); await waitSaved();
      assert.deepEqual((await api('GET', pathRules)).rules.regular, presetRules[index]);
    }
    for (const index of [1, 3]) {
      await open(); await editor().getByLabel('普通局常用规则', { exact: true }).selectOption(String(index));
      await save(); await confirm(); await waitSaved();
      assert.deepEqual((await api('GET', pathRules)).rules.regular, presetRules[index]);
    }
    pass('快捷按钮和全部四种常用规则实际保存刷新口径一致');
    await editor().getByRole('button', { name: '自定义参数', exact: true }).first().click();
    await editor().getByLabel('普通局目标分', { exact: true }).fill('100');
    const ordinaryDetail = editor().locator('.team-rules-details').first();
    await ordinaryDetail.locator('summary').click();
    await save();
    await editor().getByRole('alert').filter({ hasText: '目标分必须是' }).waitFor();
    assert.equal(await ordinaryDetail.evaluate(el => el.open), true);
    assert.equal(await editor().getByLabel('普通局目标分', { exact: true }).inputValue(), '100');
    assert.equal(await page.getByRole('dialog', { name: '确认修改比赛规则' }).count(), 0);
    await editor().getByLabel('普通局目标分', { exact: true }).fill('21');
    await editor().getByLabel('普通局启用封顶', { exact: true }).uncheck();
    assert.equal(await editor().locator('label.field').filter({ has: editor().getByLabel('普通局封顶分', { exact: true }) }).isVisible(), false);
    await editor().getByLabel('比赛局制', { exact: true }).selectOption('custom');
    await editor().getByLabel('自定义最多局数', { exact: true }).fill('7');
    await save(); await confirm(); await waitSaved();
    const customSaved = (await api('GET', pathRules)).rules;
    assert.equal(customSaved.max_sets, 7); assert.equal(customSaved.regular.win_by, 2); assert.equal(customSaved.regular.point_cap, null);
    pass('折叠中的非法自定义参数保存时自动展开错误，输入保留；七局不封顶实际保存');

    const longName = '男子三人赛 · 甲组校园藤球联赛规则设置长赛事名称可读性检查';
    await api('PUT', `/api/events/${identity.event_id}`, { name: longName });
    await page.reload(); await editor().waitFor(); await open();
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 1000 });
      const geometry = await page.evaluate(() => {
        const card = document.querySelector('.rules-project-card'), section = document.querySelector('.team-rules-section');
        const controls = [...document.querySelectorAll('.team-rules button,.team-rules select,.rules-context select')]
          .filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect());
        return { scroll: document.documentElement.scrollWidth, width: innerWidth, panel: document.querySelector('#setup-rules').getBoundingClientRect().width,
          outside: controls.some(r => r.left < 0 || r.right > innerWidth + 1), short: controls.some(r => r.height < 43.5),
          sectionPadding: parseFloat(getComputedStyle(section).paddingTop), cardPadding: parseFloat(getComputedStyle(card).paddingLeft) };
      });
      assert.ok(geometry.scroll <= width + 1 && geometry.panel <= width + 1 && !geometry.outside && !geometry.short, JSON.stringify(geometry));
      assert.ok(geometry.sectionPadding >= 24); if (width <= 760) assert.ok(geometry.cardPadding <= 18);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(artifacts, `team-rules-custom-${width}.png`), fullPage: true });
    }
    await api('PUT', `/api/events/${identity.event_id}`, { name: '三人赛规则测试赛事' });
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.reload(); await editor().waitFor();
    assert.equal(await editor().getByLabel('自定义最多局数', { exact: true }).inputValue(), '7');
    pass('四宽度长赛事名/自定义参数、分区无横向溢出、24分区间距和44像素控件通过');
    // Build actual mixed legacy SQLite data, then exercise the one-time unification UI.
    const legacyFixture = spawnSync(process.env.STSS_PYTHON || 'python', ['-B', '-c', `
import sys
from app import db,team_rules_store
from app.domain import team_rules
c=db.connect(sys.argv[1])
r=team_rules.normalize();r['max_sets']=5
db.update(c,'categories',int(sys.argv[2]),{'team_rules_json':team_rules.canonical(r),'rules_revision':4})
c.execute('DELETE FROM settings WHERE k=?',(team_rules_store.EVENT_MARKER,))
c.close()
db.init_db(sys.argv[1])
`, path.join(data, 'events', `event_${identity.event_id}.db`), String(team)], { cwd: root, windowsHide: true, encoding: 'utf8' });
    assert.equal(legacyFixture.status, 0, legacyFixture.stderr);
    await page.reload(); await editor().waitFor();
    await page.getByText('旧规则尚未统一', { exact: true }).waitFor();
    assert.equal(await editor().locator('.team-rules-state').innerText(), '待统一');
    assert.ok((await editor().locator('.team-rules-overview').innerText()).includes('尚未应用'));
    assert.equal((await api('GET', pathRules)).rules_state, 'legacy_mixed');
    await page.getByText('查看原有规则差异', { exact: true }).click();
    assert.ok((await page.locator('.rules-legacy').innerText()).includes('5局3胜'));
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `team-rules-legacy-${width}.png`), fullPage: true });
    }
    const pendingContext = await browser.newContext();
    await pendingContext.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token: viewer, event: identity.event_id });
    const pendingPage = await pendingContext.newPage(); await pendingPage.goto(`${base}/#/teamRules?event=${identity.event_id}`);
    await pendingPage.getByText('旧规则尚未统一', { exact: true }).waitFor();
    assert.equal(await pendingPage.getByRole('button', { name: '保存规则', exact: true }).count(), 0);
    await pendingContext.close();
    await page.setViewportSize({ width: 1365, height: 1000 });
    // No parameter changes: explicitly applying the default draft must leave mixed state.
    const mixedPuts = puts;
    await save(); await page.getByRole('dialog', { name: '确认修改比赛规则' }).waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes('原有规则不同'));
    await confirm(); await waitSaved();
    assert.equal(puts, mixedPuts + 1);
    assert.equal((await api('GET', pathRules)).rules_state, 'unified');
    assert.equal((await api('GET', `/api/categories/${team}/team-rules`)).rules.max_sets, 3);
    assert.equal((await api('GET', `/api/categories/${otherTeam}/team-rules`)).rules.max_sets, 3);
    assert.equal(await page.locator('.rules-legacy').isVisible(), false);
    assert.equal((await api('GET', `/api/matches/${firstMatch}`)).match.rules.max_sets, 5);
    pass('真实混合旧数据明确展示差异、只读状态，默认草稿首次确认后统一未来比赛且历史五局不变');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await page.screenshot({ path: path.join(artifacts, 'team-rules-final-saved.png'), fullPage: true });
    pass('刷新读取正式规则，浏览器无脚本异常');
  }
  await writeFile(path.join(artifacts, `team-rules-${process.env.STSS_TEAM_RULES_SUITE || 'browser'}-checks.json`), JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'team-rules-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close(); child.kill();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}
