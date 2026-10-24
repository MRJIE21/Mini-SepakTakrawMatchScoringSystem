import {registrationEdit,registrationProject} from './helpers/registration_ui.mjs';
/* Actual isolated school-deletion workflow. Never uses the running event database. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataRoot = process.env.STSS_SCHOOL_DELETE_DATA_ROOT || path.resolve(root, '../tmp/school-delete-20261014/test-data');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.resolve(root, '../tmp/school-delete-20261014/artifacts');
await mkdir(dataRoot, { recursive: true }); await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(path.join(dataRoot, 'school-'));
assert.ok(!dataDir.startsWith(path.join(root, 'data') + path.sep));
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
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
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'DeleteSchoolTest123', PYTHONUTF8: '1' },
});
const suite = process.env.STSS_SCHOOL_DELETE_SUITE || 'entry';
let browser, page, serverErrors = '';
const checks = [], errors = [];
child.stderr.on('data', chunk => { serverErrors += chunk; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Isolated server startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverErrors}`)); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const first = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(first.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token, identity;
  const api = async (method, url, body, options = {}) => {
    const scope = options.identity ?? identity;
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
        ...(options.token || token ? { Authorization: `Bearer ${options.token || token}` } : {}),
        ...(scope ? { 'X-Event-ID': String(scope.event_id), 'X-Event-UUID': scope.event_uuid,
          ...(scope.deployment_id ? { 'X-Deployment-ID': scope.deployment_id } : {}) } : {}), ...(options.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json(); assert.equal(response.status, options.status || 200, JSON.stringify(data)); return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'DeleteSchoolTest123' })).token;
  identity = await api('POST', '/api/events', { name: '学校删除入口验证（隔离数据）' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
  const group = structure.groups[0];
  const createSchool = async name => (await api('POST', `/api/events/${identity.event_id}/schools`, { name, group_id: group.id })).school_id;
  const schools = async () => (await api('GET', `/api/events/${identity.event_id}/schools`)).schools;
  const draftId = await createSchool('误建学校 bi（测试）');
  const emptyId = await createSchool('待删除的空学校（测试）');
  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  let navigation = 0;
  /* 1.5.0 报名详情页头改为 ui.js 的 pageHeader()：header.page-head + h1.page-title + .page-actions。
     用「报名名单」面包屑链接把工作台详情页头与其它视图的 .page-head 区分开。 */
  const registrationHead = target => target.locator('header.page-head')
    .filter({ has: target.getByRole('link', { name: '报名名单', exact: true }) });
  const detailHead = () => registrationHead(page);
  const openSchool = async id => {
    await page.goto(`${base}/?school_check=${++navigation}#/schoolRegistration?event=${identity.event_id}&school=${id}`);
    await page.waitForLoadState('networkidle');
    await detailHead().waitFor();
  };
  const deleteButton = () => detailHead().getByRole('button', { name: '删除学校', exact: true });
  const deleteDialog = () => page.getByRole('dialog', { name: '删除学校', exact: true });
  const screenshot = async name => {
    await page.waitForFunction(() => {
      const toast = document.querySelector('#toast');
      return !toast || (!toast.classList.contains('show') && Number(getComputedStyle(toast).opacity) < 0.01);
    });
    if (!await deleteDialog().count()) await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, name), fullPage: !await deleteDialog().count() });
  };
  const waitEnabled = async () => page.waitForFunction(() => {
    const button = document.querySelector('.school-registration-delete'); return button && !button.disabled;
  });
  await openSchool(draftId);
  for (const asset of ['/js/views/schoolRegistration.js', '/js/ui.js', '/css/app.css', '/sw.js']) {
    assert.equal((await fetch(base + asset)).status, 200, `${asset} served by actual server`);
  }
  assert.equal(await deleteButton().isVisible(), true);
  assert.match(await detailHead().innerText(), /误建学校 bi（测试）/);
  await screenshot(`school-delete-${suite}-entry-1365.png`);
  checks.push('isolated service login, actual assets and administrator deletion entry in current detail');
  let deleteCalls = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && /\/api\/schools\/\d+$/.test(request.url())) deleteCalls++; });
  await registrationEdit(page);
  await page.locator('.school-registration-people details:not(.school-registration-person) > summary').click();
  const unaddedName = page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true });
  await unaddedName.fill('取消删除后应保留的输入');
  await deleteButton().click();
  await deleteDialog().waitFor();
  assert.match(await deleteDialog().innerText(), /学校：误建学校 bi（测试）/);
  assert.match(await deleteDialog().innerText(), /所属组别：甲组/);
  assert.match(await deleteDialog().innerText(), /0 位人员 · 0 个三人赛项目名单/);
  assert.match(await deleteDialog().innerText(), /当前尚未提交的修改将一并放弃/);
  await page.waitForFunction(() => document.activeElement?.textContent === '取消');
  assert.equal(await deleteDialog().getByRole('button', { name: '确认删除', exact: true }).evaluate(el => el.classList.contains('btn-danger')), true);
  await screenshot(`school-delete-${suite}-confirm-1365.png`);
  await deleteDialog().getByRole('button', { name: '取消', exact: true }).click(); await waitEnabled();
  assert.equal(deleteCalls, 0);
  assert.equal(await unaddedName.inputValue(), '取消删除后应保留的输入');
  assert.equal(await deleteButton().evaluate(el => el === document.activeElement), true);
  assert.equal((await schools()).some(s => s.id === draftId), true);
  checks.push('fresh impact confirmation, cancel-first focus, no DELETE on cancel, unadded input and trigger focus retained');
  await deleteButton().click(); await deleteDialog().waitFor(); await page.keyboard.press('Escape'); await waitEnabled();
  assert.equal(deleteCalls, 0); assert.equal(await unaddedName.inputValue(), '取消删除后应保留的输入');
  checks.push('Escape cancels without losing draft or deleting');
  await openSchool(emptyId);
  const beforeCount = (await schools()).length;
  await deleteButton().click(); await deleteDialog().waitFor();
  await deleteDialog().getByRole('button', { name: '确认删除', exact: true }).click();
  await page.locator('.school-registration-directory').waitFor();
  assert.equal((await schools()).some(s => s.id === emptyId), false);
  assert.equal(deleteCalls, 1);
  assert.equal(await page.getByRole('button', { name: '待删除的空学校（测试）', exact: true }).count(), 0);
  assert.match(await page.locator('.school-registration-directory').innerText(), new RegExp(`共 ${beforeCount - 1} 所学校`));
  assert.match(page.url(), new RegExp(`event=${identity.event_id}`));
  checks.push('confirmed empty-school deletion updates actual data and current event list count');
  const confirmDelete = async () => {
    await deleteButton().click(); await deleteDialog().waitFor();
    await deleteDialog().getByRole('button', { name: '确认删除', exact: true }).click();
  };
  const expectFeedback = text => page.locator('#school-delete-status').filter({ hasText: text }).waitFor();
  const teamCat = group.categories.find(c => c.gender === 'male' && c.kind === 'team');
  const individualCat = group.categories.find(c => c.gender === 'male' && c.kind === 'individual');
  const addPerson = async (id, name) => (await api('POST', `/api/schools/${id}/athletes`, { name, gender: 'male', note: '' })).athlete_id;
  let otherEvent, otherSchool;
  if (['security', 'integration'].includes(suite)) {
    otherEvent = await api('POST', '/api/events', { name: '学校删除身份隔离第二赛事（测试）' });
    otherEvent.deployment_id = identity.deployment_id;
    await api('POST', `/api/events/${otherEvent.event_id}/bootstrap`, {}, { identity: otherEvent });
    const otherStructure = await api('GET', `/api/events/${otherEvent.event_id}/structure`, undefined, { identity: otherEvent });
    otherSchool = (await api('POST', `/api/events/${otherEvent.event_id}/schools`,
      { name: '第二赛事相同编号学校（测试）', group_id: otherStructure.groups[0].id }, { identity: otherEvent })).school_id;
    assert.equal(otherSchool, draftId, 'independent event databases have a colliding school ID');
  }
  if (suite === 'integration') {
    const archiveId = await createSchool('未报名但有档案的学校');
    const archivePerson = await addPerson(archiveId, '未报名档案');
    const archiveTeam = (await api('POST', `/api/categories/${teamCat.id}/teams`, { school_id: archiveId, member_ids: [archivePerson] })).team_id;
    assert.equal((await api('GET', `/api/categories/${teamCat.id}/teams`)).teams.some(t => t.id === archiveTeam), true);
    await openSchool(archiveId); await deleteButton().click(); await deleteDialog().waitFor();
    assert.match(await deleteDialog().innerText(), /1 位人员 · 1 个三人赛项目名单/);
    await deleteDialog().getByRole('button', { name: '确认删除', exact: true }).click();
    await page.locator('.school-registration-directory').waitFor();
    assert.equal((await schools()).some(s => s.id === archiveId), false);
    assert.equal((await api('GET', `/api/schools/${archiveId}/athletes`)).athletes.length, 0);
    assert.equal((await api('GET', `/api/categories/${teamCat.id}/teams`)).teams.some(t => t.id === archiveTeam), false);
    const logs = await api('GET', '/api/audit-logs');
    assert.ok(JSON.stringify(logs).includes('delete_school'));
    checks.push('deleting an unenrolled school cascades its actual person/team archives and records an audit');

    const zeroId = await createSchool('零人员但已有三人赛报名');
    const zeroTeam = (await api('POST', `/api/categories/${teamCat.id}/teams`, { school_id: zeroId, member_ids: [] })).team_id;
    await api('POST', `/api/categories/${teamCat.id}/participations`, { team_id: zeroTeam });
    assert.equal((await schools()).find(s => s.id === zeroId).athlete_count, 0);
    await openSchool(zeroId); await confirmDelete(); await expectFeedback('该学校已有参赛报名，不能删除'); await waitEnabled();
    assert.equal((await schools()).some(s => s.id === zeroId), true);
    assert.equal((await api('GET', `/api/categories/${teamCat.id}/participations`)).participations.some(p => p.team_id === zeroTeam), true);
    checks.push('zero people does not bypass the actual team participation deletion guard');

    const enrolledId = await createSchool('已有个人赛报名的学校');
    const enrolledPerson = await addPerson(enrolledId, '参赛档案');
    await api('POST', `/api/categories/${individualCat.id}/participations`, { athlete_id: enrolledPerson });
    await openSchool(enrolledId); await registrationEdit(page);
    const personNote = page.locator(`[data-person="a:${enrolledPerson}"]`).getByLabel('区分信息', { exact: true });
    await personNote.fill('拒绝删除后仍保留的输入');
    await confirmDelete(); await expectFeedback('该学校已有参赛报名，不能删除'); await waitEnabled();
    assert.equal(await personNote.inputValue(), '拒绝删除后仍保留的输入');
    assert.equal((await api('GET', `/api/schools/${enrolledId}/athletes`)).athletes[0].note, '');
    assert.equal((await api('GET', `/api/categories/${individualCat.id}/participations`)).participations.some(p => p.athlete_id === enrolledPerson), true);
    checks.push('individual participation refuses deletion without altering server data or local edits');

    const detailUrl = `${base}/api/schools/${enrolledId}/detail`;
    const callsBeforeRead = deleteCalls;
    await page.route(detailUrl, handler => handler.fulfill({ status: 503, json: { code: 'test_read_error', message: '档案读取失败（测试）' } }));
    await deleteButton().click(); await expectFeedback('档案读取失败'); await waitEnabled();
    assert.equal(await deleteDialog().count(), 0); assert.equal(deleteCalls, callsBeforeRead);
    assert.equal(await personNote.inputValue(), '拒绝删除后仍保留的输入');
    await page.unroute(detailUrl);
    await page.route(detailUrl, handler => handler.fulfill({ status: 200, json: { school: { id: enrolledId }, athletes: [], teams: [] } }));
    await deleteButton().click(); await expectFeedback('学校档案读取不完整'); await waitEnabled();
    assert.equal(await deleteDialog().count(), 0); assert.equal(deleteCalls, callsBeforeRead);
    await page.unroute(detailUrl);
    checks.push('failed/malformed preflight does not open an unverified confirmation or send DELETE');

    const lostId = await createSchool('删除成功但丢回执的学校');
    await openSchool(lostId); const lostUrl = `${base}/api/schools/${lostId}`;
    const beforeLost = deleteCalls;
    await page.route(lostUrl, async handler => { await handler.fetch(); await handler.fulfill({ status: 502, json: { code: 'test_lost_ack', message: '删除回执丢失（测试）' } }); });
    await confirmDelete(); await expectFeedback('删除结果尚未确认');
    assert.equal((await schools()).some(s => s.id === lostId), false);
    assert.equal(await deleteButton().isDisabled(), true);
    const listUrl = `${base}/api/events/${identity.event_id}/schools`;
    await page.route(listUrl, handler => handler.fulfill({ status: 503, json: { code: 'test_verify_error', message: '核对读取失败（测试）' } }));
    await page.getByRole('button', { name: '核对删除结果', exact: true }).click(); await expectFeedback('核对失败');
    assert.equal(deleteCalls, beforeLost + 1); assert.equal(await deleteButton().isDisabled(), true);
    await page.unroute(listUrl);
    await page.route(listUrl, handler => handler.fulfill({ status: 200, json: { schools: 'not-an-array' } }));
    await page.getByRole('button', { name: '核对删除结果', exact: true }).click(); await expectFeedback('学校名单读取不完整');
    assert.equal(deleteCalls, beforeLost + 1); assert.equal(await deleteButton().isDisabled(), true);
    await page.unroute(listUrl);
    const foreignList = await api('GET', `/api/events/${otherEvent.event_id}/schools`, undefined, { identity: otherEvent });
    await page.route(listUrl, handler => handler.fulfill({ status: 200, json: foreignList }));
    await page.getByRole('button', { name: '核对删除结果', exact: true }).click(); await expectFeedback('学校名单读取不完整');
    assert.equal(deleteCalls, beforeLost + 1); assert.equal(await deleteButton().isDisabled(), true);
    await page.unroute(listUrl); await page.unroute(lostUrl);
    await page.getByRole('button', { name: '核对删除结果', exact: true }).click(); await page.locator('.school-registration-directory').waitFor();
    assert.equal(deleteCalls, beforeLost + 1);
    checks.push('committed deletion with lost acknowledgement is recovered by valid GET only, never replayed on failed/malformed reads');

    const retryId = await createSchool('网络失败仍在名单的学校');
    await openSchool(retryId); await registrationEdit(page);
    await page.locator('.school-registration-people details:not(.school-registration-person) > summary').click();
    await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).fill('未知删除结果仍保留的输入');
    const retryUrl = `${base}/api/schools/${retryId}`, beforeRetry = deleteCalls;
    await page.route(retryUrl, handler => handler.abort('failed'));
    await confirmDelete(); await expectFeedback('删除结果尚未确认');
    assert.equal((await schools()).some(s => s.id === retryId), true);
    await page.unroute(retryUrl);
    await page.getByRole('button', { name: '核对删除结果', exact: true }).click(); await expectFeedback('学校仍在名单'); await waitEnabled();
    assert.equal(await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).inputValue(), '未知删除结果仍保留的输入');
    assert.equal(deleteCalls, beforeRetry + 1);
    await confirmDelete(); await page.locator('.school-registration-directory').waitFor();
    assert.equal(deleteCalls, beforeRetry + 2); assert.equal((await schools()).some(s => s.id === retryId), false);
    checks.push('uncommitted network failure preserves input, and retry requires a new explicit confirmation after GET reconciliation');

    const busyId = await createSchool('报名与删除互斥学校');
    const busyPerson = await addPerson(busyId, '报名状态测试档案');
    await openSchool(busyId); await registrationEdit(page);
    const busyNote = () => page.locator(`[data-person="a:${busyPerson}"]`).getByLabel('区分信息', { exact: true });
    const submit = () => page.locator('[data-action="school-preview"]');
    await busyNote().fill('保存进行中'); await submit().click();
    await page.getByRole('heading', { name: '核对整批变更', exact: true }).waitFor();
    const commitUrl = `${base}/api/schools/${busyId}/registration-commit`;
    let releaseCommit, commitArrived;
    const commitArrival = new Promise(resolve => { commitArrived = resolve; });
    const commitRelease = new Promise(resolve => { releaseCommit = resolve; });
    await page.route(commitUrl, async handler => { const response = await handler.fetch(); commitArrived(); await commitRelease; await handler.fulfill({ response }); });
    await submit().click(); await commitArrival;
    assert.equal(await deleteButton().isDisabled(), true); await expectFeedback('正在处理报名');
    const callsWhileBusy = deleteCalls; await deleteButton().evaluate(el => el.click()); assert.equal(deleteCalls, callsWhileBusy);
    releaseCommit(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor(); await waitEnabled();
    await page.unroute(commitUrl);
    await registrationEdit(page);
    await busyNote().fill('报名提交待核实'); await submit().click(); await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
    await page.route(commitUrl, handler => handler.abort('failed')); await submit().click();
    await page.getByRole('button', { name: '核实并重试原提交', exact: true }).waitFor();
    assert.equal(await deleteButton().isDisabled(), true); await expectFeedback('报名提交结果待核实');
    await page.unroute(commitUrl); await submit().click(); await page.getByRole('button', { name: '预览整批变更', exact: true }).waitFor(); await waitEnabled();
    await registrationEdit(page);
    await busyNote().fill('报名已保存但读取失败'); await submit().click(); await page.getByRole('button', { name: '确认整批提交', exact: true }).waitFor();
    const workspaceUrl = `${base}/api/schools/${busyId}/registration-workspace`;
    await page.route(workspaceUrl, handler => handler.fulfill({ status: 503, json: { code: 'test_read_after_save', message: '读取保存结果失败（测试）' } }));
    await submit().click(); await page.getByRole('button', { name: '读取最新正式名单', exact: true }).waitFor();
    assert.equal(await deleteButton().isDisabled(), true); await expectFeedback('报名已保存，请先读取');
    await page.unroute(workspaceUrl); await page.getByRole('button', { name: '读取最新正式名单', exact: true }).click(); await waitEnabled();
    assert.equal((await api('GET', `/api/schools/${busyId}/athletes`)).athletes[0].note, '报名已保存但读取失败');
    checks.push('registration busy, uncertain packet and acknowledged-but-unread result all block deletion; existing recovery still completes');

    const delayedId = await createSchool('迟到删除回执学校');
    await openSchool(delayedId); const delayedUrl = `${base}/api/schools/${delayedId}`;
    let releaseDelete, deleteArrived;
    const deleteArrival = new Promise(resolve => { deleteArrived = resolve; });
    const deleteRelease = new Promise(resolve => { releaseDelete = resolve; });
    await page.route(delayedUrl, async handler => { const response = await handler.fetch(); deleteArrived(); await deleteRelease; await handler.fulfill({ response }).catch(() => {}); });
    await confirmDelete(); await deleteArrival;
    await openSchool(draftId);
    await registrationEdit(page); await page.locator('.school-registration-people details:not(.school-registration-person) > summary').click();
    await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).fill('新页面不应被旧回执清空');
    const afterNavigation = page.url(); releaseDelete(); await page.waitForLoadState('networkidle');
    assert.equal(page.url(), afterNavigation);
    assert.equal(await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).inputValue(), '新页面不应被旧回执清空');
    assert.match(await detailHead().innerText(), /误建学校 bi（测试）/);
    assert.equal((await schools()).some(s => s.id === delayedId), false); assert.equal((await schools()).some(s => s.id === draftId), true);
    await page.unroute(delayedUrl);
    checks.push('late deletion response cannot redirect or clear a newly opened school');

    await openSchool(draftId);
    await registrationEdit(page); await page.locator('.school-registration-people details:not(.school-registration-person) > summary').click();
    await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).fill('账号变化后保留的输入');
    const staleDetailUrl = `${base}/api/schools/${draftId}/detail`, beforeAccountChange = deleteCalls;
    let releaseDetail, detailArrived;
    const detailArrival = new Promise(resolve => { detailArrived = resolve; });
    const detailRelease = new Promise(resolve => { releaseDetail = resolve; });
    const detailResponse = page.waitForResponse(staleDetailUrl);
    detailResponse.catch(() => {}); // Keep early teardown from hiding the original test failure.
    await page.route(staleDetailUrl, async handler => { const response = await handler.fetch(); detailArrived(); await detailRelease; await handler.fulfill({ response }); });
    await deleteButton().click(); await detailArrival;
    const newLogin = await api('POST', '/api/login', { username: 'admin', password: 'DeleteSchoolTest123' });
    assert.notEqual(newLogin.token, token);
    await page.evaluate(nextToken => localStorage.setItem('stss_token', nextToken), newLogin.token);
    releaseDetail(); await detailResponse; await page.waitForLoadState('networkidle');
    assert.equal(await deleteDialog().count(), 0); assert.equal(deleteCalls, beforeAccountChange);
    assert.equal(await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).inputValue(), '账号变化后保留的输入');
    assert.equal((await schools()).some(s => s.id === draftId), true);
    await page.unroute(staleDetailUrl); await page.evaluate(originalToken => localStorage.setItem('stss_token', originalToken), token);
    checks.push('late preflight after an actual session-token change cannot open confirmation, clear input or send DELETE');

    const eventDelayedId = await createSchool('切换赛事后迟到删除回执学校');
    await openSchool(eventDelayedId);
    await registrationEdit(page); await page.locator('.school-registration-people details:not(.school-registration-person) > summary').click();
    await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).fill('赛事变化后保留的输入');
    const eventDelayedUrl = `${base}/api/schools/${eventDelayedId}`;
    let releaseEventDelete, eventDeleteArrived, sentEvent;
    const eventDeleteArrival = new Promise(resolve => { eventDeleteArrived = resolve; });
    const eventDeleteRelease = new Promise(resolve => { releaseEventDelete = resolve; });
    const eventDeleteResponse = page.waitForResponse(eventDelayedUrl);
    eventDeleteResponse.catch(() => {});
    await page.route(eventDelayedUrl, async handler => {
      sentEvent = handler.request().headers()['x-event-id'];
      const response = await handler.fetch(); eventDeleteArrived(); await eventDeleteRelease; await handler.fulfill({ response });
    });
    await confirmDelete(); await eventDeleteArrival;
    // Clear the old route's read scope as normal navigation does, but keep this page alive to exercise its event fence.
    await page.evaluate(async eventId => {
      const api = await import('/js/api.js'); api.setApiReadScope(null);
      const main = await import('/js/main.js'); await main.reloadShell(eventId);
    }, otherEvent.event_id);
    const unchangedURL = page.url();
    assert.equal(await page.locator('#event-select').inputValue(), String(otherEvent.event_id));
    releaseEventDelete(); await eventDeleteResponse; await page.waitForLoadState('networkidle');
    assert.equal(page.url(), unchangedURL); assert.equal(sentEvent, String(identity.event_id));
    assert.equal(await page.locator('#event-select').inputValue(), String(otherEvent.event_id));
    assert.equal(await page.locator('.school-registration-people').getByLabel('新增人员姓名', { exact: true }).inputValue(), '赛事变化后保留的输入');
    assert.equal((await schools()).some(s => s.id === eventDelayedId), false);
    assert.equal((await api('GET', `/api/events/${otherEvent.event_id}/schools`, undefined, { identity: otherEvent })).schools.some(s => s.id === otherSchool), true);
    await page.unroute(eventDelayedUrl);
    await page.evaluate(async eventId => { const main = await import('/js/main.js'); await main.reloadShell(eventId); }, identity.event_id);
    checks.push('same-page shell event change rejects late deletion callbacks and preserves the new event and local input; request stayed scoped to the original event');
  }
  if (['security', 'integration'].includes(suite)) {
    const safeName = '<img src=x onerror=alert(1)> 学校名称';
    const securityId = await createSchool(safeName);
    await openSchool(securityId);
    assert.equal(await detailHead().getByRole('heading', { level: 1 }).textContent(), safeName);
    assert.equal(await detailHead().locator('img').count(), 0);
    await deleteButton().click(); await deleteDialog().waitFor();
    assert.ok((await deleteDialog().innerText()).includes(safeName)); assert.equal(await deleteDialog().locator('img').count(), 0);
    await deleteDialog().getByRole('button', { name: '取消', exact: true }).click(); await waitEnabled();
    for (const role of ['organizer', 'recorder', 'viewer']) {
      const username = `delete-school-${role}`;
      await api('POST', '/api/users', { username, display_name: '权限隔离测试', password: 'SchoolDeleteRead123', role, event_ids: [identity.event_id] });
      const login = await api('POST', '/api/login', { username, password: 'SchoolDeleteRead123' });
      const forbidden = await api('DELETE', `/api/schools/${securityId}`, {}, { token: login.token, status: 403 });
      assert.equal(forbidden.code, 'forbidden');
      const roleContext = await browser.newContext({ viewport: { width: 390, height: 950 }, locale: 'zh-CN' });
      await roleContext.addInitScript(({ token, event }) => { localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event)); }, { token: login.token, event: identity.event_id });
      const rolePage = await roleContext.newPage(); rolePage.setDefaultTimeout(10000); rolePage.on('pageerror', error => errors.push(error.message));
      await rolePage.goto(`${base}/#/schoolRegistration?event=${identity.event_id}&school=${securityId}`);
      if (role === 'organizer') {
        await registrationHead(rolePage).waitFor();
        assert.equal(await rolePage.getByRole('button', { name: '删除学校', exact: true }).count(), 0);
        assert.equal(await rolePage.getByRole('tab', { name: '统一编辑', exact: true }).count(), 1);
      } else {
        await rolePage.waitForURL(role === 'recorder' ? '**/#/field' : '**/#/school');
        assert.equal(await registrationHead(rolePage).count(), 0);
      }
      await rolePage.screenshot({ path: path.join(artifacts, `school-delete-role-${role}.png`), fullPage: true }); await roleContext.close();
    }
    const mismatch = await api('DELETE', `/api/schools/${securityId}`, {}, { identity: { ...identity, event_uuid: 'wrong-event-uuid' }, status: 409 });
    assert.equal(mismatch.code, 'event_identity_mismatch');
    const wrongActor = await api('DELETE', `/api/schools/${securityId}`, {}, { headers: { 'X-Actor-ID': '-1' }, status: 409 });
    assert.equal(wrongActor.code, 'account_changed');
    const wrongScope = await api('DELETE', `/api/schools/${otherSchool}`, { event_identity: identity }, { identity: otherEvent, status: 409 });
    assert.equal(wrongScope.code, 'event_identity_mismatch');
    assert.equal((await api('GET', `/api/events/${otherEvent.event_id}/schools`, undefined, { identity: otherEvent })).schools.some(s => s.id === otherSchool), true);
    assert.equal((await schools()).some(s => s.id === draftId), true);
    assert.equal((await schools()).some(s => s.id === securityId), true);
    checks.push('all non-admin DELETEs forbidden, organizer has no entry, restricted routes unchanged, identity/actor mismatches rejected and names remain literal');
  }
  if (['layout', 'integration'].includes(suite)) {
    const longId = await createSchool('一所用于核对手机长名称与学校删除确认操作的虚构学校（全部为隔离测试数据）');
    await openSchool(longId);
    const assertBounds = async label => {
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('header.page-head *,#school-delete-status *,.modal *')].filter(el => {
          if (!el.getClientRects().length) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < -1 || b.right > innerWidth + 1);
        }).map(el => el.className).slice(0, 8) }));
      assert.ok(geometry.scroll <= geometry.width + 1, `${label}: ${JSON.stringify(geometry)}`); assert.deepEqual(geometry.outside, [], label);
    };
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 950 }); await assertBounds(`detail ${width}`); await screenshot(`school-delete-detail-${width}.png`);
      await deleteButton().focus(); await deleteButton().press('Enter'); await deleteDialog().waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === '取消');
      await assertBounds(`dialog ${width}`); const box = await deleteDialog().boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 951, `dialog fits height ${width}`);
      await screenshot(`school-delete-confirm-${width}.png`); await page.keyboard.press('Escape'); await waitEnabled();
      assert.equal(await deleteButton().evaluate(el => el === document.activeElement), true);
    }
    const callsBeforeLayout = deleteCalls, longUrl = `${base}/api/schools/${longId}`;
    await page.route(longUrl, handler => handler.abort('failed'));
    await confirmDelete(); await expectFeedback('删除结果尚未确认');
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 950 }); await assertBounds(`unknown ${width}`); await screenshot(`school-delete-unknown-${width}.png`);
    }
    assert.equal(deleteCalls, callsBeforeLayout + 1);
    await page.unroute(longUrl); await page.getByRole('button', { name: '核对删除结果', exact: true }).click(); await waitEnabled();
    assert.equal((await schools()).some(s => s.id === longId), true);
    checks.push('four-width detail/confirmation/unknown state, long names, keyboard open/cancel and focus recovery without overflow');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `school-delete-${suite}-report.json`), JSON.stringify({ status: 'PASS', suite, checks, dataDir, browser: await browser.version() }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', suite, checks }));
} catch (error) {
  console.error('Primary school-deletion check failure:', error);
  if (page) await page.screenshot({ path: path.join(artifacts, `school-delete-${suite}-failure.png`), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close(); child.kill();
}
