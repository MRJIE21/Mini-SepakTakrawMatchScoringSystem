/* P2-A REQ-001/002 真实浏览器检查：
   - 8 窗口：状态标签 / 局标签 / 局分小分在 1920×1080 计算字号 ≥16px、1366×768 ≥12px；
     小分 pill 允许换行，但不得溢出 tile、不得与比分重叠；
   - 大比分：1>2>3>4>8 严格单调且 1–4 均大于 8，1920/1366 两档都成立；
   - 3840×2160 额外做溢出兜底检查；
   - 每个布局/分辨率截图写入 STSS_BROWSER_ARTIFACTS。 */
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stss-p2a-fonts-'));
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
  Authorization: `Bearer ${ready.admin_token}`, 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
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

const LAYOUTS = [1, 2, 3, 4, 8];
const VISIBLE = { 1: [0], 2: [0, 1], 3: [0, 1, 2], 4: [0, 1, 2, 3], 8: [0, 1, 2, 3, 4, 5, 6, 7] };
const POINTS_REM = { 1: 14, 2: 9.2, 3: 8.4, 4: 7.8, 8: 7.2 };

async function publishLayout(layout, pollMs = 200) {
  return api('/api/display/publish', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      event_id: 1,
      layout,
      mode: 'score',
      poll_ms: pollMs,
      slots: [{ match_id: 1, label: '1 号场' }, { match_id: 2, label: '2 号场' }],
      visible_slots: VISIBLE[layout],
    }),
  });
}

function expectedRoot(width, height) {
  return Math.max(10, Math.min(36, Math.min(width / 1920, height / 1080) * 16));
}

async function waitForLayout(page, layout) {
  await page.waitForFunction((expected) => {
    const grid = document.getElementById('grid');
    return grid && grid.dataset.layout === String(expected)
      && document.querySelectorAll('#grid .tile').length === Number(expected);
  }, layout, { timeout: 15000 });
}

function readMetrics(page) {
  return page.evaluate(() => {
    const px = (node) => (node ? parseFloat(getComputedStyle(node).fontSize) : null);
    const intersects = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5
      && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const tiles = [...document.querySelectorAll('#grid .tile')].map((tile) => {
      const box = tile.getBoundingClientRect();
      const chip = tile.querySelector('.chip');
      const label = tile.querySelector('.setlabel');
      const pill = tile.querySelector('.set-pill');
      const pillBox = pill ? pill.getBoundingClientRect() : null;
      const labelBox = label ? label.getBoundingClientRect() : null;
      const points = [...tile.querySelectorAll('.team .points')].map((node) => node.getBoundingClientRect());
      const inside = (rect) => rect.left >= box.left - 1 && rect.right <= box.right + 1
        && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
      const selectors = ['.tile-top', '.board', '.mid', '.sets', '.setlabel', '.chip', '.set-pill'];
      return {
        chipFont: px(chip),
        labelFont: px(label),
        pillFont: px(pill),
        pointsFont: px(tile.querySelector('.team .points')),
        chipText: chip ? chip.textContent : null,
        labelText: label ? label.textContent : null,
        pillText: pill ? pill.textContent : null,
        tileWidth: box.width,
        tileHeight: box.height,
        overflowX: tile.scrollWidth > tile.clientWidth + 1,
        overflowY: tile.scrollHeight > tile.clientHeight + 1,
        contentsInside: selectors.filter((sel) => tile.querySelector(sel))
          .every((sel) => inside(tile.querySelector(sel).getBoundingClientRect())),
        pillInside: pillBox ? inside(pillBox) : null,
        pillOverlapsPoints: pillBox ? points.some((rect) => intersects(pillBox, rect)) : false,
        labelOverlapsPoints: labelBox ? points.some((rect) => intersects(labelBox, rect)) : false,
      };
    });
    return {
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
      layout: Number(document.getElementById('grid').dataset.layout),
      empty: document.getElementById('grid').classList.contains('empty'),
      tiles,
    };
  });
}

