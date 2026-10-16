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
  const team = group.categories.find(c => c.gender === 'male' && c.kind === 'team');
  const individual = group.categories.find(c => c.gender === 'male' && c.kind === 'individual');
  await api('POST', `/api/categories/${team.id}/enrollments`, { school: { name: '学校工作台测试大学' }, members: [{ name: '甲', gender: 'male', jersey_no: '3' }] });
  const school = (await api('GET', `/api/events/${identity.event_id}/schools`)).schools[0];
  const a = (await api('GET', `/api/schools/${school.id}/athletes`)).athletes[0];
  const b = await api('POST', `/api/schools/${school.id}/athletes`, { name: '乙', gender: 'male', jersey_no: '5' });
  browser = await chromium.launch({ executablePath: process.env.STSS_BROWSER_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  const page = await context.newPage(), errors = [];
  await installLegacyRosterFixture(page);
  page.on('pageerror', error => errors.push(error.message));
  const url = `${base}/#/schoolRegistration?event=${identity.event_id}&school=${school.id}`;
  await page.goto(url);
  await page.getByRole('heading', { name: school.name, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /共享草稿/ }).count(), 0);
  const project = cat => page.locator(`[data-category="${cat.id}"]`);
  assert.ok((await project(individual).textContent()).includes('尚未决定'));
  // Neither matching-base nor stale cached rosters may replace backend people/projects.
  const formal = await api('GET', `/api/schools/${school.id}/registration-workspace`);
  const poison = async stale => page.evaluate(async ({ formal, stale }) => {
    const scope = `admin:${formal.event_identity.deployment_id}:${formal.event_identity.event_uuid}`;
    const local = structuredClone(formal);
    local.people[0].name = '未同步的本机姓名';
    local.people.push({ key: 'new:cached-only', name: '未同步的新增人员', gender: 'male' });
    for (const p of local.projects) Object.assign(p, { choice: 'participate', members: [], captain_key: '', athlete_key: '' });
    const oldBase = structuredClone(formal);
    if (stale) oldBase.base_hash = 'old-browser-base';
    localStorage.setItem(`stss_draft:${scope}:school-registration:${formal.school.id}:${formal.group.id}`, JSON.stringify({ values: { base: oldBase, model: local, sharedRev: -1 } }));
  }, { formal, stale });
  for (const stale of [false, true]) {
    await poison(stale);
    await page.reload();
    await page.getByRole('heading', { name: school.name, exact: true }).waitFor();
    assert.equal(await project(team).getByLabel('甲本项目号码', { exact: true }).inputValue(), '3');
    assert.ok((await page.locator('.school-registration-summary').textContent()).includes('后台已保存：1 项报名'));
    assert.equal(await page.locator('[data-resolve]').count(), 0);
    await page.getByRole('tab', { name: '人员名单', exact: true }).click();
    assert.equal(await page.locator('.school-registration-person').count(), 2);
    assert.equal(await page.locator(`[data-person="a:${a.id}"]`).getByLabel('姓名', { exact: true }).inputValue(), '甲');
    await page.getByRole('tab', { name: '项目报名', exact: true }).click();
  }
  await project(team).getByRole('button', { name: '移除', exact: true }).click();
  await project(team).getByLabel(`${team.name}选人`, { exact: true }).selectOption(`a:${b.athlete_id}`);
  await project(individual).getByLabel('参赛选择').selectOption('participate');
  await project(individual).getByLabel(`${individual.name}选人`, { exact: true }).selectOption(`a:${a.id}`);
  for (const cat of group.categories.filter(c => c.gender === 'female')) await project(cat).getByLabel('参赛选择').selectOption('not_participating');
  assert.ok((await page.locator('.school-registration-summary').textContent()).includes('后台已保存：1 项报名'), 'unsubmitted inputs cannot change formal statistics');
  await page.screenshot({ path: path.join(artifacts, 'school-workspace-projects-desktop.png'), fullPage: true });
  const submit = () => page.locator('[data-action="school-preview"]');
  await submit().click();
  await page.getByRole('heading', { name: '核对整批变更', exact: true }).waitFor();
  assert.ok((await page.locator('.school-registration-content').textContent()).includes('乙（号码 5）'));
  assert.ok((await page.locator('.school-registration-content').textContent()).includes('队员不足 3 人'));
  const before = await api('GET', `/api/categories/${individual.id}/participations`);
  assert.equal(before.participations.length, 0, 'preview must not write');
  await page.screenshot({ path: path.join(artifacts, 'school-workspace-review-desktop.png'), fullPage: true });
  // Deliver the request to the server, but lose its success response. Retry after reload.
  let lost = false;
  await page.route('**/registration-commit', async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await submit().click();
  await page.getByRole('button', { name: '核实并重试原提交', exact: true }).waitFor();
  assert.equal((await api('GET', `/api/categories/${individual.id}/participations`)).participations.length, 1);
  await page.reload();
  await page.getByRole('button', { name: '核实并重试原提交', exact: true }).waitFor();
  assert.equal(await project(team).getByLabel('参赛选择').isDisabled(), true);
  assert.equal(await project(team).getByLabel('乙本项目号码', { exact: true }).inputValue(), '5', 'lost-response recovery displays the saved backend roster');
  await submit().click();
  await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.length, 2);
  await page.unroute('**/registration-commit');
  // Refresh ignores local inputs; an in-session concurrency rejection loads backend values.
  await page.getByRole('tab', { name: '人员名单', exact: true }).click();
  const ar = () => page.locator(`[data-person="a:${a.id}"]`);
  await ar().getByLabel('区分信息', { exact: true }).fill('本机二班');
  await page.reload();
  await page.getByRole('tab', { name: '人员名单', exact: true }).click();
  assert.equal(await ar().getByLabel('区分信息', { exact: true }).inputValue(), '');
  assert.equal(await submit().isDisabled(), true);
  await ar().getByLabel('区分信息', { exact: true }).fill('本机二班');
  await api('PUT', `/api/athletes/${a.id}`, { note: '其他窗口三班' });
  await submit().click();
  await page.getByText('后台报名已被其他入口更新，已读取最新名单。当前未提交修改未生效，请重新填写。', { exact: true }).waitFor();
  assert.equal(await ar().getByLabel('区分信息', { exact: true }).inputValue(), '其他窗口三班');
  assert.equal(await submit().isDisabled(), true);
  assert.equal(await page.locator('select[data-resolve]').count(), 0);
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.find(p => p.id === a.id).note, '其他窗口三班');
  await ar().getByLabel('区分信息', { exact: true }).fill('重新填写二班');
  await submit().click();
  await page.getByRole('button', { name: '确认整批提交' }).waitFor();
  await page.route('**/registration-workspace', route => route.abort('failed'));
  await submit().click();
  const reread = page.getByRole('button', { name: '读取最新正式名单', exact: true });
  await reread.waitFor();
  assert.equal(await reread.isEnabled(), true, 'a failed refresh must leave backend reload available');
  assert.equal(await page.locator('.school-registration-person').count(), 0, 'unverified inputs are not presented as saved records');
  assert.equal(await page.locator('.school-registration-summary').textContent(), '报名提交成功，等待读取后台最新统计');
  await page.unroute('**/registration-workspace');
  await reread.click();
  await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.find(p => p.id === a.id).note, '重新填写二班');
  // Existing occupied athletes are still included in same-name verification.
  await page.getByRole('tab', { name: '人员名单', exact: true }).click();
  await page.getByText('＋ 新增人员', { exact: true }).click();
  await page.getByLabel('新增人员姓名', { exact: true }).fill('甲');
  assert.ok((await page.locator('.same-name-review').textContent()).includes(individual.name));
  await page.getByLabel('新增人员区分信息', { exact: true }).fill('另一位四班');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '添加人员', exact: true }).click();
  await submit().click(); await page.getByRole('button', { name: '确认整批提交' }).waitFor();
  await submit().click(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor();
  assert.equal((await api('GET', `/api/schools/${school.id}/athletes`)).athletes.filter(p => p.name === '甲').length, 2);
  // Legacy team quick-add uses the same complete same-name review.
  const legacy = await api('POST', `/api/events/${identity.event_id}/schools`, { name: '旧入口同名测试校', group_id: group.id });
  const original = await api('POST', `/api/schools/${legacy.school_id}/athletes`, { name: '同名队员', gender: 'male', note: '一班' });
  await api('POST', `/api/categories/${individual.id}/participations`, { athlete_id: original.athlete_id });
  await page.goto(`${base}/?legacy_fixture=1#/legacyRosterTest?event=${identity.event_id}&group=${group.id}&category=${team.id}`);
  await page.getByRole('button', { name: '添加参赛学校', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加项目报名', exact: true });
  await dialog.getByPlaceholder('搜索或新建学校').fill('旧入口同名测试校');
  await dialog.getByRole('option').filter({ hasText: '旧入口同名测试校' }).click();
  await dialog.getByPlaceholder('姓名', { exact: true }).fill('同名队员');
  assert.ok((await dialog.locator('.same-name-review').textContent()).includes('一班'));
  await dialog.getByPlaceholder('班级、学号等区分信息').fill('另一位二班');
  await dialog.locator('.same-name-review input[type=checkbox]').check();
  await dialog.getByRole('button', { name: '加入名单', exact: true }).click();
  await dialog.getByRole('button', { name: '确认报名', exact: true }).click();
  await Promise.race([dialog.waitFor({ state: 'detached' }), dialog.locator('.form-errors:not(.hidden)').waitFor().then(async () => {
    throw new Error(await dialog.locator('.form-errors:not(.hidden)').textContent());
  })]);
  assert.equal((await api('GET', `/api/schools/${legacy.school_id}/athletes`)).athletes.length, 2);
  // Create-school UI can enter its own workspace without separate personnel setup.
  await page.goto(`${base}/#/schoolRegistration?event=${identity.event_id}`);
  await page.getByRole('button', { name: '新增学校', exact: true }).click();
  const newSchool = page.getByRole('dialog', { name: '新增学校', exact: true });
  await newSchool.getByLabel('学校名称').fill('界面创建测试校');
  await newSchool.getByRole('button', { name: '创建并整理报名', exact: true }).click();
  await page.getByRole('heading', { name: '界面创建测试校', exact: true }).waitFor();
  assert.equal(await page.locator('.school-registration-project').count(), group.categories.length);
  await page.goto(url);
  await page.getByRole('tab', { name: '人员名单', exact: true }).click();
  await page.getByText('＋ 新增人员', { exact: true }).click();
  await page.getByLabel('新增人员姓名', { exact: true }).fill('尚未加入的人员');
  await page.reload();
  await page.getByRole('tab', { name: '人员名单', exact: true }).click();
  assert.equal(await page.getByLabel('新增人员姓名', { exact: true }).inputValue(), '');
  await page.getByText('＋ 新增人员', { exact: true }).click();
  await page.getByLabel('新增人员姓名', { exact: true }).fill('本次尚未加入的人员');
  await submit().click();
  assert.ok((await page.locator('.form-errors:not(.hidden)').textContent()).includes('请先添加新增人员'));
  await page.getByRole('button', { name: '清空新增输入', exact: true }).click();
  await page.getByRole('tab', { name: '项目报名', exact: true }).click();
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
    await page.screenshot({ path: path.join(artifacts, `school-workspace-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const cacheName = (await caches.keys()).find(name => name.startsWith('stss-shell-'));
    if (!cacheName) throw new Error('Missing offline shell cache');
    const cache = await caches.open(cacheName);
    for (const resource of ['/js/views/schoolRegistration.js', '/js/schoolRegistrationModel.js']) if (!await cache.match(resource)) throw new Error('Missing offline resource '+resource);
  });
  console.log('PASS: 后台名单优先、同版本/过期缓存不覆盖、未提交内容不计入统计、并发以后台为准、丢失响应重试、完整同名核对、390/768/1024 布局');
} finally { if (browser) await browser.close(); child.kill(); }
