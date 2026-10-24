import {liveFixture} from './helpers/reviewed_result.mjs';
/* P2-A REQ-003/004/005 真实浏览器检查：
   - 预览角标：只在 ?preview=1 显示、带“预览模式 · 已推送 vN”、dirty 时提示未推送修改，
     版本以服务端 config_revision 为准；正式 /display.html 不显示角标、不预留预览空间；
   - 无效预览：event_id=999999 → 具体原因 + 返回控制台且停止重试；event_id=abc → 参数校验；
     403 保留凭据/权限提示；正常预览仍渲染 tile；
   - 刷新间隔：50/空/250.5 就地报错并禁用推送且不丢焦点，500 恢复；服务端 400 兜底；
   - 控制台预览 URL 携带已推送 revision 与 dirty 快照，预览内容仍是已推送配置。 */
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stss-p2a-preview-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(dataDir, 'artifacts');
await mkdir(dataDir, { recursive: true });
await mkdir(artifacts, { recursive: true });

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
const adminHeaders = {
  Authorization: `Bearer ${ready.admin_token}`, 'Content-Type': 'application/json',
  'X-Client-Protocol': '2', 'X-Event-ID': '1',
};
const recorderHeaders = {
  Authorization: `Bearer ${ready.recorder_token}`, 'Content-Type': 'application/json',
  'X-Client-Protocol': '2', 'X-Event-ID': '1',
};

async function api(pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function publish(body) {
  return api('/api/display/publish', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ event_id: 1, ...body }),
  });
}

async function consoleConfig() {
  return api('/api/display/console?event_id=1', { headers: adminHeaders });
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STSS_BROWSER_PATH || undefined,
});

