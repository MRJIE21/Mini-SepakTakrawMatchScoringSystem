/* P2-A REQ-010: delete-school guard renders actionable reasons and steps. Isolated data only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const dataRoot = process.env.STSS_P2A_DELETE_DATA_ROOT || path.resolve(root, '../tmp/p2a-delete-20261018/test-data');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.resolve(root, '../tmp/p2a-delete-20261018/artifacts');
await mkdir(dataRoot, { recursive: true });
await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(path.join(dataRoot, 'delete-'));
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
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'DeleteReasonTest123',
    PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
let browser, page, serverErrors = '';
const checks = [];
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'isolated server startup timeout')), 12000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${serverErrors}`)); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      try { const first = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(first.port); } catch {}
    });
  });
  child.stderr.on('data', chunk => { serverErrors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let token, identity;
  const api = async (method, url, body, options = {}) => {
    const scope = options.identity ?? identity;
    const response = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
        ...(options.token || token ? { Authorization: `Bearer ${options.token || token}` } : {}),
        ...(scope ? { 'X-Event-ID': String(scope.event_id), 'X-Event-UUID': scope.event_uuid,
          ...(scope.deployment_id ? { 'X-Deployment-ID': scope.deployment_id } : {}) } : {}),
        ...(options.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, options.status || 200, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'DeleteReasonTest123' })).token;
  identity = await api('POST', '/api/events', { name: 'P2A 删除提示验证（隔离数据）' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
  const group = structure.groups[0];
  const teamCategory = group.categories.find(category => category.gender === 'male' && category.kind === 'team');
  const schoolId = (await api('POST', `/api/events/${identity.event_id}/schools`,
    { name: '已报名学校（测试）', group_id: group.id })).school_id;
  const team = await api('POST', `/api/categories/${teamCategory.id}/teams`,
    { school_id: schoolId, name: '已报名学校代表队' });
  await api('POST', `/api/categories/${teamCategory.id}/participations`, { team_id: team.team_id });
  const blocked = await api('DELETE', `/api/schools/${schoolId}`, undefined, { status: 409 });
  assert.equal(blocked.code, 'in_use');
  assert.equal(blocked.detail.reasons[0].code, 'registration_in_use');
  assert.ok(blocked.detail.reasons[0].steps.length >= 2);
  assert.ok(!blocked.message.includes('修改参赛记录状态'));
  checks.push('api 409 returns structured registration_in_use reason with steps');

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, locale: 'zh-CN' });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token);
    localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const deleteButton = () => page.locator('.school-registration-detail-head')
    .getByRole('button', { name: '删除学校', exact: true });
  const deleteDialog = () => page.getByRole('dialog', { name: '删除学校', exact: true });
  const feedback = () => page.locator('.school-registration-delete-feedback');
  const waitFeedback = async (pattern) => {
    await page.waitForFunction((source) => {
      const node = document.querySelector('.school-registration-delete-feedback');
      return node && !node.hidden && new RegExp(source).test(node.textContent || '');
    }, pattern.source);
    return feedback().innerText();
  };
  await page.goto(`${base}/?delete_reason=1#/schoolRegistration?event=${identity.event_id}&school=${schoolId}`);
  await page.waitForLoadState('networkidle');
  await page.locator('.school-registration-detail-head').waitFor();
  await page.screenshot({ path: path.join(artifacts, 'p2a-delete-guard-1365.png'), fullPage: true });

  await deleteButton().click();
  await deleteDialog().waitFor();
  await deleteDialog().getByRole('button', { name: '确认删除', exact: true }).click();
  const first = await waitFeedback(/该学校已有参赛报名/);
  assert.match(first, /下一步/);
  assert.match(first, /退出或删除/);
  assert.match(first, /报名名单为空/);
  await page.screenshot({ path: path.join(artifacts, 'p2a-delete-reason-registration-1365.png'), fullPage: true });
  checks.push('real 409 registration reason and executable steps rendered in review area');

  await page.route('**/api/schools/*', async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
      code: 'in_use',
      message: '该学校已有比赛成绩或名次，不能删除',
      detail: { reasons: [{ code: 'has_results', message: '该学校已有比赛成绩或名次，不能删除',
        steps: ['先由管理员或编排对相关场次做正式更正或取消', '确认该校已无成绩后再删除学校'] }] },
    }) });
  });
  await deleteButton().click();
  await deleteDialog().waitFor();
  await deleteDialog().getByRole('button', { name: '确认删除', exact: true }).click();
  const second = await waitFeedback(/已有比赛成绩或名次/);
  assert.match(second, /正式更正或取消/);
  assert.match(second, /无成绩后再删除/);
  await page.screenshot({ path: path.join(artifacts, 'p2a-delete-reason-results-1365.png'), fullPage: true });
  checks.push('has_results reason and correction/cancel path rendered in review area');
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(artifacts, 'p2a-delete-reason-report.json'),
    JSON.stringify({ status: 'PASS', checks, pageErrors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', checks }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'p2a-delete-reason-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ status: 'FAIL', error: error.message, serverErrors }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}
