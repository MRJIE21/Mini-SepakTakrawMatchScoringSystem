/* 结构树重构真实浏览器验证：任务域侧栏、工作台五页签、学校报名/成绩与名次直达、
   旧 tab=tasks/groups/review 兼容，以及 viewer 只读导航边界。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'stss-structure-tree-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });

const serverCode = `
import json
from app import db, security
from app.http_server import Handler, load_routes, create_server
db.init_db(); db.init_db()
conn = db.connect(); security.ensure_default_users(conn); conn.close()
load_routes()
class Quiet(Handler):
    def log_message(self, *args): pass
s = create_server(('127.0.0.1', 0), Quiet)
print(json.dumps({'port': s.server_port}), flush=True)
s.serve_forever()
`;
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', serverCode], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'),
    STSS_EVENTS_DIR: path.join(data, 'events'), STSS_ADMIN_PASSWORD: 'StructureTree123', PYTHONUTF8: '1' },
});
let serverErrors = '', browser, page;
const checks = [], errors = [];
const pass = (name, detail = '') => { checks.push({ name, detail }); console.log('PASS', name, detail); };
child.stderr.on('data', (chunk) => { serverErrors += chunk; });

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'startup timeout')), 15000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exit ${code}: ${serverErrors}`)));
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      try { const first = JSON.parse(out.split('\n')[0]); clearTimeout(timer); resolve(first.port); } catch { /* wait */ }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity = null;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: {
      'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json();
    assert.ok(response.ok, `${method} ${url}: ${JSON.stringify(payload)}`);
    return payload;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'StructureTree123' })).token;
  const event = await api('POST', '/api/events', { name: '结构树验证赛' });
  const events = await api('GET', '/api/events');
  identity = { event_id: event.event_id, event_uuid: events.events.find((row) => row.id === event.event_id).uuid,
    deployment_id: events.deployment_id };
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const group = structure.groups[0];
  const team = group.categories.find((cat) => cat.kind === 'team');
  const individual = group.categories.find((cat) => cat.kind === 'individual');
  await api('POST', '/api/users', { username: 'structure-viewer', password: 'StructureViewer123',
    display_name: '结构只读', role: 'viewer', event_ids: [event.event_id] });
  const viewerToken = (await api('POST', '/api/login',
    { username: 'structure-viewer', password: 'StructureViewer123' })).token;

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const makePage = async (value) => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
    await context.addInitScript(({ token, eid }) => {
      localStorage.setItem('stss_token', token);
      localStorage.setItem('stss_event', String(eid));
    }, { token: value, eid: event.event_id });
    const created = await context.newPage();
    created.setDefaultTimeout(12000);
    created.on('pageerror', (error) => errors.push(error.message));
    return created;
  };
  page = await makePage(token);
  const nav = () => page.locator('#sidenav');

  await page.goto(`${base}/#/workspace`);
  await page.locator('.ctx-tabs').waitFor();
  const groups = await nav().locator('.nav-group').allTextContents();
  assert.deepEqual(groups, ['赛事管理', '项目与赛程', '比赛执行', '成绩', '系统维护', '个人']);
  const adminLinks = await nav().locator('a').allTextContents();
  for (const label of ['赛事首页', '赛事设置', '项目工作台', '学校报名', '分组与抽签', '赛程与场地',
    '现场任务', '大屏', '成绩与名次', '学校总分', '成绩复核', '更正与导出', '账号管理', '我的账号']) {
    assert.ok(adminLinks.includes(label), `缺少侧栏入口：${label}`);
  }
  assert.deepEqual(await page.locator('.ctx-tabs a').allTextContents(), ['概况', '报名', '赛程', '比赛', '成绩']);
  pass('管理员侧栏按任务域分组，学校报名/分组/赛程/成绩与名次直达；工作台五页签', JSON.stringify(adminLinks));

  await nav().getByRole('link', { name: '学校报名', exact: true }).click();
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('tab') === 'registration');
  await page.locator('.school-registration-directory').waitFor();
  pass('侧栏学校报名落到工作台报名页签（不是独立页面）');

  await nav().getByRole('link', { name: '分组与抽签', exact: true }).click();
  await page.waitForFunction(() => {
    const params = new URLSearchParams(location.hash.split('?')[1]);
    return params.get('tab') === 'schedule' && params.get('view') === 'groups';
  });
  await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor();
  pass('侧栏分组与抽签落到赛程内的分组视图');

  await nav().getByRole('link', { name: '赛程与场地', exact: true }).click();
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('tab') === 'schedule');
  await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
  pass('侧栏赛程与场地落到赛程视图');

  await nav().getByRole('link', { name: '成绩与名次', exact: true }).click();
  await page.getByRole('heading', { name: '成绩与名次', exact: true }).waitFor();
  assert.ok(page.url().includes('#/results'));
  pass('侧栏成绩与名次从一级入口可达');

  /* 旧页签兼容：tasks→overview、groups→schedule+view、review→全局复核 */
  await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${team.id}&tab=tasks`);
  await page.locator('.ctx-tabs a.active').filter({ hasText: '概况' }).waitFor();
  assert.ok(page.url().includes('tab=overview'));
  pass('旧 tab=tasks 兼容为概况');
  await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${team.id}&tab=groups`);
  await page.locator('.ctx-tabs a.active').filter({ hasText: '赛程' }).waitFor();
  await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor();
  assert.ok(page.url().includes('tab=schedule') && page.url().includes('view=groups'));
  pass('旧 tab=groups 兼容为赛程内的分组视图');
  await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${team.id}&tab=review`);
  await page.waitForFunction(() => location.hash.startsWith('#/resultReview'));
  await page.getByRole('heading', { name: '成绩复核', exact: true }).waitFor();
  pass('旧 tab=review 跳转全局成绩复核');

  await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${individual.id}`);
  await page.locator('.ctx-tabs').waitFor();
  assert.deepEqual(await page.locator('.ctx-tabs a').allTextContents(), ['概况', '报名', '成绩录入', '成绩']);
  pass('个人赛工作台四页签，比赛页更正为成绩录入');

  const viewer = await makePage(viewerToken);
  await viewer.goto(`${base}/#/workspace`);
  await viewer.locator('.ctx-tabs').waitFor();
  const viewerLinks = await viewer.locator('#sidenav a').allTextContents();
  assert.ok(!viewerLinks.includes('赛事首页'));
  assert.ok(!viewerLinks.includes('学校报名'));
  assert.ok(!viewerLinks.includes('成绩复核'));
  assert.ok(!viewerLinks.includes('账号管理'));
  for (const label of ['项目工作台', '成绩与名次', '学校总分', '我的账号']) {
    assert.ok(viewerLinks.includes(label), `查看者缺少：${label}`);
  }
  await viewer.context().close();
  pass('查看者侧栏无维护入口，保留工作台/成绩/学校总分/我的账号');

  await page.screenshot({ path: path.join(artifacts, 'structure-tree-1365.png'), fullPage: true });
  assert.deepEqual(errors, [], `页面脚本错误：${JSON.stringify(errors)}`);
  await writeFile(path.join(artifacts, 'structure-tree-report.json'),
    JSON.stringify({ status: 'PASS', checks, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'structure-tree-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}
