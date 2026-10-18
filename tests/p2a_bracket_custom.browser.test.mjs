/* P2-A REQ-007：淘汰及评次图渲染 custom 阶段普通场次（有/无场次），小组/淘汰渲染回归不变。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'p2a-bracket-custom-'));
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
  STSS_ADMIN_PASSWORD: 'BracketCustom123', PYTHONUTF8: '1' } });
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

/* 在隔离赛事库里补小组赛 / 淘汰赛结构，用于验证 custom 之外的渲染回归不变。 */
const SEED = `
import json, sys
from app import db
db_path, spec_json = sys.argv[1:3]
spec = json.loads(spec_json)
conn = db.connect(db_path)
out = []
for item in spec:
    cat_id = int(item['category_id']); parts = item['parts']
    plan_id = db.insert(conn, 'plans', {'category_id': cat_id, 'name': '回归验证方案', 'status': 'locked'})
    if item['mode'] == 'group':
        stage_id = db.insert(conn, 'stages', {'plan_id': plan_id, 'seq': 1, 'kind': 'round_robin',
            'name': '小组赛'})
        pool_id = db.insert(conn, 'pools', {'stage_id': stage_id, 'name': 'A组', 'kind': 'group',
            'seq': 1, 'status': 'running', 'rank_from': 1, 'rank_to': 2})
        for seed, pid in enumerate(parts, start=1):
            db.insert(conn, 'pool_members', {'pool_id': pool_id, 'participation_id': pid, 'seed_no': seed})
        db.insert(conn, 'matches', {
            'category_id': cat_id, 'plan_id': plan_id, 'plan_version': 1, 'stage_id': stage_id,
            'pool_id': pool_id, 'seq': 1, 'round_no': 1, 'round_label': '第1轮',
            'home_source_type': 'participation', 'home_participation': parts[0], 'home_actual': parts[0],
            'away_source_type': 'participation', 'away_participation': parts[1], 'away_actual': parts[1],
            'status': 'ready'})
        out.append({'mode': 'group', 'pool_id': pool_id})
    else:
        params = json.dumps({'schedule_meta': {'version': 1, 'revision': 1, 'state': 'confirmed',
            'definition': {'purpose': 'knockout', 'name': '淘汰赛'}}}, ensure_ascii=False)
        stage_id = db.insert(conn, 'stages', {'plan_id': plan_id, 'seq': 1, 'kind': 'single_elim',
            'name': '淘汰赛', 'params_json': params})
        match_id = db.insert(conn, 'matches', {
            'category_id': cat_id, 'plan_id': plan_id, 'plan_version': 1, 'stage_id': stage_id,
            'seq': 1, 'round_no': 1, 'round_label': '决赛', 'schedule_role': 'final',
            'home_source_type': 'participation', 'home_participation': parts[0], 'home_actual': parts[0],
            'away_source_type': 'participation', 'away_participation': parts[1], 'away_actual': parts[1],
            'status': 'finished', 'result_status': 'normal', 'result_version': 1})
        for set_no, (hp, ap) in enumerate([(15, 10), (15, 8)], start=1):
            db.insert(conn, 'match_sets', {'match_id': match_id, 'set_no': set_no,
                'home_points': hp, 'away_points': ap, 'winner_side': 'home'})
        out.append({'mode': 'knockout', 'match_id': match_id})
conn.commit(); conn.close()
print(json.dumps(out))
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
    assert.equal(response.ok, true, `${method} ${url} -> ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'BracketCustom123' })).token;
  const event = await api('POST', '/api/events', { name: '淘汰及评次图自定义阶段验证赛', start_date: '2026-10-18' });
  identity = { event_id: event.event_id, event_uuid: event.event_uuid,
    deployment_id: (await api('GET', '/api/events')).deployment_id };
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const groupA = structure.groups[0];
  const groupB = structure.groups[1];
  const groupC = structure.groups[2];
  const enrollTeams = async (group, category, count) => {
    const parts = [];
    for (let i = 1; i <= count; i += 1) {
      const school = await api('POST', `/api/events/${event.event_id}/schools`,
        { name: `${group.code}${category.id}队${i}校`, group_id: group.id });
      const team = await api('POST', `/api/categories/${category.id}/teams`,
        { school_id: school.school_id, name: `${group.code}${i}号队` });
      const part = await api('POST', `/api/categories/${category.id}/participations`,
        { team_id: team.team_id, seed_no: i });
      parts.push(part.participation_id);
    }
    return parts;
  };
  const customCat = groupA.categories.find((c) => c.gender === 'male' && c.kind === 'team');
  const emptyCat = groupA.categories.find((c) => c.gender === 'female' && c.kind === 'team');
  const groupCat = groupB.categories.find((c) => c.gender === 'male' && c.kind === 'team');
  const knockCat = groupC.categories.find((c) => c.gender === 'male' && c.kind === 'team');
  const customParts = await enrollTeams(groupA, customCat, 2);
  const emptyParts = await enrollTeams(groupA, emptyCat, 2);
  const groupParts = await enrollTeams(groupB, groupCat, 2);
  const knockParts = await enrollTeams(groupC, knockCat, 2);

  /* custom 有场次：手动新增 2 场自定义比赛（自动建立 custom 阶段）。 */
  await api('POST', '/api/matches', { category_id: customCat.id,
    home_participation: customParts[0], away_participation: customParts[1], round_label: '补赛A' });
  await api('POST', '/api/matches', { category_id: customCat.id,
    home_participation: customParts[1], away_participation: customParts[0], round_label: '补赛B' });
  /* custom 空阶段：新增一场后删除，留下 kind=custom 的空阶段。 */
  const removed = await api('POST', '/api/matches', { category_id: emptyCat.id,
    home_participation: emptyParts[0], away_participation: emptyParts[1], round_label: '临时场次' });
  await api('DELETE', `/api/matches/${removed.match_id}`, {});
  /* 小组 / 淘汰阶段回归数据。 */
  const seeded = JSON.parse(await runPython(SEED, [path.join(data, 'events',
    `event_${event.event_id}.db`), JSON.stringify([
    { mode: 'group', category_id: groupCat.id, parts: groupParts },
    { mode: 'knockout', category_id: knockCat.id, parts: knockParts },
  ])]));
  assert.equal(seeded.length, 2, JSON.stringify(seeded));

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
  await context.addInitScript(({ value, eid }) => {
    localStorage.setItem('stss_token', value); localStorage.setItem('stss_event', String(eid));
  }, { value: token, eid: event.event_id });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const open = async (categoryId) => {
    await page.goto(`${base}/#/bracket?category=${categoryId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.querySelector('.content .spinner'));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };

  /* ------------------------------------------------ custom 有场次：普通场次表 */
  await open(customCat.id);
  await page.getByText('补赛A', { exact: true }).first().waitFor();
  const customText = await page.locator('.content').innerText();
  assert.ok(customText.includes('自定义比赛'), customText);
  const customRows = page.locator('.table-scroll table tbody tr');
  assert.equal(await customRows.count(), 2, 'custom 阶段应列出 2 场普通场次');
  const customCells = await customRows.evaluateAll((rows) => rows.map((tr) =>
    [...tr.children].map((td) => td.textContent.trim())));
  assert.equal(customCells[0][0], '补赛A', JSON.stringify(customCells));
  assert.equal(customCells[1][0], '补赛B', JSON.stringify(customCells));
  assert.ok(customCells[0][4] && customCells[1][4], `状态列应有内容：${JSON.stringify(customCells)}`);
  assert.equal(await page.locator('.bk-canvas').count(), 0, 'custom 阶段不应画对阵树');
  await page.screenshot({ path: path.join(artifacts, 'bracket-custom-matches.png'), fullPage: true });
  pass('custom 阶段（2 场补赛）：按 seq 列出轮次/双方/比分/状态，不显示空白面板');

  /* ------------------------------------------------ custom 空阶段：明确空态 */
  await open(emptyCat.id);
  await page.getByText('暂无自定义比赛', { exact: true }).waitFor();
  const emptyText = await page.locator('.content').innerText();
  assert.ok(emptyText.includes('暂无自定义比赛'), emptyText);
  assert.equal(await page.locator('.table-scroll table tbody tr').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'bracket-custom-empty.png'), fullPage: true });
  pass('空 custom 阶段显示“暂无自定义比赛”空态，不再整段跳过');

  /* ------------------------------------------------ 小组阶段渲染回归 */
  await open(groupCat.id);
  await page.getByText('A组', { exact: false }).first().waitFor();
  const groupText = await page.locator('.content').innerText();
  assert.ok(groupText.includes('A组'), groupText);
  assert.equal(await page.locator('.table-scroll table tbody tr').count(), 1);
  assert.equal(await page.locator('.bk-canvas').count(), 0);
  pass('小组阶段仍按原小组表渲染（场次表 + 无对阵树）');

  /* ------------------------------------------------ 淘汰阶段渲染回归 */
  await open(knockCat.id);
  await page.locator('.bk-canvas').waitFor();
  assert.equal(await page.locator('.bk-canvas').count(), 1, '淘汰阶段仍渲染对阵树');
  const cards = page.locator('.bk-canvas .bk-card');
  assert.ok(await cards.count() >= 1, '淘汰阶段应有场次卡片');
  const knockText = await page.locator('.content').innerText();
  assert.ok(knockText.includes('决赛'), knockText);
  assert.ok(knockText.includes('冠军'), knockText);
  assert.equal(await page.locator('.bk-canvas .bk-card').count(), 1);
  pass('淘汰阶段对阵树、比分与 champion 渲染保持不变');

  assert.deepEqual(pageErrors, [], `页面脚本错误：${JSON.stringify(pageErrors)}`);
  await writeFile(path.join(artifacts, 'p2a-bracket-custom-report.json'),
    JSON.stringify({ status: 'PASS', checks, customCells }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'p2a-bracket-custom-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}
