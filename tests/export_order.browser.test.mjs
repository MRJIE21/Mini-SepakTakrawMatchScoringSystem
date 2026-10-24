import {reviewedResult,prepareReviewedFixture,approveCandidate} from './helpers/reviewed_result.mjs';
/* 成绩导出正/倒序的真实浏览器验证：下拉、传参、重置与只读边界。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'export-order-browser-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db()
c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class QuietHandler(Handler):
    def log_message(self,*args): pass
s=create_server(('127.0.0.1',0),QuietHandler)
print(json.dumps({'port':s.server_port}),flush=True)
s.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_ADMIN_PASSWORD: 'ExportOrder123', PYTHONUTF8: '1' } });
let browser, page, serverErrors = '';
const checks = [];
child.stderr.on('data', chunk => { serverErrors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'startup timeout')), 10000);
    child.once('exit', code => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  let identity = null;
  const api = async (method, url, body, expected = 200, alternateToken = token) => {
    const response = await fetch(base + url, { method, headers: {
      'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(alternateToken ? { Authorization: `Bearer ${alternateToken}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const eventsFor = scorelines => {
    const events = [];
    let seq = 0;
    scorelines.forEach((set, index) => {
      let home = 0; let away = 0;
      const order = set.home_points > set.away_points ? ['away', 'home'] : ['home', 'away'];
      for (const side of order) {
        const target = side === 'home' ? set.home_points : set.away_points;
        while ((side === 'home' ? home : away) < target) {
          if (side === 'home') home += 1; else away += 1;
          seq += 1;
          events.push({ seq, kind: 'score', set_no: index + 1, side, home_after: home, away_after: away });
        }
      }
    });
    return events;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'ExportOrder123' })).token;
  const event = await api('POST', '/api/events', { name: '导出排序浏览器验证', start_date: '2026-10-17' });
  identity = { event_id: event.event_id, event_uuid: event.event_uuid,
    deployment_id: (await api('GET', '/api/events')).deployment_id };
  await api('POST', `/api/events/${identity.event_id}/bootstrap`);
  const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
  const group = structure.groups[0];
  const cats = Object.fromEntries(group.categories.map(c => [`${c.gender}:${c.kind}`, c.id]));
  const teamParts = [];
  for (const [index, name] of ['排序甲校', '排序乙校'].entries()) {
    const school = await api('POST', `/api/events/${identity.event_id}/schools`, { name, group_id: group.id });
    const team = await api('POST', `/api/categories/${cats['male:team']}/teams`,
      { school_id: school.school_id, name: `${name}代表队` });
    const part = await api('POST', `/api/categories/${cats['male:team']}/participations`,
      { team_id: team.team_id, seed_no: index + 1 });
    teamParts.push(part.participation_id);
  }
  const match = await api('POST', '/api/matches', {
    category_id: cats['male:team'], home_participation: teamParts[0],
    away_participation: teamParts[1], round_label: '排序验证场次',
  });
  const detail = await api('GET', `/api/matches/${match.match_id}`);
  const sets = [{ set_no: 1, home_points: 15, away_points: 8, winner_side: 'home' },
    { set_no: 2, home_points: 15, away_points: 10, winner_side: 'home' }];
  await reviewedResult({base,token,identity},'POST','/api/scoring/submit', {
    submission_uid: `export-order-${match.match_id}`, match_id: match.match_id, base_version: 0,
    result_status: 'normal', sets, events: eventsFor(sets), device: 'UI 测试',
    plan_version: detail.match.plan_version,
    home_participation: detail.match.home.participation_id,
    away_participation: detail.match.away.participation_id,
    event_identity: identity,
  });
  const individualParts = [];
  for (const [index, name] of ['排序个人甲', '排序个人乙'].entries()) {
    const school = await api('POST', `/api/events/${identity.event_id}/schools`,
      { name: `排序个人校${index + 1}`, group_id: group.id });
    const athlete = await api('POST', `/api/schools/${school.school_id}/athletes`, { name, gender: 'male' });
    const part = await api('POST', `/api/categories/${cats['male:individual']}/participations`,
      { athlete_id: athlete.athlete_id });
    individualParts.push(part.participation_id);
  }
  for (const [index, part] of individualParts.entries()) {
    await reviewedResult({base,token,identity},'POST','/api/scoring/individual', {
      submission_uid: `export-order-ind-${index}`, participation_id: part, base_version: 0,
      result_status: 'normal', result_value: 20 - index, error_count: 0, violation_count: 0,
      event_identity: identity,
    });
  }
  await api('POST', `/api/categories/${cats['male:individual']}/individual-rankings/confirm`, {});

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN',
    acceptDownloads: true });
  await context.addInitScript(({ token, eventId }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(eventId));
  }, { token, eventId: identity.event_id });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw new Error(error.message); });

  const orderSelect = page.locator('select[aria-label="导出排序"]');
  const requestWith = async action => {
    const pending = page.waitForRequest(req => req.method() === 'GET' && req.url().includes('/api/exports/'));
    await action();
    const request = await pending;
    return new URL(request.url());
  };

  await page.goto(`${base}/#/results?category=${cats['male:individual']}`);
  await orderSelect.waitFor();
  assert.equal(await orderSelect.inputValue(), 'asc', '默认应为正序');
  await orderSelect.selectOption('desc');
  /* 1.5.0 成绩页（独立页）导出按钮文案为“导出 CSV / 导出 XLSX”（web/js/views/results.js:57-79）。 */
  const csvUrl = await requestWith(() => page.getByRole('button', { name: '导出 CSV', exact: true }).click());
  assert.equal(csvUrl.searchParams.get('order'), 'desc', `CSV 应带 order=desc：${csvUrl}`);
  /* REQ-011：打印改为稳定静态地址 /print.html?...，由打印页自己带令牌请求（主页面不再直接发导出请求）。 */
  const noticePopupWait = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打印成绩单', exact: true }).click();
  const noticePopup = await noticePopupWait;
  await noticePopup.getByRole('heading', { name: '个人赛成绩单', exact: true }).waitFor();
  const noticeUrl = new URL(noticePopup.url());
  assert.equal(noticeUrl.pathname, '/print.html', `打印页应为稳定静态地址：${noticeUrl}`);
  assert.equal(noticeUrl.searchParams.get('type'), 'category-notice');
  assert.equal(noticeUrl.searchParams.get('category_id'), String(cats['male:individual']));
  assert.equal(noticeUrl.searchParams.get('order'), 'desc', `打印页应带 order=desc：${noticeUrl}`);
  assert.ok(!noticeUrl.search.toLowerCase().includes('token'), `打印 URL 不得包含令牌：${noticeUrl}`);
  await noticePopup.close();
  /* 1.5.0 导出改为“前端带 Authorization 取回 blob 后本地下载”，Edge headless 触发下载后会额外
     打开 edge://downloads-hub/ 内部页；对浏览器内部页调用 page.close() 会挂起（实测 >4 分钟）。
     打印弹窗已显式关闭，这里仅清理 http(s) 残留页并跳过 edge:// 内部页，避免拖死整套回归。 */
  for (const extra of context.pages()) {
    if (extra === page) continue;
    if (extra.url().startsWith('edge://')) continue;
    await extra.close().catch(() => {});
  }
  checks.push('成绩页默认正序、切倒序后 CSV 与打印页传 order=desc（打印页为稳定 /print.html 地址）');

  await page.goto(`${base}/#/results?category=${cats['male:team']}`);
  await orderSelect.waitFor();
  assert.equal(await orderSelect.inputValue(), 'asc', '切换项目后应恢复正序');
  checks.push('切换项目后恢复默认正序');

  /* 1.5.0 起管理页按页签组织，导出与打印位于 #/admin?tab=exports；导出表按“报表行”渲染，
     项目成绩行的按钮为 XLSX/CSV，赛程行按钮为“整届 CSV/本项目 CSV”（web/js/views/admin.js:84-116、221-291）。 */
  await page.goto(`${base}/#/admin?tab=exports&category=${cats['male:team']}`);
  await page.getByRole('heading', { name: /更正与导出/ }).waitFor();
  const adminOrder = page.locator('select[aria-label="导出排序"]');
  await adminOrder.waitFor();
  assert.equal(await adminOrder.inputValue(), 'asc');
  await adminOrder.selectOption('desc');
  const projectReportRow = page.getByRole('row').filter({ hasText: '项目成绩' });
  const xlsxUrl = await requestWith(() => projectReportRow.getByRole('button', { name: 'XLSX', exact: true }).click());
  assert.equal(xlsxUrl.searchParams.get('order'), 'desc', `XLSX 应带 order=desc：${xlsxUrl}`);
  const scheduleReportRow = page.getByRole('row').filter({ hasText: '赛程' });
  const scheduleUrl = await requestWith(() => scheduleReportRow.getByRole('button', { name: '整届 CSV', exact: true }).click());
  assert.equal(scheduleUrl.searchParams.get('order'), null, '赛程导出不应带 order');
  checks.push('更正与导出页下拉、XLSX 传参、赛程不带 order');

  await page.goto(`${base}/#/school?group=${group.id}`);
  const schoolOrder = page.locator('select[aria-label="导出排序"]');
  await schoolOrder.waitFor();
  assert.equal(await schoolOrder.inputValue(), 'asc');
  await schoolOrder.selectOption('desc');
  const totalsUrl = await requestWith(() => page.getByRole('button', { name: /CSV$/ }).first().click());
  assert.equal(totalsUrl.searchParams.get('order'), 'desc', `学校总分 CSV 应带 order=desc：${totalsUrl}`);
  checks.push('学校总分页下拉与 CSV 传参');

  await api('POST', '/api/users', { username: 'order-viewer', display_name: '排序只读',
    password: 'OrderViewer123', role: 'viewer', event_ids: [identity.event_id] });
  const viewerToken = (await api('POST', '/api/login',
    { username: 'order-viewer', password: 'OrderViewer123' })).token;
  const viewerContext = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
  await viewerContext.addInitScript(({ token, eventId }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(eventId));
  }, { token: viewerToken, eventId: identity.event_id });
  const viewerPage = await viewerContext.newPage();
  for (const url of [`${base}/#/admin?category=${cats['male:team']}`, `${base}/#/school?group=${group.id}`]) {
    await viewerPage.goto(url);
    await viewerPage.waitForTimeout(1200);
    assert.equal(await viewerPage.locator('select[aria-label="导出排序"]').count(), 0, `查看角色不应有排序下拉：${url}`);
  }
  await viewerContext.close();
  checks.push('查看角色不显示排序与导出控件');

  await writeFile(path.join(artifacts, 'export-order-browser-report.json'),
    JSON.stringify({ status: 'PASS', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'export-order-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}
