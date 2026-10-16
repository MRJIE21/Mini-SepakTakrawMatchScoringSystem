import { scheduleFixture } from './helpers/schedule_fixture.mjs';
/* 工作台的真实浏览器流程；服务与数据均为独立临时实例。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(tmpdir(), `stss-project-workspace-${Date.now()}`);
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-project-workspace-artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', `
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
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'WorkspaceTest123', PYTHONUTF8: '1' },
});
let serverErrors = '', browser, page;
child.stderr.on('data', chunk => { serverErrors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Server timeout')), 10000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const result = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(result.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity;
  const api = async (method, url, body) => {
    if (method === 'POST' && /^\/api\/pools\/\d+\/(confirm|lots)$/.test(url) && body?.base_results === undefined) {
      const poolId = url.split('/')[3];
      const standings = await api('GET', `/api/pools/${poolId}/standings`);
      body = { ...body, base_results: standings.base_results, base_confirmation: standings.base_confirmation };
    }
    if (method === 'POST' && /^\/api\/matches\/\d+\/(correction|cancel)$/.test(url)) {
      const match = (await api('GET', `/api/matches/${url.split('/')[3]}`)).match;
      body = { request_uid: `fixture-${Date.now()}-${Math.random()}`, base_version: match.result_version,
        event_identity: identity, ...body };
    }

    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'WorkspaceTest123' })).token;
  identity = await api('POST', '/api/events', { name: '首都高校第十八届藤球比赛 · 工作台验证' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
  const group = structure.groups[0];
  const team = group.categories.find(c => c.kind === 'team' && c.gender === 'male');
  const female = group.categories.find(c => c.kind === 'team' && c.gender === 'female');
  const femaleB = structure.groups[1].categories.find(c => c.kind === 'team' && c.gender === 'female');
  for (const [index, name] of ['中国政法大学', '清华大学', '中国人民大学', '北京科技大学', '华北电力大学', '北京北大方正软件职业技术学院'].entries()) {
    await api('POST', `/api/categories/${team.id}/enrollments`, { school: { name }, captain_index: index === 5 ? undefined : 0,
      members: [1, 2, 3].map(i => ({ name: `匿名队员${index + 1}-${i}`, gender: 'male', jersey_no: String(i), is_captain: i === 1 })),
    });
  }
  const venue = (await api('POST', `/api/events/${identity.event_id}/venues`, { name: '主馆一号场' })).venue_id;
  const plan = (await scheduleFixture(api, identity, team.id, { groupCount: 2, knockout: true })).plan_id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const workspace = (category, tab = 'overview', extra = {}) => `${base}/#/workspace?${new URLSearchParams({ event: identity.event_id,
    group: category.group_id, category: category.id, tab, ...extra })}`;
  const navigation = () => page.getByRole('navigation', { name: '项目工作台导航', exact: true });
  await page.goto(workspace(team));
  await page.locator('.workspace-match').first().waitFor();
  assert.equal(await page.locator('.project-step').count(), 5);
  assert.equal(await navigation().isVisible(), true);
  const first = (await api('GET', `/api/matches?category_id=${team.id}&status=ready`)).matches[0];
  await navigation().getByRole('link', { name: '赛程', exact: true }).click();
  await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
  await api('PUT', `/api/matches/${first.id}`, { venue_id: venue, scheduled_at: '2026-10-11 09:00' });
  const before = await api('GET', `/api/plans/${plan}`);
  await navigation().getByRole('link', { name: '概况', exact: true }).click();
  await page.locator('.workspace-match').first().waitFor();
  assert.match(await page.locator('.workspace-match').first().innerText(), /主馆一号场/);
  assert.equal(await page.locator('.workspace-match').count(), 5);
  assert.deepEqual(await api('GET', `/api/plans/${plan}`), before, '概况读取不会修改赛程');
  for (const width of [1920, 1365, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `概况 ${width} 无整页横向溢出`);
    if ([1365, 390].includes(width)) await page.screenshot({ path: path.join(artifacts, `workspace-overview-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.getByRole('button', { name: '进入记录', exact: true }).first().click();
  await page.getByRole('button', { name: '返回列表', exact: true }).waitFor();
  assert.match(page.url(), /from=workspace/);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await navigation().waitFor();
  assert.match(page.url(), new RegExp(`category=${team.id}.*tab=matches`));
  await navigation().getByRole('link', { name: '赛程', exact: true }).click();
  await page.getByRole('navigation', { name: '项目工作台导航', exact: true }).getByRole('link', { name: '分组', exact: true }).click();
  await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor();
  assert.equal(await navigation().isVisible(), true);
  await navigation().getByRole('link', { name: '概况', exact: true }).click();
  await page.getByLabel('比赛项目').selectOption(String(female.id));
  await page.getByRole('heading', { name: `${group.name} · 女子三人赛`, exact: true }).waitFor();
  await page.getByLabel('大组别').selectOption(String(structure.groups[1].id));
  await page.getByRole('heading', { name: `${structure.groups[1].name} · 女子三人赛`, exact: true }).waitFor();
  assert.match(page.url(), new RegExp(`category=${femaleB.id}`), '跨组继续停留女子三人赛');

  const play = async match => {
    const sets = [1, 2].map(set_no => ({ set_no, home_points: 15, away_points: 9, winner_side: 'home' }));
    let seq = 0; const events = [];
    for (const set of sets) {
      for (let away = 1; away <= 9; away++) events.push({ seq: ++seq, kind: 'score', set_no: set.set_no, side: 'away', home_after: 0, away_after: away });
      for (let home = 1; home <= 15; home++) events.push({ seq: ++seq, kind: 'score', set_no: set.set_no, side: 'home', home_after: home, away_after: 9 });
    }
    await api('POST', '/api/scoring/submit', { submission_uid: crypto.randomUUID(), match_id: match.id,
      event_identity: identity,
      base_version: match.result_version, plan_version: match.plan_version, home_participation: match.home.participation_id,
      away_participation: match.away.participation_id, device: '工作台测试', result_status: 'normal', sets, events });
  };
  const poolStage = before.plan.stages[0];
  for (const match of (await api('GET', `/api/matches?stage_id=${poolStage.id}`)).matches) await play(match);
  await page.goto(workspace(team));
  await page.getByRole('button', { name: '核对小组排名', exact: true }).waitFor();
  const tasks = page.locator('.workspace-task');
  assert.equal(await tasks.getByRole('button', { name: '核对排名', exact: true }).count(), 2);
  await tasks.getByRole('button', { name: '核对排名', exact: true }).first().click();
  const focusId = `pool-${poolStage.pools[0].id}`;
  await page.locator(`#${focusId}`).getByRole('button', { name: '确认小组名次', exact: true }).waitFor();
  await page.waitForFunction(id => document.activeElement?.id === id, focusId);
  assert.match(page.url(), new RegExp(`pool=${poolStage.pools[0].id}`));
  assert.equal((await api('GET', `/api/pools/${poolStage.pools[0].id}/standings`)).confirmed, false, '进入待办仅定位，不自动确认');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'workspace-pool-focus-390.png'), fullPage: true });
  for (const pool of poolStage.pools) await api('POST', `/api/pools/${pool.id}/confirm`, {});
  await page.goto(workspace(team));
  await page.locator('.workspace-match').first().waitFor();
  assert.equal(await page.getByRole('button', { name: '核对小组排名', exact: true }).count(), 0);
  assert.equal((await api('GET', `/api/categories/${team.id}/workspace`)).counts.pools_to_confirm, 0);
  // Removed next-round generation has no workbench action.
  assert.equal(await page.getByRole('button', { name: '生成下一轮对阵', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: 阶段赛程、导航保留、实际队列、记录返回、排名待办定位、无旧编排动作、跨组保留女子项目、后台更新及五种屏幕宽度');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, 'workspace-failure.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(0, 3000));
  }
  throw error;
} finally { if (browser) await browser.close(); child.kill(); }
