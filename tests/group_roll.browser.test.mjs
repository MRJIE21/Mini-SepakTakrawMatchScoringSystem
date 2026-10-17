/* 三人赛小组抽签「手动起止」滚动验证：独立赛事库 + 真实 Chromium，不写入实际赛事。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-manual-roll-artifacts');
const dataDir = path.join(tmpdir(), `stss-manual-roll-${Date.now()}`);
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
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'Manual123', PYTHONUTF8: '1' },
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const pass = (text) => console.log('PASS ' + text);
let browser, page;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Server timeout')), 15000);
    child.once('error', reject);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      try { const line = JSON.parse(out.split('\n')[0]); clearTimeout(timer); resolve(line.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', event = null;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(event ? { 'X-Event-ID': String(event.event_id), 'X-Event-UUID': event.event_uuid } : {}) } });
    const parsed = await response.json();
    assert.equal(response.ok, true, `${method} ${url} -> ${response.status} ${JSON.stringify(parsed)}`);
    return parsed;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'Manual123' })).token;
  event = await api('POST', '/api/events', { name: '小组抽签手动起止验证', start_date: '2026-10-06' });
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const group = structure.groups[0];
  const cat = group.categories.find((c) => c.kind === 'team' && c.gender === 'male');
  for (let i = 1; i <= 8; i++) {
    const school = await api('POST', `/api/events/${event.event_id}/schools`,
      { name: `手动${i}大学`, short_name: `手动${i}`, group_id: group.id });
    const team = await api('POST', `/api/categories/${cat.id}/teams`, { school_id: school.school_id, name: `手动${i}队` });
    await api('POST', `/api/categories/${cat.id}/participations`, { team_id: team.team_id, seed_no: i });
  }
  const drawPath = `/api/categories/${cat.id}/group-draw`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', reducedMotion: 'no-preference' });
  await context.addInitScript(({ token, eventId }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: event.event_id });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url().replace(base, '')); });
  await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${cat.id}&tab=schedule&view=groups`);
  const panel = page.getByRole('region', { name: '学校小组抽签', exact: true });
  const startBtn = () => panel.getByRole('button', { name: /^开始抽签/, exact: false });
  const stopBtn = () => panel.getByRole('button', { name: '停止并揭晓', exact: true });
  const methodSelect = panel.getByLabel('抽签方式', { exact: true });
  assert.equal(await methodSelect.inputValue(), 'cycle', '默认抽签方式应为循环落位');
  const cycleOption = await methodSelect.locator('option[value="cycle"]').innerText();
  assert.equal(cycleOption.trim(), '循环落位', '选项名称应精简为“循环落位”：' + cycleOption);
  assert.ok(!/A→B|依次|（|\(/.test(cycleOption), '选项名称不应再带括号补充：' + cycleOption);
  assert.ok((await panel.innerText()).includes('循环落位：每签先从剩余学校中随机抽一所'),
    '面板应保留循环落位的规则说明');
  await panel.getByLabel('小组数量', { exact: true }).fill('2');
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await panel.getByText('0 / 8 所学校已揭晓', { exact: true }).waitFor();
  assert.equal(await startBtn().isEnabled(), true, '开始抽签后“开始抽签”必须可用');
  pass('开始小组抽签后按键可用，等待手动开始滚动');

  /* 1. 手动起止：开始→滚动；点停止才揭晓，且定格与后台一致 */
  await startBtn().click();
  await stopBtn().waitFor();
  const rollDiag = await panel.evaluate((el) => ({
    rolling: el.dataset.drawRolling,
    reveal: el.querySelector('.draw-reveal')?.innerText?.replace(/\n/g, ' | '),
  }));
  assert.equal(rollDiag.rolling, 'true', '开始后必须处于滚动状态：' + JSON.stringify(rollDiag));
  assert.match(rollDiag.reveal, /正在滚动/, '滚动期应提示正在滚动');
  assert.equal(await panel.getByRole('button', { name: '一键完成抽签', exact: true }).isDisabled(), true,
    '滚动期间“一键完成抽签”必须冻结');
  assert.equal(await startBtn().count(), 0, '滚动期间不得出现“开始抽签”按钮');
  assert.ok(!/进入 /.test(rollDiag.reveal), '未点停止前不得揭晓小组结果');
  assert.ok(!/后台抽签决定|由后台决定/.test(rollDiag.reveal), '不得再显示把结果归因于后台的说明：' + rollDiag.reveal);
  assert.match(rollDiag.reveal, /点“停止并揭晓”/, '应保留必要的操作提示');
  assert.equal((await panel.locator('.draw-school').innerText()).trim() !== '', true, '滚动期应显示候选学校名');

  await stopBtn().click();
  await panel.getByText('1 / 8 所学校已揭晓', { exact: true }).waitFor();
  const afterStop = await panel.locator('.draw-reveal').innerText();
  const step = (await api('GET', drawPath)).draw.steps.at(-1);
  assert.match(afterStop, new RegExp(step.school_name), `停止后应定格显示抽中学校：${afterStop}`);
  assert.match(afterStop, /进入 /, '停止后应显示进入的小组');
  const drawAfterStop = (await api('GET', drawPath)).draw;
  assert.equal(drawAfterStop.method, 'cycle', '抽签方式应落库为 cycle');

  assert.equal(await panel.locator('[data-draw-rolling="true"]').count(), 0, '定格后不得残留滚动状态');
  assert.equal(await startBtn().isEnabled(), true, '定格后应可开始下一签');
  pass('手动起止：开始后滚动且不自动揭晓，点停止才定格且与后台一致');

  /* 2. 第二签同样需要手动开始与停止 */
  await startBtn().click();
  await stopBtn().click();
  await panel.getByText('2 / 8 所学校已揭晓', { exact: true }).waitFor();
  assert.equal((await api('GET', drawPath)).draw.steps.length, 2);
  pass('第二签仍需手动开始与停止，逐签推进');

  /* 3. 连点、重复停止不得并发多抽 */
  const before = (await api('GET', drawPath)).draw.steps.length;
  const postsBefore = posts.filter((url) => url.endsWith('/next')).length;
  await startBtn().evaluate((button) => { button.click(); button.click(); button.click(); });
  await stopBtn().waitFor();
  await stopBtn().evaluate((button) => { button.click(); button.click(); });
  await panel.getByText('3 / 8 所学校已揭晓', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  const after = (await api('GET', drawPath)).draw.steps.length;
  assert.equal(after, before + 1, '连点开始/停止只允许新增一所');
  const postsAfter = posts.filter((url) => url.endsWith('/next')).length;
  assert.equal(postsAfter - postsBefore, 1, `连点只应发出一次抽签请求：${postsAfter - postsBefore}`);
  pass('连点开始/停止与重复停止只新增一所、只发出一次请求');

  /* 4. 一键完成抽签：连续补齐，不需要手动起止 */
  await panel.getByRole('button', { name: '一键完成抽签', exact: true }).click();
  await panel.getByText('8 / 8 所学校已揭晓', { exact: true }).waitFor();
  const finished = (await api('GET', drawPath)).draw;
  assert.equal(finished.steps.length, 8);
  assert.equal(finished.method, 'cycle');
  assert.deepEqual(finished.steps.map((s) => s.group), [0, 1, 0, 1, 0, 1, 0, 1], '循环落位应为 A,B,A,B…');
  assert.equal(await page.locator('[data-draw-rolling="true"]').count(), 0, '结束后不得残留滚动');
  assert.equal(await page.locator('.draw-school-rolling').count(), 0, '结束后不得残留滚动元素');
  pass('一键完成抽签补齐剩余签次，结束后无残留滚动');

  /* 5. 服务端拒绝：停止滚动并显示错误，不把候选名当结果 */
  await panel.getByRole('button', { name: '撤销本次抽签', exact: true }).click();
  const cancelDialog = page.getByRole('dialog').first();
  await cancelDialog.locator('textarea, input').first().fill('手动起止验证重新抽签');
  await cancelDialog.getByRole('button', { name: '撤销抽签', exact: true }).click();
  await panel.getByLabel('小组数量', { exact: true }).waitFor();
  await panel.getByLabel('小组数量', { exact: true }).fill('2');
  await panel.getByRole('button', { name: '开始小组抽签', exact: true }).click();
  await panel.getByText('0 / 8 所学校已揭晓', { exact: true }).waitFor();
  await page.route('**/group-draw/next', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'draw_conflict', message: '其他设备已更新抽签，请刷新后继续' }) });
  });
  await startBtn().click();
  await stopBtn().click();
  await panel.getByText('其他设备已更新抽签，请刷新后继续', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-draw-rolling="true"]').count(), 0, '拒绝后必须停止滚动');
  assert.equal(await panel.locator('.draw-school-rolling').count(), 0, '拒绝后不得把候选名当结果展示');
  await page.unroute('**/group-draw/next');
  pass('服务端拒绝时停止滚动并显示错误，不把候选名当结果');

  /* 6. 减少动态效果：仍可手动开始与停止，不循环姓名 */
  const reduced = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await reduced.addInitScript(({ token, eventId }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: event.event_id });
  const reducedPage = await reduced.newPage();
  const reducedErrors = [];
  reducedPage.on('pageerror', (error) => reducedErrors.push(error.message));
  await reducedPage.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${cat.id}&tab=schedule&view=groups`);
  const reducedPanel = reducedPage.getByRole('region', { name: '学校小组抽签', exact: true });
  await reducedPanel.getByRole('button', { name: /^开始抽签/, exact: false }).click();
  await reducedPanel.getByRole('button', { name: '停止并揭晓', exact: true }).waitFor();
  const reducedSamples = [];
  for (let i = 0; i < 6; i += 1) {
    const text = await reducedPage.locator('.draw-school-rolling').first().innerText().catch(() => '');
    if (text) reducedSamples.push(text.trim());
    await reducedPage.waitForTimeout(60);
  }
  assert.equal(new Set(reducedSamples).size, 1,
    `减少动态效果下不得循环姓名：${JSON.stringify([...new Set(reducedSamples)])}`);
  await reducedPanel.getByRole('button', { name: '停止并揭晓', exact: true }).click();
  await reducedPanel.getByText('1 / 8 所学校已揭晓', { exact: true }).waitFor();
  assert.deepEqual(reducedErrors, [], JSON.stringify(reducedErrors));
  await reduced.close();
  pass('减少动态效果下不循环姓名，仍可手动开始与停止并定格');

  /* 7. 四档宽度无横向溢出（定格态） */
  for (const width of [320, 390, 768, 1365]) {
    await page.setViewportSize({ width, height: 1000 });
    const dims = await page.evaluate(() => ({ width: innerWidth,
      scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dims.scroll <= width + 1 && dims.body <= width + 1, JSON.stringify(dims));
    await page.screenshot({ path: path.join(artifacts, `manual-roll-${width}.png`), fullPage: true });
  }
  pass('四档宽度无横向溢出');
  assert.deepEqual(pageErrors, [], JSON.stringify(pageErrors));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'manual-roll-failure.png'), fullPage: true });
  console.error('FAILED:', error.message);
  if (stderr) console.error(stderr.slice(-1200));
  process.exitCode = 1;
} finally { if (browser) await browser.close(); child.kill(); }
