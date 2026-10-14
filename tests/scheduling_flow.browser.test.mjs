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


  for(let i=1;i<=8;i++) await api('POST','/api/categories/'+team.id+'/enrollments',{
    school:{name:'流程测试学校'+i}, members:[1,2,3,4].map(n=>({name:'队员'+i+'-'+n,gender:'male',jersey_no:String(n)})),captain_index:0,seed_no:i,
  });
  await page.goto(base+'/#/scheduling?category='+team.id);
  const guided=page.locator('.schedule-flow');
  await guided.getByText('预计 16 场比赛：小组赛 12 场＋淘汰赛 4 场。',{exact:true}).waitFor();
  assert.equal(await page.locator('.stage-item:visible').count(),0);
  assert.deepEqual(await guided.locator('.schedule-pair').allTextContents(),['A组第1名对B组第2名','B组第1名对A组第2名']);
  await guided.screenshot({path:path.join(artifacts,'flow-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await guided.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  await guided.screenshot({path:path.join(artifacts,'flow-mobile.png')});
  await page.setViewportSize({width:1360,height:1000});
  await guided.getByLabel(/^分组数量/).fill('16');
  await guided.getByText('每组至少保留 1 支队伍，请减少小组数量。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'仅保存草稿',exact:true}).count(),0);
  await page.getByRole('button',{name:'保存并查看赛程预览',exact:true}).click();
  assert.equal((await api('GET','/api/categories/'+team.id+'/plan')).plan,null);
  await guided.getByLabel(/^分组数量/).fill('2');
  const generated=page.waitForResponse(r=>r.url().endsWith('/generate') && r.request().method()==='POST');
  await page.getByRole('button',{name:'保存并查看赛程预览',exact:true}).click();
  const result=await (await generated).json();
  assert.equal(result.matches_total,16);
  await page.getByText('预计 16 场比赛：小组赛 12 场＋淘汰赛 4 场。',{exact:true}).waitFor();
  const saved=(await api('GET','/api/categories/'+team.id+'/plan')).plan;
  assert.deepEqual(saved.params.stages[1].params.sources.map(s=>[s.pool,s.rank]),[[0,1],[1,1],[0,2],[1,2]]);
  await page.getByRole('button',{name:'高级自定义',exact:true}).click();
  assert.equal(await page.locator('.stage-item:visible').count(),2);
  await page.getByRole('button',{name:'返回常用流程',exact:true}).click();
  assert.equal(await guided.isVisible(),true);
  // 自定义来源不能被常用模式悄悄重写。
  const custom=saved.params.stages; custom[1].params.sources.reverse();
  await api('POST','/api/categories/'+team.id+'/plan',{name:saved.name,stages:custom});
  await page.reload();
  await page.getByRole('button',{name:'返回常用流程',exact:true}).waitFor();
  assert.equal(await guided.isVisible(),false);
  await page.getByRole('button',{name:'返回常用流程',exact:true}).click();
  await page.getByRole('dialog',{name:'切换到常用流程',exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual((await api('GET','/api/categories/'+team.id+'/plan')).plan.params.stages,custom);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS: 默认流程、交叉对阵、16场实际生成、无效配置拦截、已存方案回显、高级切换与旧方案保护、手机布局');
} finally { if(browser) await browser.close(); child.kill(); }
