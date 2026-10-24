/* D08 移动导航真实浏览器验证：≤620px 抽屉 + 底栏；≥621px 保持桌面/平板导航。
   独立临时数据目录与随机端口；不修改产品数据。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'stss-mobile-nav-'));
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
    STSS_EVENTS_DIR: path.join(data, 'events'), STSS_ADMIN_PASSWORD: 'MobileNav123', PYTHONUTF8: '1' },
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
  token = (await api('POST', '/api/login', { username: 'admin', password: 'MobileNav123' })).token;
  const event = await api('POST', '/api/events', { name: '移动导航验证赛' });
  const events = await api('GET', '/api/events');
  identity = { event_id: event.event_id, event_uuid: events.events.find((row) => row.id === event.event_id).uuid,
    deployment_id: events.deployment_id };
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});

  browser = await chromium.launch({ headless: true,
    executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  await context.addInitScript(({ value, eid }) => {
    localStorage.setItem('stss_token', value);
    localStorage.setItem('stss_event', String(eid));
  }, { value: token, eid: event.event_id });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/#/dashboard');
  await page.locator('#btn-mobile-nav').waitFor();
  await page.getByRole('heading', { name: '移动导航验证赛', exact: true }).waitFor();

  const closed = await page.evaluate(() => {
    const toggle = document.getElementById('btn-mobile-nav');
    const nav = document.getElementById('sidenav');
    const bar = document.getElementById('mobile-tabbar');
    return {
      toggleVisible: !!toggle?.getClientRects().length,
      toggleExpanded: toggle?.getAttribute('aria-expanded'),
      navVisible: !!nav?.getClientRects().length && getComputedStyle(nav).visibility !== 'hidden',
      navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : null,
      groups: nav ? nav.querySelectorAll('.nav-group').length : 0,
      links: nav ? nav.querySelectorAll('a').length : 0,
      tabbarVisible: !!bar?.getClientRects().length,
      tabs: bar ? bar.querySelectorAll('.mobile-tab').length : 0,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert.equal(closed.toggleVisible, true);
  assert.equal(closed.navVisible, false, '未打开时抽屉不可见');
  assert.equal(closed.navHeight, 0, '未打开时抽屉不应占用布局高度');
  assert.ok(closed.groups >= 5, `抽屉应保留分组标题：${closed.groups}`);
  assert.ok(closed.links >= 10, `抽屉应保留全部入口：${closed.links}`);
  assert.equal(closed.tabbarVisible, true, '390 下应显示底部快捷导航');
  assert.equal(closed.tabs, 4, `底部应有 4 个入口：${closed.tabs}`);
  assert.ok(closed.overflow <= 1, `390 不得整页横向溢出：${closed.overflow}`);
  pass('390 初始：抽屉关闭、底栏 4 项、无横向溢出', JSON.stringify(closed));

  await page.locator('#btn-mobile-nav').click();
  await page.locator('#sidenav.open').waitFor();
  await page.waitForFunction(() => document.activeElement?.closest?.('#sidenav'));
  const opened = await page.evaluate(() => {
    const nav = document.getElementById('sidenav');
    const rect = nav.getBoundingClientRect();
    const groups = [...nav.querySelectorAll('.nav-group')].map((el) => el.textContent.trim());
    const focused = document.activeElement;
    return {
      width: Math.round(rect.width), height: Math.round(rect.height),
      left: Math.round(rect.left), visibility: getComputedStyle(nav).visibility,
      backdrop: !document.getElementById('nav-backdrop')?.hidden,
      expanded: document.getElementById('btn-mobile-nav')?.getAttribute('aria-expanded'),
      focusedInNav: !!focused?.closest?.('#sidenav'),
      groups,
      bodyLocked: document.body.classList.contains('nav-open'),
    };
  });
  assert.ok(opened.width >= 240 && opened.width <= 322, `抽屉宽度应适中：${opened.width}`);
  assert.ok(opened.height >= 800, `抽屉应接近视口高度：${opened.height}`);
  assert.equal(opened.visibility, 'visible');
  assert.equal(opened.backdrop, true);
  assert.equal(opened.expanded, 'true');
  assert.equal(opened.focusedInNav, true, '打开后焦点应进入抽屉');
  assert.equal(opened.bodyLocked, true);
  assert.ok(opened.groups.includes('赛事管理') && opened.groups.includes('项目与赛程') && opened.groups.includes('成绩'), JSON.stringify(opened.groups));
  pass('抽屉：打开、分组树、焦点、遮罩、滚动锁', JSON.stringify({ width: opened.width, height: opened.height, groups: opened.groups }));

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('sidenav')?.classList.contains('open'));
  assert.equal(await page.locator('#btn-mobile-nav').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#nav-backdrop').evaluate((el) => el.hidden), true);
  pass('Escape 关闭抽屉并恢复 aria/遮罩');

  await page.locator('#btn-mobile-nav').click();
  await page.locator('#sidenav.open').waitFor();
  await page.locator('#sidenav a[data-view="workspace"]').click();
  await page.waitForFunction(() => location.hash.startsWith('#/workspace'));
  await page.waitForFunction(() => !document.getElementById('sidenav')?.classList.contains('open'));
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('nav-open'))));
  pass('点击抽屉入口后跳转并自动关闭', page.url());

  await page.setViewportSize({ width: 834, height: 1112 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tablet = await page.evaluate(() => ({
    toggle: !!document.getElementById('btn-mobile-nav')?.getClientRects().length,
    tabbar: !!document.getElementById('mobile-tabbar')?.getClientRects().length,
    sidenav: !!document.getElementById('sidenav')?.getClientRects().length,
    sidenavMode: getComputedStyle(document.getElementById('sidenav')).position,
  }));
  assert.equal(tablet.toggle, false);
  assert.equal(tablet.tabbar, false);
  assert.equal(tablet.sidenav, true);
  assert.notEqual(tablet.sidenavMode, 'fixed');
  pass('834 保持平板/桌面导航，不显示抽屉按钮与底栏', JSON.stringify(tablet));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const desktop = await page.evaluate(() => ({
    toggle: !!document.getElementById('btn-mobile-nav')?.getClientRects().length,
    tabbar: !!document.getElementById('mobile-tabbar')?.getClientRects().length,
    sidenav: !!document.getElementById('sidenav')?.getClientRects().length,
  }));
  assert.equal(desktop.toggle, false);
  assert.equal(desktop.tabbar, false);
  assert.equal(desktop.sidenav, true);
  pass('1440 保持桌面侧栏', JSON.stringify(desktop));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(artifacts, 'mobile-nav-390.png'), fullPage: true });
  assert.deepEqual(errors, [], `页面脚本错误：${JSON.stringify(errors)}`);
  await writeFile(path.join(artifacts, 'mobile-nav-report.json'),
    JSON.stringify({ status: 'PASS', checks, closed, opened, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'mobile-nav-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}
