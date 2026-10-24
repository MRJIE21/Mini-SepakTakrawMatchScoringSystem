import {liveFixture} from './helpers/reviewed_result.mjs';
/* 真实浏览器检查：大屏状态、布局切换、公告、配对。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.STSS_PYTHON || 'python';
const helper = path.join(process.cwd(), 'tests/helpers/display_server.py');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stss-display-browser-'));
await mkdir(dataDir, { recursive: true });

const child = spawn(python, ['-B', helper], {
  env: { ...process.env, STSS_DISPLAY_DATA: dataDir, PYTHONDONTWRITEBYTECODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('display server timeout\n' + stderr)), 20000);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const payload = JSON.parse(line);
      if (payload.port) { clearTimeout(timer); lines.close(); resolve(payload); }
    } catch { /* ignore non-JSON logs */ }
  });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`display server exit ${code}\n${stderr}`)); });
});

const base = `http://127.0.0.1:${ready.port}`;
const adminHeaders = { Authorization: `Bearer ${ready.admin_token}`, 'Content-Type': 'application/json',
  'X-Client-Protocol': '2' };
const recorderHeaders = { Authorization: `Bearer ${ready.recorder_token}`, 'Content-Type': 'application/json',
  'X-Client-Protocol': '2', 'X-Event-ID': '1' };
let activeDisplayToken = ready.display_token;

async function api(pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function publish(body) {
  return api('/api/display/publish', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ event_id: 1, ...body }),
  });
}

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.STSS_BROWSER_PATH || undefined });

