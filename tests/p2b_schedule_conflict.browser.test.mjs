/* P2-B 并发冲突真实浏览器回归（REQ-010）：单场保存 409 stale_revision 保留输入并
   提供“重新读取最新安排”；自动编排 preview_changed 提示“重新生成预览”且零写入。

   独立 mkdtemp 数据目录 + 随机端口；不接触产品 data/，不依赖其它套件。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scheduleFixture } from './helpers/schedule_fixture.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'p2b-conflict-'));
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(data, 'artifacts');
await mkdir(artifacts, { recursive: true });
const child = spawn(process.env.STSS_PYTHON || 'python', ['-B', '-u', '-c', `
import json
from app import db, security
from app.http_server import Handler, load_routes, create_server
db.init_db()
conn = db.connect()
security.ensure_default_users(conn)
conn.close()
load_routes()
class Quiet(Handler):
    def log_message(self, *args): pass
server = create_server(('127.0.0.1', 0), Quiet)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  STSS_DATA_DIR: data, STSS_DB: path.join(data, 'registry.db'), STSS_EVENTS_DIR: path.join(data, 'events'),
  STSS_BACKUPS_DIR: path.join(data, 'backups'), STSS_ADMIN_PASSWORD: 'P2bConflict123', PYTHONUTF8: '1' } });

let browser;
let serverErrors = '';
let token = '';
let identity = null;
let page;
const contexts = [];
const checks = [];
const failures = [];
const pageErrors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
const check = async (name, action) => {
  try { await action(); checks.push(name); console.log('PASS ' + name); }
  catch (error) {
    failures.push({ name, message: error.stack || error.message });
    console.error('FAIL ' + name + ': ' + error.message);
    try { if (page) await page.screenshot({ path: path.join(artifacts, `failure-${failures.length}.png`), fullPage: true }); } catch {}
  }
};

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverErrors || 'Startup timeout')), 15000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server ${code}: ${serverErrors}`)));
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      try { const info = JSON.parse(text.split('\n')[0]); clearTimeout(timer); resolve(info.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json',
      'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid,
        'X-Deployment-ID': identity.deployment_id } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${url} -> ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'P2bConflict123' })).token;
  const deployment = (await api('GET', '/api/events')).deployment_id;
  const created = await api('POST', '/api/events/full', {
    event: { name: 'P2B 冲突测试赛事' },
    groups: [{ name: '甲组', code: 'G', categories: [{ name: '男子三人赛', kind: 'team', gender: 'male' }] }],
    venues: [{ name: '1号场地' }],
  });
  identity = { event_id: created.event_id, event_uuid: created.event_uuid, deployment_id: deployment };
  const catId = created.category_id;
  for (let index = 1; index <= 2; index += 1) {
    await api('POST', `/api/categories/${catId}/enrollments`, {
      school: { name: `冲突测试学校${index}` },
      members: [1, 2, 3].map((n) => ({ name: `冲突队员${index}-${n}`, gender: 'male', jersey_no: String(n) })),
      captain_index: 0,
    });
  }
  await scheduleFixture(api, identity, catId, { groupCount: 1, confirmed: true });
  const structure = await api('GET', `/api/events/${created.event_id}/structure`);

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, locale: 'zh-CN',
    serviceWorkers: 'block' });
  await context.addInitScript(({ value, eventId }) => {
    localStorage.setItem('stss_token', value);
    localStorage.setItem('stss_event', String(eventId));
  }, { value: token, eventId: created.event_id });
  contexts.push(context);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base + `/#/workspace?event=${created.event_id}&group=${structure.groups[0].id}`
    + `&category=${catId}&tab=schedule`);
  await page.getByRole('heading', { name: '比赛赛程', exact: true }).waitFor();
  await page.locator('.schedule-match').first().waitFor();

  /* ---------- 单场保存冲突 ---------- */
  await check('REQ-010 单场保存 409 stale_revision：提示、保留输入、可重新读取后再保存', async () => {
    const match = (await api('GET', `/api/matches?category_id=${catId}`)).matches[0];
    const article = page.locator(`[data-match-id="${match.id}"]`);
    await article.getByRole('button', { name: '调整场地时间', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`调整场地时间.*${match.public_code}`) });
    await dialog.waitFor();
    const note = dialog.getByLabel('备注', { exact: true });
    await note.fill('本机保留的备注');
    /* 另一编排人员先保存，提升 schedule_revision。 */
    const current = (await api('GET', `/api/matches/${match.id}`)).match;
    await api('PUT', `/api/matches/${match.id}`, { note: '其他设备先保存',
      base_schedule_revision: current.schedule_revision });
    await dialog.getByRole('button', { name: '保存安排', exact: true }).click();
    await dialog.getByText('比赛安排已被其他操作更新，当前保存未生效。', { exact: true }).waitFor();
    const reread = dialog.getByRole('button', { name: '重新读取最新安排', exact: true });
    assert.equal(await reread.isVisible(), true, '冲突后应提供重新读取动作');
    assert.equal(await note.inputValue(), '本机保留的备注', '冲突后应保留用户输入');
    assert.equal((await api('GET', `/api/matches/${match.id}`)).match.manual_note, '其他设备先保存',
      '冲突请求不能覆盖其他设备的修改');
    assert.equal(await dialog.getByRole('button', { name: '保存安排', exact: true }).isDisabled(), false,
      '冲突后应先重新读取，保存按钮保持可用以便重试');

    const freshRead = page.waitForRequest((request) =>
      request.url().endsWith(`/api/matches/${match.id}`) && request.method() === 'GET');
    await reread.click();
    await freshRead;
    const reopened = page.getByRole('dialog', { name: new RegExp(`调整场地时间.*${match.public_code}`) });
    await reopened.waitFor();
    assert.equal(await reopened.getByLabel('备注', { exact: true }).inputValue(), '本机保留的备注',
      '重新读取后用户输入应保留');
    await reopened.getByRole('button', { name: '保存安排', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await sleep(300);
    const saved = (await api('GET', `/api/matches/${match.id}`)).match;
    assert.equal(saved.manual_note, '本机保留的备注', '重新读取后的保存应成功写入');
  });

  /* ---------- 自动编排预览冲突 ---------- */
  await check('REQ-010 自动编排 preview_changed：提示重新生成预览、禁用保存且零写入', async () => {
    const matchesBefore = (await api('GET', `/api/matches?category_id=${catId}`)).matches.length;
    await page.getByRole('button', { name: '自动编排', exact: true }).click();
    await page.getByRole('heading', { name: '自动编排赛程', exact: true }).waitFor();
    for (const box of await page.locator('.auto-choices input').all()) {
      if (!await box.isChecked()) await box.check();
    }
    await page.getByRole('button', { name: '生成预览', exact: true }).click();
    const save = page.getByRole('button', { name: /确认并保存/ });
    await save.waitFor();
    assert.equal(await save.isDisabled(), false);
    /* 另一设备新增场地，预览依据（venues 等）变化 → 确认必须 409 且不写入。 */
    await api('POST', `/api/events/${created.event_id}/venues`, { name: '2号场地' });
    await save.click();
    const restart = page.getByRole('button', { name: '重新生成预览', exact: true });
    await restart.waitFor();
    assert.equal(await restart.isVisible(), true, '预览冲突后应提供重新生成预览动作');
    await page.getByRole('alert').filter({ hasText: '重新生成预览' }).waitFor();
    assert.equal(await save.isDisabled(), true, '预览冲突后应禁用保存');
    const matchesAfter = (await api('GET', `/api/matches?category_id=${catId}`)).matches.length;
    assert.equal(matchesAfter, matchesBefore, '预览冲突不能写入任何比赛');
    /* 重新生成预览回到规则页，原有输入保留。 */
    await restart.click();
    const rest = page.getByLabel('同队最短休息（分钟）', { exact: true });
    await rest.waitFor();
    assert.equal(await rest.inputValue(), '30');
    assert.equal(await page.getByRole('button', { name: '生成预览', exact: true }).count(), 1);
  });

  assert.deepEqual(pageErrors, [], '页面不应出现脚本异常');
  console.log(`PASS: P2-B 并发冲突 ${checks.length} 项检查全部通过`);
} finally {
  await writeFile(path.join(artifacts, 'p2b-schedule-conflict-report.json'),
    JSON.stringify({ checks, failures, pageErrors, serverErrors }, null, 2));
  for (const context of contexts) { try { await context.close(); } catch {} }
  if (browser) { try { await browser.close(); } catch {} }
  child.kill();
}
assert.deepEqual(failures, [], 'P2-B 并发冲突回归必须全部通过');
