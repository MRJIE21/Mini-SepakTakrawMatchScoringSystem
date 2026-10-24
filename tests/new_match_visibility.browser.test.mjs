/* 赛程“新增比赛”可见性回归（上一轮 R2/G-05）：
   状态/场地筛选激活时新增场次会被筛掉；修复后应自动清空筛选、提示并定位高亮新场次。
   独立临时数据目录 + 随机端口 + 真实服务进程。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(tmpdir(), `stss-new-match-${Date.now()}-${process.pid}`);
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-new-match-artifacts');
await mkdir(artifacts, { recursive: true });

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
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'NewMatchTest123',
    PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });

let serverErrors = '', browser, context, page;
child.stderr.on('data', (chunk) => { serverErrors += chunk; });

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      try { const result = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(result.port); } catch { /* wait */ }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  let identity = null;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid,
          'X-Deployment-ID': identity.deployment_id } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.ok, true, `${method} ${url}: ${JSON.stringify(data)}`);
    return data;
  };

  token = (await api('POST', '/api/login', { username: 'admin', password: 'NewMatchTest123' })).token;
  identity = await api('POST', '/api/events', { name: '新增比赛可见性赛事' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  const groupId = (await api('POST', `/api/events/${identity.event_id}/groups`, {
    name: '甲组', code: '甲', seq: 1 })).group_id;
  const categoryId = (await api('POST', `/api/groups/${groupId}/categories`, {
    name: '男子三人赛', kind: 'team', gender: 'male' })).category_id;
  for (const [index, name] of ['甲队大学', '乙队大学'].entries()) {
    const schoolId = (await api('POST', `/api/events/${identity.event_id}/schools`, {
      name, group_id: groupId })).school_id;
    await api('POST', `/api/categories/${categoryId}/enrollments`, {
      school_id: schoolId, captain_index: 0,
      members: [1, 2, 3].map((number) => ({ name: `${name}队员${number}`, gender: 'male',
        jersey_no: String(number + index) })) });
  }

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(({ token: savedToken, eventId }) => {
    localStorage.setItem('stss_token', savedToken);
    localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: identity.event_id });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const url = `${base}/#/workspace?event=${identity.event_id}&group=${groupId}&category=${categoryId}&tab=schedule`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();

  // 先制造“会隐藏新场次”的筛选态：状态=已确认（新场次必为“等待前序”）
  const statusFilter = page.getByLabel('状态', { exact: false }).first();
  await statusFilter.selectOption('finished');
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: '新增比赛', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增比赛', exact: true });
  await dialog.waitFor();
  const pickTeams = async (label, index) => {
    const select = dialog.getByLabel(label, { exact: false }).first();
    const values = await select.locator('option').evaluateAll((options) => options
      .map((option) => option.value).filter((value) => value && value !== '0'));
    assert.ok(values.length >= 2, `${label}缺少可报名人员`);
    await select.selectOption(values[index]);
    return values[index];
  };
  await pickTeams('主队', 0);
  await pickTeams('客队', 1);
  await dialog.getByRole('button', { name: '添加比赛', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('已新增比赛，已清除筛选以显示新场次'));
  await page.locator('.schedule-match').first().waitFor();
  assert.equal(await statusFilter.inputValue(), '', '新增比赛后应清空状态筛选');
  assert.equal(await page.getByLabel('场地', { exact: false }).first().inputValue(), '', '新增比赛后应清空场地筛选');
  assert.equal(await page.locator('.schedule-match.flash').count(), 1, '新增场次应高亮定位');
  await page.screenshot({ path: path.join(artifacts, 'new-match-visible.png'), fullPage: true });
  assert.deepEqual(pageErrors, [], '页面不应有未捕获脚本错误');
  console.log('PASS: 筛选态新增比赛后自动清空筛选、提示并高亮新场次');
} finally {
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  child.kill();
  if (serverErrors && !serverErrors.includes('INFO')) console.error(serverErrors.slice(-2000));
}
