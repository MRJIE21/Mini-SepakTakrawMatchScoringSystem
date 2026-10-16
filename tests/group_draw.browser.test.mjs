import { scheduleFixture } from './helpers/schedule_fixture.mjs';
/* 独立赛事库验证抽签全过程；不会写入实际赛事。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-draw-artifacts');
const dataDir = path.join(tmpdir(), `stss-draw-browser-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const code = `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db()
conn=db.connect()
security.ensure_default_users(conn)
conn.close()
load_routes()
class QuietHandler(Handler):
    def log_message(self,*args): pass
server=create_server(('127.0.0.1',0),QuietHandler)
print(json.dumps({'port':server.server_port}),flush=True)
server.serve_forever()
`;
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', code], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'DrawTest123', PYTHONUTF8: '1' },
});
let errors = '';
child.stderr.on('data', (chunk) => { errors += chunk; });
let browser, page;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || 'Server timeout')), 10000);
    child.once('error', reject);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      try { const line = JSON.parse(out.split('\n')[0]); clearTimeout(timer); resolve(line.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', event;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(event ? { 'X-Event-ID': String(event.event_id), 'X-Event-UUID': event.event_uuid } : {}) } });
    const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'DrawTest123' })).token;
  event = await api('POST', '/api/events', { name: '学校小组抽签浏览器验证', start_date: '2026-10-06' });
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const group = structure.groups[0];
  const cat = group.categories.find((c) => c.kind === 'team' && c.gender === 'male');
  for (let i = 1; i <= 10; i++) {
    const school = await api('POST', `/api/events/${event.event_id}/schools`, { name: `第${i}所测试大学`, short_name: `测试大学${i}`, group_id: group.id });
    const team = await api('POST', `/api/categories/${cat.id}/teams`, { school_id: school.school_id, name: `第${i}校代表队` });
    await api('POST', `/api/categories/${cat.id}/participations`, { team_id: team.team_id, seed_no: i });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', colorScheme: 'dark' });
  await context.addInitScript(({ token, eventId }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: event.event_id });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${cat.id}&tab=schedule&view=groups`);
  const panel = page.getByRole('region', { name: '学校小组抽签', exact: true });
  assert.equal(await panel.getByLabel('小组数量', { exact: true }).getAttribute('min'), '1');
  assert.equal(await panel.getByLabel('小组数量', { exact: true }).getAttribute('max'), null);
  await panel.getByLabel('小组数量', { exact: true }).fill('1');
  await panel.getByText('A组 10 校', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '开始小组抽签', exact: true }).isEnabled(), true);
  await panel.getByLabel('小组数量', { exact: true }).fill('10');
  assert.equal(await panel.locator('.draw-capacities .chip').count(), 10);
  assert.equal(await panel.getByRole('button', { name: '开始小组抽签', exact: true }).isEnabled(), true);
  await panel.getByLabel('小组数量', { exact: true }).fill('3');
  await panel.getByLabel('抽签方式', { exact: true }).selectOption('seeded');
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await panel.getByText('0 / 10 所学校已揭晓', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '抽下一所学校', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await panel.getByText('1 / 10 所学校已揭晓', { exact: true }).waitFor();
  const drawPath = `/api/categories/${cat.id}/group-draw`;
  const first = (await api('GET', drawPath)).draw.steps[0];
  await page.reload();
  await panel.getByText('1 / 10 所学校已揭晓', { exact: true }).waitFor();
  assert.deepEqual((await api('GET', drawPath)).draw.steps[0], first);
  const other = await context.newPage();
  await other.goto(page.url());
  const otherPanel = other.getByRole('region', { name: '学校小组抽签', exact: true });
  await otherPanel.getByText('1 / 10 所学校已揭晓', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '抽下一所学校', exact: true }).click();
  await panel.getByText('2 / 10 所学校已揭晓', { exact: true }).waitFor();
  await otherPanel.getByRole('button', { name: '抽下一所学校', exact: true }).click();
  await otherPanel.getByText('其他设备已更新抽签，请刷新后继续', { exact: true }).waitFor();
  assert.equal((await api('GET', drawPath)).draw.revealed, 2);
  await other.close();
  // 服务器已落库但响应丢失：原操作重试应重放，不能又抽出一校。
  await page.route('**/group-draw/next', async (route) => { await route.fetch(); await route.abort('failed'); });
  await panel.getByRole('button', { name: '抽下一所学校', exact: true }).click();
  await panel.getByText('操作结果待核实。请刷新抽签状态，或用原操作重试。', { exact: true }).waitFor();
  assert.equal((await api('GET', drawPath)).draw.revealed, 3);
  await page.unroute('**/group-draw/next');
  await page.getByRole('button', { name: '核实并重试原操作', exact: true }).click();
  await panel.getByRole('button', { name: '刷新抽签状态', exact: true }).click();
  await panel.getByText('3 / 10 所学校已揭晓', { exact: true }).waitFor();
  assert.equal((await api('GET', drawPath)).draw.revealed, 3);
  await panel.getByRole('button', { name: '一键完成抽签', exact: true }).click();
  await panel.getByText('10 / 10 所学校已揭晓', { exact: true }).waitFor();
  const palette = await panel.evaluate((element) => {
    const read = () => {
      const result = { scheme: getComputedStyle(document.documentElement).colorScheme };
      for (const [key, node] of Object.entries({
        canvas: document.body, panel: element, reveal: element.querySelector('.draw-reveal'),
        school: element.querySelector('.draw-school'), destination: element.querySelector('.draw-destination'),
        group: element.querySelector('.draw-group'),
      })) {
        const style = getComputedStyle(node);
        result[key] = { background: style.backgroundColor, color: style.color, opacity: style.opacity };
      }
      result.animation = getComputedStyle(element.querySelector('.draw-reveal')).animationName;
      return result;
    };
    window.drawPaletteChanges = [];
    document.addEventListener('fullscreenchange', () => window.drawPaletteChanges.push(read()));
    return read();
  });
  assert.equal(palette.scheme, 'light');
  assert.equal(palette.panel.background, palette.canvas.background);
  assert.equal(palette.animation, 'none');
  assert.equal(palette.reveal.opacity, '1');
  await panel.screenshot({ path: path.join(artifacts, 'draw-before-fullscreen.png') });
  for (const exit of ['button', 'escape']) {
    await panel.getByRole('button', { name: '全屏展示', exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await panel.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
    if (exit === 'button') await panel.getByRole('button', { name: '退出全屏', exact: true }).click();
    else await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.fullscreenElement);
    await panel.getByRole('button', { name: '全屏展示', exact: true }).waitFor();
  }
  await panel.screenshot({ path: path.join(artifacts, 'draw-after-fullscreen.png') });
  await panel.getByRole('button', { name: '全屏展示', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await panel.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  await panel.locator('.draw-reveal').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await page.screenshot({ path: path.join(artifacts, 'draw-fullscreen.png') });
  await panel.getByRole('button', { name: '确认抽签分组', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => window.drawPaletteChanges.length === 6);
  const paletteChanges = await page.evaluate(() => window.drawPaletteChanges);
  assert.equal(paletteChanges.length, 6);
  for (const colors of paletteChanges) assert.deepEqual(colors, palette, '进入/退出全屏的第一帧应保持配色及不透明度');
  await page.getByRole('dialog', { name: '确认抽签分组', exact: true }).getByRole('button', { name: '确认分组', exact: true }).click();
  await panel.getByText('分组已确认', { exact: true }).waitFor();
  const confirmed = (await api('GET', drawPath)).draw;
  assert.equal(await page.getByRole('button', { name: '建立小组赛阶段', exact: true }).count(), 0);
  await page.getByRole('link', { name: '进入赛程', exact: true }).click();
  await page.getByRole('button', { name: '建立小组赛阶段', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '核对阶段 · 小组赛', exact: true });
  await preview.getByRole('button', { name: '确认正式赛程', exact: true }).click();
  await preview.waitFor({ state: 'detached' });
  const plan = (await api('GET', `/api/categories/${cat.id}/plan`)).plan;
  assert.deepEqual(plan.stages[0].pools.map(p => p.members.map(m => m.participation_id)), confirmed.groups.map(g => g.members.map(m => m.participation_id)));
  assert.equal(plan.stages[0].matches.length, 0, 'draw confirmation does not create fixtures');
  await page.getByRole('navigation', { name: '项目工作台导航', exact: true }).getByRole('link', { name: '分组', exact: true }).click();
  await panel.getByText('分组已确认', { exact: true }).waitFor();
  const popupWait = page.waitForEvent('popup');
  await panel.getByRole('button', { name: '打印分组表', exact: true }).click();
  const popup = await popupWait;
  await popup.getByText('学校小组抽签分组表', { exact: true }).waitFor();
  for (const school of confirmed.roster) assert.equal(await popup.getByText(school.school_name, { exact: true }).count(), 1);
  await popup.close();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(artifacts, 'draw-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await panel.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const headingBox = await panel.getByRole('heading', { name: '学校小组抽签', exact: true }).boundingBox();
  const navBox = await page.locator('.sidenav').boundingBox();
  assert.ok(headingBox.y >= navBox.y + navBox.height, '手机导航不能遮住抽签标题');
  await page.locator('.toast.show').waitFor({ state: 'hidden' });
  await page.locator('.toast').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await panel.screenshot({ path: path.join(artifacts, 'draw-mobile.png') });
  const stage = plan.stages[0];
  const frozen = { event_id: event.event_id, event_uuid: event.event_uuid, deployment_id: (await api('GET', '/api/events')).deployment_id };
  await page.reload();
  await panel.getByText('分组已用于正式赛程，调整前须处理后续引用并撤回小组赛阶段确认', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '撤销本次抽签', exact: true }).count(), 0);
  await api('POST', `/api/schedule-stages/${stage.id}/unconfirm`, { event_identity: frozen, request_uid: crypto.randomUUID(), base_revision: 2, reason: '核对分组' });
  await api('DELETE', `/api/schedule-stages/${stage.id}`, { category_id: cat.id, event_identity: frozen, request_uid: crypto.randomUUID(), base_revision: 3 });
  await page.reload();
  await panel.getByRole('button', { name: '撤销本次抽签', exact: true }).click();
  const reasonDialog = page.getByRole('dialog', { name: '撤销本次抽签', exact: true });
  await reasonDialog.getByLabel(/^撤销原因/).fill('验证重新抽签');
  await reasonDialog.getByRole('button', { name: '撤销抽签', exact: true }).click();
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).waitFor();
  await panel.getByLabel('抽签方式', { exact: true }).selectOption('random');
  await panel.getByLabel('各组人数（可选）', { exact: true }).fill('6,2,2');
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await panel.getByRole('button', { name: '一键完成抽签', exact: true }).click();
  await panel.getByText('10 / 10 所学校已揭晓', { exact: true }).waitFor();
  assert.deepEqual((await api('GET', drawPath)).draw.groups.map((g) => g.members.length), [6, 2, 2]);
  assert.equal((await api('GET', drawPath)).history[0].cancel_reason, '验证重新抽签');
  let latestDraw = (await api('GET', drawPath)).draw;
  await api('POST', drawPath + '/cancel', { draw_id: latestDraw.id, base_rev: latestDraw.rev, request_uid: crypto.randomUUID(), reason: '验证单校小组' });
  await page.reload();
  await panel.getByLabel('小组数量', { exact: true }).fill('3');
  await panel.getByLabel('各组人数（可选）', { exact: true }).fill('8,1,1');
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await panel.getByRole('button', { name: '一键完成抽签', exact: true }).click();
  await panel.getByText('10 / 10 所学校已揭晓', { exact: true }).waitFor();
  latestDraw = (await api('GET', drawPath)).draw;
  assert.deepEqual(latestDraw.groups.map((g) => g.members.length), [8, 1, 1]);
  await api('POST', drawPath + '/cancel', { draw_id: latestDraw.id, base_rev: latestDraw.rev, request_uid: crypto.randomUUID(), reason: '验证单组抽签' });
  await page.reload();
  await panel.getByLabel('小组数量', { exact: true }).fill('1');
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await panel.getByRole('button', { name: '一键完成抽签', exact: true }).click();
  await panel.getByText('10 / 10 所学校已揭晓', { exact: true }).waitFor();
  assert.deepEqual((await api('GET', drawPath)).draw.groups.map((g) => g.members.length), [10]);
  assert.deepEqual(pageErrors, []);
  console.log('PASS: 抽签全过程、单组与单校分组、全屏按钮/Esc/确认退出即时配色一致、固定编排、打印、手机布局及锁定保护');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, 'draw-failure.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(-3000));
  }
  throw error;
} finally { if (browser) await browser.close(); child.kill(); }
