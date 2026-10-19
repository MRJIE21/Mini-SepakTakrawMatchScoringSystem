/* 真实浏览器验证：报名页校验失败可见/聚焦，可预见的 400 在预览前被拦截。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'workspace-school-feedback-'));
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
  STSS_ADMIN_PASSWORD: 'WorkspaceSchoolFeedback123', PYTHONUTF8: '1' } });
let browser, serverErrors = '';
const checks = [];
child.stderr.on('data', chunk => { serverErrors += chunk; });
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server ${code}: ${serverErrors}`)); });
    let output = ''; child.stdout.on('data', chunk => {
      output += chunk; try { const value = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(value.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '', identity;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'WorkspaceSchoolFeedback123' })).token;
  identity = await api('POST', '/api/events', { name: '2026 报名页反馈修复验证' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  const group = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '甲组', code: 'A' })).group_id;
  const team = (await api('POST', `/api/groups/${group}/categories`, { name: '男子三人赛', kind: 'team', gender: 'male' })).category_id;
  const individual = (await api('POST', `/api/groups/${group}/categories`, { name: '男子个人赛', kind: 'individual', gender: 'male' })).category_id;
  const school = (await api('POST', `/api/events/${identity.event_id}/schools`, { name: '报名反馈测试大学', group_id: group })).school_id;
  const seeded = (await api('POST', `/api/schools/${school}/athletes`, { name: '原有甲', gender: 'male', jersey_no: '8' })).athlete_id;
  const seededPeer = (await api('POST', `/api/schools/${school}/athletes`, { name: '原有乙', gender: 'male', jersey_no: '9' })).athlete_id;
  pass('隔离服务、赛事与报名页资源启动');

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  await context.addInitScript(({ value, event }) => {
    localStorage.setItem('stss_token', value); localStorage.setItem('stss_event', String(event));
  }, { value: token, event: identity.event_id });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  let previewPosts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/registration-preview')) previewPosts += 1;
  });
  const link = `${base}/#/workspace?${new URLSearchParams({ event: identity.event_id, group, category: team, tab: 'registration', school })}`;
  await page.goto(link);
  await page.locator('.school-registration-detail-head').waitFor();
  const teamCard = () => page.locator(`.school-registration-project[data-category="${team}"]`);
  const individualCard = () => page.locator(`.school-registration-project[data-category="${individual}"]`);
  const choiceOf = card => card.locator('label.field', { hasText: '参赛选择' }).locator('select');
  const addPerson = async (card, name, commonNumber) => {
    const details = card.locator('details', { hasText: '就地新增人员' });
    await details.evaluate(node => { node.open = true; });
    await card.getByLabel('新增人员姓名').fill(name);
    await card.getByLabel('新增人员常用号码').fill(commonNumber);
    await card.getByRole('button', { name: /添加人员/ }).click();
    await card.getByText(name, { exact: false }).first().waitFor();
  };
  await choiceOf(teamCard()).selectOption('participate');
  await addPerson(teamCard(), '第一人', '23');
  assert.equal(await teamCard().getByLabel('第一人本项目号码').inputValue(), '',
    '常用号码 23 不能自动带入项目号码');
  await addPerson(teamCard(), '第二人', '7');
  assert.equal(await teamCard().getByLabel('第二人本项目号码').inputValue(), '7',
    '合法常用号码 7 仍按原规则预填');
  await teamCard().locator('label.field', { hasText: '队长' }).locator('select').selectOption({ label: '第二人' });
  pass('常用号码带入规则：非法值留空、合法 1—20 仍预填');

  const errorBox = page.locator('.form-errors:not(.hidden)');
  const footerError = page.locator('.school-registration-footer .field-error');
  const preview = page.locator('[data-action="school-preview"]');
  const waitErrorVisible = async () => {
    await errorBox.waitFor();
    await page.waitForFunction(() => {
      const box = document.querySelector('.form-errors:not(.hidden)');
      if (!box) return false;
      const rect = box.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && document.activeElement === box;
    }, null, { timeout: 8000 });
  };
  await teamCard().getByLabel('第一人本项目号码').fill('abc');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const postsBefore = previewPosts;
  await preview.click();
  await waitErrorVisible();
  const serverErrorText = await errorBox.innerText();
  assert.ok(serverErrorText.includes('1—20'), serverErrorText);
  assert.equal(await page.locator('#toast.show.error').count(), 1, '失败时应显示全局错误提示');
  assert.ok((await footerError.innerText()).includes('1—20'), '底部操作区应同步显示失败原因');
  assert.equal(previewPosts, postsBefore + 1, '服务端 400 只应发送一次预览请求');
  await page.screenshot({ path: path.join(artifacts, 'feedback-server-error-1280.png') });
  pass('服务端 400：错误框滚入视口并聚焦、toast 与底部摘要同步');

  await teamCard().getByLabel('第一人本项目号码').fill('9');
  await preview.click();
  await page.getByRole('heading', { name: '核对整批变更' }).waitFor();
  assert.equal(await errorBox.count(), 0, '预览成功后应清除旧错误');
  pass('合法号码可正常进入核对页');

  await page.getByRole('tab', { name: '人员名单' }).click();
  const firstPersonRow = page.locator('.school-registration-person').nth(2);
  await firstPersonRow.locator('select').selectOption('female');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const postsBeforeGender = previewPosts;
  await preview.click();
  await waitErrorVisible();
  const genderError = await errorBox.innerText();
  assert.ok(genderError.includes('性别') && genderError.includes('第一人'), genderError);
  assert.equal(previewPosts, postsBeforeGender, '性别冲突应在预览前拦截，不发送请求');
  assert.ok((await footerError.innerText()).includes('第一人'));
  pass('已报名运动员性别冲突在预览前拦截并指到具体人员');

  await firstPersonRow.locator('select').selectOption('male');
  await page.getByRole('tab', { name: '项目报名' }).click();
  await choiceOf(individualCard()).selectOption('participate');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const postsBeforeIndividual = previewPosts;
  await preview.click();
  await waitErrorVisible();
  const individualError = await errorBox.innerText();
  assert.ok(individualError.includes('请先选择 1 名运动员') && individualError.includes('男子个人赛'), individualError);
  assert.equal(previewPosts, postsBeforeIndividual, '个人赛未选人应在预览前拦截');
  pass('个人赛参加未选人在预览前拦截并给出项目名');

  await page.getByRole('tab', { name: '项目报名' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await choiceOf(individualCard()).selectOption('not_participating');
  await teamCard().getByLabel('第一人本项目号码').fill('abc');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await preview.click();
  await waitErrorVisible();
  assert.ok((await errorBox.innerText()).includes('1—20'));
  await page.screenshot({ path: path.join(artifacts, 'feedback-server-error-390.png') });
  pass('390 窄屏同样可见并聚焦');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('tab', { name: '人员名单' }).click();
  const seededRow = () => page.locator(`.school-registration-person[data-person="a:${seeded}"]`);
  await seededRow().locator('input').first().fill('原有甲改');
  await api('PUT', `/api/athletes/${seededPeer}`, { note: '后台改动触发基线变化' });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await preview.click();
  await waitErrorVisible();
  const staleText = await errorBox.innerText();
  assert.ok(staleText.includes('已读取最新名单') && staleText.includes('保留'), staleText);
  assert.equal(await seededRow().locator('input').first().inputValue(), '原有甲改',
    '409 后未冲突的本地修改应保留');
  pass('409 基线更新时保留未冲突的本地输入并提示重新预览');

  assert.deepEqual(pageErrors, [], '页面不应出现未捕获脚本错误');
  assert.deepEqual(checks.length, 8);
  await browser.close();
  console.log('FEEDBACK CHECKS PASSED: ' + checks.length);
} catch (error) {
  console.error('FEEDBACK FAILURE: ' + (error && error.stack || error));
  console.error('SERVER ERRORS: ' + serverErrors.slice(-4000));
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch {}
  child.kill();
}
