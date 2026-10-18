/* P2-A REQ-009：移动端成绩表关键列固定与横向滚动提示（390×844 真实浏览器）。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'p2a-mobile-results-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db()
c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class Quiet(Handler):
    def log_message(self,*args): pass
s=create_server(('127.0.0.1',0),Quiet)
print(json.dumps({'port':s.server_port}),flush=True)
s.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_ADMIN_PASSWORD: 'MobileResults123', PYTHONUTF8: '1' } });
let browser, page, serverErrors = '';
const checks = [];
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
const pass = (text) => { checks.push(text); console.log('PASS ' + text); };

const runPython = (code, args = []) => new Promise((resolve, reject) => {
  const proc = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', code, ...args],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'),
      STSS_EVENTS_DIR: path.join(data, 'events'), PYTHONUTF8: '1' } });
  let out = '', err = '';
  proc.stdout.on('data', (chunk) => { out += chunk; });
  proc.stderr.on('data', (chunk) => { err += chunk; });
  proc.on('error', reject);
  proc.on('close', (status) => status === 0
    ? resolve(out.trim()) : reject(new Error(`seed exit ${status}: ${err || out}`)));
});

/* 直接在隔离赛事库里补一个已确认的小组赛结构：真实比赛 + 局分（不依赖已退休的旧编排接口）。 */
const SEED_POOL = `
import json, sys
from app import db
db_path, cat_id, part_json, stage_json = sys.argv[1:5]
parts = json.loads(part_json)
conn = db.connect(db_path)
plan_id = db.insert(conn, 'plans', {'category_id': int(cat_id), 'name': '移动端验证方案', 'status': 'locked'})
stage_id = db.insert(conn, 'stages', {'plan_id': plan_id, 'seq': 1, 'kind': 'round_robin', 'name': '小组赛'})
pool_id = db.insert(conn, 'pools', {'stage_id': stage_id, 'name': 'A组', 'kind': 'group', 'seq': 1,
    'status': 'running', 'rank_from': 1, 'rank_to': 4})
for seed, pid in enumerate(parts, start=1):
    db.insert(conn, 'pool_members', {'pool_id': pool_id, 'participation_id': pid, 'seed_no': seed})
pairs = [(0, 1, 15, 9), (2, 3, 15, 12), (0, 2, 15, 11), (1, 3, 12, 15)]
for seq, (home, away, hp, ap) in enumerate(pairs, start=1):
    match_id = db.insert(conn, 'matches', {
        'category_id': int(cat_id), 'plan_id': plan_id, 'plan_version': 1,
        'stage_id': stage_id, 'pool_id': pool_id, 'seq': seq, 'round_no': 1,
        'round_label': '第1轮', 'home_source_type': 'participation',
        'home_participation': parts[home], 'home_actual': parts[home],
        'away_source_type': 'participation', 'away_participation': parts[away],
        'away_actual': parts[away], 'status': 'finished', 'result_status': 'normal',
        'result_version': 1})
    db.insert(conn, 'match_sets', {'match_id': match_id, 'set_no': 1, 'home_points': hp,
        'away_points': ap, 'winner_side': 'home' if hp > ap else 'away'})
conn.commit(); conn.close()
print(json.dumps({'plan_id': plan_id, 'pool_id': pool_id, 'stage': stage_json}))
`;

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'startup timeout')), 15000);
    child.once('exit', (code) => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch { /* 等首行 */ }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity = null;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: {
      'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.ok, true, JSON.stringify(payload));
    return payload;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'MobileResults123' })).token;
  const event = await api('POST', '/api/events', { name: '移动端成绩表验证赛', start_date: '2026-10-18' });
  identity = { event_id: event.event_id, event_uuid: event.event_uuid,
    deployment_id: (await api('GET', '/api/events')).deployment_id };
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const group = structure.groups[0];
  const teamCat = group.categories.find((c) => c.gender === 'male' && c.kind === 'team');
  const parts = [];
  for (let i = 1; i <= 4; i += 1) {
    const school = await api('POST', `/api/events/${event.event_id}/schools`,
      { name: `移动端${i}校`, group_id: group.id });
    const team = await api('POST', `/api/categories/${teamCat.id}/teams`,
      { school_id: school.school_id, name: `移动端${i}校队` });
    const part = await api('POST', `/api/categories/${teamCat.id}/participations`,
      { team_id: team.team_id, seed_no: i });
    parts.push(part.participation_id);
  }
  const seeded = JSON.parse(await runPython(SEED_POOL,
    [path.join(data, 'events', `event_${event.event_id}.db`), String(teamCat.id), JSON.stringify(parts), '{}']));
  assert.ok(seeded.pool_id);
  for (const [index, pid] of parts.entries()) {
    await api('POST', `/api/categories/${teamCat.id}/placements`,
      { participation_id: pid, rank_no: index + 1, confirm: true });
  }

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  await context.addInitScript(({ value, eid }) => {
    localStorage.setItem('stss_token', value); localStorage.setItem('stss_event', String(eid));
  }, { value: token, eid: event.event_id });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const ready = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.table-scroll-wrap').length === 2);
    await page.waitForFunction(() => document.querySelectorAll('.table-scroll-wrap table tbody tr').length >= 2);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const open = async () => {
    await page.goto(`${base}/#/results?category=${teamCat.id}`);
    await ready();
  };
  const inspect = async () => page.evaluate(() => {
    const wraps = [...document.querySelectorAll('.table-scroll-wrap')];
    const detail = (wrap) => {
      const scroll = wrap.querySelector('.table-scroll');
      const ths = [...wrap.querySelectorAll('thead th')];
      const header = (label) => ths.find((th) => th.textContent.trim() === label) || null;
      const box = (el) => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; };
      const viewport = innerWidth;
      const overflowCells = [...wrap.querySelectorAll('[data-sticky]')].slice(0, 3)
        .map((el) => ({ sticky: el.dataset.sticky, position: getComputedStyle(el).position, box: box(el) }));
      return {
        hintVisible: !wrap.querySelector('.table-scroll-hint').hidden,
        hintText: wrap.querySelector('.table-scroll-hint').textContent.trim(),
        scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
        viewport, pageOverflow: document.documentElement.scrollWidth - viewport,
        container: box(scroll),
        rank: header('名次') ? box(header('名次')) : null,
        subject: header('参赛主体') ? box(header('参赛主体')) : null,
        key: header('积分') ? box(header('积分')) : header('计入积分') ? box(header('计入积分')) : null,
        sticky: overflowCells,
      };
    };
    return { first: detail(wraps[0]), second: detail(wraps[1]) };
  });

  /* ------------------------------------------------ 390×844：首屏关键列 + 提示 */
  await open();
  const mobile = await inspect();
  for (const [name, item] of Object.entries(mobile)) {
    assert.ok(item.hintVisible, `${name} 溢出时必须显示横向滚动提示`);
    assert.equal(item.hintText, '横向滚动查看完整数据');
    assert.ok(item.scrollWidth > item.clientWidth + 1, `${name} 表格应可横向滚动：${JSON.stringify(item)}`);
    assert.ok(Math.abs(item.pageOverflow) <= 1, `${name} 不得整页横向溢出：${item.pageOverflow}`);
    for (const key of ['rank', 'subject', 'key']) {
      assert.ok(item[key], `${name} 缺少关键列表头 ${key}`);
      assert.ok(item[key].left >= item.container.left - 1 && item[key].right <= item.viewport + 1,
        `${name} 关键列 ${key} 应在首屏可见：${JSON.stringify(item[key])} / ${JSON.stringify(item.container)}`);
    }
    /* 名次/参赛主体固定在滚动容器左侧，积分/计入积分固定在右侧。 */
    assert.ok(Math.abs(item.rank.left - item.container.left) <= 2,
      `${name} 名次列应固定在左侧：${JSON.stringify(item)}`);
    assert.ok(Math.abs(item.key.right - item.container.right) <= 2,
      `${name} 关键列应固定在右侧：${JSON.stringify(item)}`);
    assert.equal(item.sticky.length, 3, `${name} 应有 3 个固定列`);
    assert.ok(item.sticky.every((cell) => cell.position === 'sticky'), `${name} 固定列必须 sticky：${JSON.stringify(item.sticky)}`);
  }
  /* 横向滚动后可查看后面的列，“名次/参赛主体”仍固定在容器左侧。 */
  const stickyAfterScroll = await page.evaluate(() => {
    const wrap = document.querySelectorAll('.table-scroll-wrap')[0];
    const scroll = wrap.querySelector('.table-scroll');
    const container = scroll.getBoundingClientRect();
    const ths = () => [...wrap.querySelectorAll('thead th')];
    const winHeader = () => ths().find((th) => th.textContent.trim() === '胜').getBoundingClientRect();
    scroll.scrollLeft = 0;
    const before = winHeader().left;
    scroll.scrollLeft = 260;
    const cells = [...wrap.querySelectorAll('tbody tr:first-child td')];
    const first = cells[0].getBoundingClientRect();
    const after = winHeader().left;
    return { scrollLeft: scroll.scrollLeft, firstLeft: first.left, containerLeft: container.left,
      before, after, viewport: innerWidth,
      debug: { container: container.toJSON(), inlineLeft: cells[0].style.left,
        computed: { position: getComputedStyle(cells[0]).position, left: getComputedStyle(cells[0]).left } } };
  });
  assert.ok(stickyAfterScroll.scrollLeft > 0, '表格应真的可以横向滚动');
  assert.ok(stickyAfterScroll.after < stickyAfterScroll.before - 100,
    `滚动后非固定列应随内容左移：${JSON.stringify(stickyAfterScroll)}`);
  assert.ok(Math.abs(stickyAfterScroll.firstLeft - stickyAfterScroll.containerLeft) <= 2,
    `滚动后“名次”列应固定在左侧：${JSON.stringify(stickyAfterScroll)}`);
  await page.screenshot({ path: path.join(artifacts, 'p2a-mobile-results-390.png'), fullPage: true });
  pass('390×844：小组排名/项目名次表名次、参赛主体、积分关键列首屏可见，固定列可横向滚动，显示滚动提示且无整页横向溢出');

  /* ------------------------------------------------ 桌面：无提示、布局不变 */
  await page.setViewportSize({ width: 1365, height: 950 });
  await open();
  const desktop = await inspect();
  for (const [name, item] of Object.entries(desktop)) {
    assert.equal(item.hintVisible, false, `${name} 桌面无溢出时不应显示滚动提示`);
    assert.ok(Math.abs(item.pageOverflow) <= 1, `${name} 桌面不得整页横向溢出：${item.pageOverflow}`);
    assert.ok(item.scrollWidth <= item.clientWidth + 1,
      `${name} 桌面表格不应需要横向滚动：${JSON.stringify(item)}`);
  }
  assert.equal(await page.locator('.table-scroll-hint:not([hidden])').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'p2a-mobile-results-1365.png'), fullPage: true });
  pass('1365 桌面：成绩表不显示横向滚动提示、无整页溢出，固定列能力不影响列布局');

  assert.deepEqual(pageErrors, [], `页面脚本错误：${JSON.stringify(pageErrors)}`);
  await writeFile(path.join(artifacts, 'p2a-mobile-results-report.json'),
    JSON.stringify({ status: 'PASS', checks, mobile, desktop }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'p2a-mobile-results-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}
