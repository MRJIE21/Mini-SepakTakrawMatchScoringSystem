/* 真实浏览器：大屏状态版本必须让 stale / missing 转换自动重绘（无需刷新）。 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.STSS_PYTHON || 'python';
const root = path.resolve(import.meta.dirname, '..');
const helper = path.join(root, 'tests/helpers/display_server.py');
const control = path.join(root, 'tests/helpers/display_live_control.py');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stss-display-redraw-'));
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
    } catch { /* ignore */ }
  });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`display server exit ${code}\n${stderr}`)); });
});

const base = `http://127.0.0.1:${ready.port}`;
const adminHeaders = { Authorization: `Bearer ${ready.admin_token}`, 'Content-Type': 'application/json',
  'X-Client-Protocol': '2', 'X-Event-ID': '1' };
const dbPath = path.join(dataDir, 'events', 'event_1.db');
function controlDb(action) {
  const result = spawnSync(python, ['-B', control, dbPath, action], { encoding: 'utf8' });
  assert.equal(result.status, 0, `display control ${action} failed: ${result.stderr}`);
}
async function api(pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}
await api('/api/display/publish', {
  method: 'POST', headers: adminHeaders,
  body: JSON.stringify({ event_id: 1, layout: 1, mode: 'score', poll_ms: 200,
    slots: [{ match_id: 1, label: '1 号场' }], visible_slots: [0] }),
});

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.STSS_BROWSER_PATH || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript((token) => {
    localStorage.setItem('stss_display_token', token);
  }, ready.display_token);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(base + '/display.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen:not(.hidden) .tile', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.tile')?.innerText.includes('待开始'), null,
    { timeout: 8000 });
  const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  assert.equal(navigations, 1, 'display must not reload the page');

  // live -> stale：快照过期后 2 个轮询周期内自动显示“数据暂未同步”
  controlDb('live');
  await page.waitForFunction(() => document.querySelector('.tile')?.innerText.includes('进行中'), null,
    { timeout: 8000 });
  controlDb('expire');
  await page.waitForFunction(() => document.querySelector('.tile')?.innerText.includes('数据暂未同步'), null,
    { timeout: 8000 });

  // 删除已上屏场次：自动显示“场次不存在”，不刷新
  controlDb('release');
  await api('/api/matches/1', { method: 'DELETE', headers: adminHeaders,
    body: JSON.stringify({ reason: '浏览器状态重绘测试' }) });
  await page.waitForFunction(() => document.querySelector('.tile')?.innerText.includes('场次不存在'), null,
    { timeout: 8000 });
  assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1);
  console.log('PASS display stale/missing auto redraw without refresh');
  await context.close();
} finally {
  await browser.close();
  child.kill();
}
