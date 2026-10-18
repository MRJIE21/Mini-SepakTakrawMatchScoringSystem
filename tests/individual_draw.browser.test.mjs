/* 个人赛逐人抽签：真实浏览器 + 隔离 HTTP/SQLite 的端到端验证。

   覆盖 DESIGN_V3 模块「抽签面板和动画」的全部界面行为：
   初态不显示完整排序、滚动/停止/逐人揭晓、未抽完禁止确认、确认后与界面同一排列、
   刷新与响应丢失恢复、存储失败零发送、名单变化与开赛锁、角色权限、键盘、减少动画、
   标签隐藏无幽灵抽取、四宽度无横向溢出，以及旧客户端 426 与旧已提交回执重放。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'individual-draw-process-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const ADMIN = 'DrawProcess123';
const env = { ...process.env, PYTHONUTF8: '1', STSS_DATA_DIR: data,
  STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events') };
const SERVER = `
import json,os
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db();c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class Quiet(Handler):
 def log_message(self,*args):pass
s=create_server(('127.0.0.1',int(os.environ['STSS_TEST_PORT'])),Quiet);print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
`;
/* Node 的 fetch 会拒绝若干「不安全端口」，因此由测试自己选一个安全范围内的端口并重试。 */
const startServer = async () => {
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 25000);
    const proc = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', SERVER],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, STSS_TEST_PORT: String(port), STSS_ADMIN_PASSWORD: ADMIN } });
    let out = '';
    proc.stderr.on('data', (c) => { lastError += c; });
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20000);
      proc.once('error', () => { clearTimeout(timer); resolve(false); });
      proc.once('close', () => { clearTimeout(timer); resolve(false); });
      proc.stdout.on('data', (c) => {
        out += c;
        try { JSON.parse(out.split('\n')[0]); clearTimeout(timer); resolve(true); } catch { /* 等完整首行 */ }
      });
    });
    if (ready) return { proc, port: JSON.parse(out.split('\n')[0]).port };
    proc.kill();
    lastError += `\n端口 ${port} 启动失败，重试`;
  }
  throw new Error(`无法启动隔离服务：${lastError}`);
};
const { proc: child, port } = await startServer();
let browser, page, stderr = '', token = '', identity = null, adminId = 0;
const checks = [], geometry = [], errors = [];
child.stderr.on('data', (c) => { stderr += c; });
const pass = (text) => { checks.push(text); console.log('PASS ' + text); };

/* 在隔离事件库里种入一条「升级前已提交」的旧一次性回执（走后端自己的 content_hash）。 */
const runPython = (code, args = []) => new Promise((resolve, reject) => {
  const proc = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', code, ...args],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '', err = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { err += c; });
  proc.on('error', reject);
  proc.on('close', (status) => status === 0 ? resolve(out.trim()) : reject(new Error(`seed exit ${status}: ${err || out}`)));
});
const SEED = `
import json,sys
from pathlib import Path
from app import db, idempotency
db_path, cid, uid, actor, body_json, result_json = sys.argv[1:7]
conn = db.connect(Path(db_path))
body = json.loads(body_json)
payload = {'path': '/api/categories/%s/individual-draw/confirm' % cid, 'method': 'POST',
           'actor': int(actor), 'body': body}
assert not db.q1(conn, 'SELECT id FROM submissions WHERE uid=?', (uid,)), 'uid already in submissions'
assert not db.q1(conn, 'SELECT uid FROM request_log WHERE uid=?', (uid,)), 'uid already in request_log'
db.insert(conn, 'request_log', {'uid': uid, 'scope': 'individual_draw', 'user_id': int(actor),
    'payload_hash': idempotency.content_hash(payload), 'status': 'succeeded',
    'result_json': json.dumps(json.loads(result_json), ensure_ascii=False), 'message': ''})
conn.commit(); conn.close()
print(json.dumps({'seeded': uid}))
`;

