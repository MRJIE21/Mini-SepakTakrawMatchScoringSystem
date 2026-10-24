import {reviewedResult,prepareReviewedFixture,approveCandidate} from './helpers/reviewed_result.mjs';
/* P2-A REQ-011：打印页稳定 URL、可刷新、权限失败提示与名次分组排序。
   真实浏览器 + 隔离 HTTP/SQLite；不写产品 data，不使用真实赛事数据。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'p2a-print-'));
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
  STSS_ADMIN_PASSWORD: 'PrintUrl123', PYTHONUTF8: '1' } });
let browser, page, serverErrors = '';
const checks = [];
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
const pass = (text) => { checks.push(text); console.log('PASS ' + text); };

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
  let token = '';
  let identity = null;
  const raw = async (method, url, body, t = token) => {
    const response = await fetch(base + url, { method, headers: {
      'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  };
  const api = async (method, url, body) => {
    const result = await raw(method, url, body);
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${url} -> ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };

  /* ---------------------------------------------------------------- 准备数据 */
  token = (await api('POST', '/api/login', { username: 'admin', password: 'PrintUrl123' })).token;
  const event = await api('POST', '/api/events', { name: '打印稳定地址验证赛', start_date: '2026-10-18' });
  identity = { event_id: event.event_id, event_uuid: event.event_uuid,
    deployment_id: (await api('GET', '/api/events')).deployment_id };
  await api('POST', `/api/events/${event.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${event.event_id}/structure`);
  const groupA = structure.groups[0];
  const groupB = structure.groups[1];
  const groupC = structure.groups[2];
  const teamCat = groupA.categories.find((c) => c.gender === 'male' && c.kind === 'team');
  const indivCat = groupA.categories.find((c) => c.gender === 'male' && c.kind === 'individual');

  const teamParts = [];
  for (let i = 1; i <= 4; i += 1) {
    const school = await api('POST', `/api/events/${event.event_id}/schools`,
      { name: `打印${i}校`, group_id: groupA.id });
    const team = await api('POST', `/api/categories/${teamCat.id}/teams`,
      { school_id: school.school_id, name: `打印${i}校队` });
    const part = await api('POST', `/api/categories/${teamCat.id}/participations`,
      { team_id: team.team_id, seed_no: i });
    teamParts.push(part.participation_id);
  }
  /* 三人赛：2 个已确认名次 + 2 个待确认 → 打印倒序时待确认必须单独分组。 */
  for (const [index, rank] of [1, 2].entries()) {
    await api('POST', `/api/categories/${teamCat.id}/placements`,
      { participation_id: teamParts[index], rank_no: rank, confirm: true });
  }
  /* 个人赛：2 名运动员成绩与已确认名次。 */
  const indivParts = [];
  for (let i = 1; i <= 2; i += 1) {
    const school = await api('POST', `/api/events/${event.event_id}/schools`,
      { name: `个人打印${i}校`, group_id: groupA.id });
    const athlete = await api('POST', `/api/schools/${school.school_id}/athletes`,
      { name: `打印选手${i}`, gender: 'male' });
    const part = await api('POST', `/api/categories/${indivCat.id}/participations`,
      { athlete_id: athlete.athlete_id });
    indivParts.push(part.participation_id);
  }
  for (const [index, pid] of indivParts.entries()) {
    await reviewedResult({base,token,identity},'POST','/api/scoring/individual', {
      submission_uid: `p2a-print-ind-${index}`, participation_id: pid, base_version: 0,
      result_status: 'normal', result_value: 20 - index, error_count: 0, violation_count: 0,
      event_identity: identity });
  }
  await api('POST', `/api/categories/${indivCat.id}/individual-rankings/confirm`, {});
  /* 乙组：只有报名、没有任何已开赛场次 → 未开赛组（REQ-008 页面/打印口径）。 */
  await api('POST', `/api/events/${event.event_id}/schools`, { name: '乙组未开赛校', group_id: groupB.id });
  /* 只读账号：访问导出接口返回 403。 */
  await api('POST', '/api/users', { username: 'print-viewer', password: 'PrintViewer123', role: 'viewer',
    display_name: '打印只读', event_ids: [event.event_id] });
  const viewerToken = (await api('POST', '/api/login',
    { username: 'print-viewer', password: 'PrintViewer123' })).token;

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const makeContext = async (t, eventId = event.event_id) => {
    const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
    await context.addInitScript(({ value, eid }) => {
      if (value) localStorage.setItem('stss_token', value);
      if (eid) localStorage.setItem('stss_event', String(eid));
    }, { value: t, eid: eventId });
    return context;
  };
  const context = await makeContext(token);
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const waitPrint = async (popup, title) => {
    await popup.waitForLoadState('domcontentloaded');
    await popup.getByRole('heading', { name: title, exact: true }).waitFor();
  };
  const openFrom = async (action) => {
    const popupWait = page.waitForEvent('popup');
    await action();
    const popup = await popupWait;
    return popup;
  };
  const tableRows = (popup) => popup.evaluate(() => [...document.querySelectorAll('table tbody tr')]
    .map((tr) => (tr.children.length === 1
      ? { separator: tr.textContent.trim() }
      : { cells: [...tr.children].map((td) => td.textContent.trim()) })));

  /* ---------------------------------------------------------------- 1. 项目成绩单：稳定 URL + 刷新 */
  await page.goto(`${base}/#/results?category=${indivCat.id}`);
  await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  const orderSelect = page.locator('select[aria-label="导出排序"]');
  await orderSelect.waitFor();
  assert.equal(await orderSelect.inputValue(), 'asc');
  await orderSelect.selectOption('desc');
  /* 1.5.0 成绩页（独立页）打印按钮按项目类型命名：“打印成绩单 / 打印名次表”（web/js/views/results.js:80-96）。 */
  const indivPopup = await openFrom(() => page.getByRole('button', { name: '打印成绩单', exact: true }).click());
  await waitPrint(indivPopup, '个人赛成绩单');
  const indivUrl = new URL(indivPopup.url());
  assert.notEqual(indivPopup.url(), 'about:blank', '打印页地址不能是 about:blank');
  assert.ok(indivUrl.pathname.endsWith('/print.html'), `打印页应为稳定静态地址：${indivUrl}`);
  assert.equal(indivUrl.searchParams.get('type'), 'category-notice');
  assert.equal(indivUrl.searchParams.get('category_id'), String(indivCat.id));
  assert.equal(indivUrl.searchParams.get('order'), 'desc');
  assert.equal(indivUrl.searchParams.get('event'), String(event.event_id));
  assert.ok(!indivUrl.search.toLowerCase().includes('token'), `打印 URL 不得包含令牌：${indivUrl}`);
  const assertIndivOrder = async (note) => {
    const rows = await tableRows(indivPopup);
    assert.deepEqual(rows.map((row) => row.cells && row.cells[0]), ['2', '1'], `${note}：${JSON.stringify(rows)}`);
  };
  await assertIndivOrder('成绩单倒序应只反转已确认名次');
  /* 复制到新标签/刷新后仍能按当前数据渲染（地址稳定、可刷新）。 */
  const copied = await context.newPage();
  await copied.goto(indivPopup.url());
  await copied.getByRole('heading', { name: '个人赛成绩单', exact: true }).waitFor();
  assert.equal((await copied.evaluate(() => document.querySelectorAll('table tbody tr').length)), 2);
  await copied.close();
  await indivPopup.reload();
  await waitPrint(indivPopup, '个人赛成绩单');
  await assertIndivOrder('刷新后');
  await indivPopup.close();
  pass('成绩页打印：popup URL 为 /print.html?...（非 about:blank、不含令牌），倒序只反转已确认名次，复制/刷新后仍渲染');

  /* ---------------------------------------------------------------- 2. 三人赛名次表：desc 待确认分组 */
  await page.goto(`${base}/#/results?category=${teamCat.id}`);
  await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  const teamPopup = await openFrom(() => page.getByRole('button', { name: '打印名次表', exact: true }).click());
  await waitPrint(teamPopup, '三人赛项目名次表');
  const teamUrl = new URL(teamPopup.url());
  assert.equal(teamUrl.searchParams.get('type'), 'category-notice');
  assert.equal(teamUrl.searchParams.get('order'), 'asc');
  const ascRows = await tableRows(teamPopup);
  assert.deepEqual(ascRows.map((row) => row.separator || row.cells[0]),
    ['1', '2', '待确认名次（不计入）', '待确认', '待确认'], JSON.stringify(ascRows));
  /* 直接在稳定 URL 上加 order=desc：已确认块降序，待确认分组仍固定在后。 */
  const descPopup = await openFrom(() => page.evaluate((url) => window.open(url, '_blank'),
    `${base}/print.html?type=category-notice&category_id=${teamCat.id}&event=${event.event_id}&order=desc`));
  await waitPrint(descPopup, '三人赛项目名次表');
  const descRows = await tableRows(descPopup);
  assert.deepEqual(descRows.map((row) => row.separator || row.cells[0]),
    ['2', '1', '待确认名次（不计入）', '待确认', '待确认'], JSON.stringify(descRows));
  await descPopup.close();
  await teamPopup.close();
  pass('三人赛名次表：desc 只反转已确认块，待确认名次固定分组追加（不稳定排序不会把待确认排到最前）');

  /* ---------------------------------------------------------------- 3. 学校总分页：打印 + 未开赛口径 */
  await page.goto(`${base}/#/school?group=${groupA.id}`);
  await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  await page.waitForFunction(() => document.querySelectorAll('.content .table-scroll tbody tr').length > 0);
  /* D01：该组还有 2 项名次未确认，名次列必须用“—（待确认）”占位，不能显示暂排数字。 */
  const normalRanks = await page.evaluate(() => [...document.querySelectorAll('.content .table-scroll tbody tr')]
    .map((tr) => tr.children[0].textContent.trim()));
  assert.ok(normalRanks.length > 0 && normalRanks.every((value) => value === '—（待确认）'),
    `已开赛但有未确认名次时页面应显示占位：${JSON.stringify(normalRanks)}`);
  assert.ok((await page.locator('.content').innerText()).includes('名次列以“—（待确认）”表示暂排'));
  const schoolPopup = await openFrom(() => page.getByRole('button', { name: '打印总分表', exact: true }).click());
  await waitPrint(schoolPopup, '学校团体总分表');
  const schoolUrl = new URL(schoolPopup.url());
  assert.equal(schoolUrl.searchParams.get('type'), 'school-notice');
  assert.equal(schoolUrl.searchParams.get('group_id'), String(groupA.id));
  assert.ok(!schoolUrl.search.includes('token'));
  const schoolText = await schoolPopup.locator('body').innerText();
  assert.ok(schoolText.includes('团体总分'), schoolText);
  assert.ok(schoolText.includes('打印1校'), schoolText);
  assert.ok(schoolText.includes('—（待确认）'), schoolText);
  await schoolPopup.close();

  await page.goto(`${base}/#/school?group=${groupB.id}`);
  await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  await page.waitForFunction(() => document.querySelectorAll('.content .table-scroll tbody tr').length > 0);
  const notStartedRanks = await page.evaluate(() => [...document.querySelectorAll('.content .table-scroll tbody tr')]
    .map((tr) => tr.children[0].textContent.trim()));
  assert.deepEqual(notStartedRanks, ['未开赛/无成绩'], JSON.stringify(notStartedRanks));
  const notStarted = await page.locator('.content').innerText();
  assert.ok(notStarted.includes('未开赛/无成绩'), notStarted);
  assert.ok(!notStarted.includes('项名次未确认'), '未开赛组不得显示待确认警告');
  const notStartedPopup = await openFrom(() => page.getByRole('button', { name: '打印总分表', exact: true }).click());
  await waitPrint(notStartedPopup, '学校团体总分表');
  const notStartedText = await notStartedPopup.locator('body').innerText();
  assert.ok(notStartedText.includes('本组别尚未开赛/无成绩，名次不计入'), notStartedText);
  assert.ok(!notStartedText.includes('尚有'), notStartedText);
  await notStartedPopup.close();

  /* 空组：页面空态行 + 去报名入口（REQ-017），仍保留打印/导出按钮。 */
  await page.goto(`${base}/#/school?group=${groupC.id}`);
  await page.waitForFunction(() => !document.querySelector('.content .spinner'));
  const emptyGroup = await page.locator('.content').innerText();
  assert.ok(emptyGroup.includes('暂无学校/暂无成绩'), emptyGroup);
  const registerLink = page.getByRole('link', { name: '去学校报名', exact: true });
  assert.equal(await registerLink.count(), 1);
  assert.ok((await registerLink.getAttribute('href')).includes('tab=registration'));
  assert.equal(await page.getByRole('button', { name: '打印总分表', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /XLSX$/ }).count(), 1);
  pass('学校总分：打印 URL 稳定；未开赛组显示“未开赛/无成绩”且公告同口径；空组显示空态行与报名入口并保留导出/打印');

  /* ---------------------------------------------------------------- 4. 失败路径：401 / 403 / 404 / 网络 */
  const printUrl = `${base}/print.html?type=category-notice&category_id=${indivCat.id}&event=${event.event_id}`;
  const noTokenContext = await makeContext('', event.event_id);
  const noTokenPage = await noTokenContext.newPage();
  await noTokenPage.goto(printUrl);
  await noTokenPage.locator('[data-print-error-code="401"]').waitFor();
  assert.ok((await noTokenPage.locator('[data-print-error-code="401"]').innerText()).includes('请登录'));
  assert.equal(await noTokenPage.locator('[data-print-back="true"]').count(), 1);
  await noTokenContext.close();

  const badTokenContext = await makeContext('invalid-token', event.event_id);
  const badTokenPage = await badTokenContext.newPage();
  await badTokenPage.goto(printUrl);
  await badTokenPage.locator('[data-print-error-code="401"]').waitFor();
  await badTokenContext.close();

  const viewerContext = await makeContext(viewerToken);
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(printUrl);
  await viewerPage.locator('[data-print-error-code="403"]').waitFor();
  const forbiddenText = await viewerPage.locator('[data-print-error-code="403"]').innerText();
  assert.ok(forbiddenText.includes('无权限'), forbiddenText);
  assert.equal(await viewerPage.locator('[data-print-back="true"]').count(), 1);
  await viewerContext.close();

  const missing = await context.newPage();
  await missing.goto(`${base}/print.html?type=category-notice&category_id=999999&event=${event.event_id}`);
  await missing.locator('[data-print-error-code="404"]').waitFor();
  assert.ok((await missing.locator('[data-print-error-code="404"]').innerText()).includes('数据不存在'));
  await missing.close();

  const networkPage = await context.newPage();
  await networkPage.route('**/api/exports/**', (route) => route.abort('failed'));
  await networkPage.goto(printUrl);
  await networkPage.locator('[data-print-error-code="network"]').waitFor();
  const networkText = await networkPage.locator('[data-print-error-code="network"]').innerText();
  assert.ok(networkText.includes('网络不可用'), networkText);
  assert.equal(await networkPage.locator('[data-print-retry="true"]').count(), 1);
  /* 点“重试”恢复后应正常渲染，而不是停留在错误页。 */
  await networkPage.unroute('**/api/exports/**');
  await networkPage.locator('[data-print-retry="true"]').click();
  await waitPrint(networkPage, '个人赛成绩单');
  await networkPage.close();
  pass('打印页失败路径：未登录/失效令牌 401、只读账号 403、无效项目 404、网络失败可重试并有返回入口，均不显示空白 about:blank');

  assert.deepEqual(pageErrors, [], `页面脚本错误：${JSON.stringify(pageErrors)}`);
  await writeFile(path.join(artifacts, 'p2a-print-url-report.json'),
    JSON.stringify({ status: 'PASS', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'p2a-print-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}
