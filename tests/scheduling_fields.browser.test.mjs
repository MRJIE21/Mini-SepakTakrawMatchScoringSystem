/* 独立测试库；工具路径通过 STSS_PLAYWRIGHT_MODULE / STSS_PYTHON / STSS_BROWSER_PATH 指定。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const artifacts = process.env.STSS_BROWSER_ARTIFACTS || path.join(tmpdir(), 'stss-school-artifacts');
const dataDir = path.join(tmpdir(), `stss-school-data-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
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
const child = spawn(process.env.STSS_PYTHON || 'python',
  ['-u', '-c', serverCode], {
    cwd: root,
    env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
      STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'BrowserTest123', PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
let serverErrors = '';
child.stderr.on('data', (chunk) => { serverErrors += chunk; });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server timeout: ${serverErrors}`)), 10000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${serverErrors}`)));
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n')[0];
      try { const data = JSON.parse(line); clearTimeout(timer); resolve(data.port); } catch {}
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  let identity;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Client-Protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(identity ? { 'X-Event-ID': String(identity.event_id), 'X-Event-UUID': identity.event_uuid } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  token = (await api('POST', '/api/login', { username: 'admin', password: 'BrowserTest123' })).token;
  identity = await api('POST', '/api/events', { name: '学校报名浏览器回归测试', start_date: '2026-10-01' });
  await api('POST', `/api/events/${identity.event_id}/bootstrap`, {});
  const structure = await api('GET', `/api/events/${identity.event_id}/structure`);
  const group = structure.groups[0];
  const team = group.categories.find((c) => c.kind === 'team' && c.gender === 'male');
  const individual = group.categories.find((c) => c.kind === 'individual' && c.gender === 'male');
  for (let i = 1; i <= 4; i++) await api('POST', `/api/categories/${team.id}/enrollments`, { school: { name: `字段测试学校${i}` }, members: [{ name: `匿名人员${i}`, gender: 'male' }] });
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.STSS_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', acceptDownloads: true });
  await context.addInitScript(({ token, event }) => {
    localStorage.setItem('stss_token', token); localStorage.setItem('stss_event', String(event));
  }, { token, event: identity.event_id });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const workspace = (cat, tab) => `${base}/#/workspace?event=${identity.event_id}&group=${group.id}&category=${cat.id}&tab=${tab}`;
  await page.goto(workspace(team, 'registration'));


  await page.goto(base + '/#/scheduling?category=' + team.id);
  await page.getByRole('button', {name:'高级自定义', exact:true}).click();
  await page.getByRole('button', {name:'+ 添加阶段', exact:true}).click();
  const stage=page.locator('.stage-item').first();
  for (const name of ['小组数量','分组方式','循环次数']) assert.equal(await stage.getByLabel(new RegExp('^'+name)).count(),1,name+'只能出现一次');
  await stage.getByLabel('小组数量',{exact:true}).fill('2');
  assert.equal(await stage.getByLabel('小组数量',{exact:true}).inputValue(),'2');
  await stage.getByLabel(/^类型/).selectOption('swiss');
  for (const name of ['小组数量','分组方式','轮次数']) assert.equal(await stage.getByLabel(new RegExp('^'+name)).count(),1,name+'只能出现一次');
  await stage.getByLabel(/^类型/).selectOption('placement');
  assert.equal(await stage.getByLabel('循环次数',{exact:true}).count(),1,'评次赛保留循环次数');
  await stage.getByLabel(/^类型/).selectOption('round_robin');
  assert.equal(await stage.getByLabel('小组数量',{exact:true}).inputValue(),'2');
  assert.equal(await page.getByRole('button',{name:'仅保存草稿',exact:true}).count(),0);
  const refreshed = page.waitForResponse(response=>response.url().includes('/plan') && response.request().method()==='GET');
  await page.getByRole('button',{name:'保存并查看赛程预览',exact:true}).click();
  await refreshed;
  const saved=await api('GET','/api/categories/'+team.id+'/plan');
  assert.equal(saved.plan.params.stages[0].params.pool_count,2);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS: 循环赛与瑞士制字段唯一、评次赛保留循环次数、切换赛制与直接保存预览正确');
} finally {
  if(browser) await browser.close();
  child.kill();
}