function assertNoOverflow(metrics, where) {
  assert.ok(!metrics.empty, `${where}: grid must not be empty`);
  for (const [index, tile] of metrics.tiles.entries()) {
    assert.ok(!tile.overflowX, `${where}: tile ${index} horizontal overflow`);
    assert.ok(!tile.overflowY, `${where}: tile ${index} vertical overflow (scrollHeight ${tile.tileHeight})`);
    assert.ok(tile.contentsInside, `${where}: tile ${index} content escapes the tile box`);
    if (tile.pillInside !== null) {
      assert.ok(tile.pillInside, `${where}: tile ${index} set-pill escapes the tile box`);
      assert.ok(!tile.pillOverlapsPoints, `${where}: tile ${index} set-pill overlaps a score`);
    }
    if (tile.labelOverlapsPoints !== null) {
      assert.ok(!tile.labelOverlapsPoints, `${where}: tile ${index} setlabel overlaps a score`);
    }
  }
}

function assertEightWindowReadable(metrics, minimum, where) {
  assert.equal(metrics.layout, 8, `${where}: expected 8-window layout`);
  assert.equal(metrics.tiles.length, 8, `${where}: expected 8 tiles`);
  const expected = Math.max(12, 1.06 * metrics.rootFont);
  for (const [index, tile] of metrics.tiles.entries()) {
    assert.ok(tile.chipFont >= minimum - 0.01,
      `${where}: tile ${index} status chip ${tile.chipFont}px < ${minimum}px`);
    assert.ok(tile.labelFont >= minimum - 0.01,
      `${where}: tile ${index} set label ${tile.labelFont}px < ${minimum}px`);
    assert.ok(Math.abs(tile.chipFont - expected) < 0.6,
      `${where}: tile ${index} status chip ${tile.chipFont}px != max(12px, 1.06rem) ${expected}px`);
    assert.ok(Math.abs(tile.labelFont - expected) < 0.6,
      `${where}: tile ${index} set label ${tile.labelFont}px != max(12px, 1.06rem) ${expected}px`);
  }
  const pillTiles = metrics.tiles.filter((tile) => tile.pillFont !== null);
  assert.ok(pillTiles.length >= 1, `${where}: expected at least one rendered set-pill`);
  for (const tile of pillTiles) {
    assert.ok(tile.pillFont >= minimum - 0.01,
      `${where}: set-pill ${tile.pillText} ${tile.pillFont}px < ${minimum}px`);
    assert.ok(Math.abs(tile.pillFont - expected) < 0.6,
      `${where}: set-pill font ${tile.pillFont}px != max(12px, 1.06rem) ${expected}px`);
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STSS_BROWSER_PATH || undefined,
});

