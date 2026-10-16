/* Actual server/browser verification for the unified schedule and on-demand editors. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scheduleFixture } from './helpers/schedule_fixture.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'schedule-browser-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db();db.init_db()
c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class QuietHandler(Handler):
    def log_message(self,*args): pass
s=create_server(('127.0.0.1',0),QuietHandler)
print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_ADMIN_PASSWORD: 'ScheduleTest123', PYTHONUTF8: '1' } });
let browser, serverErrors = '', token = '', identity;
child.stderr.on('data', chunk => { serverErrors += chunk; });
const errors = [], geometry = [], checks = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 10000);
    child.once('error', reject); child.once('exit', code => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let output = ''; child.stdout.on('data', chunk => { output += chunk; try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch {} });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  const packet = body => ({ request_uid: randomUUID(), event_identity: identity, ...body });
  token = (await api('POST', '/api/login', { username: 'admin', password: 'ScheduleTest123' })).token;
  for (const resource of ['/js/views/schedule.js', '/js/scheduleStageModel.js', '/js/groupNames.js', '/sw.js']) assert.equal((await fetch(base + resource)).status, 200);
  for (const retired of ['/js/views/scheduling.js', '/js/schedulingFlow.js']) assert.equal((await fetch(base + retired)).status, 404);
  pass('真实随机端口启动、两次迁移及新旧资源边界');
  if (process.env.STSS_SCHEDULE_SUITE !== 'startup') {
    const event = await api('POST', '/api/events', { name: '赛程统一验证' });
    identity = { event_id: event.event_id, event_uuid: event.event_uuid, deployment_id: (await api('GET', '/api/events')).deployment_id };
    await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
    const group = (await api('GET', `/api/events/${event.event_id}/structure`)).groups[0];
    const cat = group.categories.find(c => c.kind === 'team' && c.gender === 'male');
    for (let i = 1; i <= 16; i++) {
      const school = await api('POST', `/api/events/${event.event_id}/schools`, { group_id: group.id, name: `赛程验证${i}校` });
      const team = await api('POST', `/api/categories/${cat.id}/teams`, { school_id: school.school_id, name: '代表队' });
      await api('POST', `/api/categories/${cat.id}/participations`, { team_id: team.team_id, seed_no: i });
    }
    let draw = (await api('GET', `/api/categories/${cat.id}/group-draw`));
    draw = (await api('POST', `/api/categories/${cat.id}/group-draw`, packet({ method: 'seeded', capacities: [4, 4, 4, 4], roster_hash: draw.roster_hash }))).draw;
    for (const action of ['complete', 'confirm']) draw = (await api('POST', `/api/categories/${cat.id}/group-draw/${action}`, packet({ draw_id: draw.id, base_rev: draw.rev }))).draw;
    const create = definition => api('POST', `/api/categories/${cat.id}/schedule/stages`, packet({ base_revision: 0, definition }));
    const confirm = async stage => {
      const preview = await api('POST', `/api/schedule-stages/${stage.stage_id}/preview`, packet({ base_revision: stage.revision }));
      return api('POST', `/api/schedule-stages/${stage.stage_id}/confirm`, packet({ base_revision: stage.revision,
        definition_hash: preview.definition_hash, basis_hash: preview.basis_hash, approved_byes: preview.graph.byes }));
    };
    await confirm(await create({ purpose: 'group', name: '小组赛', draw_id: draw.id }));
    const stages = (await api('GET', `/api/categories/${cat.id}/schedule`)).plan.stages;
    const pools = stages[0].pools;
    browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN' });
    await context.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token, event: event.event_id });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    const url = `${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${cat.id}&tab=schedule`;
    await page.goto(url); await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '自动辅助编排', exact: false }).count(), 0);
    assert.equal(await page.locator('.modal').count(), 0);
    await page.getByRole('button', { name: '设置后续赛程', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '设置后续赛程', exact: true });
    await dialog.getByLabel('阶段名称', { exact: false }).fill('八队淘汰赛');
    await dialog.getByRole('button', { name: '保存并预览', exact: true }).click();
    let preview = page.getByRole('dialog', { name: '核对阶段 · 八队淘汰赛', exact: true }); await preview.waitFor();
    assert.ok((await preview.textContent()).includes('A组第1名 对 B组第1名'));
    assert.ok((await preview.textContent()).includes('C组第2名 对 D组第2名'));
    await preview.getByRole('button', { name: '确认正式赛程', exact: true }).click();
    await page.locator('.schedule-match').first().waitFor();
    assert.equal(await page.locator('.schedule-match').count(), 8);
    const csvResponse = await fetch(`${base}/api/exports/schedule.csv?category_id=${cat.id}`, { headers: {
      Authorization: `Bearer ${token}`, 'X-Event-ID': String(event.event_id), 'X-Event-UUID': event.event_uuid } });
    assert.equal(csvResponse.status, 200);
    const csvText = await csvResponse.text();
    assert.ok(csvText.includes('比赛编号') && csvText.includes('A组第1名') && csvText.includes('M001胜者'));
    pass('四组首轮A1/B1、C1/D1及第二名配对，预览确认后显示正式赛程');
    const snapshot = async view => {
      for (const width of [320, 390, 768, 1365]) {
        await page.setViewportSize({ width, height: 1000 });
        const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
          outside: [...document.querySelectorAll('.workspace-content button,.workspace-content select,.modal input,.modal select,.modal button')]
            .filter(e => e.getClientRects().length).map(e => ({ text: e.textContent.slice(0, 30), left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right }))
            .filter(r => r.left < -1 || r.right > innerWidth + 1) }));
        geometry.push({ view, ...dimensions }); assert.ok(dimensions.scroll <= width + 1, JSON.stringify(dimensions)); assert.deepEqual(dimensions.outside, []);
        await page.screenshot({ path: path.join(artifacts, `schedule-${view}-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1365, height: 1000 });
    };
    await snapshot('knockout');
    const codes = await page.locator('.schedule-match-heading > strong').allTextContents();
    await page.getByLabel('排列方式', { exact: false }).selectOption('schedule');
    await page.locator('.schedule-round-list').waitFor();
    assert.deepEqual((await page.locator('.schedule-match-heading > strong').allTextContents()).sort(), [...codes].sort());
    pass('轮次与时间排列切换保留比赛编号');
    await page.getByRole('button', { name: '设置后续赛程', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '设置后续赛程', exact: true });
    await dialog.getByLabel('阶段用途', { exact: false }).selectOption('placement');
    await dialog.getByLabel('阶段名称', { exact: false }).fill('第三名名次赛');
    await dialog.getByLabel('起始名次', { exact: false }).fill('5'); await dialog.getByLabel('结束名次', { exact: false }).fill('8');
    await snapshot('settings');
    await dialog.getByRole('button', { name: '保存并预览', exact: true }).click();
    preview = page.getByRole('dialog', { name: '核对阶段 · 第三名名次赛', exact: true }); await preview.waitFor();
    assert.ok((await preview.textContent()).includes('本阶段决出第5—8名'));
    await preview.getByRole('button', { name: '确认正式赛程', exact: true }).click();
    await page.getByRole('button', { name: '第三名名次赛 · 第5—8名', exact: true }).waitFor();
    await snapshot('placement');
    pass('四组第三名自定第5—8名，表单按需显示且名次范围清晰');
    // Play real results through both complete brackets, then inspect the final
    // ranking UI. No final placements are seeded into the database.
    const play = async match => {
      const sets = [1, 2].map(set_no => ({ set_no, home_points: 15, away_points: 8, winner_side: 'home' }));
      const events = []; let seq = 0;
      for (const set of sets) {
        for (let away = 1; away <= 8; away++) events.push({ seq: ++seq, kind: 'score', set_no: set.set_no, side: 'away', home_after: 0, away_after: away });
        for (let home = 1; home <= 15; home++) events.push({ seq: ++seq, kind: 'score', set_no: set.set_no, side: 'home', home_after: home, away_after: 8 });
      }
      await api('POST', '/api/scoring/submit', { event_identity: identity, submission_uid: randomUUID(), match_id: match.id,
        base_version: match.result_version, plan_version: match.plan_version, home_participation: match.home.participation_id,
        away_participation: match.away.participation_id, result_status: 'normal', sets, events });
    };
    const finishTournament = async categoryId => {
      const read = async () => (await api('GET', `/api/categories/${categoryId}/plan`)).plan;
      const initial = await read();
      const groupStage = initial.stages.find(s => s.kind === 'round_robin');
      if (!groupStage.matches.length) for (const pool of groupStage.pools) {
        const members = pool.members.map(m => m.participation_id);
        for (let a = 0; a < members.length; a++) for (let b = a+1; b < members.length; b++) await api('POST', '/api/matches', packet({
          category_id: categoryId, stage_id: groupStage.id, pool_id: pool.id, home_participation: members[a], away_participation: members[b], round_label: pool.name + '小组赛' }));
      }
      for (const match of (await read()).stages.find(s => s.id === groupStage.id).matches) if (match.status !== 'finished') await play(match);
      for (const pool of groupStage.pools) {
        const standings = await api('GET', `/api/pools/${pool.id}/standings`);
        await api('POST', `/api/pools/${pool.id}/confirm`, { base_results: standings.base_results, base_confirmation: standings.base_confirmation });
      }
      for (const stage of initial.stages.filter(s => s.id !== groupStage.id)) for (;;) {
        const remaining = (await read()).stages.find(s => s.id === stage.id).matches.filter(m => m.status !== 'finished');
        if (!remaining.length) break;
        const ready = remaining.filter(m => m.can_score); assert.ok(ready.length, JSON.stringify(remaining));
        for (const match of ready) await play(match);
      }
      await api('POST', `/api/categories/${categoryId}/placements/auto`, { confirm: true });
      const rankings = (await api('GET', `/api/categories/${categoryId}/placements`)).placements;
      assert.deepEqual(rankings.map(r => r.rank_no).sort((a,b) => a-b), [1,2,3,4,5,6,7,8]);
      assert.equal(new Set(rankings.map(r => r.participation_id)).size, 8);
      await page.goto(`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${categoryId}&tab=results`);
      const resultPanel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: /项目名次与积分/ }) });
      await resultPanel.locator('tbody tr').nth(7).waitFor();
      assert.equal(await resultPanel.locator('tbody tr').count(), 8);
      await page.screenshot({ path: path.join(artifacts, `schedule-played-rankings-${categoryId}.png`), fullPage: true });
    };
    await finishTournament(cat.id);
    await page.goto(`${base}/#/bracket?category=${cat.id}`);
    await page.locator('.bk-card').nth(11).waitFor();
    assert.equal(await page.locator('.bk-card').count(), 12, 'managed knockout and placement graphs both remain visible');
    assert.equal(await page.locator('.bk-champion').count(), 1, 'explicit championship final is distinguished from bronze and placement finals');
    const twoGroupCat = group.categories.find(c => c.kind === 'team' && c.gender === 'female');
    for (let i = 1; i <= 8; i++) await api('POST', `/api/categories/${twoGroupCat.id}/enrollments`, {
      school: { name: `两组完整比赛${i}校` }, seed_no: i, captain_index: 0,
      members: [1,2,3].map(n => ({ name: `两组${i}队员${n}`, gender: 'female', jersey_no: String(n) })) });
    await scheduleFixture(api, identity, twoGroupCat.id, { groupCount: 2, knockout: true });
    const twoPools = (await api('GET', `/api/categories/${twoGroupCat.id}/schedule`)).plan.stages[0].pools.map(p => p.id);
    for (const rank of [3,4]) {
      const stage = await api('POST', `/api/categories/${twoGroupCat.id}/schedule/stages`, packet({ base_revision: 0,
        definition: { purpose: 'placement', name: rank === 3 ? '第五六名赛' : '第七八名赛', pool_ids: twoPools, source_rank: rank,
          rank_from: rank === 3 ? 5 : 7, rank_to: rank === 3 ? 6 : 8 } }));
      await confirm(stage);
    }
    await finishTournament(twoGroupCat.id);
    pass('两组四队及四组八队主淘汰均实际打完，小组排名、冠亚季殿和名次赛闭环到浏览器最终名次表');
    const thirdStage = (await api('GET', `/api/categories/${cat.id}/schedule`)).plan.stages.find(s => s.name === '第三名名次赛');
    await page.goto(url + `&stage=${thirdStage.id}`); await page.locator('.schedule-match').first().waitFor();
    // Lose the actual success response, reload and replay the immutable packet.
    await page.getByRole('button', { name: '调整场地时间', exact: true }).first().click();
    dialog = page.getByRole('dialog', { name: /^调整场地时间/ });
    await dialog.getByLabel('备注', { exact: false }).fill('丢响应恢复验证');
    let lost = false;
    await page.route('**/api/matches/*', async route => {
      if (route.request().method() === 'PUT' && !lost) { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
    });
    await dialog.getByRole('button', { name: '保存安排', exact: true }).click();
    await dialog.locator('.form-errors:not(.hidden)').waitFor(); await page.reload();
    const retry = page.getByRole('button', { name: '核实并重试原操作', exact: true });
    const replayResponse = page.waitForResponse(r => r.request().method() === 'PUT' && /\/api\/matches\/\d+$/.test(new URL(r.url()).pathname));
    await retry.click();
    assert.equal((await replayResponse).status(), 200);
    // The heading was already present before replay; it cannot prove that
    // the pending write finished and the navigation guard was released.
    await retry.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
    await page.unroute('**/api/matches/*');
    const saved = (await api('GET', `/api/categories/${cat.id}/plan`)).plan;
    assert.equal(saved.stages.flatMap(s => s.matches).filter(m => m.manual_note === '丢响应恢复验证').length, 1);
    pass('真实丢失成功响应，刷新后同UID核实，无重复写入');
    await page.getByRole('link', { name: '分组', exact: true }).click();
    await page.getByRole('heading', { name: '学校小组抽签', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '新增比赛', exact: true }).count(), 0);
    await snapshot('groups');
    await page.goto(`${base}/#/scheduling?category=${cat.id}`); await page.getByRole('heading', { name: '自动辅助编排已移除', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    pass('分组与赛程职责分离，旧编排地址只显示退役提示，四宽度布局无横向溢出');
  }
  await writeFile(path.join(artifacts, 'schedule-browser-report.json'), JSON.stringify({ checks, geometry, errors }, null, 2));
} catch (error) {
  if (browser) {
    const active = browser.contexts().flatMap(c => c.pages()).find(p => !p.isClosed());
    if (active) {
      await active.screenshot({ path: path.join(artifacts, 'schedule-management-failure.png'), fullPage: true });
      await writeFile(path.join(artifacts, 'schedule-management-failure.json'), JSON.stringify({url:active.url(),body:await active.locator('body').innerText(),errors},null,2));
    }
  }
  throw error;
} finally { if (browser) await browser.close(); child.kill(); }
