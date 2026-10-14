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
    if (method === 'POST' && /^\/api\/pools\/\d+\/(confirm|lots)$/.test(url) && body?.base_results === undefined) {
      const poolId = url.split('/')[3];
      const standings = await api('GET', `/api/pools/${poolId}/standings`);
      body = { ...body, base_results: standings.base_results, base_confirmation: standings.base_confirmation };
    }
    if (method === 'POST' && /^\/api\/matches\/\d+\/(correction|cancel)$/.test(url)) {
      const match = (await api('GET', `/api/matches/${url.split('/')[3]}`)).match;
      body = { request_uid: `fixture-${Date.now()}-${Math.random()}`, base_version: match.result_version,
        event_identity: identity, ...body };
    }

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
  identity.deployment_id = (await api('GET', '/api/events')).deployment_id;
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


  for(let i=1;i<=4;i++) await api('POST','/api/categories/'+team.id+'/enrollments',{
    school:{name:'刷新测试学校'+i},members:[1,2,3,4].map(n=>({name:'队员'+i+'-'+n,gender:'male',jersey_no:String(n)})),captain_index:0,seed_no:i,
  });
  const plan=(await api('POST','/api/categories/'+team.id+'/plan',{stages:[
    {kind:'round_robin',name:'小组赛',params:{pool_count:2,legs:1,assign:'snake'}},
    {kind:'single_elim',name:'决赛',params:{sources:[{type:'pool_rank',stage:1,pool:0,rank:1},{type:'pool_rank',stage:1,pool:1,rank:1}]}},
  ]})).plan_id;
  await api('POST','/api/plans/'+plan+'/generate',{});
  await api('POST','/api/plans/'+plan+'/lock',{});
  const matches=(await api('GET','/api/matches?category_id='+team.id)).matches;
  for(const match of matches.filter(m=>m.status==='ready')) {
    const detail=(await api('GET','/api/matches/'+match.id)).match;
    await api('POST','/api/scoring/submit',{
      event_identity:identity,submission_uid:'refresh-test-'+match.id,match_id:match.id,base_version:0,
      plan_version:detail.plan_version,home_participation:detail.home.participation_id,away_participation:detail.away.participation_id,
      result_status:'away_forfeit',sets:[],events:[],
    });
  }
  await page.goto(base+'/#/results?category='+team.id);
  let placementReads=0;
  page.on('request',r=>{if(r.url().endsWith('/placements')) placementReads++;});
  const confirmPool=async(index)=>{
    const block=page.locator('.stage-block').nth(index);
    await block.getByRole('button',{name:'确认小组名次',exact:true}).click();
    await page.getByRole('dialog',{name:'确认小组名次',exact:true}).getByRole('button',{name:'确认名次',exact:true}).click();
    await page.locator('.stage-block').nth(index).getByText('名次已确认',{exact:true}).waitFor();
    await page.locator('.stage-block').nth(index).getByRole('button',{name:'重新确认名次',exact:true}).waitFor();
  };
  await confirmPool(0);
  // 后续比赛在双方来源均确认后才补齐参赛名单。
  await confirmPool(1);
  const advanced = (await api('GET', `/api/matches?category_id=${team.id}`)).matches.find(m => m.round_label.includes('决赛'));
  assert.equal(advanced.status, 'ready');
  assert.ok(advanced.home.participation_id && advanced.away.participation_id, 'both confirmed sources resolve the final lineup');
  assert.ok(placementReads>=2,'每次确认后重新加载项目名次');
  await page.goto(base+'/#/workspace?event='+identity.event_id+'&group='+group.id+'&category='+team.id+'&tab=results');
  await page.locator('.stage-block').first().getByRole('button',{name:'重新确认名次',exact:true}).click();
  await page.getByRole('dialog',{name:'确认小组名次',exact:true}).getByRole('button',{name:'确认名次',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal(await page.locator('.stage-block').getByText('名次已确认',{exact:true}).count(),2);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS: 确认后徽标和按钮立即更新、后续晋级名单自动更新、项目名次重载、独立页与项目工作台均正常');
} finally {if(browser) await browser.close();child.kill();}



