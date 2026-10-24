import {registrationEdit,registrationProject} from './helpers/registration_ui.mjs';
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
  const team = group.categories.find(c => c.gender === 'male' && c.kind === 'team');
  const individual = group.categories.find(c => c.gender === 'male' && c.kind === 'individual');
  await api('POST', `/api/categories/${team.id}/enrollments`, { school: { name: '学校工作台测试大学' }, members: [{ name: '甲', gender: 'male', jersey_no: '3' }] });
  const school = (await api('GET', `/api/events/${identity.event_id}/schools`)).schools[0];
  const a = (await api('GET', `/api/schools/${school.id}/athletes`)).athletes[0];
  const b = await api('POST', `/api/schools/${school.id}/athletes`, { name: '乙', gender: 'male', jersey_no: '5' });
  browser = await chromium.launch({ executablePath: process.env.STSS_BROWSER_PATH, headless: true });
  const url = `${base}/#/schoolRegistration?event=${identity.event_id}&school=${school.id}`;
  const makeContext = async () => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await context.addInitScript(({ token, event }) => {
      localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
    }, { token, event: identity.event_id });
    return context;
  };
  const context = await makeContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('heading', { name: school.name, exact: true }).waitFor();
  const submit = () => page.locator('[data-action="school-preview"]');
  const openImport = async () => {
    await page.getByRole('button', { name: '粘贴 / 导入学校报名表', exact: true }).click();
    return page.getByRole('dialog', { name: '粘贴 / 导入学校报名表', exact: true });
  };
  let dialog = await openImport();
  await dialog.getByLabel('学校报名表内容').fill(`项目\t运动员\n${team.name}\t甲\n${individual.name}\t甲`);
  await dialog.getByRole('button', { name: '核对表格', exact: true }).click();
  await dialog.getByText('整批校验', { exact: true }).waitFor();
  assert.ok((await dialog.textContent()).includes('不可兼项'));
  assert.equal(await dialog.getByRole('button', { name: '应用到报名表', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await submit().click();
  assert.ok((await page.locator('.form-errors:not(.hidden)').textContent()).includes('尚未合入的表格'));
  await page.reload();
  dialog = await openImport();
  assert.equal(await dialog.getByLabel('学校报名表内容').inputValue(), '', 'unsubmitted pasted text is not restored from the browser');
  const table = `项目\t运动员\t项目号码\t队长\t区分信息\n${team.name}\t乙\t7\t是\t一班\n${team.name}\t丙\t8\t\t三班\n${individual.name}\t甲\t\t\t`;
  await dialog.getByLabel('学校报名表内容').fill(table);
  await dialog.getByRole('button', { name: '核对表格', exact: true }).click();
  await dialog.getByRole('button', { name: '应用到报名表', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => ![...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === '应用到报名表')?.disabled);
  await page.screenshot({ path: path.join(artifacts, 'school-table-preview-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: '应用到报名表', exact: true }).click();
  assert.ok((await (await registrationProject(page,team.id)).textContent()).includes('丙'));
  assert.equal((await api('GET', `/api/categories/${individual.id}/participations`)).participations.length, 0);
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.length, 2);
  // Unsaved edits stay in the current form and never appear on another device.
  assert.equal(await page.getByRole('button', { name: /共享草稿/ }).count(), 0);
  const context2 = await makeContext(), page2 = await context2.newPage();
  page2.on('pageerror', e => errors.push(e.message));
  await page2.goto(url);
  await page2.getByRole('heading', { name: school.name, exact: true }).waitFor();
  assert.ok(!(await (await registrationProject(page2,team.id)).textContent()).includes('丙'));
  assert.ok((await page2.locator('.school-registration-summary').textContent()).includes('后台已保存：1 项报名'));
  const personB = () => page.locator(`[data-person="a:${b.athlete_id}"]`);
  // Lost commit responses replay the original packet after refresh.
  await submit().click();
  await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
  let lostCommit = false;
  await page.route('**/registration-commit', async route => {
    if (!lostCommit) { lostCommit = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await submit().click();
  await page.getByRole('button', { name: '核实并重试原提交', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '核实并重试原提交', exact: true }).click();
  await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.length, 3);
  await page.unroute('**/registration-commit');
  await page2.reload();
  await page2.waitForFunction(id => document.querySelector(`[data-category="${id}"]`)?.textContent.includes('丙'), team.id);
  // CSV upload changes the form only until its normal submission.
  dialog = await openImport();
  await dialog.getByLabel('学校报名 CSV 文件').setInputFiles({ name: 'school.csv', mimeType: 'text/csv', buffer: Buffer.from('\ufeff项目,运动员,区分信息,运动员ID\n,乙,"上传备注,二班",'+b.athlete_id+'\n') });
  await page.waitForFunction(() => document.querySelector('.modal textarea')?.value.includes('上传备注'));
  await dialog.getByRole('button', { name: '核对表格', exact: true }).click();
  await dialog.getByRole('button', { name: '应用到报名表', exact: true }).click();
  await registrationEdit(page);
  assert.equal(await personB().getByLabel('区分信息', { exact: true }).inputValue(), '上传备注,二班');
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.find(p => p.id === b.athlete_id).note, '一班');
  dialog = await openImport();
  const encoded = Buffer.concat([Buffer.from('cfeec4bf2cd4cbb6afd4b12cc7f8b7d6d0c5cfa22cd4cbb6afd4b149440a2cd2d22cb9fab1eab1e0c2ebb6feb0e02c', 'hex'), Buffer.from(String(b.athlete_id)+'\n')]);
  await dialog.getByLabel('学校报名 CSV 文件').setInputFiles({ name: 'gb18030.csv', mimeType: 'text/csv', buffer: encoded });
  await page.waitForFunction(() => document.querySelector('.modal textarea')?.value.includes('国标编码二班'));
  await dialog.getByRole('button', { name: '核对表格', exact: true }).click();
  await dialog.getByRole('button', { name: '应用到报名表', exact: true }).click();
  assert.equal(await personB().getByLabel('区分信息', { exact: true }).inputValue(), '国标编码二班');
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
    await page.screenshot({ path: path.join(artifacts, `school-phase2-${width}.png`), fullPage: true });
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const cacheName = (await caches.keys()).find(name => name.startsWith('stss-shell-'));
    if (!cacheName) throw new Error('Missing offline shell cache');
    const cache = await caches.open(cacheName);
    for (const r of ['/js/schoolRegistrationImport.js', '/js/pendingRequests.js']) if (!await cache.match(r)) throw new Error('Missing offline resource '+r);
  });
  assert.deepEqual(errors, []);
  console.log('PASS: Excel/CSV 导入、移除共享草稿、跨设备仅显示后台报名、原请求响应丢失重试、390/768/1024 布局');
} finally { if (browser) await browser.close(); child.kill(); }
