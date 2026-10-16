/* 运行需已有 Playwright、Python 与 Edge；所有赛事均写入独立临时库。
   可用 STSS_PLAYWRIGHT_MODULE / STSS_PYTHON / STSS_BROWSER_PATH 指定本机工具。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const tempRoot = path.resolve(tmpdir());
const dataDir = await mkdtemp(path.join(tempRoot, 'stss-interactions-'));
const serverCode = `
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
`;
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', serverCode], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'BrowserTest123', PYTHONUTF8: '1' },
});
let serverErrors = '';
child.stderr.on('data', chunk => { serverErrors += chunk; });
let browser;
let passed = 0;
const pass = name => { passed++; console.log(`PASS ${name}`); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时: ${serverErrors}`)), 10000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`服务退出 ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const result = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(result.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  let identity;
  const api = async (method, url, body, expected = 200) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'BrowserTest123' })).token;
  identity = await api('POST', '/api/events', { name: '交互修复回归' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const group = (await api('GET', `/api/events/${identity.event_id}/structure`)).groups[0];
  const team = group.categories.find(c => c.kind === 'team' && c.gender === 'male');
  const individual = group.categories.find(c => c.kind === 'individual' && c.gender === 'male');
  const people = [], teams = [];
  for (let i = 1; i <= 2; i++) {
    const school = (await api('POST', `/api/events/${identity.event_id}/schools`, { name: `学校${i}`, group_id: group.id })).school_id;
    const athlete = (await api('POST', `/api/schools/${school}/athletes`, { name: `选手${i}`, gender: 'male' })).athlete_id;
    people.push((await api('POST', `/api/categories/${individual.id}/participations`, { athlete_id: athlete })).participation_id);
    const createdTeam = (await api('POST', `/api/categories/${team.id}/teams`, { school_id: school, name: `队伍${i}` })).team_id;
    teams.push((await api('POST', `/api/categories/${team.id}/participations`, { team_id: createdTeam })).participation_id);
  }
  const matches = [];
  for (let i = 0; i < 4; i++) matches.push((await api('POST', '/api/matches', {
    category_id: team.id, home_participation: teams[0], away_participation: teams[1], round_label: `复现赛${i}`,
  })).match_id);
  browser = await chromium.launch({ headless: true, ...(process.env.STSS_BROWSER_PATH
    ? { executablePath: process.env.STSS_BROWSER_PATH } : { channel: 'msedge' }) });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', acceptDownloads: true });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const drafts = () => page.evaluate(async () => (await (await import('/js/store.js')).localStore.all()).filter(d => !d.storage_conflict));
  const waitSaved = () => page.waitForFunction(() => !document.querySelector('.status-line')?.textContent.includes('正在保存本机记录'));

  await page.goto(`${base}/#/individual?category=${individual.id}`);
  await page.getByRole('button', { name: '首次录入', exact: true }).first().click();
  let dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').fill('18');
  await dialog.locator('[data-field=error_count]').fill('1');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  assert.equal((await drafts()).filter(d => d.kind === 'individual').length, 0);
  pass('快速输入后放弃，不产生本机草稿');

  await page.getByRole('button', { name: '首次录入', exact: true }).first().click();
  dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').fill('18');
  await dialog.locator('[data-field=error_count]').fill('1');
  assert.equal(await dialog.getByRole('button', { name: /保存.*草稿/ }).count(), 0);
  assert.equal((await drafts()).filter(d => d.kind === 'individual').length, 0, 'typing never stores a draft');
  await dialog.locator('[data-field=result_value]').fill('19');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  assert.equal((await drafts()).filter(d => d.kind === 'individual').length, 0);
  pass('个人赛仅提供提交，关闭可放弃未提交输入');
  const firstRow = () => page.getByRole('row').filter({ hasText: '选手1' });
  assert.ok(!(await firstRow().textContent()).includes('本机待提交'));
  assert.equal(await firstRow().getByRole('cell').nth(3).innerText(), '未录入');
  await firstRow().getByRole('button', { name: '首次录入', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  assert.equal(await dialog.locator('[data-field=result_value]').inputValue(), '', 'unsynced input is not restored into a reopened editor');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  pass('未提交的个人成绩不进入列表，重开编辑器读取后台值');

  await page.goto(`${base}/#/scoring?match=${matches[0]}`);
  await page.getByRole('button', { name: '开始第 1 局记录', exact: true }).click();
  await waitSaved();
  await page.evaluate(async () => {
    const { localStore } = await import('/js/store.js');
    window.originalPut = localStore.put;
    localStore.put = async () => null;
  });
  await page.locator('.add-btn.home').click();
  await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  assert.equal(await page.locator('.add-btn.home').isDisabled(), true);
  assert.equal(await page.locator('[data-role=points-home]').innerText(), '1');
  assert.equal((await drafts()).find(d => d.match_id === matches[0]).events.length, 0);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前记录', exact: true }).click();
  const download = await downloading;
  assert.equal(JSON.parse(await readFile(await download.path(), 'utf8')).drafts[0].events.length, 1);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByRole('dialog', { name: '当前记录尚未保存' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(page.url().endsWith(`match=${matches[0]}`));
  await page.evaluate(async () => { (await import('/js/store.js')).localStore.put = window.originalPut; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await waitSaved();
  assert.equal(await page.locator('.add-btn.home').isEnabled(), true);
  assert.equal((await drafts()).find(d => d.match_id === matches[0]).events.length, 1);
  pass('保存失败暂停记分、阻止误离开，导出与重试保留最新一分');

  await page.locator('select').last().selectOption('home_forfeit');
  await waitSaved();
  await page.route('**/api/scoring/submit', route => route.abort('failed'));
  await page.getByRole('button', { name: '核对无误，提交成绩', exact: true }).click();
  await page.getByRole('button', { name: '重试提交', exact: true }).waitFor();
  await waitSaved();
  await page.reload();
  await page.getByRole('button', { name: '重试提交', exact: true }).waitFor();
  await waitSaved();
  assert.equal(await page.getByRole('button', { name: '重试提交', exact: true }).isEnabled(), true);
  await page.unroute('**/api/scoring/submit');
  await page.getByRole('button', { name: '重试提交', exact: true }).click();
  await page.waitForURL('**/#/scoring?category=*');
  assert.equal((await api('GET', `/api/scoring/match/${matches[0]}`)).match.status, 'finished');
  pass('服务器未收到的提交，刷新后可以原样重试');

  await page.goto(`${base}/#/scoring?match=${matches[1]}`);
  await page.getByRole('button', { name: '开始第 1 局记录', exact: true }).waitFor();
  await page.locator('select').last().selectOption('away_forfeit');
  await waitSaved();
  await page.route('**/api/scoring/submit', async route => { await route.fetch(); await route.abort('failed'); });
  await page.getByRole('button', { name: '核对无误，提交成绩', exact: true }).click();
  await page.getByRole('button', { name: '重试提交', exact: true }).waitFor();
  await waitSaved();
  await page.unroute('**/api/scoring/submit');
  await page.reload();
  await page.getByRole('heading', { name: /已确认结果/ }).waitFor();
  assert.equal((await drafts()).filter(d => d.match_id === matches[1]).length, 0);
  assert.equal((await api('GET', `/api/matches/${matches[1]}/submissions`)).submissions.length, 1);
  pass('提交成功但响应丢失，刷新自动核实并显示正式结果');
  await page.evaluate(async ({ matchId, categoryId }) => {
    const { localStore } = await import('/js/store.js');
    const identity = (await import('/js/api.js')).getApiEventContext();
    const key = `${identity.deployment_id}:${identity.event_uuid}:match:${matchId}`;
    await localStore.begin({ key, kind: 'match', event_identity: identity, base_version: 0, category_id: categoryId, match_id: matchId,
      uid: 'stale-browser-only', status: 'recording', events: [{ type: 'point', set_no: 1, side: 'away', seq: 1 }] });
  }, { matchId: matches[1], categoryId: team.id });
  await page.reload();
  await page.getByRole('heading', { name: /已确认结果/ }).waitFor();
  assert.equal(await page.locator('.add-btn').count(), 0, 'unsynced cached record cannot hide an official finished result');
  await page.goto(`${base}/#/scoring?category=${team.id}`);
  await page.getByRole('heading', { name: /场次列表/ }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: '本地记录', exact: true }).count(), 0);
  await page.getByLabel('场次状态', { exact: true }).selectOption('ready');
  await page.waitForFunction(() => !document.querySelector('tbody')?.textContent.includes('复现赛1'));
  assert.ok(!(await page.locator('tbody').textContent()).includes('复现赛1'));
  pass('比赛状态与已确认结果以后台为准，本机缓存不进入队列筛选');

  await page.goto(`${base}/#/scoring?match=${matches[2]}`);
  await page.getByRole('button', { name: '开始第 1 局记录', exact: true }).waitFor();
  await page.evaluate(async matchId => {
    const { localStore } = await import('/js/store.js');
    const draft = (await localStore.all()).find(d => d.match_id === matchId);
    draft.status = 'submitting'; draft.result_status = 'home_forfeit';
    (await import('/js/submit.js')).buildMatchPayload(draft);
    await localStore.put(draft);
  }, matches[2]);
  await page.route('**/api/receipts/*', route => route.abort('failed'));
  await page.reload();
  await page.getByRole('button', { name: '重试提交', exact: true }).waitFor();
  await waitSaved();
  assert.equal(await page.getByRole('button', { name: '重试提交', exact: true }).isEnabled(), true);
  await page.unroute('**/api/receipts/*');
  await page.getByRole('button', { name: '重试提交', exact: true }).click();
  await page.waitForURL('**/#/scoring?category=*');
  pass('恢复提交中草稿且查询失败时仍能安全重试');

  await page.goto(`${base}/#/scoring?match=${matches[3]}`);
  await page.getByRole('button', { name: '开始第 1 局记录', exact: true }).click();
  await waitSaved();
  const onlineIdentity = await page.evaluate(async () => (await import('/js/api.js')).getApiEventContext());
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.add-btn.home').waitFor();
  assert.deepEqual(await page.evaluate(async () => (await import('/js/api.js')).getApiEventContext()), onlineIdentity);
  await page.locator('.add-btn.home').click();
  await waitSaved();
  assert.equal((await drafts()).find(d => d.match_id === matches[3]).events.length, 1);
  await page.evaluate(cat => { location.hash = `#/individual?category=${cat}`; }, individual.id);
  await page.getByRole('button', { name: '首次录入', exact: true }).first().waitFor();
  await page.getByRole('button', { name: '首次录入', exact: true }).first().click();
  assert.equal(await page.getByRole('dialog').locator('[data-field=result_value]').inputValue(), '');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  pass('离线身份与待提交比赛输入保留，个人赛名单不恢复未提交的成绩');
  await context.setOffline(false);
  await page.waitForFunction(async () => !(await import('/js/main.js')).state.offline);
  await page.goto(`${base}/#/field`);
  await page.getByRole('heading', { name: '现场任务', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /本机待处理/ }).count(), 0);
  assert.equal(await page.getByText(/条本机记录/).count(), 0);
  await page.evaluate(async cat => {
    const identity = (await import('/js/api.js')).getApiEventContext();
    localStorage.setItem(`stss_draft:admin:${identity.deployment_id}:${identity.event_uuid}:enroll:individual:${cat}`, JSON.stringify({ values: { name: '仅在本机的报名' } }));
  }, individual.id);
  await page.goto(`${base}/#/workspace?event=${identity.event_id}&group=${group.id}&category=${individual.id}&tab=registration`);
  await page.getByRole('heading', { name: '学校名单', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /未完成添加/ }).count(), 0);
  assert.ok(!(await page.locator('main').textContent()).includes('仅在本机的报名'));
  await page.goto(`${base}/#/individual?category=${individual.id}`);
  await page.getByRole('heading', { name: /成绩与名次（2 人）/ }).waitFor();
  pass('现场入口与项目报名名单不显示未同步的本机计数');

  for (const pid of people) await api('POST', '/api/scoring/individual', {
    submission_uid: `browser-${pid}`, participation_id: pid, event_identity: identity,
    base_version: 0, result_status: 'normal', result_value: 20, error_count: 1, violation_count: 0,
  });
  await page.evaluate(async () => {
    const { localStore } = await import('/js/store.js');
    for (const draft of await localStore.all()) if (draft.kind === 'individual') await localStore.remove(draft.key, draft);
  });
  await page.reload();
  await page.getByRole('button', { name: '按成绩确认项目名次', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '个人赛并列名次 · 录入抽签结果' });
  await dialog.locator(`[data-field=lot_${people[0]}]`).fill('2');
  await dialog.locator(`[data-field=lot_${people[1]}]`).fill('1');
  await dialog.getByRole('button', { name: '保存抽签并确认项目名次', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  const placements = (await api('GET', `/api/categories/${individual.id}/placements`)).placements;
  assert.equal(placements.find(p => p.rank_no === 1).participation_id, people[1]);
  pass('个人赛抽签窗口可完成并列排序与项目名次确认');

  await page.getByRole('row').filter({ hasText: '选手1' }).getByRole('button', { name: '修改正式成绩', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').fill('30');
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await dialog.getByText('请填写正式更正原因', { exact: true }).first().waitFor();
  await dialog.locator('[data-field=reason]').fill('裁判复核');
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  assert.ok((await api('GET', `/api/categories/${individual.id}/placements`)).placements.every(p => p.status === 'pending'));
  await api('POST', '/api/users', { username: 'browser_recorder', password: 'Recorder123', role: 'recorder', display_name: '记录员', event_ids: [identity.event_id] });
  const recorderToken = (await api('POST', '/api/login', { username: 'browser_recorder', password: 'Recorder123' })).token;
  const recorderContext = await browser.newContext();
  await recorderContext.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token: recorderToken, event: identity.event_id });
  const recorderPage = await recorderContext.newPage();
  await recorderPage.goto(`${base}/#/individual?category=${individual.id}`);
  await recorderPage.getByText('已提交；更正请联系成绩人员', { exact: true }).first().waitFor();
  assert.equal(await recorderPage.getByRole('button', { name: '修改正式成绩', exact: true }).count(), 0);
  pass('正式更正要求原因，记录员界面只读');

  await page.evaluate(async ({ participationId, categoryId }) => {
    const { localStore } = await import('/js/store.js');
    const identity = (await import('/js/api.js')).getApiEventContext();
    await localStore.begin({ key: `${identity.deployment_id}:${identity.event_uuid}:individual:${participationId}`, kind: 'individual',
      event_identity: identity, category_id: categoryId, participation_id: participationId,
      base_version: 0, uid: 'stale-individual-cache', status: 'recording', result_value: 777, result_status: 'normal' });
  }, { participationId: people[1], categoryId: individual.id });
  await page.reload();
  const secondRow = page.getByRole('row').filter({ hasText: '选手2' });
  assert.equal(await secondRow.getByRole('cell').nth(3).innerText(), '20');
  await secondRow.getByRole('button', { name: '修改正式成绩', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  assert.equal(await dialog.locator('[data-field=result_value]').inputValue(), '20', 'backend result overrides a cached correction input');
  await dialog.locator('[data-field=result_value]').fill('55');
  await dialog.locator('[data-field=reason]').fill('慢存储测试');
  assert.ok(!(await drafts()).some(d => d.result_value === 55), 'ordinary edits stay in the form');
  await page.evaluate(async () => {
    const { localStore } = await import('/js/store.js');
    delete window.releasePut;
    window.originalBegin = localStore.begin;
    localStore.begin = async (...args) => {
      await new Promise(resolve => { window.releasePut = resolve; });
      localStore.begin = window.originalBegin;
      return localStore.begin(...args);
    };
  });
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await page.waitForFunction(() => !!window.releasePut);
  assert.equal(await dialog.locator('[data-field=result_value]').isDisabled(), true);
  await page.evaluate(() => window.releasePut());
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  pass('提交包写入较慢时冻结输入，避免自动保存与提交相互覆盖');
  assert.ok(await page.evaluate(async () => (await (await import('/js/store.js')).localStore.all())
    .some(d => d.storage_conflict && d.uid === 'stale-individual-cache' && d.result_value === 777)), 'old ordinary input remains in a recovery branch');
  // Backend confirmation wins after an individual response is lost, without hiding its retry packet.
  await page.getByRole('row').filter({ hasText: '选手2' }).getByRole('button', { name: '修改正式成绩', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').fill('56');
  await dialog.locator('[data-field=reason]').fill('响应丢失验证');
  await page.route('**/api/scoring/individual', async route => { await route.fetch(); await route.abort('failed'); });
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await dialog.locator('.form-errors:not(.hidden)').waitFor();
  await page.unroute('**/api/scoring/individual');
  await page.reload();
  let row2 = page.getByRole('row').filter({ hasText: '选手2' });
  assert.equal(await row2.getByRole('cell').nth(3).innerText(), '56');
  await row2.getByRole('button', { name: '修改正式成绩', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').waitFor();
  assert.equal(await dialog.locator('[data-field=result_value]').inputValue(), '56');
  assert.equal((await drafts()).filter(d => d.kind === 'individual' && d.participation_id === people[1]).length, 0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  pass('个人赛响应丢失后显示后台成绩，自动核实原提交再打开最新值');
  // A request that never reached the backend stays private and retries with exactly its original UID.
  row2 = page.getByRole('row').filter({ hasText: '选手2' });
  await row2.getByRole('button', { name: '修改正式成绩', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').fill('57');
  await dialog.locator('[data-field=reason]').fill('请求未达验证');
  await page.route('**/api/scoring/individual', route => route.abort('failed'));
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await dialog.locator('.form-errors:not(.hidden)').waitFor();
  const originalPacket = (await drafts()).find(d => d.kind === 'individual' && d.participation_id === people[1]).payload;
  assert.equal(originalPacket.result_value, 57);
  await page.unroute('**/api/scoring/individual');
  await page.reload();
  row2 = page.getByRole('row').filter({ hasText: '选手2' });
  assert.equal(await row2.getByRole('cell').nth(3).innerText(), '56');
  await row2.getByRole('button', { name: '修改正式成绩', exact: true }).click();
  await page.getByRole('dialog', { name: '上次提交结果待核实', exact: true }).waitFor();
  assert.equal((await drafts()).find(d => d.kind === 'individual' && d.participation_id === people[1]).payload.submission_uid, originalPacket.submission_uid);
  const retryConfirmed = page.waitForResponse(response => response.url().endsWith('/api/scoring/individual')
    && response.request().method() === 'POST'
    && response.request().postDataJSON()?.submission_uid === originalPacket.submission_uid);
  await page.getByRole('dialog', { name: '上次提交结果待核实', exact: true }).getByRole('button', { name: '重试提交', exact: true }).click();
  const retryResponse = await retryConfirmed;
  assert.equal(retryResponse.status(), 200);
  assert.equal((await retryResponse.json()).receipt.uid, originalPacket.submission_uid);
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  await page.waitForFunction(async pid => !(await (await import('/js/store.js')).localStore.all()).some(d => d.kind === 'individual' && d.participation_id === pid), people[1]);
  assert.equal((await api('GET', `/api/categories/${individual.id}/individual-results`)).results.find(r => r.participation_id === people[1]).result_value, 57);
  assert.equal((await api('GET', `/api/submissions/${originalPacket.submission_uid}`)).found, true);
  pass('未到达后台的个人成绩不显示，私有原提交包可原样重试');
  // A definite validation rejection keeps editable input without an extra draft workflow.
  await page.getByRole('row').filter({ hasText: '选手2' }).getByRole('button', { name: '修改正式成绩', exact: true }).click();
  dialog = page.getByRole('dialog').first();
  await dialog.locator('[data-field=result_value]').fill('58.5');
  await dialog.locator('[data-field=reason]').fill('校验重试');
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await dialog.locator('.form-errors:not(.hidden)').waitFor();
  assert.equal(await dialog.locator('[data-field=result_value]').isDisabled(), false);
  assert.equal(await dialog.locator('[data-field=result_value]').inputValue(), '58.5');
  assert.equal((await drafts()).filter(d => d.kind === 'individual' && d.participation_id === people[1]).length, 0);
  assert.equal((await api('GET', `/api/categories/${individual.id}/individual-results`)).results.find(r => r.participation_id === people[1]).result_value, 57);
  await dialog.locator('[data-field=result_value]').fill('58');
  await dialog.getByRole('button', { name: '核对并提交', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  assert.equal((await api('GET', `/api/categories/${individual.id}/individual-results`)).results.find(r => r.participation_id === people[1]).result_value, 58);
  pass('后台校验拒绝后输入保持可编辑，修改后直接提交成功');
  await page.route('**/api/me', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ ok: false, code: 'server_busy', message: '测试忙锁' }) }), { times: 1 });
  const busyRecovery = page.waitForResponse(response => response.url().endsWith('/api/me') && response.status() === 503);
  await page.evaluate(async () => { (await import('/js/main.js')).state.offline = true; window.dispatchEvent(new Event('online')); });
  await busyRecovery;
  await page.getByText('测试忙锁', { exact: true }).waitFor();
  assert.equal(await page.locator('#login-screen').count(), 0, 'temporary server failure does not invalidate authentication');
  await page.route('**/api/me', route => route.fulfill({ status: 401, contentType: 'application/json',
    body: JSON.stringify({ ok: false, code: 'unauthorized', message: '登录已失效' }) }), { times: 1 });
  await page.evaluate(async () => { (await import('/js/main.js')).state.offline = true; window.dispatchEvent(new Event('online')); });
  try { await page.locator('#login-screen').waitFor(); }
  catch(error) { console.error(await page.locator('body').innerText()); console.error(pageErrors); throw error; }
  await page.locator('#login-screen input[type=text]').fill('admin');
  await page.locator('#login-screen input[type=password]').fill('BrowserTest123');
  const freshEventRead = page.waitForResponse(response => response.url().endsWith('/api/events')
    && response.request().method() === 'GET' && response.status() === 200);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await freshEventRead;
  await page.waitForFunction(() => !document.querySelector('#login-screen') && !document.querySelector('#app.hidden'));
  pass('离线恢复遇到登录失效时清除旧账号绑定，原账号可重新登录');
  assert.deepEqual(pageErrors, []);
  console.log(`${passed} browser scenarios passed`);
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  const resolved = path.resolve(dataDir);
  if (resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('stss-interactions-')) {
    await rm(resolved, { recursive: true, force: true });
  }
}
