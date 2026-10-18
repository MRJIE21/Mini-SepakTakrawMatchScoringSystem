/* 真实浏览器：大屏操作员的每个可见菜单都能打开，受限路由回角色首页。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stss-operator-nav-'));
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
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', serverCode], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'OperatorNav123', PYTHONUTF8: '1' },
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server timeout\n' + stderr)), 15000);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    try {
      const payload = JSON.parse(output.split('\n')[0]);
      clearTimeout(timer);
      resolve(payload.port);
    } catch { /* ignore */ }
  });
  child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exit ${code}: ${stderr}`)); });
});
const base = `http://127.0.0.1:${port}`;
let token = '';
let identity = null;
async function api(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${method} ${url} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}
token = (await api('POST', '/api/login', { username: 'admin', password: 'OperatorNav123' })).token;
identity = await api('POST', '/api/events', { name: '操作员导航测试' });
await api('POST', `/api/events/${identity.event_id}/bootstrap`);
const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
const group = structure.groups[0];
await api('POST', `/api/events/${identity.event_id}/schools`, { name: '测试学校', group_id: group.id });
await api('POST', '/api/users', { username: 'operator-nav', password: 'Operator123',
  role: 'display_operator', display_name: '大屏操作员', event_ids: [identity.event_id] });
const operator = await api('POST', '/api/login', { username: 'operator-nav', password: 'Operator123' });

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.STSS_BROWSER_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(({ value, event }) => {
    localStorage.setItem('stss_token', value);
    localStorage.setItem('stss_event', String(event));
  }, { value: operator.token, event: identity.event_id });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => location.hash.includes('/display'), null, { timeout: 10000 });
  const nav = await page.locator('#sidenav a').evaluateAll((items) => items.map((a) => ({ text: a.innerText.trim(), href: a.getAttribute('href') })));
  assert.ok(nav.length >= 3, JSON.stringify(nav));
  for (const item of nav) {
    await page.goto(base + '/' + item.href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const text = await page.locator('body').innerText();
    assert.ok(!text.includes('页面加载失败'), `${item.text} 打开失败: ${text.slice(0, 500)}`);
  }
  // 项目工作台只读：默认赛程，成绩页可打开；报名/概览不可达
  await page.goto(base + '/#/workspace', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  assert.ok(page.url().includes('tab=schedule'), `default tab should be read-only schedule: ${page.url()}`);
  assert.ok(!(await page.locator('body').innerText()).includes('页面加载失败'));
  await page.goto(base + '/#/workspace?tab=results', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  assert.ok(page.url().includes('tab=results'), `results tab should open: ${page.url()}`);
  assert.ok(!(await page.locator('body').innerText()).includes('页面加载失败'));
  // 直接访问受限路由应回到角色首页
  await page.goto(base + '/#/users', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  assert.ok(!(await page.locator('body').innerText()).includes('页面加载失败'));
  assert.ok(page.url().includes('#/display'), `expected redirect to display, got ${page.url()}`);
  console.log('PASS display_operator visible menus and restricted-route fallback');
  await context.close();
} finally {
  await browser.close();
  child.kill();
}
