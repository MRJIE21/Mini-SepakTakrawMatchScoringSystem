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
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const workspace = (cat, tab) => `${base}/#/workspace?event=${identity.event_id}&group=${group.id}&category=${cat.id}&tab=${tab}`;
  await page.goto(workspace(team, 'registration'));


  await page.getByRole('button', { name: '添加参赛学校', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '添加项目报名', exact: true });
  const input = dialog.getByPlaceholder('搜索或新建学校');
  await dialog.getByRole('heading', { name: '添加项目报名', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.modal input[role=combobox]').getAttribute('aria-expanded') === 'false');
  const collapsed = (await dialog.boundingBox()).height;
  await input.fill('清华大学');
  const expanded = (await dialog.boundingBox()).height;
  assert.ok(expanded > collapsed + 40, '下拉展开必须撑高弹窗');
  const scrollState = await dialog.locator('.modal-body').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(scrollState.scroll <= scrollState.height + 1, '空间充足时不应出现弹窗滚动条');
  await dialog.screenshot({ path: path.join(artifacts, 'responsive-school-search.png') });
  await dialog.getByRole('option', { name: '＋ 新建“清华大学”', exact: true }).click();
  await dialog.getByPlaceholder('姓名', { exact: true }).waitFor();
  assert.ok((await dialog.boundingBox()).height > expanded, '动态名单应继续撑高弹窗');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();

  for (const viewport of [{width:1360,height:1000}, {width:900,height:600}, {width:390,height:844}, {width:568,height:320}, {width:320,height:568}]) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      const ui = await import('/js/ui.js');
      const select = ui.searchSelect([{ value: 1, label: '测试学校', hint: '已有学校' }], '', { placeholder: '尺寸测试搜索' });
      const dynamic = ui.h('div');
      window.resizeSelect = select;
      window.resizeDynamic = dynamic;
      window.resizeDialog = ui.modal({ title: '通用弹窗尺寸测试', width: '900px',
        body: ui.h('div.form-grid', ui.h('button.btn', '初始焦点'), ui.field('学校', select), dynamic),
        buttons: [{ label: '保存', keepOpen: true, onClick: () => {} }] });
    });
    dialog = page.getByRole('dialog', { name: '通用弹窗尺寸测试', exact: true });
    const before = (await dialog.boundingBox()).height;
    await dialog.getByPlaceholder('尺寸测试搜索').focus();
    assert.ok((await dialog.boundingBox()).height >= before, '展开不能压缩弹窗');
    await page.evaluate(() => window.resizeSelect.setOptions(Array.from({ length: 30 }, (_, i) => ({ value: i, label: '学校' + i, hint: '用于检验动态长列表' }))));
    const list = dialog.locator('.ss-list');
    assert.equal(await list.evaluate(el => el.scrollHeight > el.clientHeight), true, '长下拉列表内部滚动');
    await dialog.getByPlaceholder('尺寸测试搜索').fill('学校29');
    assert.equal(await list.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, '筛选后立即收缩');
    await page.evaluate(() => {
      for (let i = 0; i < 30; i++) {
        const row = document.createElement('p'); row.textContent = '动态展开的表单内容 ' + i;
        window.resizeDynamic.append(row);
      }
    });
    const panel = await dialog.boundingBox();
    const footer = await dialog.locator('.modal-foot').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width + 1, '弹窗不能横向溢出');
    assert.ok(panel.y >= 0 && panel.y + panel.height <= viewport.height + 1, '弹窗不能超出视口');
    assert.ok(footer.y + footer.height <= viewport.height, '底部操作保持可见');
    assert.equal(await dialog.locator('.modal-body').evaluate(el => el.scrollHeight > el.clientHeight), true, '超出可用高度后才滚动');
    await page.evaluate(() => { window.resizeDynamic.replaceChildren(); });
    assert.ok((await dialog.boundingBox()).height < panel.height, '收起内容后高度及时恢复');
    await dialog.screenshot({ path: path.join(artifacts, 'responsive-dialog-' + viewport.width + 'x' + viewport.height + '.png') });
    await page.evaluate(() => window.resizeDialog.close());
  }
  await page.setViewportSize({width:1360,height:1000});
  await page.evaluate(async () => {
    const ui = await import('/js/ui.js');
    window.resizeDialog = ui.modal({title: '调整窗口测试', body: ui.h('div', { style: 'height:1200px' }, '长表单')});
  });
  await page.setViewportSize({width:390,height:480});
  const resized = await page.getByRole('dialog', {name:'调整窗口测试'}).boundingBox();
  assert.ok(resized.width <= 358 && resized.height <= 448, '打开中的弹窗随窗口即时缩放');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: 报名下拉实时撑高、动态内容展开收起、长列表筛选、5 种屏幕尺寸、窗口实时缩放、底部按钮可见');
} finally {
  if (browser) await browser.close();
  child.kill();
}
