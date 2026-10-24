/* 真实浏览器验证：导入弹窗字段说明/示例预览与模板、说明、示例三个下载入口。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const data = await mkdtemp(path.join(tmpdir(), 'workspace-school-template-'));
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
  STSS_ADMIN_PASSWORD: 'WorkspaceTemplate123', PYTHONUTF8: '1' } });
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
  token = (await api('POST', '/api/login', { username: 'admin', password: 'WorkspaceTemplate123' })).token;
  identity = await api('POST', '/api/events', { name: '2026 报名模板可读性验证' });
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
  const group = (await api('POST', `/api/events/${identity.event_id}/groups`, { name: '甲组', code: 'A' })).group_id;
  const team = (await api('POST', `/api/groups/${group}/categories`, { name: '男子三人赛', kind: 'team', gender: 'male' })).category_id;
  await api('POST', `/api/groups/${group}/categories`, { name: '男子个人赛', kind: 'individual', gender: 'male' });
  const school = (await api('POST', `/api/events/${identity.event_id}/schools`, { name: '模板验证大学', group_id: group })).school_id;
  pass('隔离服务、赛事与模板下载资源启动');

  browser = await chromium.launch({ headless: true, executablePath: process.env.STSS_BROWSER_PATH });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', acceptDownloads: true });
  await context.addInitScript(({ value, event }) => {
    localStorage.setItem('stss_token', value); localStorage.setItem('stss_event', String(event));
  }, { value: token, event: identity.event_id });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const link = `${base}/#/workspace?${new URLSearchParams({ event: identity.event_id, group, category: team, tab: 'registration', school })}`;
  await page.goto(link);
  await page.locator('header.page-head').filter({ has: page.getByRole('link', { name: '报名名单', exact: true }) }).waitFor();
  await page.getByRole('button', { name: '粘贴 / 导入学校报名表' }).click();
  const dialog = page.locator('.modal, .dialog').filter({ hasText: '粘贴 / 导入学校报名表' }).first();
  await dialog.waitFor();
  const text = await dialog.innerText();
  assert.ok(text.includes('字段说明（默认 8 列）'), text);
  for (const heading of ('项目 参赛选择 运动员 性别 常用号码 项目号码 队长 种子序号').split(' ')) {
    assert.ok(text.includes(heading), heading);
  }
  assert.ok(text.includes('运动员ID') && text.includes('同名新建确认'), '旧列说明需保留');
  assert.ok(text.includes('张三') && text.includes('赵六'), '示例预览需含虚构人员');
  assert.ok(text.includes('男子个人赛'), '示例预览需含个人赛');
  assert.ok(await dialog.getByRole('button', { name: '下载报名模板（8 列）' }).count() === 1);
  assert.ok(await dialog.locator('input[type=file]').count() === 1);
  assert.ok(await dialog.locator('textarea[data-field=csv_text]').count() === 1);
  pass('导入弹窗字段说明表、示例预览与上传/粘贴入口');

  const downloadFile = async (label, expectedName) => {
    const waiting = page.waitForEvent('download');
    await dialog.getByRole('button', { name: label }).click();
    const download = await waiting;
    const name = download.suggestedFilename();
    assert.equal(expectedName(name), true, name);
    const saved = path.join(artifacts, name);
    await download.saveAs(saved);
    return { name, content: await readFile(saved, 'utf-8') };
  };
  const template = await downloadFile('下载报名模板（8 列）',
    name => name.startsWith('模板验证大学_报名表_') && name.endsWith('.csv'));
  assert.equal(template.content.replace(/^\ufeff/, '').split(/\r?\n/)[0],
    '项目,参赛选择,运动员,性别,常用号码,项目号码,队长,种子序号');
  assert.ok(template.content.includes('男子三人赛') && template.content.includes('尚未决定'));
  pass('模板下载：文件名含学校与日期，表头严格 8 列');

  const guide = await downloadFile('下载填写说明',
    name => name.startsWith('模板验证大学_填写说明_') && name.endsWith('.txt'));
  for (const phrase of ['字段说明', '三人赛', '个人赛', '常用号码', '填写规则', '示例']) {
    assert.ok(guide.content.includes(phrase), phrase);
  }
  const example = await downloadFile('下载示例 CSV',
    name => name.startsWith('示例_模板验证大学_报名表_') && name.endsWith('.csv'));
  assert.ok(example.content.includes('示例'), '示例 CSV 需要虚构人员');
  assert.ok(example.content.replace(/^\ufeff/, '').split(/\r?\n/)[0].includes('参赛选择'));
  pass('填写说明与示例 CSV 下载入口可用');

  assert.deepEqual(pageErrors, [], '页面不应出现未捕获脚本错误');
  assert.equal(checks.length, 4);
  await browser.close();
  console.log('TEMPLATE CHECKS PASSED: ' + checks.length);
} catch (error) {
  console.error('TEMPLATE FAILURE: ' + (error && error.stack || error));
  console.error('SERVER ERRORS: ' + serverErrors.slice(-4000));
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch {}
  child.kill();
}