async function newAdminContext(viewport = { width: 1920, height: 1080 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((token) => {
    try { localStorage.setItem('stss_token', token); } catch { /* ignore */ }
  }, ready.admin_token);
  return context;
}

async function waitPreviewLoaded(page) {
  await page.waitForSelector('#screen:not(.hidden) #preview-badge:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#screen:not(.hidden) .tile', { timeout: 15000 });
}

async function badgeMetrics(page) {
  return page.evaluate(() => {
    const badge = document.getElementById('preview-badge');
    const tile = document.querySelector('#grid .tile');
    const screen = document.getElementById('screen');
    const badgeBox = badge.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    return {
      badgeVisible: !badge.classList.contains('hidden'),
      badgeText: badge.textContent.replace(/\s+/g, ' ').trim(),
      versionText: document.getElementById('pv-version')?.textContent || '',
      dirtyVisible: !document.getElementById('pv-dirty')?.classList.contains('hidden'),
      dirtyText: document.getElementById('pv-dirty')?.textContent || '',
      bodyPreview: document.body.classList.contains('preview'),
      screenPaddingTop: parseFloat(getComputedStyle(screen).paddingTop),
      badgeBottom: badgeBox.bottom,
      tileTop: tileBox.top,
      badgeInsideViewport: badgeBox.left >= 0 && badgeBox.bottom <= window.innerHeight,
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
}

try {
  // 已推送配置：2 窗口 · 比赛 1/2，poll 500；并给比赛 1 一个 live 快照让预览有比分。
  await publish({
    layout: 2, mode: 'score', poll_ms: 500,
    slots: [{ match_id: 1, label: '1 号场' }, { match_id: 2, label: '2 号场' }],
    visible_slots: [0, 1],
  });
  const published = await publish({
    layout: 1, mode: 'score', poll_ms: 500,
    slots: [{ match_id: 1, label: '1 号场' }],
    visible_slots: [0],
  });
  const revision = published.config.revision;
  await liveFixture(base, {
    method: 'POST', headers: recorderHeaders,
    body: JSON.stringify({
      match_id: 1, event_seq: 1, status: 'live', current_set: 2,
      home_points: 12, away_points: 9, home_sets: 1, away_sets: 0,
      sets: [
        { set_no: 1, home_points: 15, away_points: 12, winner_side: 'home' },
        { set_no: 2, home_points: 12, away_points: 9, winner_side: '' },
      ],
      draft_uid: 'p2a-preview-draft', lineup_hash: 'p2a-preview-lineup',
    }),
  });
  assert.ok(revision >= 2, `expected at least 2 publishes, got revision ${revision}`);

  // ---------- REQ-003：预览角标 / 版本 / 草稿提示 ----------
  const previewContext = await newAdminContext();
  const previewPage = await previewContext.newPage();
  // URL 里故意写旧版本 v=0，角标最终必须显示服务端 config_revision。
  await previewPage.goto(`${base}/display.html?preview=1&event_id=1&v=0&dirty=0`, { waitUntil: 'load' });
  await waitPreviewLoaded(previewPage);
  await previewPage.waitForFunction(
    (expected) => document.getElementById('pv-version')?.textContent === `v${expected}`,
    revision, { timeout: 15000 });
  const previewMetrics = await badgeMetrics(previewPage);
  assert.ok(previewMetrics.badgeVisible, 'preview badge must be visible in preview mode');
  assert.ok(previewMetrics.bodyPreview, 'body.preview must be set in preview mode');
  assert.ok(previewMetrics.badgeText.includes('预览模式'), `badge text: ${previewMetrics.badgeText}`);
  assert.ok(previewMetrics.badgeText.includes('已推送'), `badge text: ${previewMetrics.badgeText}`);
  assert.equal(previewMetrics.versionText, `v${revision}`,
    'preview badge version must come from the server config_revision');
  assert.equal(previewMetrics.dirtyVisible, false, 'dirty hint must stay hidden when dirty=0');
  assert.ok(previewMetrics.screenPaddingTop >= 40,
    `preview screen must reserve top space for the badge, got ${previewMetrics.screenPaddingTop}px`);
  assert.ok(previewMetrics.badgeBottom <= previewMetrics.tileTop + 0.5,
    `badge (bottom ${previewMetrics.badgeBottom}) must not cover tiles (top ${previewMetrics.tileTop})`);
  assert.ok(previewMetrics.badgeInsideViewport, 'badge must stay inside the viewport');
  assert.equal(await previewPage.locator('#grid .tile').count(), 1,
    'preview must render the published layout (1 window), not a draft');
  await previewPage.screenshot({ path: path.join(artifacts, 'p2a-preview-badge-1920.png') });

  // 1366 下角标同样不遮挡比赛信息。
  await previewPage.setViewportSize({ width: 1366, height: 768 });
  await previewPage.waitForFunction(() => {
    const size = parseFloat(document.documentElement.style.fontSize);
    return Number.isFinite(size) && Math.abs(size - 11.3778) < 0.2;
  }, null, { timeout: 10000 });
  const previewMetrics1366 = await badgeMetrics(previewPage);
  assert.ok(previewMetrics1366.badgeVisible, 'preview badge must stay visible at 1366x768');
  assert.ok(previewMetrics1366.badgeBottom <= previewMetrics1366.tileTop + 0.5,
    'badge must not cover tiles at 1366x768');
  await previewPage.screenshot({ path: path.join(artifacts, 'p2a-preview-badge-1366.png') });

  // dirty=1：提示“未推送的修改不会显示”，且版本仍是服务端已推送版本。
  const dirtyPage = await previewContext.newPage();
  await dirtyPage.goto(`${base}/display.html?preview=1&event_id=1&v=${revision}&dirty=1`, { waitUntil: 'load' });
  await waitPreviewLoaded(dirtyPage);
  const dirtyMetrics = await badgeMetrics(dirtyPage);
  assert.ok(dirtyMetrics.badgeVisible, 'dirty preview badge must be visible');
  assert.equal(dirtyMetrics.dirtyVisible, true, 'dirty hint must be visible for dirty=1');
  assert.ok(dirtyMetrics.badgeText.includes('未推送的修改不会显示'),
    `dirty hint text: ${dirtyMetrics.badgeText}`);
  assert.equal(dirtyMetrics.versionText, `v${revision}`, 'dirty preview still shows published version');
  await dirtyPage.close();

  // 正式 /display.html：绝不显示预览角标，也不预留预览空间。
  const formalContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await formalContext.addInitScript((token) => {
    try { localStorage.setItem('stss_display_token', token); } catch { /* ignore */ }
  }, ready.display_token);
  const formalPage = await formalContext.newPage();
  await formalPage.goto(base + '/display.html', { waitUntil: 'load' });
  await formalPage.waitForSelector('#screen:not(.hidden) .tile', { timeout: 15000 });
  const formal = await formalPage.evaluate(() => {
    const badge = document.getElementById('preview-badge');
    const screen = document.getElementById('screen');
    return {
      badgeHidden: badge.classList.contains('hidden'),
      badgeVisible: badge.offsetParent !== null,
      bodyPreview: document.body.classList.contains('preview'),
      screenPaddingTop: parseFloat(getComputedStyle(screen).paddingTop),
    };
  });
  assert.equal(formal.badgeHidden, true, 'formal display must keep #preview-badge hidden');
  assert.equal(formal.badgeVisible, false, 'formal display must not paint #preview-badge');
  assert.equal(formal.bodyPreview, false, 'formal display must not get body.preview');
  assert.ok(formal.screenPaddingTop <= 8,
    `formal display must not reserve preview space, got ${formal.screenPaddingTop}px`);
  await formalContext.close();

  // ---------- REQ-004：无效预览 / 403 / 返回控制台 ----------
  const missingPage = await previewContext.newPage();
  let missingPreviewRequests = 0;
  missingPage.on('request', (request) => {
    if (request.url().includes('/api/display/preview')) missingPreviewRequests += 1;
  });
  await missingPage.goto(`${base}/display.html?preview=1&event_id=999999`, { waitUntil: 'load' });
  await missingPage.waitForSelector('#pairing:not(.hidden)', { timeout: 15000 });
  await missingPage.waitForFunction(() => {
    const status = document.getElementById('pair-status');
    return status && status.textContent.includes('赛事不存在');
  }, null, { timeout: 15000 });
  assert.ok((await missingPage.locator('#pair-status').textContent()).includes('赛事不存在'),
    '404 preview must show the server message');
  assert.equal(await missingPage.locator('#pair-refresh').isVisible(), true,
    '404 preview must offer a way back to the console');
  assert.equal((await missingPage.locator('#pair-refresh').textContent()).trim(), '返回控制台');
  assert.equal(await missingPage.locator('#reconnect').isVisible(), false,
    '404 preview must not show the reconnect banner');
  assert.ok(!(await missingPage.locator('body').innerText()).includes('连接中断'),
    '404 preview must not fall back to the generic reconnect message');
  await missingPage.waitForTimeout(2500);
  assert.equal(missingPreviewRequests, 1,
    `404 preview must stop retrying, saw ${missingPreviewRequests} preview requests`);
  await missingPage.screenshot({ path: path.join(artifacts, 'p2a-preview-blocked-404.png') });

  // 返回控制台：直接打开的标签页无法 window.close()，应回退到控制台首页。
  await missingPage.locator('#pair-refresh').click();
  await missingPage.waitForURL((url) => new URL(url).pathname === '/', { timeout: 10000 });
  await missingPage.close();

  const invalidParamPage = await previewContext.newPage();
  let invalidPreviewRequests = 0;
  invalidParamPage.on('request', (request) => {
    if (request.url().includes('/api/display/preview')) invalidPreviewRequests += 1;
  });
  await invalidParamPage.goto(`${base}/display.html?preview=1&event_id=abc`, { waitUntil: 'load' });
  await invalidParamPage.waitForSelector('#pairing:not(.hidden)', { timeout: 15000 });
  const invalidStatus = (await invalidParamPage.locator('#pair-status').textContent()).trim();
  assert.ok(invalidStatus.includes('预览参数无效'), `invalid event_id status: ${invalidStatus}`);
  assert.equal(await invalidParamPage.locator('#pair-refresh').isVisible(), true,
    'invalid event_id preview must offer a way back to the console');
  await invalidParamPage.waitForTimeout(500);
  assert.equal(invalidPreviewRequests, 0,
    'invalid event_id must be rejected before any preview request');
  await invalidParamPage.close();

  // 403：角色无权预览时保留凭据/权限提示，且不重试。
  const forbiddenContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await forbiddenContext.addInitScript((token) => {
    try { localStorage.setItem('stss_token', token); } catch { /* ignore */ }
  }, ready.recorder_token);
  const forbiddenPage = await forbiddenContext.newPage();
  let forbiddenRequests = 0;
  forbiddenPage.on('request', (request) => {
    if (request.url().includes('/api/display/preview')) forbiddenRequests += 1;
  });
  await forbiddenPage.goto(`${base}/display.html?preview=1&event_id=1`, { waitUntil: 'load' });
  await forbiddenPage.waitForSelector('#pairing:not(.hidden)', { timeout: 15000 });
  await forbiddenPage.waitForFunction(() => {
    const status = document.getElementById('pair-status');
    return status && /凭据|权限/.test(status.textContent);
  }, null, { timeout: 15000 });
  const forbiddenStatus = (await forbiddenPage.locator('#pair-status').textContent()).trim();
  assert.ok(/凭据|权限/.test(forbiddenStatus), `403 preview status: ${forbiddenStatus}`);
  assert.equal(await forbiddenPage.locator('#pair-refresh').isVisible(), false,
    '403 preview keeps the credentials hint without the console-back button');
  await forbiddenPage.waitForTimeout(2000);
  assert.equal(forbiddenRequests, 1, `403 preview must stop retrying, saw ${forbiddenRequests} requests`);
  await forbiddenContext.close();

  // ---------- REQ-005：刷新间隔即时校验 ----------
  // 用真实登录流程进入控制台（不预置 stss_token，才能走登录页）。
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', (error) => { console.error('admin pageerror:', error.message); });
  adminPage.on('console', (message) => {
    if (message.type() === 'error') console.error('admin console error:', message.text());
  });
  await adminPage.goto(base + '/', { waitUntil: 'load' });
  await adminPage.waitForSelector('#login-username', { timeout: 15000 });
  await adminPage.fill('#login-username', 'admin');
  await adminPage.fill('#login-password', 'admin123');
  await adminPage.click('form.login-card button[type="submit"]');
  await adminPage.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await adminPage.waitForFunction(() => document.querySelector('#event-select option[value="1"]'), null,
    { timeout: 15000 });
  await adminPage.selectOption('#event-select', '1');
  await adminPage.evaluate(() => { location.hash = '#/display'; });
  await adminPage.waitForFunction(() => document.body.textContent.includes('大屏控制台'), null,
    { timeout: 15000 });
  await adminPage.waitForSelector('.display-slots .slot-card', { timeout: 15000 });

  const pollInput = adminPage.locator('.display-admin-controls input[type="number"]').first();
  const pushButton = adminPage.getByRole('button', { name: /推送到大屏|推送中/ }).first();
  const fieldError = adminPage.locator('.display-panel .field-error, .display-admin-controls .field-error')
    .first();
  await adminPage.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === '推送到大屏');
    return button && !button.disabled;
  }, null, { timeout: 15000 });
  assert.equal(await fieldError.isVisible(), false, 'poll error must start hidden');

  async function assertInvalidPoll(value) {
    await pollInput.fill(value);
    await adminPage.waitForFunction(() => {
      const error = document.querySelector('.display-admin-controls .field-error');
      return error && !error.classList.contains('hidden');
    }, null, { timeout: 5000 });
    const text = (await fieldError.textContent()).trim();
    assert.ok(text.includes('刷新间隔需为 100–1000 的整数毫秒'), `poll error text: ${text}`);
    assert.equal(await pushButton.isDisabled(), true, `push must be disabled when poll_ms="${value}"`);
    const focused = await adminPage.evaluate(() => {
      const input = document.querySelector('.display-admin-controls input[type="number"]');
      return document.activeElement === input;
    });
    assert.equal(focused, true, `poll input must keep focus when validating "${value}" (no draw())`);
  }

  await assertInvalidPoll('50');
  await adminPage.screenshot({ path: path.join(artifacts, 'p2a-console-poll-error.png') });
  await assertInvalidPoll('');
  await assertInvalidPoll('250.5');

  await pollInput.fill('500');
  await adminPage.waitForFunction(() => {
    const error = document.querySelector('.display-admin-controls .field-error');
    return error && error.classList.contains('hidden');
  }, null, { timeout: 5000 });
  assert.equal(await pushButton.isDisabled(), false, 'push must re-enable for a valid poll interval');

  await pushButton.click();
  try {
    await adminPage.waitForFunction(() => {
      const panel = document.querySelector('.display-push-panel');
      return panel && panel.textContent.includes('已推送 v');
    }, null, { timeout: 15000 });
  } catch (error) {
    const panelText = await adminPage.locator('.display-push-panel').innerText().catch(() => '(none)');
    console.error('push panel after click:', panelText);
    throw error;
  }
  const pushedConfig = await consoleConfig();
  assert.equal(pushedConfig.config.poll_ms, 500, 'valid poll interval must still be pushed');

  // 服务端兜底：绕过前端直接提交非法 poll_ms 仍然是 400。
  const rejected = await fetch(base + '/api/display/publish', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      event_id: 1, layout: 1, mode: 'score', poll_ms: 50,
      slots: [{ match_id: 1, label: '1 号场' }], visible_slots: [0],
    }),
  });
  const rejectedPayload = await rejected.json().catch(() => ({}));
  assert.equal(rejected.status, 400, 'server must reject an out-of-range poll interval');
  assert.ok(String(rejectedPayload.message || '').includes('刷新间隔'),
    `server poll error message: ${rejectedPayload.message}`);

  // ---------- REQ-003 控制台联动：预览 URL 携带已推送版本与 dirty 快照 ----------
  const revisionAfterPush = (await consoleConfig()).config.revision;
  async function openPreviewFromConsole() {
    const [popup] = await Promise.all([
      adminContext.waitForEvent('page'),
      adminPage.getByRole('button', { name: '预览当前大屏', exact: true }).click(),
    ]);
    await popup.waitForURL(/\/display\.html\?/, { timeout: 15000 });
    return popup;
  }

  const cleanPopup = await openPreviewFromConsole();
  const cleanUrl = new URL(cleanPopup.url());
  assert.equal(cleanUrl.searchParams.get('preview'), '1');
  assert.equal(cleanUrl.searchParams.get('event_id'), '1');
  assert.equal(cleanUrl.searchParams.get('v'), String(revisionAfterPush),
    'preview URL must carry the published revision');
  assert.equal(cleanUrl.searchParams.get('dirty'), '0', 'clean config must open with dirty=0');
  await waitPreviewLoaded(cleanPopup);
  assert.equal(await cleanPopup.locator('#pv-dirty').isVisible(), false,
    'clean preview must not show the unpushed-changes hint');
  await cleanPopup.close();

  // 制造未推送修改（切到 2 窗口），再开预览：dirty=1，但内容仍是已推送的 1 窗口。
  await adminPage.getByRole('button', { name: '2 窗口', exact: true }).click();
  await adminPage.waitForFunction(() => document.body.textContent.includes('有未推送修改'), null,
    { timeout: 10000 });
  const dirtyPopup = await openPreviewFromConsole();
  const dirtyUrl = new URL(dirtyPopup.url());
  assert.equal(dirtyUrl.searchParams.get('dirty'), '1',
    'dirty config must open the preview with dirty=1');
  assert.equal(dirtyUrl.searchParams.get('v'), String(revisionAfterPush),
    'dirty preview URL must still carry the published revision');
  await waitPreviewLoaded(dirtyPopup);
  await dirtyPopup.waitForFunction(() => {
    const hint = document.getElementById('pv-dirty');
    return hint && !hint.classList.contains('hidden');
  }, null, { timeout: 15000 });
  assert.equal(await dirtyPopup.locator('#pv-dirty').isVisible(), true,
    'dirty console preview must show the unpushed-changes hint');
  assert.equal(await dirtyPopup.locator('#grid .tile').count(), 1,
    'preview must show the published 1-window config, not the dirty 2-window draft');
  await dirtyPopup.close();

  await adminContext.close();
  await previewContext.close();

  console.log('p2a_display_preview: badge/version/dirty, invalid preview, console validation and URL snapshot checks passed');
} finally {
  await browser.close();
  child.kill();
}