try {
  await publish({ layout: 1, mode: 'score', slots: [{ match_id: 1, label: '1 号场' }],
    visible_slots: [0] });
  await liveFixture(base, {
    method: 'POST', headers: recorderHeaders,
    body: JSON.stringify({
      match_id: 1, event_seq: 1, status: 'live', current_set: 1,
      home_points: 5, away_points: 3, home_sets: 0, away_sets: 0,
      sets: [{ set_no: 1, home_points: 5, away_points: 3, winner_side: '' }],
      draft_uid: 'browser-draft', lineup_hash: 'browser-lineup',
    }),
  });

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript((token) => {
    try { localStorage.setItem('stss_display_token', token); } catch { /* ignore */ }
  }, ready.display_token);
  const page = await context.newPage();
  await page.goto(base + '/display.html', { waitUntil: 'load' });
  await page.waitForSelector('#screen:not(.hidden) .tile', { timeout: 10000 });

  assert.equal(await page.locator('.tile .team.home .name').first().textContent(), '机械');
  assert.equal(await page.locator('.tile .team.away .name').first().textContent(), '电气');
  assert.equal((await page.locator('.tile .team.home .points').first().textContent()).trim(), '5');
  assert.equal((await page.locator('.tile .team.away .points').first().textContent()).trim(), '3');
  assert.ok((await page.locator('.tile .set-pill').first().textContent()).includes('第1局 5:3'));

  await publish({ layout: 8, mode: 'score', visible_slots: [0, 1, 2, 3, 4, 5, 6, 7] });
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8, null, { timeout: 5000 });
  assert.equal(await page.locator('.tile').count(), 8);

  await publish({ layout: 8, mode: 'announce', announcement_title: '请各队检录',
    announcement_body: '下一场比赛 10 分钟后开始', visible_slots: [0, 1, 2, 3, 4, 5, 6, 7] });
  await page.waitForSelector('#overlay:not(.hidden)', { timeout: 5000 });
  assert.equal(await page.locator('#ov-title').textContent(), '请各队检录');
  assert.equal(await page.locator('#ov-hint').isVisible(), false);

  await publish({ layout: 8, mode: 'standby', visible_slots: [0, 1, 2, 3, 4, 5, 6, 7] });
  await page.waitForFunction(() => document.getElementById('ov-title').textContent === '比赛即将开始');
  assert.equal(await page.locator('#ov-eyebrow').isVisible(), false);
  assert.equal(await page.locator('#ov-text').isVisible(), false);
  assert.equal(await page.locator('#ov-hint').isVisible(), false);
  await context.close();

  const pairContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const pairPage = await pairContext.newPage();
  await pairPage.goto(base + '/display.html', { waitUntil: 'load' });
  await pairPage.waitForSelector('#pairing:not(.hidden) #pair-code', { timeout: 10000 });
  await pairPage.waitForFunction(() => /^\d{6}$/.test(document.getElementById('pair-code').textContent),
    null, { timeout: 5000 });
  const code = await pairPage.locator('#pair-code').textContent();
  await api('/api/display/pair/claim', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ code, event_id: 1, name: '浏览器配对屏' }),
  });
  await pairPage.waitForSelector('#screen:not(.hidden) .tile', { timeout: 10000 });
  activeDisplayToken = await pairPage.evaluate(() => localStorage.getItem('stss_display_token'));
  await pairContext.close();

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 600 } });
  const adminPage = await adminContext.newPage();
  let consoleRefreshCount = 0;
  adminPage.on('request', (request) => {
    if (request.url().includes('/api/display/console')) consoleRefreshCount += 1;
  });
  await adminPage.goto(base + '/', { waitUntil: 'load' });
  await adminPage.waitForSelector('#login-username', { timeout: 10000 });
  await adminPage.fill('#login-username', 'admin');
  await adminPage.fill('#login-password', 'admin123');
  await adminPage.click('form.login-card button[type="submit"]');
  await adminPage.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await adminPage.waitForFunction(() => document.querySelector('#event-select option[value="1"]'), null,
    { timeout: 10000 });
  await adminPage.selectOption('#event-select', '1');
  await adminPage.evaluate(() => { location.hash = '#/display'; });
  await adminPage.waitForFunction(() => document.body.textContent.includes('大屏控制台'), null, { timeout: 10000 });
  await adminPage.waitForSelector('.display-slots .slot-card', { timeout: 10000 });
  await adminPage.locator('.slot-card').last().scrollIntoViewIfNeeded();
  const scrollBefore = await adminPage.evaluate(() => window.scrollY);
  await adminPage.locator('.slot-card select').last().selectOption('2');
  await adminPage.waitForTimeout(300);
  const scrollAfter = await adminPage.evaluate(() => window.scrollY);
  assert.ok(Math.abs(scrollAfter - scrollBefore) < 40,
    `slot selection scrolled from ${scrollBefore} to ${scrollAfter}`);
  await adminPage.getByRole('button', { name: '1 窗口', exact: true }).click();
  await adminPage.waitForTimeout(200);
  await adminPage.locator('.slot-card select').first().selectOption('1');
  await adminPage.locator('input[type="number"]').fill('250');
  await adminPage.getByRole('button', { name: '推送到大屏', exact: true }).click();
  await adminPage.waitForFunction(() => !document.body.textContent.includes('推送中…'), null,
    { timeout: 10000 });
  assert.ok((await adminPage.locator('.display-push-panel').innerText()).includes('已推送 v'));
  await adminPage.waitForTimeout(1200);
  const consoleData = await api('/api/display/console?event_id=1', { headers: adminHeaders });
  assert.equal(consoleData.config.layout, 1);
  assert.equal(consoleData.config.slots[0].match_id, 1);
  assert.equal(consoleData.config.poll_ms, 250);

  const pagePromise = adminPage.context().waitForEvent('page');
  await adminPage.getByRole('button', { name: '预览当前大屏', exact: true }).click();
  const previewPage = await pagePromise;
  await previewPage.waitForSelector('#screen:not(.hidden) .tile', { timeout: 10000 });
  await previewPage.close();
  assert.ok((await adminPage.locator('.display-device-panel').innerText()).includes('在线状态每 5 秒自动刷新'));
  await adminPage.waitForTimeout(5500);
  assert.ok(consoleRefreshCount >= 2, `expected auto-refreshed console status, got ${consoleRefreshCount}`);
  await adminContext.close();

  const operatorContext = await browser.newContext({ viewport: { width: 1440, height: 700 } });
  await operatorContext.addInitScript((value) => {
    try { localStorage.setItem('stss_token', value); } catch { /* ignore */ }
  }, ready.operator_token);
  const operatorPage = await operatorContext.newPage();
  await operatorPage.goto(base + '/', { waitUntil: 'load' });
  await operatorPage.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await operatorPage.waitForFunction(() => location.hash.includes('/display'), null, { timeout: 10000 });
  await operatorPage.waitForFunction(() => document.body.textContent.includes('大屏控制台'), null,
    { timeout: 10000 });
  const operatorNav = await operatorPage.locator('#sidenav').innerText();
  assert.ok(operatorNav.includes('大屏'));
  assert.ok(!operatorNav.includes('账号管理'));
  await operatorContext.close();

  await publish({ layout: 1, mode: 'score', slots: [{ match_id: 2, label: '2 号场' }],
    visible_slots: [0] });
  await api('/api/recording/match/2/claim', {
    method: 'POST', headers: recorderHeaders, body: JSON.stringify({}),
  });
  const recorderContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await recorderContext.addInitScript((value) => {
    try { localStorage.setItem('stss_token', value); } catch { /* ignore */ }
  }, ready.recorder_token);
  const recorderPage = await recorderContext.newPage();
  await recorderPage.goto(base + '/', { waitUntil: 'load' });
  await recorderPage.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await recorderPage.waitForFunction(() => document.querySelector('#event-select option[value="1"]'), null,
    { timeout: 10000 });
  await recorderPage.selectOption('#event-select', '1');
  await recorderPage.evaluate(() => { location.hash = '#/scoring?match=2'; });
  await recorderPage.waitForSelector('.start-set-btn', { timeout: 10000 });
  await recorderPage.click('.start-set-btn');
  await recorderPage.waitForSelector('.add-btn.home:not([disabled])', { timeout: 10000 });
  await recorderPage.click('.add-btn.home');
  await recorderPage.waitForTimeout(800);
  let liveTile = null;
  for (let attempt = 0; attempt < 15 && !liveTile; attempt += 1) {
    const current = await api('/api/display/state', {
      headers: { Authorization: `Display ${activeDisplayToken}` },
    });
    const tile = current.slots?.[0];
    if (tile?.match_id === 2 && tile.status === 'live' && tile.home?.points === 1) liveTile = tile;
    else await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(liveTile, 'scoring page did not sync a live snapshot to the display');
  assert.equal(liveTile.away.points, 0);
  await recorderContext.close();
} finally {
  await browser.close();
  child.kill();
}
