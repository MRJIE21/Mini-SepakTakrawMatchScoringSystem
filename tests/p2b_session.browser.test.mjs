/* P2-B 会话治理真实浏览器回归（REQ-002/006）：退出所有设备、改密踢出其他设备、
   管理员重置踢出全部设备、401 集中回登录页且不循环。

   独立 mkdtemp 数据目录 + 随机端口；不接触产品 data/，不依赖其它套件。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'p2b-session-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
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
class Quiet(Handler):
    def log_message(self, *args): pass
server = create_server(('127.0.0.1', 0), Quiet)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_BACKUPS_DIR: path.join(data, 'backups'), STSS_ADMIN_PASSWORD: 'P2bSession123', PYTHONUTF8: '1' } });

let browser;
let serverErrors = '';
let adminToken = '';
let token = '';
let identity = null;
let page;
const contexts = [];
const checks = [];
const failures = [];
const pageErrors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
const check = async (name, action) => {
  try { await action(); checks.push(name); console.log('PASS ' + name); }
  catch (error) {
    failures.push({ name, message: error.stack || error.message });
    console.error('FAIL ' + name + ': ' + error.message);
    try { if (page) await page.screenshot({ path: path.join(artifacts, `failure-${failures.length}.png`), fullPage: true }); } catch {}
  }
};

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 15000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      try { const info = JSON.parse(text.split('\n')[0]); clearTimeout(timer); resolve(info.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json',
      'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid,
        'X-Deployment-ID': identity.deployment_id } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${url} -> ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const loginToken = async (username, password) => {
    const response = await fetch(base + '/api/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2' },
      body: JSON.stringify({ username, password }) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result.token;
  };
  adminToken = await loginToken('admin', 'P2bSession123');
  token = adminToken;
  identity = null;
  const deployment = (await api('GET', '/api/events')).deployment_id;
  const createdEvent = await api('POST', '/api/events/full', {
    event: { name: 'P2B 会话测试赛事' },
    groups: [{ name: '甲组', code: 'G', categories: [{ name: '男子三人赛', kind: 'team', gender: 'male' }] }],
    venues: [],
  });
  identity = { event_id: createdEvent.event_id, event_uuid: createdEvent.event_uuid, deployment_id: deployment };
  const username = 'twodevice';
  let password = 'P2bUser123';
  await api('POST', '/api/users', { username, display_name: '双设备用户', role: 'viewer',
    password, event_ids: [identity.event_id] });

  const openPage = async (authToken) => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN',
      serviceWorkers: 'block' });
    await context.addInitScript(({ value, eventId }) => {
      /* 每个 context 只注入一次初始令牌：退出所有设备/会话失效后页面会 reload，
         若每次导航都重新写入旧令牌，登录页会立刻再次 401 并覆盖“已退出”提示。 */
      if (!sessionStorage.getItem('p2b_seeded')) {
        sessionStorage.setItem('p2b_seeded', '1');
        localStorage.setItem('stss_token', value);
        localStorage.setItem('stss_event', String(eventId));
      }
      /* 记录最近一次 toast：退出所有设备会在 600ms 后整页重载，测试在重载后仍可核对提示。 */
      let seen = '';
      try { seen = localStorage.getItem('stss_last_toast') || ''; } catch {}
      setInterval(() => {
        const toast = document.getElementById('toast');
        if (!toast || !toast.textContent || toast.textContent === seen) return;
        seen = toast.textContent;
        try { localStorage.setItem('stss_last_toast', seen); } catch {}
      }, 40);
    }, { value: authToken, eventId: identity.event_id });
    const tab = await context.newPage();
    tab.setDefaultTimeout(15000);
    tab.on('pageerror', (error) => pageErrors.push(error.message));
    contexts.push(context);
    return tab;
  };
  const lastToast = (tab) => tab.evaluate(() => localStorage.getItem('stss_last_toast') || '');
  /* toast 由 40ms 轮询写入 localStorage（跨整页重载保留），这里等它落盘再断言。 */
  const waitToast = (tab, text) => tab.waitForFunction((expected) =>
    (localStorage.getItem('stss_last_toast') || '').includes(expected), text, { timeout: 8000 });
  const clearToast = (tab) => tab.evaluate(() => { localStorage.removeItem('stss_last_toast'); });
  const tokenOf = (tab) => tab.evaluate(() => localStorage.getItem('stss_token') || '');
  const gotoAccount = async (tab) => {
    await tab.goto(base + '/#/account');
    await tab.getByRole('heading', { name: '修改我的密码', exact: true }).waitFor();
  };

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });

  /* ---------- 退出所有设备 ---------- */
  await check('REQ-002 退出所有设备：本机回登录页、其他设备 401 回登录页、提示与令牌清理正确', async () => {
    const tokenA = await loginToken(username, password);
    const tokenB = await loginToken(username, password);
    const pageA = await openPage(tokenA);
    const pageB = await openPage(tokenB);
    page = pageA;
    await gotoAccount(pageA);
    await gotoAccount(pageB);
    await clearToast(pageA);
    await pageA.getByRole('button', { name: '退出所有设备', exact: true }).click();
    const dialog = pageA.getByRole('dialog', { name: '退出所有设备', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '退出所有设备', exact: true }).click();
    await pageA.waitForFunction(() => !!document.getElementById('login-screen'));
    await waitToast(pageA, '已退出');
    const toastA = await lastToast(pageA);
    assert.match(toastA, /已退出 \d+ 个设备/, `退出提示不正确：${toastA}`);
    assert.equal(await tokenOf(pageA), '', '本机令牌应被清除');
    assert.equal(await pageA.locator('#login-screen').isVisible(), true);

    let meRequests = 0;
    pageB.on('request', (request) => { if (new URL(request.url()).pathname === '/api/me') meRequests += 1; });
    page = pageB;
    await pageB.reload();
    await pageB.waitForFunction(() => !!document.getElementById('login-screen'));
    await waitToast(pageB, '登录状态已失效');
    const countAfterLogout = meRequests;
    await sleep(800);
    const toastB = await lastToast(pageB);
    assert.ok(toastB.includes('登录状态已失效'), `会话失效提示不正确：${toastB}`);
    assert.equal(await tokenOf(pageB), '', '被吊销设备的令牌应被清除');
    assert.equal(await pageB.locator('#login-screen').isVisible(), true);
    assert.ok(countAfterLogout <= 2, `登录页出现后不应反复请求 /api/me（实际 ${countAfterLogout} 次）`);
    assert.equal(meRequests, countAfterLogout, '登录页出现后不应继续循环请求');

    /* 重新登录仍可用。 */
    await pageB.getByLabel('用户名', { exact: true }).fill(username);
    await pageB.getByLabel('密码', { exact: true }).fill(password);
    await pageB.getByRole('button', { name: '登录', exact: true }).click();
    await pageB.waitForFunction(() => !!localStorage.getItem('stss_token'));
    assert.ok((await tokenOf(pageB)).length > 10);
  });

  /* ---------- 自助改密：保留当前、踢出其他 ---------- */
  await check('REQ-002 改密后其他设备 401 回登录页、当前会话保留', async () => {
    const tokenC = await loginToken(username, password);
    const tokenD = await loginToken(username, password);
    const pageC = await openPage(tokenC);
    const pageD = await openPage(tokenD);
    page = pageC;
    await gotoAccount(pageC);
    await gotoAccount(pageD);
    await clearToast(pageC);
    await pageC.getByLabel('当前密码', { exact: true }).fill(password);
    const nextPassword = 'P2bUser456';
    await pageC.getByLabel('新密码', { exact: true }).fill(nextPassword);
    await pageC.getByRole('button', { name: '更新密码', exact: true }).click();
    await waitToast(pageC, '密码已更新');
    const toastC = await lastToast(pageC);
    assert.ok(/已下线|其他设备/.test(toastC), `改密提示应说明其他设备已下线：${toastC}`);

    page = pageD;
    await pageD.reload();
    await pageD.waitForFunction(() => !!document.getElementById('login-screen'));
    await waitToast(pageD, '登录状态已失效');
    assert.ok((await lastToast(pageD)).includes('登录状态已失效'));
    assert.equal(await tokenOf(pageD), '');

    page = pageC;
    const me = await pageC.evaluate(async () => (await import('/js/api.js')).api.get('/api/me'));
    assert.equal(me.user.username, username, '当前设备会话应保留');
    assert.ok((await tokenOf(pageC)).length > 10, '当前设备令牌应保留');
    password = nextPassword;
  });

  /* ---------- 管理员重置：该用户全部设备被踢 ---------- */
  await check('REQ-006 管理员重置口令后提示其他设备下线，该用户全部会话失效', async () => {
    const tokenE = await loginToken(username, password);
    const tokenF = await loginToken(username, password);
    const pageE = await openPage(tokenE);
    const pageF = await openPage(tokenF);
    const adminPage = await openPage(adminToken);
    page = adminPage;
    await gotoAccount(pageE);
    await gotoAccount(pageF);
    await adminPage.goto(base + '/#/users');
    await adminPage.getByRole('heading', { name: '账号列表', exact: true }).waitFor();
    const row = adminPage.getByRole('row').filter({ has: adminPage.getByRole('cell', { name: username, exact: true }) });
    await row.getByRole('button', { name: '重置密码', exact: true }).click();
    const dialog = adminPage.getByRole('dialog', { name: `重置密码 · ${username}`, exact: true });
    await dialog.waitFor();
    await dialog.getByLabel('新密码', { exact: false }).fill('P2bReset789');
    await dialog.getByRole('button', { name: '重置密码', exact: true }).click();
    await waitToast(adminPage, '其他设备已下线');
    const toastAdmin = await lastToast(adminPage);
    assert.ok(toastAdmin.includes('密码已重置') && toastAdmin.includes('其他设备已下线'), toastAdmin);

    for (const [label, tab] of [['设备E', pageE], ['设备F', pageF]]) {
      page = tab;
      await tab.reload();
      await tab.waitForFunction(() => !!document.getElementById('login-screen'));
      assert.equal(await tab.locator('#login-screen').isVisible(), true, `${label} 应回到登录页`);
      assert.equal(await tokenOf(tab), '', `${label} 令牌应被清除`);
    }
    page = pageE;
    await pageE.getByLabel('用户名', { exact: true }).fill(username);
    await pageE.getByLabel('密码', { exact: true }).fill('P2bReset789');
    await pageE.getByRole('button', { name: '登录', exact: true }).click();
    await pageE.waitForFunction(() => !!localStorage.getItem('stss_token'));
    assert.ok((await tokenOf(pageE)).length > 10, '重置后的新口令应可重新登录');
  });

  await check('REQ-006 审计页可切换赛事/账号范围并显示新增动作标签', async () => {
    const adminPage = await openPage(adminToken);
    page = adminPage;
    /* 1.5.0 起审计日志移入“更正与导出”页的 tab；不再单独占 #/admin 首页。 */
    await adminPage.goto(base + '/#/admin?tab=audit');
    await adminPage.getByRole('heading', { name: '维护 · 关键操作记录（最近 60 条）', exact: true }).waitFor();
    await adminPage.locator('#content').getByRole('button', { name: '账号', exact: true }).click();
    await adminPage.waitForFunction(() => (document.querySelector('#content')?.innerText || '').includes('退出所有设备'));
    const text = await adminPage.locator('#content').innerText();
    assert.ok(text.includes('退出所有设备'), 'logout_all 应有中文动作标签');
    assert.ok(text.includes('登录'), '账号范围应显示注册库中的登录类审计');
    assert.equal(await adminPage.getByText('加载失败', { exact: false }).count(), 0);
  });

  assert.deepEqual(pageErrors, [], '页面不应出现脚本异常');
  console.log(`PASS: P2-B 会话治理 ${checks.length} 项检查全部通过`);
} finally {
  await writeFile(path.join(artifacts, 'p2b-session-report.json'),
    JSON.stringify({ checks, failures, pageErrors, serverErrors }, null, 2));
  for (const context of contexts) { try { await context.close(); } catch {} }
  if (browser) { try { await browser.close(); } catch {} }
  child.kill();
}
assert.deepEqual(failures, [], 'P2-B 会话治理回归必须全部通过');