try {
  const base = `http://127.0.0.1:${port}`;
  const headers = (t = token) => ({ 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid,
      'X-Deployment-ID': identity.deployment_id } : {}) });
  const raw = async (method, url, body, t = token) => {
    const res = await fetch(base + url, { method, headers: headers(t), body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };
  const api = async (method, url, body, t = token) => {
    const res = await raw(method, url, body, t);
    assert.ok(res.status >= 200 && res.status < 300, `${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  /* ---------------------------------------------------------------- 准备 */
  const login = await api('POST', '/api/login', { username: 'admin', password: ADMIN });
  token = login.token;
  adminId = login.user.id;
  const event = await api('POST', '/api/events/full', { event: { name: '个人赛逐人抽签验证' },
    groups: [
      { code: '甲', name: '甲组', categories: [
        { name: '男子个人赛', gender: 'male', kind: 'individual' },
        { name: '女子个人赛', gender: 'female', kind: 'individual' }] },
      { code: '乙', name: '乙组', categories: [
        { name: '旧版兼容赛', gender: 'male', kind: 'individual' }] },
    ], venues: [] });
  identity = { event_id: event.event_id, event_uuid: event.event_uuid,
    deployment_id: (await api('GET', '/api/events')).deployment_id };
  const structure = (await api('GET', `/api/events/${event.event_id}/structure`)).groups;
  const group = structure[0];
  const [male, female] = group.categories;
  const [legacy] = structure[1].categories;
  const drawPath = (cid) => `/api/categories/${cid}/individual-draw`;
  const sessionPath = (cid) => `${drawPath(cid)}/session`;
  const enroll = async (cid, count, gender) => {
    for (let i = 1; i <= count; i++) {
      await api('POST', `/api/categories/${cid}/enrollments/individual`,
        { school: { name: `抽签${cid}-${i}校` }, athlete: { name: `选手${cid}-${i}`, gender } });
    }
  };
  await enroll(male.id, 4, 'male');
  await enroll(female.id, 2, 'female');
  await enroll(legacy.id, 2, 'male');
  const maleRoster = (await api('GET', `/api/categories/${male.id}/participations`)).participations;
  assert.equal(maleRoster.length, 4);
  const maleIds = maleRoster.map((row) => row.id).sort((a, b) => a - b);
  const sessionOf = async (cid) => (await api('GET', sessionPath(cid))).session;
  const officialOf = async (cid) => (await api('GET', drawPath(cid))).draw;

  /* ---------------------------------------------------------------- 14. 旧客户端兼容 */
  const preview426 = await raw('POST', `${drawPath(legacy.id)}/preview`, { event_identity: identity });
  assert.equal(preview426.status, 426);
  assert.equal(preview426.body.code, 'client_upgrade_required');
  assert.equal(preview426.body.outcome, 'not_committed');
  assert.equal(preview426.body.detail.not_committed, true);
  const legacyUid = 'legacy-draw-process-0001';
  const legacyBody = { event_identity: identity, request_uid: legacyUid,
    preview_id: 'legacy-preview-token-0001', base_revision: 0 };
  const confirm426 = await raw('POST', `${drawPath(legacy.id)}/confirm`, legacyBody);
  assert.equal(confirm426.status, 426);
  assert.equal(confirm426.body.code, 'client_upgrade_required');
  assert.equal(confirm426.body.detail.not_committed, true);
  /* 升级前已提交的旧回执：种入 request_log 后按原包重放必须返回原 revision 且不写业务数据 */
  const legacyReceipt = { request_uid: legacyUid, event_identity: identity, category_id: legacy.id,
    revision: 3, order_hash: 'legacy-order-hash-0001' };
  await runPython(SEED, [path.join(data, 'events', `event_${event.event_id}.db`), String(legacy.id),
    legacyUid, String(adminId), JSON.stringify(legacyBody),
    JSON.stringify({ draw: { status: 'current', revision: 3, entries: [] }, receipt: legacyReceipt,
      message: '个人赛出场顺序已保存' })]);
  const replayed = await raw('POST', `${drawPath(legacy.id)}/confirm`, legacyBody);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.receipt.revision, 3);
  assert.equal(replayed.body.receipt.order_hash, legacyReceipt.order_hash);
  assert.equal(replayed.body.replayed, true);
  const legacyOfficial = await officialOf(legacy.id);
  assert.equal(legacyOfficial.status, 'none');
  assert.equal(legacyOfficial.revision, 0);
  pass('旧 preview/confirm 未提交请求 426+not_committed；升级前已提交回执按原包重放返回原 revision 且不写业务数据');

  /* ---------------------------------------------------------------- 浏览器 */
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const makePage = async (t, extra = {}) => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN',
      serviceWorkers: 'allow', ...extra });
    await context.addInitScript(({ value, eid }) => {
      localStorage.setItem('stss_token', value);
      localStorage.setItem('stss_event', String(eid));
    }, { value: t, eid: event.event_id });
    const p = await context.newPage();
    p.setDefaultTimeout(15000);
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.accept());
    return p;
  };
  const url = (cid, tab = 'entry') => base
    + `/#/workspace?event=${event.event_id}&group=${group.id}&category=${cid}&tab=${tab}`;
  page = await makePage(token);
  await page.goto(url(male.id));
  await page.locator('.individual-draw').waitFor();

  const panel = () => page.locator('.individual-draw');
  const phaseOf = () => panel().getAttribute('data-draw-phase');
  const button = (name) => page.getByRole('button', { name, exact: true });
  const progress = () => page.locator('.draw-progress-count').innerText();
  const waitPhase = (name, timeout = 15000) => page.waitForFunction(
    (p) => document.querySelector('.individual-draw')?.dataset.drawPhase === p, name, { timeout });
  const waitPicked = (count) => page.waitForFunction((value) => {
    const text = document.querySelector('.draw-progress-count')?.textContent?.trim() || '';
    const m = /^已抽 (\d+) \/ (\d+) 人$/.exec(text);
    return !!m && Number(m[1]) === value;
  }, count);
  const primary = async () => {
    for (const label of ['开始抽签', '重新抽签', '抽下一位']) {
      const target = button(label);
      if (await target.count()) { await target.click(); return label; }
    }
    throw new Error('当前状态没有可用的抽取按钮');
  };
  const stopAndReveal = () => button('停止并揭晓').click();
  const extractLabels = ['开始抽签', '重新抽签', '抽下一位', '停止并揭晓', '确认保存出场顺序'];
  /* 只统计「可实际点击」的抽取按钮：禁用或只读状态下必须为 0 */
  const extractCount = async (target = page) => {
    let total = 0;
    for (const label of extractLabels) {
      const found = target.getByRole('button', { name: label, exact: true });
      const count = await found.count();
      for (let i = 0; i < count; i += 1) if (!await found.nth(i).isDisabled()) total += 1;
    }
    return total;
  };
  const uiRevealed = () => page.locator('.draw-revealed li').evaluateAll((els) => els
    .map((el) => ({ order: Number(el.dataset.drawOrder), name: el.querySelector('.draw-person')?.textContent.trim() }))
    .sort((a, b) => a.order - b.order));
  const uiRevealCard = async () => ({
    order: (await page.locator('.draw-reveal-order').innerText()).trim(),
    name: (await page.locator('.draw-reveal-name').innerText()).trim(),
    school: (await page.locator('.draw-reveal-school').innerText()).trim(),
  });
  const capture = async (state) => {
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 1000 });
      const dims = await page.evaluate(() => ({ width: innerWidth,
        scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(dims.scroll <= width + 1 && dims.body <= width + 1, JSON.stringify({ state, ...dims }));
      geometry.push({ state, ...dims });
      await page.screenshot({ path: path.join(artifacts, `individual-draw-${state}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1365, height: 1000 });
  };

  /* 全屏与按钮稳定性：操作区位置在状态切换前后必须一致（容差 2px）。
     位置按“滚动内容坐标”测量（视口坐标 + 当前滚动量），避免把点击前的
     自动滚动或视口抖动误判成布局位移。 */
  const actionSnapshot = async () => page.evaluate(() => {
    const bar = document.querySelector('[data-draw-actions="true"]');
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    const panel = document.querySelector('.individual-draw');
    const scroller = panel && panel.scrollHeight > panel.clientHeight ? panel : null;
    return {
      y: rect.top + (scroller ? scroller.scrollTop : window.scrollY),
      x: rect.left + (scroller ? scroller.scrollLeft : window.scrollX),
      labels: [...bar.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  });
  const assertSameActions = (before, after, note) => {
    assert.ok(before && after, `${note}：操作区不存在（${JSON.stringify({ before, after })}）`);
    assert.ok(Math.abs(before.y - after.y) <= 2,
      `${note}：操作区顶部位移 ${Math.abs(before.y - after.y)}px（${before.y} → ${after.y}）`);
    assert.ok(Math.abs(before.x - after.x) <= 2,
      `${note}：操作区左侧位移 ${Math.abs(before.x - after.x)}px（${before.x} → ${after.x}）`);
  };
  const fullscreenButton = () => page.locator('[data-draw-fullscreen="true"]');
  const inFullscreen = () => page.evaluate(() => Boolean(document.fullscreenElement));
  /* document.fullscreenElement 会先于全屏布局生效：必须等面板真的贴到视口左上角、
     宽度等于视口宽度后再量基准位置，否则量到的是普通布局的坐标。 */
  const waitFullscreenLayout = () => page.waitForFunction(() => {
    const panel = document.querySelector('.individual-draw');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    return rect.top <= 2 && rect.left <= 2 && rect.width >= innerWidth - 2;
  });

  /* 1. 初态：只显示人数/候选/进度，不显示完整排序；旧正式签表仍可读 */
  assert.equal(await phaseOf(), 'idle');
  assert.equal(await progress(), '已抽 0 / 4 人');
  assert.equal(await page.locator('.draw-candidates li').count(), 4);
  assert.equal(await page.locator('.draw-revealed li').count(), 0);
  assert.equal(await page.locator('.draw-reveal').count(), 0);
  assert.equal(await page.locator('.draw-official').count(), 0);
  assert.equal((await officialOf(male.id)).status, 'none');
  await capture('ready');
  pass('初态只显示人数、候选与进度，不显示完整排序；旧 GET /individual-draw 仍可读');

  /* 1b. 全屏显示：进入/退出、按钮状态、全屏下可继续抽取 */
  assert.equal(await fullscreenButton().count(), 1, '面板头部必须有全屏按钮');
  assert.equal((await fullscreenButton().innerText()).trim(), '全屏显示');
  assert.equal(await fullscreenButton().getAttribute('aria-pressed'), 'false');
  const readyActions = await actionSnapshot();
  await fullscreenButton().click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await waitFullscreenLayout();
  assert.ok(await inFullscreen(), '点击后必须进入全屏');
  assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains('individual-draw')), true,
    '全屏元素必须是抽签面板本身');
  await page.waitForFunction(() => document.querySelector('[data-draw-fullscreen="true"]')?.textContent.trim() === '退出全屏');
  assert.equal(await fullscreenButton().getAttribute('aria-pressed'), 'true');
  const fsViewport = await page.evaluate(() => ({
    inner: { w: innerWidth, h: innerHeight },
    panel: (() => { const r = document.querySelector('.individual-draw').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  assert.ok(fsViewport.panel.w >= fsViewport.inner.w - 2, JSON.stringify(fsViewport));
  assert.ok(fsViewport.overflow <= 1, JSON.stringify(fsViewport));
  geometry.push({ state: 'fullscreen', ...fsViewport });
  await page.screenshot({ path: path.join(artifacts, 'individual-draw-fullscreen-1365.png'), fullPage: false });
  /* 全屏把面板移到视口原点，绝对坐标必然变化；这里比较同一视口内的稳定性：
     全屏内停留、切回普通布局后按钮都回到各自的稳定位置。 */
  const fullscreenActions = await actionSnapshot();
  assert.equal(await fullscreenActions.labels.join('|'), '开始抽签',
    `全屏内按钮应可用：${JSON.stringify(fullscreenActions.labels)}`);
  await page.waitForTimeout(300);
  assertSameActions(fullscreenActions, await actionSnapshot(), '全屏内等待动画帧');
  await fullscreenButton().click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => document.querySelector('[data-draw-fullscreen="true"]')?.textContent.trim() === '全屏显示');
  assert.equal(await fullscreenButton().getAttribute('aria-pressed'), 'false');
  assert.equal(await phaseOf(), 'idle', '退出全屏不得改变抽取状态');
  assertSameActions(readyActions, await actionSnapshot(), '退出全屏回到普通布局');
  pass('全屏显示可进入/退出，面板铺满且无横向溢出，按钮状态与抽取进度保持一致');

  /* 1c. 浏览器侧退出（真实浏览器里的 Esc 或系统退出按钮）后按钮与进度保持。
     说明：无头 Chromium 不实现 Esc 退出全屏的用户手势（已用独立诊断确认：
     Esc 既不到达页面也不退出全屏，而 requestFullscreen/exitFullscreen 正常），
     因此这里用浏览器侧的 exitFullscreen 代表“由浏览器发起退出”，
     验证应用只靠 fullscreenchange 同步状态，不依赖自己的按钮。 */
  await fullscreenButton().click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await waitFullscreenLayout();
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => document.querySelector('[data-draw-fullscreen="true"]')?.textContent.trim() === '全屏显示');
  assert.equal(await phaseOf(), 'idle');
  assert.equal(await progress(), '已抽 0 / 4 人');
  assertSameActions(readyActions, await actionSnapshot(), '浏览器侧退出全屏后');
  pass('浏览器侧退出全屏（真实浏览器为 Esc）后按钮回到“全屏显示”，抽取进度不变');

  /* 1d. 环境不支持或被拒绝：明确提示且不报错、不影响抽取 */
  await page.evaluate(() => {
    window.__originalFullscreen = {
      request: Element.prototype.requestFullscreen,
      enabled: Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenEnabled'),
    };
    Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('测试拒绝全屏', 'NotAllowedError'));
  });
  const errorsBeforeReject = errors.length;
  await fullscreenButton().click();
  await page.locator('[data-draw-fullscreen-notice="true"]').waitFor();
  const noticeText = (await page.locator('[data-draw-fullscreen-notice="true"]').innerText()).trim();
  assert.ok(noticeText.includes('无法进入全屏'), noticeText);
  assert.equal(errors.length, errorsBeforeReject, `拒绝全屏不得产生 pageerror：${JSON.stringify(errors.slice(errorsBeforeReject))}`);
  assert.equal(await inFullscreen(), false);
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = window.__originalFullscreen.request;
    if (window.__originalFullscreen.enabled) {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', window.__originalFullscreen.enabled);
    }
  });
  const afterReject = await actionSnapshot();
  assertSameActions(readyActions, afterReject, '全屏被拒绝后');
  const redrawProbe = await page.evaluate(() => {
    const host = document.getElementById('content');
    window.__drawReplacements = 0;
    window.__drawObserver?.disconnect?.();
    window.__drawObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList?.contains('individual-draw')) window.__drawReplacements += 1;
        }
      }
    });
    window.__drawObserver.observe(host, { childList: true, subtree: true });
    return { hosting: Boolean(host), title: document.querySelector('.individual-draw h3')?.textContent };
  });
  await page.waitForTimeout(600);
  const replacements = await page.evaluate(() => {
    window.__drawObserver.disconnect();
    return { count: window.__drawReplacements, phase: document.querySelector('.individual-draw')?.dataset.drawPhase,
      hidden: document.hidden };
  });
  console.log('REDRAW PROBE', JSON.stringify({ redrawProbe, replacements }));
  await page.evaluate(() => {
    const host = document.getElementById('content');
    window.__probe = { routeContent: 0, hashes: [], errors: [] };
    window.__probeObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList?.contains('route-content')) {
            window.__probe.routeContent += 1;
            window.__probe.hashes.push(location.hash);
          }
        }
      }
    });
    window.__probeObserver.observe(host, { childList: true });
    window.addEventListener('hashchange', () => window.__probe.hashes.push('hashchange:' + location.hash));
    window.addEventListener('error', (e) => window.__probe.errors.push('error:' + e.message));
    window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push('rejection:' + String(e.reason)));
  });
  await page.waitForTimeout(1200);
  console.log('ROUTE PROBE', JSON.stringify(await page.evaluate(() => {
    window.__probeObserver.disconnect();
    return { ...window.__probe, online: navigator.onLine, hash: location.hash };
  })));
  assert.equal(await primary(), '开始抽签', '全屏失败不得影响抽取');
  pass('全屏被拒绝时给出明确提示、无 pageerror，且抽取仍可正常开始');

  /* 诊断：确认开始抽签这一步是否被反复重绘或重复请求打断 */
  const beginProbe = await page.evaluate(async () => {
    const log = { clicks: 0, sessionCalls: [], redraws: 0 };
    const host = document.getElementById('content');
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList?.contains('individual-draw')) log.redraws += 1;
        }
      }
    });
    observer.observe(host, { childList: true });
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      const url = String(args[0]);
      if (url.includes('/individual-draw')) log.sessionCalls.push(url.replace(/^.*individual-draw/, ''));
      return originalFetch(...args);
    };
    const target = [...document.querySelectorAll('[data-draw-actions="true"] button')]
      .find((b) => b.textContent.trim() === '开始抽签');
    if (target) { target.click(); log.clicks = 1; }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    window.fetch = originalFetch;
    observer.disconnect();
    return { ...log, phase: document.querySelector('.individual-draw')?.dataset.drawPhase,
      buttons: [...document.querySelectorAll('[data-draw-actions="true"] button')].map((b) => b.textContent.trim()) };
  });
  console.log('BEGIN PROBE', JSON.stringify(beginProbe));
  if (beginProbe.phase !== 'rolling') throw new Error('开始抽签未进入滚动：' + JSON.stringify(beginProbe));

  /* 2. 已进入滚动；停止并揭晓 → 逐人揭晓（界面不提前显示结果） */
  await page.locator('.draw-roll-name').waitFor();
  await waitPhase('rolling');
  const candidateNames = new Set(await page.locator('.draw-candidates li .draw-candidate-name').allInnerTexts());
  const samples = [];
  for (let i = 0; i < 6; i++) { samples.push((await page.locator('.draw-roll-name').innerText()).trim()); await page.waitForTimeout(150); }
  assert.ok(samples.every((name) => candidateNames.has(name)), JSON.stringify(samples));
  assert.ok(new Set(samples).size > 1, `滚动文案应变化：${JSON.stringify(samples)}`);
  assert.equal(await page.locator('.draw-reveal').count(), 0, '未停止前不得显示结果');
  await capture('rolling');
  await stopAndReveal();
  await page.locator('.draw-reveal[data-draw-reveal="1"]').waitFor();
  await waitPicked(1);
  const first = await uiRevealCard();
  assert.equal(first.order, '出场序号 1');
  assert.ok(candidateNames.has(first.name), first.name);
  assert.ok(first.school.length > 0);
  const afterFirst = await sessionOf(male.id);
  assert.equal(afterFirst.picked, 1);
  assert.equal(afterFirst.order.length, 1);
  assert.equal(afterFirst.revealed[0].name, first.name);
  await capture('revealed');
  pass('开始抽签进入滚动（只展示候选且不提前揭晓），停止并揭晓后显示出场序号 1、姓名与学校，进度 1/4');

  /* 2b. 按钮位置稳定：初态 → 揭晓态 → 等待态之间操作区不得移动 */
  const revealedActions = await actionSnapshot();
  assertSameActions(readyActions, revealedActions, '初态到首次揭晓');
  assert.deepEqual(revealedActions.labels, ['抽下一位', '放弃本次抽取'],
    `揭晓态按钮顺序应稳定：${JSON.stringify(revealedActions.labels)}`);

  /* 2c. 抽取进行中进入全屏：全屏内完成一次揭晓，退出后进度与按钮位置保持 */
  await fullscreenButton().click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await waitFullscreenLayout();
  const sectionHeights = async (note) => {
    const data = await page.evaluate(() => {
      const out = {};
      const panel = document.querySelector('.individual-draw');
      const scroller = panel && panel.scrollHeight > panel.clientHeight ? panel : null;
      out.scrollTop = scroller ? scroller.scrollTop : window.scrollY;
      for (const selector of ['.draw-progress', '[data-draw-actions="true"]', '.draw-body',
        '.draw-main-card', '.draw-roll', '.draw-reveal', '.draw-wait', '.draw-columns', '.draw-live']) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        out[selector] = { top: Math.round(rect.top + out.scrollTop), h: Math.round(rect.height) };
      }
      return out;
    });
    console.log('SECTIONS ' + note, JSON.stringify(data));
    return data;
  };
  const baselinePicked = (await sessionOf(male.id)).picked;
  await page.screenshot({ path: path.join(artifacts, 'individual-draw-fullscreen-idle-1365.png'), fullPage: false });
  await page.evaluate(() => {
    window.__fsChanges = [];
    document.addEventListener('fullscreenchange', () => window.__fsChanges.push(Boolean(document.fullscreenElement)));
  });
  await primary();
  await waitPhase('rolling');
  await page.waitForTimeout(400);
  const fsMidActions = await actionSnapshot();
  assert.deepEqual(await page.evaluate(() => window.__fsChanges.slice(-2)), [],
    '进入滚动不得把全屏元素换掉（全屏元素被移除会让浏览器退出全屏）');
  assertSameActions(fsMidActions, await actionSnapshot(), '全屏内滚动态');
  await stopAndReveal();
  await waitPicked(baselinePicked + 1);
  assertSameActions(fsMidActions, await actionSnapshot(), '全屏内揭晓态');
  assert.ok(await inFullscreen(), '抽取过程不得意外退出全屏');
  await fullscreenButton().click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assertSameActions(revealedActions, await actionSnapshot(), '退出全屏回到普通布局');
  assert.equal((await sessionOf(male.id)).picked, baselinePicked + 1, '全屏内抽取必须被后台真实记录');
  pass('抽取进行中进入全屏可继续逐人揭晓，退出全屏后进度与按钮位置保持');

  /* 4. 未抽完不能确认 */
  assert.equal(await button('确认保存出场顺序').count(), 0);
  pass('未抽完时没有“确认保存出场顺序”入口');

  /* 11. 键盘：Enter/Space 真实触发按钮 */
  const keyboardBase = (await sessionOf(male.id)).picked;
  await button('抽下一位').focus();
  await page.keyboard.press('Enter');
  await waitPhase('rolling');
  await button('停止并揭晓').focus();
  await page.keyboard.press('Space');
  await waitPicked(keyboardBase + 1);
  assert.equal(await phaseOf(), 'revealed');
  pass('键盘 Enter/Space 可触发出场抽取按钮');

  /* 11b. Escape 关闭“放弃本轮抽取”弹窗且不撤销会话 */
  await button('放弃本次抽取').click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.ok(await sessionOf(male.id), '按 Escape 不得撤销会话');
  assert.equal((await sessionOf(male.id)).picked, keyboardBase + 1);
  pass('Escape 只关闭放弃确认弹窗，不撤销后台抽取会话');

  /* 11c. 关闭页面前有未完成进度时触发浏览器的离开提醒；站内切换菜单不弹确认。
     站内守卫只在后台抽取请求进行中（busy）时短暂拦住，避免死锁。 */
  const blocked = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    /* 浏览器实现不同：有的用 preventDefault，有的只看 returnValue。 */
    return { prevented: event.defaultPrevented, legacy: !!event.returnValue };
  });
  assert.ok(blocked.prevented || blocked.legacy,
    `有未完成抽取进度时关闭页面必须触发离开提醒（实际 ${JSON.stringify(blocked)}）`);
  const leaving = await page.evaluate(async () => {
    const ui = await import('/js/ui.js');
    return ui.prepareNavigation();
  });
  assert.equal(leaving, true, '空闲时站内切换菜单不得被离开确认拦下');
  assert.equal((await sessionOf(male.id)).picked, keyboardBase + 1);
  pass('关闭页面前触发离开提醒且站内切换不被拦截，会话与进度不变');

  /* 3. 抽完 N/N → 才出现确认；确认后正式顺序与界面累计揭晓顺序同一排列 */
  while (true) {
    const current = (await sessionOf(male.id))?.picked ?? 0;
    if (current >= 4) break;
    await primary();
    await waitPhase('rolling');
    await stopAndReveal();
    await waitPicked(current + 1);
  }
  await waitPicked(4);
  await waitPhase('complete');
  const completeButton = button('确认保存出场顺序');
  await completeButton.waitFor();
  assert.equal(await completeButton.isDisabled(), false);
  await capture('complete');
  const completeActions = await actionSnapshot();
  assertSameActions(readyActions, completeActions, '初态到全部揭晓');
  assert.deepEqual(completeActions.labels, ['确认保存出场顺序', '放弃本次抽取'],
    `完成态按钮顺序应稳定：${JSON.stringify(completeActions.labels)}`);
  const revealedFinal = await uiRevealed();
  assert.deepEqual(revealedFinal.map((row) => row.order), [1, 2, 3, 4]);
  assert.equal(new Set(revealedFinal.map((row) => row.name)).size, 4);
  await completeButton.click();
  await page.locator('.draw-official').waitFor();
  const saved = await officialOf(male.id);
  assert.equal(saved.revision, 1);
  assert.equal(saved.entries.length, 4);
  assert.deepEqual(saved.entries.map((row) => row.name), revealedFinal.map((row) => row.name));
  assert.deepEqual(saved.entries.map((row) => row.id).sort((a, b) => a - b), maleIds);
  assert.equal(new Set(saved.entries.map((row) => row.id)).size, 4);
  assert.equal(saved.order_hash, await page.evaluate(async (order) => {
    const { payloadHash } = await import('/js/api.js');
    return payloadHash(order);
  }, saved.entries.map((row) => row.id)));
  assert.equal(await button('确认保存出场顺序').count(), 0, '确认后不再显示可误点的确认按钮');
  await capture('saved');
  pass('逐人抽到 4/4 后出现确认；确认后 GET /individual-draw 与界面累计揭晓顺序是同一排列且无重复遗漏');

  /* 5. 刷新后进度与正式顺序保持，不重新随机 */
  await page.reload();
  await page.locator('.draw-official').waitFor();
  const reloadedOfficial = await officialOf(male.id);
  assert.deepEqual(reloadedOfficial.entries.map((row) => row.name), revealedFinal.map((row) => row.name));
  assert.ok((await page.locator('.draw-official').innerText()).includes(revealedFinal[0].name));
  pass('保存后刷新显示同一正式出场顺序，不重新随机');

  /* 6. 响应丢失：服务端已提交但响应被丢弃 → 待核实入口 → 核实不重复推进 */
  await primary();
  await stopAndReveal();
  await waitPicked(1);
  await page.reload();
  await page.locator('.individual-draw').waitFor();
  await waitPicked(1);
  const midSession = await sessionOf(male.id);
  const midRevealed = await uiRevealed();
  assert.equal(midRevealed.length, 1);
  assert.equal(midRevealed[0].name, midSession.revealed[0].name);
  pass('抽取过程中刷新读回相同进度，已揭晓结果不重新随机');
  let stopRequests = 0;
  const countStop = (request) => { if (/\/individual-draw\/session\/(stop|pick)$/.test(request.url())) stopRequests += 1; };
  page.on('request', countStop);
  let releaseStop = () => {};
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  await page.route('**/individual-draw/session/stop', async (route) => {
    await stopGate;
    await route.fetch();
    await route.abort('failed');
  });
  await primary();
  await waitPhase('rolling');
  await stopAndReveal();
  /* 后台结果未明确前冻结下一步：不能连点 */
  await waitPhase('picking');
  assert.equal(await button('停止并揭晓').count(), 0, '揭晓进行中不得再次点击停止');
  assert.equal(await button('抽下一位').count(), 0, '揭晓进行中不得开始下一位');
  assert.equal(await page.getByRole('button', { name: '正在揭晓…', exact: true }).isDisabled(), true);
  releaseStop();
  await page.locator('[data-draw-pending="session"]').waitFor();
  await waitPhase('recovering');
  await page.unroute('**/individual-draw/session/stop');
  const serverAfterLoss = await sessionOf(male.id);
  assert.equal(serverAfterLoss.picked, 2, '服务端确实提交了这一步');
  await button('核实原请求').click();
  await page.locator('[data-draw-pending="session"]').waitFor({ state: 'detached' });
  await waitPicked(2);
  const recovered = await sessionOf(male.id);
  assert.equal(recovered.picked, 2);
  assert.equal(recovered.order.length, 2);
  assert.equal(new Set(recovered.order).size, 2);
  const recoveredUi = await uiRevealed();
  assert.deepEqual(recoveredUi.map((row) => row.name), recovered.revealed.map((row) => row.name));
  assert.equal(stopRequests, 1, `响应丢失后核实不得再次发送抽取请求：${stopRequests}`);
  pass('停止响应丢失时进入待核实；按原请求核实后进度与服务端一致（2/4，无重复），不重复抽取');

  /* 7. 本机恢复存储失败 → 零发送并显示错误 */
  await page.evaluate(async () => {
    const { localStore } = await import('/js/store.js');
    window.__drawBegin = localStore.begin;
    localStore.begin = async () => { throw new Error('测试恢复存储不可用'); };
  });
  const beforeFailedStorage = stopRequests;
  await primary();
  await waitPhase('rolling');
  await stopAndReveal();
  await page.getByText('测试恢复存储不可用').waitFor();
  assert.equal(stopRequests, beforeFailedStorage, '落盘失败时不得发出抽取请求');
  assert.equal((await sessionOf(male.id)).picked, 2);
  await page.evaluate(async () => {
    const { localStore } = await import('/js/store.js');
    localStore.begin = window.__drawBegin;
  });
  await waitPhase('revealed');
  pass('本机原包落盘失败时不发送 HTTP，界面显示错误且进度不变');

  /* 13. 标签隐藏：停止动画且不产生幽灵抽取 */
  const beforeGhost = stopRequests;
  await primary();
  await waitPhase('rolling');
  const ghostPage = await page.context().newPage();
  await ghostPage.goto('about:blank');
  await ghostPage.bringToFront();
  let realHidden = true;
  try { await page.waitForFunction(() => document.visibilityState === 'hidden', null, { timeout: 5000 }); }
  catch { realHidden = false; }
  if (!realHidden) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(600);
  assert.notEqual(await phaseOf(), 'rolling', '标签隐藏后应停止滚动');
  assert.equal(stopRequests, beforeGhost, '标签隐藏不得产生幽灵抽取');
  await ghostPage.close();
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 5000 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.draw-roll-name').count(), 0);
  assert.equal(stopRequests, beforeGhost);
  assert.equal(await progress(), '已抽 2 / 4 人');
  pass('标签隐藏停止动画、不自动抽人，返回只显示已保存进度');

  /* 12. 减少动态效果：稳定文案且不循环姓名 */
  const reduced = await makePage(token, { reducedMotion: 'reduce' });
  try {
    const reducedUrl = url(male.id);
    await reduced.goto(reducedUrl);
    await reduced.locator('.individual-draw').waitFor();
    await reduced.getByRole('button', { name: '抽下一位', exact: true }).click();
    await reduced.waitForFunction(() => document.querySelector('.individual-draw')?.dataset.drawPhase === 'rolling');
    const staticText = reduced.locator('.draw-roll-static');
    await staticText.waitFor();
    assert.equal(await staticText.innerText(), '正在抽第 3 位，待揭晓');
    assert.equal(await reduced.locator('.draw-roll-name').count(), 0, '减少动态效果时不得循环姓名');
    const sample1 = await staticText.innerText();
    await reduced.waitForTimeout(700);
    assert.equal(await staticText.innerText(), sample1);
    assert.equal(await reduced.getByRole('button', { name: '停止并揭晓', exact: true }).count(), 1);
    await reduced.getByRole('button', { name: '停止并揭晓', exact: true }).click();
    await reduced.waitForFunction(() => /^已抽 3 \/ 4 人$/.test(
      document.querySelector('.draw-progress-count')?.textContent?.trim() || ''));
    assert.equal((await sessionOf(male.id)).picked, 3);
    pass('prefers-reduced-motion 下显示稳定“正在抽第 N 位，待揭晓”，不循环姓名，仍可逐人揭晓');
  } finally { await reduced.context().close(); }

  /* 8. 名单变化：显示失效原因并禁用抽取 */
  await api('PUT', `/api/participations/${maleRoster[3].id}`, { status: 'withdrawn' });
  await page.reload();
  await page.locator('.individual-draw').waitFor();
  await waitPhase('blocked');
  const blockedText = await page.locator('[data-draw-blocked="true"]').innerText();
  assert.ok(blockedText.includes('名单'), blockedText);
  assert.equal(await button('抽下一位').count(), 0);
  assert.equal(await button('确认保存出场顺序').count(), 0);
  assert.equal(await extractCount(), 0, '失效后不得出现任何可用的抽取按钮');
  const staleSession = await sessionOf(male.id);
  assert.equal(staleSession.stale, true);
  assert.equal(staleSession.can_pick, false);
  await capture('blocked');
  pass('报名名单变化后会话失效：界面显示原因，抽取与确认按钮禁用且不自动补人');

  /* 15. 角色权限与男女项目互不影响 */
  const urls = { organizer: url(female.id, 'entry'), recorder: url(female.id, 'entry'), viewer: url(female.id, 'results') };
  const clients = {};
  for (const role of ['organizer', 'recorder', 'viewer']) {
    await api('POST', '/api/users', { username: `draw-${role}`, password: 'RoleDraw123', role,
      display_name: role, event_ids: [event.event_id] });
    const t = (await api('POST', '/api/login', { username: `draw-${role}`, password: 'RoleDraw123' })).token;
    const p = await makePage(t);
    await p.goto(urls[role]);
    await p.locator('.individual-draw').waitFor();
    clients[role] = p;
  }
  assert.ok(await extractCount(clients.organizer) > 0, 'organizer 应有抽取操作按钮');
  assert.equal(await extractCount(clients.recorder), 0);
  assert.equal(await extractCount(clients.viewer), 0);
  assert.equal((await clients.viewer.locator('h3').filter({ hasText: '个人赛出场顺序' }).count()) > 0, true,
    'viewer 只读页面仍显示正式签表入口');
  await clients.recorder.context().close();
  await clients.viewer.context().close();
  const maleSessionBefore = await sessionOf(male.id);
  const femaleStart = await api('POST', `${sessionPath(female.id)}/start`,
    { event_identity: identity, request_uid: 'female-session-start-0001' });
  assert.equal(femaleStart.session.picked, 0);
  await api('POST', `${sessionPath(female.id)}/stop`, { event_identity: identity,
    request_uid: 'female-session-stop-0001', session_id: femaleStart.session.session_id,
    base_revision: femaleStart.session.revision });
  const maleAfterFemale = await sessionOf(male.id);
  assert.equal(maleAfterFemale.session_id, maleSessionBefore.session_id);
  assert.equal(maleAfterFemale.picked, maleSessionBefore.picked);
  assert.equal((await officialOf(male.id)).revision, 1);
  assert.equal((await officialOf(female.id)).status, 'none');
  pass('organizer 有抽取按钮，recorder/viewer 无；男女项目会话与正式签表互不影响');

  /* 9. 领取记录后不能继续抽取 */
  const femaleRoster = (await api('GET', `/api/categories/${female.id}/participations`)).participations;
  await api('POST', `/api/recording/individual/${femaleRoster[0].id}/claim`, {});
  await clients.organizer.reload();
  await clients.organizer.locator('.individual-draw').waitFor();
  await clients.organizer.waitForFunction(() =>
    document.querySelector('.individual-draw')?.dataset.drawPhase === 'blocked');
  const claimBlocked = await clients.organizer.locator('[data-draw-blocked="true"]').innerText();
  assert.ok(claimBlocked.includes('记录任务领取'), claimBlocked);
  assert.equal(await clients.organizer.getByRole('button', { name: '抽下一位', exact: true }).count(), 0);
  assert.equal(await extractCount(clients.organizer), 0, '领取记录后不得出现任何可用的抽取按钮');
  await clients.organizer.context().close();
  pass('他人领取记录后会话被锁定：显示原因且抽取按钮禁用，不自动补人');

  /* 离线：显示带读取时间的只读缓存，抽取/确认禁用 */
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.context().setOffline(true);
  await page.reload();
  await page.locator('[data-draw-offline="true"]').waitFor({ timeout: 20000 });
  const offlineText = await page.locator('[data-draw-offline="true"]').innerText();
  assert.ok(offlineText.includes('当前离线'), offlineText);
  assert.ok(/\d{4}|\d+:\d+/.test(offlineText), `离线提示应带读取时间：${offlineText}`);
  assert.equal(await page.locator('.draw-actions button:not([disabled])').count(), 0);
  assert.equal(await extractCount(), 0, '离线时抽取与确认按钮必须禁用');
  await capture('offline');
  await page.context().setOffline(false);
  pass('离线显示带读取时间的只读缓存，抽取与确认禁用');

  /* 16. 正式签表 + 记录领取：面板消费服务端 can_draw/block_reason 并锁定（REQ-006） */
  const legacyGroup = structure[1];
  const legacyUrl = (tab = 'entry') => base + '/#/workspace?' + new URLSearchParams({
    event: String(event.event_id), group: String(legacyGroup.id),
    category: String(legacy.id), tab }).toString();
  const legacyRoster = (await api('GET', `/api/categories/${legacy.id}/participations`)).participations;
  const lockPage = await makePage(token);
  await lockPage.goto(legacyUrl());
  await lockPage.locator('.individual-draw').waitFor();
  const lockButton = (name) => lockPage.getByRole('button', { name, exact: true });
  const lockPhase = (name) => lockPage.waitForFunction(
    (value) => document.querySelector('.individual-draw')?.dataset.drawPhase === value, name);
  const lockPicked = (count) => lockPage.waitForFunction((value) => {
    const text = document.querySelector('.draw-progress-count')?.textContent?.trim() || '';
    const m = /^已抽 (\d+) \/ (\d+) 人$/.exec(text);
    return !!m && Number(m[1]) === value;
  }, count);
  await lockButton('开始抽签').click();
  await lockPhase('rolling');
  await lockButton('停止并揭晓').click();
  await lockPicked(1);
  await lockButton('抽下一位').click();
  await lockPhase('rolling');
  await lockButton('停止并揭晓').click();
  await lockPicked(2);
  await lockButton('确认保存出场顺序').click();
  await lockPage.locator('.draw-official').waitFor();
  const legacySaved = await officialOf(legacy.id);
  assert.equal(legacySaved.revision, 1);
  assert.equal(legacySaved.entries.length, 2);
  assert.equal(legacySaved.can_draw, true, '未领取/无成绩时仍允许重新抽签');
  assert.equal(await lockPage.getByRole('button', { name: '重新抽签', exact: true }).count(), 1,
    '未锁定状态保持现有“重新抽签”可用流程');
  /* 领取记录任务 → 服务端 can_draw=false；面板刷新后禁用重抽并说明原因。 */
  await api('POST', `/api/recording/individual/${legacyRoster[0].id}/claim`, {});
  const lockedDraw = await officialOf(legacy.id);
  assert.equal(lockedDraw.can_draw, false);
  assert.ok(lockedDraw.block_reason.includes('领取') || lockedDraw.block_reason.includes('成绩'),
    lockedDraw.block_reason);
  await lockPage.reload();
  await lockPage.locator('.individual-draw').waitFor();
  const lockedBanner = lockPage.locator('[data-draw-locked="true"]');
  await lockedBanner.waitFor();
  assert.ok((await lockedBanner.innerText()).includes('已有成绩不可重抽'));
  const lockedTitle = await lockPage.locator('.individual-draw h3').innerText();
  assert.ok(lockedTitle.includes('正式出场顺序已确认'), lockedTitle);
  assert.ok(lockedTitle.includes('2 人'), lockedTitle);
  assert.ok(lockedTitle.includes('第 1 版'), lockedTitle);
  const lockedProgress = await lockPage.locator('.draw-progress').innerText();
  assert.ok(!lockedProgress.includes('等待开始'), lockedProgress);
  assert.ok(!lockedProgress.includes('未抽候选'), lockedProgress);
  assert.ok(lockedProgress.includes('已确认 2 人'), lockedProgress);
  assert.equal((await lockPage.locator('.draw-main-label').innerText()).trim(), '正式出场顺序已确认');
  assert.equal(await lockPage.locator('.individual-draw').getAttribute('data-draw-phase'), 'idle');
  const lockedButton = lockPage.getByRole('button', { name: '重新抽签（已有成绩不可重抽）', exact: true });
  assert.equal(await lockedButton.count(), 1);
  assert.equal(await lockedButton.isDisabled(), true, '锁定后重新抽签按钮必须禁用');
  const lockedStart = await raw('POST', `/api/categories/${legacy.id}/individual-draw/session/start`,
    { event_identity: identity, request_uid: 'locked-start-must-409' });
  assert.equal(lockedStart.status, 409, JSON.stringify(lockedStart.body));
  assert.equal(lockedStart.body.code, 'individual_draw_locked', '服务端 individual_draw_locked 仍是兜底');
  /* 只读角色：可查看正式签表，但不显示锁定横幅，也没有可点的抽取按钮。 */
  await api('POST', '/api/users', { username: 'draw-lock-viewer', password: 'LockViewer123',
    role: 'viewer', display_name: '锁定只读', event_ids: [event.event_id] });
  const lockViewerToken = (await api('POST', '/api/login',
    { username: 'draw-lock-viewer', password: 'LockViewer123' })).token;
  const lockViewer = await makePage(lockViewerToken);
  try {
    await lockViewer.goto(legacyUrl('results'));
    await lockViewer.locator('.individual-draw').waitFor();
    const viewerTitle = await lockViewer.locator('.individual-draw h3').innerText();
    assert.ok(viewerTitle.includes('正式出场顺序已确认'), viewerTitle);
    assert.equal(await lockViewer.locator('[data-draw-locked="true"]').count(), 0,
      '只读角色不显示锁定横幅');
    assert.equal(await extractCount(lockViewer), 0, '只读角色没有锁定/抽取操作按钮');
  } finally { await lockViewer.context().close(); }
  await lockPage.context().close();
  pass('正式签表+记录领取后面板锁定：标题/进度为已确认状态、重抽禁用并说明原因、横幅可读、409 兜底；只读角色无锁定横幅');

  assert.deepEqual(errors, [], `浏览器控制台错误：${JSON.stringify(errors)}`);
  await writeFile(path.join(artifacts, 'individual-draw-process-report.json'),
    JSON.stringify({ status: 'PASS', checks, geometry, errors }, null, 2));
  console.log(`Artifacts: ${artifacts}`);
} catch (error) {
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: path.join(artifacts, 'individual-draw-process-failure.png'), fullPage: true });
      console.error((await page.locator('body').innerText()).slice(-3500));
    } catch { /* 失败现场尽力保存 */ }
  }
  console.error(stderr.slice(-2000));
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
}