try {
  await publishLayout(8);
  await api('/api/display/live', {
    method: 'POST',
    headers: recorderHeaders,
    body: JSON.stringify({
      match_id: 1, event_seq: 1, status: 'live', current_set: 3,
      home_points: 11, away_points: 8, home_sets: 1, away_sets: 1,
      sets: [
        { set_no: 1, home_points: 15, away_points: 11, winner_side: 'home' },
        { set_no: 2, home_points: 9, away_points: 15, winner_side: 'away' },
        { set_no: 3, home_points: 11, away_points: 8, winner_side: '' },
      ],
      draft_uid: 'p2a-fonts-draft', lineup_hash: 'p2a-fonts-lineup',
    }),
  });
  await api('/api/display/live', {
    method: 'POST',
    headers: recorderHeaders,
    body: JSON.stringify({
      match_id: 2, event_seq: 2, status: 'live', current_set: 1,
      home_points: 3, away_points: 2, home_sets: 0, away_sets: 0,
      sets: [{ set_no: 1, home_points: 3, away_points: 2, winner_side: '' }],
      draft_uid: 'p2a-fonts-draft-2', lineup_hash: 'p2a-fonts-lineup-2',
    }),
  });

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript((token) => {
    try { localStorage.setItem('stss_display_token', token); } catch { /* ignore */ }
  }, ready.display_token);
  const page = await context.newPage();
  await page.goto(base + '/display.html', { waitUntil: 'load' });
  await page.waitForSelector('#screen:not(.hidden) .tile', { timeout: 15000 });
  await waitForLayout(page, 8);

  const pointsByLayout = { 1920: {}, 1366: {} };
  const eightMetrics = {};

  // 1920×1080：逐布局测量字号并截图。
  for (const layout of LAYOUTS) {
    await publishLayout(layout);
    await waitForLayout(page, layout);
    const metrics = await readMetrics(page);
    assert.equal(metrics.layout, layout);
    assert.equal(metrics.tiles.length, layout, `1920 layout ${layout}: tile count`);
    assertNoOverflow(metrics, `1920 layout ${layout}`);
    pointsByLayout[1920][layout] = metrics.tiles[0].pointsFont;
    if (layout === 8) eightMetrics[1920] = metrics;
    await page.screenshot({ path: path.join(artifacts, `p2a-fonts-layout-${layout}-1920.png`) });
  }

  // 1366×768：同一批布局重测（fit() 由 resize 触发，不写 @media）。
  const root1366 = expectedRoot(1366, 768);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForFunction((expected) => {
    const size = parseFloat(document.documentElement.style.fontSize);
    return Number.isFinite(size) && Math.abs(size - expected) < 0.2;
  }, root1366, { timeout: 10000 });
  for (const layout of LAYOUTS) {
    await publishLayout(layout);
    await waitForLayout(page, layout);
    const metrics = await readMetrics(page);
    assert.equal(metrics.layout, layout);
    assert.equal(metrics.tiles.length, layout, `1366 layout ${layout}: tile count`);
    assertNoOverflow(metrics, `1366 layout ${layout}`);
    pointsByLayout[1366][layout] = metrics.tiles[0].pointsFont;
    if (layout === 8) eightMetrics[1366] = metrics;
    await page.screenshot({ path: path.join(artifacts, `p2a-fonts-layout-${layout}-1366.png`) });
  }

  // REQ-001：8 窗口可读性下限 + 无溢出/无重叠。
  assertEightWindowReadable(eightMetrics[1920], 16, '1920x1080');
  assertEightWindowReadable(eightMetrics[1366], 12, '1366x768');
  assert.ok(eightMetrics[1920].rootFont > 15.9, `1920 root font ${eightMetrics[1920].rootFont}px`);
  assert.ok(Math.abs(eightMetrics[1366].rootFont - 11.3778) < 0.1,
    `1366 root font ${eightMetrics[1366].rootFont}px`);

  // REQ-002：大比分 1>2>3>4>8 严格单调，且 1–4 均大于 8。
  for (const width of [1920, 1366]) {
    const sizeByLayout = pointsByLayout[width];
    for (const layout of LAYOUTS) {
      const expected = POINTS_REM[layout] * expectedRoot(width, width === 1920 ? 1080 : 768);
      assert.ok(Math.abs(sizeByLayout[layout] - expected) < 1.2,
        `${width} layout ${layout}: points ${sizeByLayout[layout]}px != ${POINTS_REM[layout]}rem`);
    }
    for (let index = 0; index < LAYOUTS.length - 1; index += 1) {
      const larger = LAYOUTS[index];
      const smaller = LAYOUTS[index + 1];
      assert.ok(sizeByLayout[larger] > sizeByLayout[smaller],
        `${width}: layout ${larger} points ${sizeByLayout[larger]}px must exceed layout ${smaller} ${sizeByLayout[smaller]}px`);
    }
    for (const layout of [1, 2, 3, 4]) {
      assert.ok(sizeByLayout[layout] > sizeByLayout[8],
        `${width}: layout ${layout} points must exceed 8-window points`);
    }
  }

  // 3840×2160 可选溢出兜底：8 窗口最高档仍应不溢出。
  await publishLayout(8);
  await waitForLayout(page, 8);
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.waitForFunction((expected) => {
    const size = parseFloat(document.documentElement.style.fontSize);
    return Number.isFinite(size) && Math.abs(size - expected) < 0.2;
  }, expectedRoot(3840, 2160), { timeout: 10000 });
  await page.waitForTimeout(200);
  const metrics4k = await readMetrics(page);
  assert.equal(metrics4k.layout, 8);
  assert.equal(metrics4k.tiles.length, 8);
  assertNoOverflow(metrics4k, '3840x2160 layout 8');
  assertEightWindowReadable(metrics4k, 16, '3840x2160');
  await page.screenshot({ path: path.join(artifacts, 'p2a-fonts-layout-8-3840.png') });

  console.log('p2a_display_fonts: 1920/1366/3840 font size, monotonic ladder and overflow checks passed');
  await context.close();
} finally {
  await browser.close();
  child.kill();
}
