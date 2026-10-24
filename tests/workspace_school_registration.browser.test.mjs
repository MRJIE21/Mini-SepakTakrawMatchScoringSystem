import {registrationEdit,registrationProject} from './helpers/registration_ui.mjs';
/* Real HTTP, SQLite, navigation and responsive registration verification. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'workspace-school-'));
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
  STSS_ADMIN_PASSWORD: 'WorkspaceSchool123', PYTHONUTF8: '1' } });
let browser, page, serverErrors = '';
const checks = [], errors = [], geometry = [];
child.stderr.on('data', chunk => { serverErrors += chunk; });
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 10000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
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
  token = (await api('POST', '/api/login', { username: 'admin', password: 'WorkspaceSchool123' })).token;
  for (const resource of ['/js/views/workspace.js', '/js/views/schoolRegistration.js', '/js/workspaceContext.js', '/js/schoolRegistrationImport.js', '/sw.js']) {
    const response = await fetch(base + resource); assert.equal(response.status, 200); assert.ok((await response.text()).length > 100);
  }
  pass('真实随机端口服务、身份接口与学校报名资源启动');
  if (process.env.STSS_WORKSPACE_SCHOOL_SUITE !== 'startup') {
    identity = await api('POST', '/api/events', { name: '2026 藤球学校报名整合验证' });
    identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
    const group = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '甲组', code: 'A' })).group_id;
    const other = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '乙组', code: 'B' })).group_id;
    const empty = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '尚未设项目组', code: 'C' })).group_id;
    const makeCategory = async (g, name, kind, gender = 'male') => (await api('POST', `/api/groups/${g}/categories`, { name, kind, gender })).category_id;
    const team = await makeCategory(group, '男子三人赛', 'team');
    const individual = await makeCategory(group, '男子个人赛', 'individual');
    const female = await makeCategory(group, '女子三人赛', 'team', 'female');
    const peer = await makeCategory(other, '男子三人赛', 'team');
    const makeSchool = async (g, name) => (await api('POST', `/api/events/${identity.event_id}/schools`, { name, group_id: g })).school_id;
    const name = '首都高校藤球联合竞赛报名测试实验中学（含多校区与超长学校名称）';
    const school = await makeSchool(group, name), second = await makeSchool(group, '甲组第二中学');
    const otherSchool = await makeSchool(other, '乙组实验学校');
    const emptySchool = await makeSchool(empty, '无项目人员维护校');
    const originalIdentity = identity;
    const alternateEvent = await api('POST', '/api/events', { name: '异步隔离验证赛事' });
    identity = originalIdentity;
    for (let i = 1; i <= 4; i++) await api('POST', `/api/schools/${school}/athletes`, { name: `测试人员${i}`, gender: 'male', jersey_no: String(i) });
    const people = (await api('GET', `/api/schools/${school}/athletes`)).athletes;
    browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN' });
    await context.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token, event: identity.event_id });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const link = (extra = {}) => `${base}/#/workspace?${new URLSearchParams({ event: identity.event_id, group, category: team, tab: 'registration', ...extra })}`;
    const visit = async extra => { await page.goto(link(extra)); await page.locator('.school-registration-directory,header.page-head,.page-state').first().waitFor(); };
    const open = async (id = school) => { await visit({ school: id }); await page.getByRole('tab', { name: '统一编辑', exact: true }).waitFor(); };
    const submit = () => page.locator('[data-action="school-preview"]');
    const snapshot = async view => {
      for (const width of [320, 390, 768, 1365]) {
        await page.setViewportSize({ width, height: 1000 });
        /* 1.5.0 报名详情页头由全局 pageHeader() 渲染且位于 .workspace-content 内。
           页头操作按钮沿用设计令牌 --control-lg=40px，不属于报名内容区 43.5px 触控门槛；
           内容区仍严格校验，页头按钮单独按设计下限 40px 校验（移动端 44px 由媒体查询保证）。 */
        const row = await page.evaluate(() => {
          const controls = [...document.querySelectorAll('.workspace-content input,.workspace-content select,.workspace-content button')]
            .filter(el => el.getClientRects().length);
          const outside = controls
            .map(el => ({ text: el.textContent.slice(0, 20), ...JSON.parse(JSON.stringify(el.getBoundingClientRect())) }))
            .filter(r => r.left < -1 || r.right > innerWidth + 1);
          const small = controls.filter(el => !el.closest('.page-head') && el.type !== 'checkbox')
            .map(el => ({ text: el.textContent.slice(0, 20), height: el.getBoundingClientRect().height })).filter(r => r.height < 43.5);
          const header = [...document.querySelectorAll('.page-head .page-actions button')].filter(el => el.getClientRects().length)
            .map(el => ({ text: el.textContent.slice(0, 20), height: el.getBoundingClientRect().height }));
          return { width: innerWidth, scroll: document.documentElement.scrollWidth, outside, small, header };
        });
        geometry.push({ view, ...row });
        assert.ok(row.scroll <= width + 1, JSON.stringify(row)); assert.deepEqual(row.outside, []); assert.deepEqual(row.small, []);
        assert.ok(row.header.every(item => item.height >= 40), `${view} ${width}: ${JSON.stringify(row.header)}`);
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(artifacts, `workspace-school-${view}-${width}.png`), fullPage: true });
      }
    };
    const memoryKey = `stss_workspace_last:admin:${identity.event_id}`;
    const assertDirect = async (category,fromDefault=false) => {
      if(fromDefault) {
      await page.getByRole('navigation', {name:'项目工作台导航'}).getByRole('link', {name:'概况',exact:true}).waitFor();
      assert.equal(await page.locator('.ctx-tabs a.active').innerText(), '概况');
      await page.getByRole('navigation', {name:'项目工作台导航'}).getByRole('link', {name:'报名',exact:true}).click();
      }
      await page.locator('.school-registration-directory').waitFor();
      assert.equal(await page.getByLabel('比赛项目').inputValue(), String(category));
      assert.equal(await page.locator('.workspace-choice').count(), 0);
      assert.equal(await page.getByRole('button', { name: '切换进入方式', exact: true }).count(), 0);
      const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.equal(params.get('tab'), 'registration'); assert.equal(params.has('school'), false);
    };
    await page.goto(`${base}/#/dashboard`);
    await page.locator('#sidenav a[data-view=workspace]').waitFor();
    await page.evaluate(key => localStorage.removeItem(key), memoryKey);
    await page.locator('#sidenav a[data-view=workspace]').click();
    await assertDirect(team,true);
    for (const [remembered, expected] of [[individual, individual], [999999, team]]) {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, String(value)), { key: memoryKey, value: remembered });
      await page.goto(`${base}/?direct=${remembered}#/workspace?event=${identity.event_id}`);
      await assertDirect(expected,true);
    }
    await page.getByLabel('比赛项目').selectOption(String(individual));
    await page.waitForFunction(id => new URLSearchParams(location.hash.split('?')[1]).get('category') === String(id), individual);
    await assertDirect(individual);
    assert.equal(await page.locator('.school-registration-school').count(), 2);
    await page.getByLabel('大组别').selectOption(String(other));
    await page.waitForFunction(id => new URLSearchParams(location.hash.split('?')[1]).get('category') === String(id), peer);
    await assertDirect(peer);
    assert.equal(await page.getByRole('button', { name: '乙组实验学校', exact: true }).count(), 1);
    await page.goto(link({ tab: 'overview' }));
    await page.locator('.project-step').first().waitFor();
    assert.equal(await page.locator('.ctx-tabs a.active').innerText(), '概况');
    await page.goto(link({ tab: '', category: individual })); await assertDirect(individual,true);
    pass('侧栏默认概况，报名入口保留；有效/失效项目记忆、跨项目和组别与概况链接正确');
    await visit();
    assert.equal(await page.locator('#sidenav a[data-view=schoolRegistration]').count(), 0);
    assert.equal(await page.locator('#sidenav a.active').innerText(), '项目工作台');
    assert.equal(await page.locator('.school-registration-school').count(), 2);
    assert.equal(await page.getByText('当前项目名单', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('大组别', { exact: true }).count(), 1);
    await snapshot('list');
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('tab', { name: '统一编辑', exact: true }).waitFor();
    assert.equal(await page.locator('.school-registration-project').count(), 1);
    assert.equal(await page.locator('.school-registration-catalog button').count(), 3);
    assert.equal(await page.locator('.ctx-bar').count(), 1);
    await page.getByRole('button', { name: '返回学校列表', exact: true }).click();
    await page.locator('.school-registration-directory').waitFor();
    assert.equal(new URLSearchParams(page.url().split('?').at(-1)).get('category'), String(team));
    await page.goBack(); await page.getByRole('tab', { name: '统一编辑', exact: true }).waitFor();
    await page.goForward(); await page.locator('.school-registration-directory').waitFor();
    await page.goto(`${base}/#/schoolRegistration?event=${identity.event_id}&school=${otherSchool}`);
    await page.getByRole('heading', { name: '乙组实验学校', exact: true }).waitFor();
    assert.ok(page.url().includes('#/workspace?')); assert.equal(await page.getByLabel('大组别').inputValue(), String(other));
    assert.equal(await page.getByLabel('比赛项目').inputValue(), String(peer));
    pass('唯一侧栏工作台、当前组学校、旧详情归属、前进后退与返回项目上下文');
    await open();
    await registrationEdit(page);
    await snapshot('people');
    const note = () => page.locator(`[data-person="a:${people[0].id}"]`).getByLabel('区分信息', { exact: true });
    await note().fill('未提交的班级');
    const originalHash = new URL(page.url()).hash;
    await page.getByRole('navigation', { name: '项目工作台导航', exact: true }).getByRole('link', { name: '概况', exact: true }).click();
    await page.getByRole('dialog', { name: '离开学校报名', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(new URL(page.url()).hash, originalHash);
    assert.equal(await note().inputValue(), '未提交的班级');
    for (const [label, value] of [['大组别', other], ['比赛项目', individual]]) {
      await page.getByLabel(label, { exact: true }).selectOption(String(value));
      await page.getByRole('dialog', { name: '离开学校报名', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(new URL(page.url()).hash, originalHash); assert.equal(await note().inputValue(), '未提交的班级');
      assert.equal(await page.getByLabel('大组别').inputValue(), String(group)); assert.equal(await page.getByLabel('比赛项目').inputValue(), String(team));
    }
    await registrationEdit(page);
    await registrationEdit(page); assert.equal(await note().inputValue(), '未提交的班级');
    await page.getByRole('button', { name: '取消未提交修改', exact: true }).click();
    await page.getByRole('dialog', { name: '取消未提交修改', exact: true }).getByRole('button', { name: '取消修改', exact: true }).click();
    await page.locator('.school-registration-project').first().waitFor();
    await registrationEdit(page);
    assert.equal(await note().inputValue(), '');
    pass('组别和项目切换取消保留地址、选择器与输入，学校内页签共用同一模型');
    await registrationEdit(page);
    await (await registrationProject(page,team)).getByLabel('参赛选择').selectOption('participate');
    for (const person of people.slice(0, 3)) await (await registrationProject(page,team)).getByLabel('男子三人赛选人', { exact: true }).selectOption(`a:${person.id}`);
    await (await registrationProject(page,team)).getByLabel('队长').selectOption(`a:${people[0].id}`);
    await (await registrationProject(page,team)).getByLabel('种子序号', { exact: true }).fill('2');
    await (await registrationProject(page,individual)).getByLabel('参赛选择').selectOption('participate');
    await (await registrationProject(page,individual)).getByLabel('男子个人赛选人', { exact: true }).selectOption(`a:${people[3].id}`);
    await snapshot('projects');
    await submit().click(); await page.getByRole('heading', { name: '核对整批变更', exact: true }).waitFor();
    assert.equal((await api('GET', `/api/categories/${team}/participations`)).participations.length, 0);
    await snapshot('review');
    let packet; const packets = [];
    await page.route('**/registration-commit', async route => {
      packets.push(route.request().postDataJSON());
      if (!packet) { packet = packets[0]; await route.fetch(); await route.abort('failed'); } else await route.continue();
    });
    await submit().click(); await page.getByRole('button', { name: '核实并重试原提交', exact: true }).waitFor();
    await page.reload(); await page.getByRole('button', { name: '核实并重试原提交', exact: true }).waitFor();
    await submit().click(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
    assert.deepEqual(packets[0], packets[1]); await page.unroute('**/registration-commit');
    const enrolled = (await api('GET', `/api/categories/${team}/participations`)).participations;
    assert.equal(enrolled.length, 1); assert.equal(enrolled[0].seed_no, 2);
    assert.equal((await api('GET', `/api/categories/${individual}/participations`)).participations.length, 1);
    const saved = await api('GET', `/api/schools/${school}/registration-workspace`);
    assert.equal(saved.projects.find(p => p.category_id === female).choice, 'unresolved');
    assert.deepEqual(saved.people.map(p => p.id), people.map(p => p.id));
    pass('人员稳定ID、同校两项目整批提交、预览不写入、未改项目不覆盖，丢响应后原UID只生效一次');
    await visit({ profile: 'incomplete' });
    assert.equal(await page.locator('.school-registration-school').count(), 0);
    await page.getByRole('link', { name: '查看全部学校', exact: true }).click(); await page.locator('.school-registration-school').first().waitFor();
    assert.equal(await page.locator('.school-registration-school').count(), 2);
    // Delay an old detail read, navigate to another school while it is loading.
    let release, arrived; const held = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
    const detailPath = `**/api/schools/${school}/registration-workspace`;
    await page.route(detailPath, async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }).catch(() => {}); });
    await page.evaluate(hash => { location.hash = hash; }, new URL(link({ school })).hash); await ready;
    await page.evaluate(hash => { location.hash = hash; }, new URL(link({ school: second })).hash); release();
    await page.getByRole('heading', { name: '甲组第二中学', exact: true }).waitFor();
    await page.unroute(detailPath);
    await page.getByRole('button', { name: '返回学校列表', exact: true }).click(); await page.locator('.school-registration-directory').waitFor();
    await page.getByRole('navigation', { name: '项目工作台导航', exact: true }).getByRole('link', { name: '概况', exact: true }).click();
    await page.locator('.project-step').first().waitFor(); assert.equal(await page.getByRole('dialog').count(), 0);
    pass('待补筛选只作用学校列表、迟到详情不覆盖新学校、非表单页不继承旧守卫');
    // Keep the actual page alive while its account/event changes, exercising callback fences.
    const hold = async pattern => {
      let release, arrived;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { arrived = resolve; });
      const response = page.waitForResponse(pattern); response.catch(() => {});
      await page.route(pattern, async route => { const result = await route.fetch(); arrived(); await gate; await route.fulfill({ response: result }).catch(() => {}); });
      return { ready, release, response };
    };
    const freshToken = (await api('POST', '/api/login', { username: 'admin', password: 'WorkspaceSchool123' })).token;
    await open(); await registrationEdit(page);
    await note().fill('迟到预览输入');
    let delayed = await hold('**/registration-preview');
    await submit().click(); await delayed.ready;
    const beforeBusyNavigation = page.url();
    await page.getByLabel('大组别').selectOption(String(other));
    await page.waitForFunction(url => location.href === url, beforeBusyNavigation);
    assert.equal(await page.getByLabel('大组别').inputValue(), String(group));
    await page.evaluate(value => localStorage.setItem('stss_token', value), freshToken);
    delayed.release(); await delayed.response; await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('heading', { name: '核对整批变更', exact: true }).count(), 0);
    assert.equal(await note().inputValue(), '迟到预览输入');
    await page.unroute('**/registration-preview'); await page.evaluate(value => localStorage.setItem('stss_token', value), token);
    await page.reload(); await registrationEdit(page);
    await note().fill('迟到提交仅保存原校'); await submit().click();
    await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
    delayed = await hold('**/registration-commit'); await submit().click(); await delayed.ready;
    await page.evaluate(async eventId => { const api = await import('/js/api.js'); api.setApiReadScope(null);
      await (await import('/js/main.js')).reloadShell(eventId); }, alternateEvent.event_id);
    const unchangedURL = page.url(); delayed.release(); await delayed.response; await page.waitForLoadState('networkidle');
    assert.equal(page.url(), unchangedURL); assert.equal(await page.locator('#event-select').inputValue(), String(alternateEvent.event_id));
    assert.equal((await api('GET', `/api/schools/${school}/athletes`)).athletes.find(p => p.id === people[0].id).note, '迟到提交仅保存原校');
    await page.unroute('**/registration-commit');
    await page.evaluate(async eventId => { await (await import('/js/main.js')).reloadShell(eventId); }, identity.event_id);
    await page.reload(); await page.getByRole('button', { name: '粘贴 / 导入学校报名表', exact: true }).click();
    let importDialog = page.getByRole('dialog', { name: '粘贴 / 导入学校报名表', exact: true });
    await importDialog.getByLabel('学校报名表内容').fill(`姓名\t性别\t区分信息\t运动员ID\n测试人员1\t男\t迟到导入不应用\t${people[0].id}`);
    delayed = await hold('**/registration-import-preview'); await importDialog.getByRole('button', { name: '核对表格', exact: true }).click(); await delayed.ready;
    await page.evaluate(value => localStorage.setItem('stss_token', value), freshToken);
    delayed.release(); await delayed.response; await page.waitForLoadState('networkidle');
    assert.equal(await importDialog.getByRole('button', { name: '应用到报名表', exact: true }).isDisabled(), true);
    assert.equal(await importDialog.getByRole('heading', { name: '完整调整结果', exact: true }).count(), 0);
    await page.unroute('**/registration-import-preview'); await page.evaluate(value => localStorage.setItem('stss_token', value), token);
    await page.reload();
    pass('真实迟到预览/导入不更新新账号上下文；处理中阻止切换；迟到已生效提交不切回原赛事');
    await visit({ group: empty, category: '' });
    await page.locator('.school-registration-directory').waitFor();
    assert.equal(await page.getByRole('button', { name: '切换进入方式', exact: true }).count(), 0);
    await page.getByLabel('大组别').selectOption(String(group));
    await page.getByLabel('比赛项目').waitFor();
    await page.getByLabel('大组别').selectOption(String(empty));
    await page.getByRole('button', { name: '无项目人员维护校', exact: true }).waitFor();
    await page.getByRole('button', { name: '无项目人员维护校', exact: true }).click();
    await page.getByRole('tab', { name: '统一编辑', exact: true }).waitFor();
    assert.equal(await page.locator('.school-registration-project').count(), 0);
    await registrationEdit(page);
    await page.getByText('＋ 新增人员', { exact: true }).click(); await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).fill('先登记人员');
    await page.getByRole('button', { name: '添加人员', exact: true }).click();
    await submit().click(); await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
    await submit().click(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
    assert.equal((await api('GET', `/api/schools/${emptySchool}/athletes`)).athletes.length, 1);
    await visit(); await page.getByRole('button', { name: '新增学校', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '新增学校', exact: true });
    assert.equal(await dialog.getByLabel('组别').inputValue(), String(group));
    await dialog.getByLabel('学校名称').fill('跨组新增学校'); await dialog.getByLabel('组别').selectOption(String(other));
    await dialog.getByRole('button', { name: '创建并整理报名', exact: true }).click();
    await page.getByRole('heading', { name: '跨组新增学校', exact: true }).waitFor();
    assert.equal(await page.getByLabel('大组别').inputValue(), String(other)); assert.equal(await page.getByLabel('比赛项目').inputValue(), String(peer));
    await page.getByRole('button', { name: '删除学校', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '删除学校', exact: true });
    await page.waitForFunction(() => document.activeElement?.textContent === '取消');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消');
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.locator('.school-registration-directory').waitFor();
    assert.equal(await page.getByRole('button', { name: '跨组新增学校', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('比赛项目').inputValue(), String(peer));
    await page.goto(link({ group: other, school })); await page.getByRole('heading', { name: '页面加载失败', exact: true }).waitFor();
    assert.ok((await page.locator('#content').innerText()).includes('不属于同一上下文'));
    pass('空项目人员真实保存、跨组新建正确定位、取消优先删除及返回、冲突链接明确报错');
    for (const [role, active] of [['admin', '概况'], ['organizer', '概况'], ['recorder', '比赛'], ['viewer', '赛程']]) {
      let roleToken = token;
      if (role !== 'admin') {
        const username = `direct_${role}`;
        await api('POST', '/api/users', { username, display_name: username, role, password: 'DirectWorkspace123', event_ids: [identity.event_id] });
        roleToken = (await api('POST', '/api/login', { username, password: 'DirectWorkspace123' })).token;
      }
      const roleContext = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN' });
      await roleContext.addInitScript(({ token, event }) => {
        localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
      }, { token: roleToken, event: identity.event_id });
      const rolePage = await roleContext.newPage();
      rolePage.on('pageerror', error => errors.push(error.message));
      await rolePage.goto(`${base}/#/workspace`);
      await rolePage.locator('.ctx-tabs a.active').filter({ hasText: active }).waitFor();
      if (['recorder', 'viewer'].includes(role)) {
        assert.equal(await rolePage.getByRole('navigation', { name: '项目工作台导航', exact: true }).getByRole('link', { name: '报名', exact: true }).count(), 0);
        await rolePage.goto(link());
        await rolePage.locator('.ctx-tabs a.active').filter({ hasText: active }).waitFor();
        assert.equal(await rolePage.locator('.school-registration-directory').count(), 0);
      } else {
        await rolePage.getByRole('navigation', {name:'项目工作台导航'}).getByRole('link', {name:'报名',exact:true}).click();
        await rolePage.locator('.school-registration-directory').waitFor();
      }
      await roleContext.close();
    }
    pass('四角色默认入口正确，录入员/查看员明确报名链接仍仅进入允许页签');
    const firstIdentity = identity;
    identity = await api('POST', '/api/events', { name: '暂无组别赛事' });
    await page.goto(`${base}/?empty_event=1#/workspace?event=${identity.event_id}`);
    await page.getByText('当前赛事还没有组别', { exact: true }).waitFor();
    const noProjectGroup = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '全赛事无项目组', code: 'A' })).group_id;
    await page.reload();
    await page.getByRole('link', { name: '维护学校报名', exact: true }).click();
    await page.getByRole('button', { name: '新增学校', exact: true }).waitFor();
    assert.equal(await page.getByLabel('大组别').inputValue(), String(noProjectGroup));
    identity = firstIdentity;
    assert.deepEqual(errors, []); pass('全赛事无项目仍能报名、无组别明确配置提示、浏览器无脚本异常与四宽度16张截图');
  }
  await writeFile(path.join(artifacts, `workspace-school-${process.env.STSS_WORKSPACE_SCHOOL_SUITE || 'browser'}-checks.json`), JSON.stringify({ checks, errors, geometry }, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(artifacts, 'workspace-school-failure.png'), fullPage: true }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(0, 2500)); }
  throw error;
} finally {
  if (browser) await browser.close(); child.kill();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}
