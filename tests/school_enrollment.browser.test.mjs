import { installLegacyRosterFixture } from './helpers/legacy_roster_fixture.mjs';
/* 独立测试库；工具路径通过 STSS_PLAYWRIGHT_MODULE / STSS_PYTHON / STSS_BROWSER_PATH 指定。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-school-artifacts');
const dataDir = path.join(tmpdir(), `stss-school-data-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const serverCode = `
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
`;
const child = spawn(process.env.STSS_PYTHON || 'python',
  ['-u', '-c', serverCode], {
    cwd: root,
    env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
      STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'BrowserTest123', PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
let serverErrors = '';
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server timeout: ${serverErrors}`)), 10000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n')[0];
      try { const data = JSON.parse(line); clearTimeout(timer); resolve(data.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  let identity;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'BrowserTest123' })).token;
  identity = await api('POST', '/api/events', { name: '学校报名浏览器回归测试', start_date: '2026-10-01' });
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
  const group = structure.groups[0];
  const team = group.categories.find((c) => c.kind === 'team' && c.gender === 'male');
  const individual = group.categories.find((c) => c.kind === 'individual' && c.gender === 'male');
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', acceptDownloads: true });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  const page = await context.newPage();
  await installLegacyRosterFixture(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const workspace = (cat, tab) => tab === 'registration' ? `${base}/?legacy_nav=${Date.now()}#/legacyRosterTest?event=${identity.event_id}&group=${group.id}&category=${cat.id}` : `${base}/#/workspace?event=${identity.event_id}&group=${group.id}&category=${cat.id}&tab=${tab}`;
  await page.goto(workspace(team, 'registration'));

  const open = async () => {
    await page.getByRole('button', { name: '添加参赛学校', exact: true }).click();
    return page.getByRole('dialog', { name: '添加项目报名', exact: true });
  };
  let dialog = await open();
  const schoolInput = () => dialog.getByPlaceholder('搜索或新建学校');
  const save = () => dialog.getByRole('button', { name: '确认报名', exact: true });
  assert.equal(await save().isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: '新建参赛学校', exact: true }).count(), 0);
  await schoolInput().fill('测试大学');
  await dialog.getByRole('option', { name: '＋ 新建“测试大学”', exact: true }).click();
  await dialog.getByPlaceholder('姓名', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal((await api('GET', '/api/events/' + identity.event_id + '/schools')).schools.length, 0);
  await dialog.getByPlaceholder('姓名', { exact: true }).fill('张三');
  await dialog.getByPlaceholder('号码', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: '加入名单', exact: true }).click();
  await dialog.getByRole('radio', { name: '队长 张三', exact: true }).check();
  await schoolInput().fill('另一大学');
  assert.equal(await save().isDisabled(), true);
  await schoolInput().fill('测试大学');
  assert.equal(await dialog.locator('.ss-create').count(), 0);
  await dialog.getByRole('option').filter({ hasText: '测试大学' }).click();
  await dialog.getByRole('radio', { name: '队长 张三', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: '队长 张三', exact: true }).isChecked(), true);
  await dialog.screenshot({ path: path.join(artifacts, 'school-enrollment-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({ path: path.join(artifacts, 'school-enrollment-mobile.png') });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.setViewportSize({ width: 1360, height: 1000 });
  let fail = true;
  await page.route('**/enrollments', async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '测试保存失败' }) }); }
    else await route.continue();
  });
  await save().click();
  await dialog.locator('.form-errors:not(.hidden)').waitFor();
  assert.equal(await dialog.getByRole('radio', { name: '队长 张三', exact: true }).isChecked(), true);
  await save().click();
  await dialog.waitFor({ state: 'detached' });
  const schools = (await api('GET', '/api/events/' + identity.event_id + '/schools')).schools;
  assert.equal(schools.length, 1);
  assert.equal((await api('GET', '/api/categories/' + team.id + '/participations')).participations.length, 1);
  dialog = await open();
  await schoolInput().fill('测试大学');
  assert.equal(await dialog.locator('.ss-create').count(), 0);
  await dialog.getByRole('option').filter({ hasText: '测试大学' }).click();
  await dialog.getByRole('button', { name: '查看 / 编辑报名', exact: true }).waitFor();
  assert.equal(await save().isDisabled(), true);
  await schoolInput().fill('取消大学');
  await schoolInput().press('ArrowDown');
  await schoolInput().press('Enter');
  await dialog.getByPlaceholder('姓名', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.equal((await api('GET', '/api/events/' + identity.event_id + '/schools')).schools.length, 1);

  await api('POST', '/api/events/' + identity.event_id + '/schools', { name: '其他组大学', group_id: structure.groups[1].id });
  dialog = await open();
  await schoolInput().fill('其他组大学');
  assert.equal(await dialog.locator('.ss-create').count(), 0);
  assert.equal(await dialog.locator('.ss-item.disabled').count(), 1);
  let releaseTeams;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { releaseTeams = resolve; });
  await page.route('**/categories/' + team.id + '/teams', async route => { started(); await released; await route.continue(); });
  await schoolInput().fill('测试大学');
  await dialog.getByRole('option').filter({ hasText: '测试大学' }).click();
  await requested;
  await schoolInput().fill('竞态大学');
  await dialog.getByRole('option', { name: '＋ 新建“竞态大学”', exact: true }).click();
  await dialog.getByPlaceholder('姓名', { exact: true }).waitFor();
  releaseTeams();
  await page.waitForResponse('**/categories/' + team.id + '/teams');
  await page.waitForTimeout(150);
  assert.equal(await dialog.getByRole('button', { name: '查看 / 编辑报名', exact: true }).count(), 0);
  assert.equal(await save().isDisabled(), false);
  assert.equal(await dialog.locator('.ss-list').isVisible(), false);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  console.log('PASS: 跨组同名禁止新建、慢请求不覆盖新选择、选择后下拉关闭');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: 单一学校入口、同窗设置、同名复用、键盘新建、切换保留名单、失败重试、禁止重复报名、取消不建档、移动端布局');
} finally {
  if (browser) await browser.close();
  child.kill();
}

