/* Six peer destinations, real draw-to-schedule workflow and legacy routing. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..'), data = await mkdtemp(path.join(tmpdir(), 'six-tabs-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db();db.init_db();c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class Quiet(Handler):
    def log_message(self,*args):pass
s=create_server(('127.0.0.1',0),Quiet)
print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'), STSS_ADMIN_PASSWORD: 'SixTabs123', PYTHONUTF8: '1' } });
let browser, serverErrors = '', token = '', identity;
const errors = [], checks = [], geometry = [];
child.stderr.on('data', c => { serverErrors += c; });
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 10000);
    child.once('error', reject); child.once('exit', c => reject(new Error(`Server ${c}: ${serverErrors}`)));
    let output = ''; child.stdout.on('data', c => { output += c; try { const r = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(r.port); } catch {} });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await response.json(); assert.ok(response.ok, JSON.stringify(r)); return r;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'SixTabs123' })).token;
  const event = await api('POST', '/api/events/full', { event: { name: '六菜单真实验证' }, groups: [{ name: 'S组', code: 'S', categories: [
    { name: '男子三人赛', gender: 'male', kind: 'team' }, { name: '男子个人赛', gender: 'male', kind: 'individual' }] }], venues: [] });
  identity = { event_id: event.event_id, event_uuid: event.event_uuid, deployment_id: (await api('GET', '/api/events')).deployment_id };
  const group = (await api('GET', `/api/events/${event.event_id}/structure`)).groups[0];
  const category = group.categories.find(c => c.kind === 'team'), individual = group.categories.find(c => c.kind === 'individual');
  for (let i = 1; i <= 8; i++) await api('POST', `/api/categories/${category.id}/enrollments`, { school: { name: `六菜单${i}校` }, seed_no: i,
    captain_index: 0, members: [1,2,3].map(n => ({ name: `队员${i}-${n}`, gender: 'male', jersey_no: String(n) })) });
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const makePage = async loginToken => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
    await context.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token: loginToken, event: event.event_id });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); return page;
  };
  const page = await makePage(token);
  const url = (tab = '', extra = '', cat = category.id) => `${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${cat}${tab ? '&tab=' + tab : ''}${extra}`;
  const nav = () => page.getByRole('navigation', { name: '项目工作台导航', exact: true });
  const active = name => nav().locator('[aria-current="page"]').filter({ hasText: name }).waitFor();
  await page.goto(url()); await nav().waitFor(); await active('报名');
  assert.deepEqual(await nav().getByRole('link').allTextContents(), ['概况', '报名', '分组', '赛程', '比赛', '成绩']);
  assert.equal(await page.locator('.workspace-schedule-nav').count(), 0);
  await nav().getByRole('link', { name: '概况', exact: true }).click(); await page.locator('.project-step').nth(4).waitFor();
  assert.deepEqual(await page.locator('.project-step-heading strong').allTextContents(), ['报名', '分组', '赛程', '比赛', '成绩']);
  assert.equal(await page.getByRole('button', { name: '查看赛程', exact: true }).count(), 1);
  const snapshot = await api('GET', `/api/categories/${category.id}/workspace`); assert.equal(snapshot.primary_action.tab, 'groups');
  await page.locator('.workspace-next').getByRole('button', { name: '完成学校分组', exact: true }).click();
  await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor(); await active('分组');
  await nav().getByRole('link', { name: '成绩', exact: true }).click();
  await page.getByRole('button', { name: '前往分组', exact: true }).click();
  await active('分组'); await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '设置后续赛程', exact: true }).count(), 0);
  await page.getByLabel('小组数量', { exact: true }).fill('2');
  await page.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await page.getByRole('button', { name: '一键完成抽签', exact: true }).click();
  await page.getByRole('button', { name: '确认抽签分组', exact: true }).click();
  await page.getByRole('dialog', { name: '确认抽签分组', exact: true }).getByRole('button', { name: '确认分组', exact: true }).click();
  await page.getByRole('link', { name: '进入赛程', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '建立小组赛阶段', exact: true }).count(), 0);
  assert.equal(await page.locator('.draw-group li:not(.draw-empty)').count(), 8);
  const capture = async name => {
    for (const width of [320,390,768,1365]) {
      await page.setViewportSize({ width, height: 1000 });
      const dims = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('.ctx-tabs a')].map(e => e.getBoundingClientRect()).filter(r => r.left < -1 || r.right > innerWidth + 1).length }));
      assert.ok(dims.scroll <= width + 1, JSON.stringify(dims)); assert.equal(dims.outside, 0); geometry.push({ name, ...dims });
      await page.screenshot({ path: path.join(artifacts, `six-tabs-${name}-${width}.png`), fullPage: true });
    }
  };
  await capture('groups');
  await page.getByRole('link', { name: '进入赛程', exact: true }).click(); await active('赛程');
  await page.getByRole('button', { name: '建立小组赛阶段', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '核对阶段 · 小组赛', exact: true }); await preview.waitFor();
  await preview.getByRole('button', { name: '确认正式赛程', exact: true }).click();
  await page.getByRole('button', { name: '小组赛', exact: true }).waitFor();
  const schedule = (await api('GET', `/api/categories/${category.id}/schedule`)).plan;
  const stage = schedule.stages[0]; assert.equal(stage.pools.length, 2);
  assert.equal(stage.pools.flatMap(p => p.members).length, 8); assert.equal(schedule.stages.length, 1);
  assert.equal((await api('GET', `/api/categories/${category.id}/plan`)).plan.stages[0].matches.length, 0);
  assert.equal(await page.getByRole('heading', { name: '学校小组抽签', exact: true }).count(), 0);
  await capture('schedule'); pass('六菜单同级、默认报名、概况独立步骤；实际抽签在分组完成，正式阶段只在赛程建立且没有自动填赛');
  await page.getByLabel('排列方式', { exact: false }).selectOption('schedule');
  await page.waitForFunction(() => location.hash.includes('sort=schedule')); const position = page.url(); await page.reload();
  await page.getByLabel('排列方式', { exact: false }).waitFor(); assert.equal(page.url(), position);
  assert.equal(await page.getByLabel('排列方式', { exact: false }).inputValue(), 'schedule');
  await page.goto(url('schedule', '&view=groups')); await active('分组'); await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor();
  assert.ok(page.url().includes('tab=groups')); assert.ok(!page.url().includes('view='));
  await nav().getByRole('link', { name: '赛程', exact: true }).click(); await active('赛程');
  await page.goBack(); await active('分组'); await page.goForward(); await active('赛程');
  await page.goto(url('schedule', `&view=fixtures&stage=${stage.id}&sort=schedule`));
  await page.getByLabel('排列方式', { exact: false }).waitFor(); assert.ok(!page.url().includes('view=')); assert.ok(page.url().includes(`stage=${stage.id}`));
  pass('旧分组和赛程地址分别规范定位，刷新、前进后退、阶段与排列保持');
  await page.getByRole('button', { name: '设置后续赛程', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置后续赛程', exact: true });
  await dialog.getByLabel('阶段名称', { exact: false }).fill('未保存内容'); const before = page.url();
  await page.evaluate(target => { location.hash = target; }, new URL(url('groups')).hash);
  await page.getByRole('dialog', { name: '有未保存的修改', exact: true }).getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(page.url(), before); await active('赛程'); assert.equal(await dialog.getByLabel('阶段名称', { exact: false }).inputValue(), '未保存内容');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('dialog', { name: '有未保存的修改', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
  let release, arrived, delivered;
  const held = new Promise(r => { release = r; }), ready = new Promise(r => { arrived = r; }), done = new Promise(r => { delivered = r; });
  const pattern = `**/api/categories/${category.id}/group-draw`;
  const gate = async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }).catch(() => {}); delivered(); };
  await page.route(pattern, gate); await nav().getByRole('link', { name: '分组', exact: true }).click(); await ready;
  await nav().getByRole('link', { name: '赛程', exact: true }).click(); await active('赛程'); release(); await done;
  await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '学校小组抽签', exact: true }).count(), 0); await page.unroute(pattern, gate);
  pass('取消菜单切换保留当前菜单/阶段/输入，迟到分组读取不覆盖赛程');
  for (const role of ['organizer', 'recorder', 'viewer']) {
    await api('POST', '/api/users', { username: `six-${role}`, display_name: role, password: 'SixRole123', role, event_ids: [event.event_id] });
    const login = await api('POST', '/api/login', { username: `six-${role}`, password: 'SixRole123' });
    const other = await makePage(login.token); await other.goto(url('groups')); const n = other.getByRole('navigation', { name: '项目工作台导航', exact: true }); await n.waitFor();
    assert.deepEqual(await n.getByRole('link').allTextContents(), role === 'organizer' ? ['概况','报名','分组','赛程','比赛','成绩'] : role === 'recorder' ? ['比赛'] : ['赛程','成绩']);
    if (role !== 'organizer') assert.equal(await other.getByRole('heading', { name: '学校小组抽签', exact: true }).count(), 0);
    await other.context().close();
  }
  await page.goto(url('entry', '', individual.id)); await nav().waitFor();
  assert.deepEqual(await nav().getByRole('link').allTextContents(), ['概况','报名','比赛','成绩']); await active('比赛');
  pass('管理者六菜单，记录员/查看者保持权限，个人赛只显示适用功能');
  await page.goto(`${base}/#/dashboard`); await page.getByRole('button', { name: '进入工作台', exact: true }).first().waitFor();
  const dashboard = await api('GET', `/api/events/${event.event_id}/dashboard`);
  assert.equal(dashboard.groups[0].categories.find(c => c.id === category.id).draw_status, 'confirmed');
  assert.deepEqual(errors, []); pass('首页读取正确分组状态，页面无脚本错误，四宽度均无全页溢出');
  await writeFile(path.join(artifacts, 'six-tabs-browser-report.json'), JSON.stringify({ status: 'PASS', checks, geometry, errors }, null, 2));
} finally { if (browser) await browser.close(); child.kill(); }
