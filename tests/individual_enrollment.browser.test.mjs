import { installLegacyRosterFixture } from './helpers/legacy_roster_fixture.mjs';
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
  await installLegacyRosterFixture(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const workspace = (cat, tab) => tab === 'registration' ? `${base}/?legacy_nav=${Date.now()}#/legacyRosterTest?event=${identity.event_id}&group=${group.id}&category=${cat.id}` : `${base}/?test_nav=${Date.now()}#/workspace?event=${identity.event_id}&group=${group.id}&category=${cat.id}&tab=${tab}`;
  await page.goto(workspace(team, 'registration'));
  await page.getByRole('button',{name:'添加参赛学校',exact:true}).waitFor();
  await api('POST','/api/categories/'+team.id+'/enrollments',{
    school:{name:'测试大学'},members:[1,2,3].map(n=>({name:'团体队员'+n,gender:'male',jersey_no:String(n)})),captain_index:0});
  const schools=(await api('GET','/api/events/'+identity.event_id+'/schools')).schools;
  const school=schools.find(s=>s.name==='测试大学');
  await api('POST','/api/schools/'+school.id+'/athletes',{name:'可报名选手',gender:'male'});
  const candidates=(await api('GET','/api/categories/'+individual.id+'/enrollment-candidates')).candidates;
  assert.equal(candidates.find(c=>c.subject==='团体队员1').action,'ineligible');
  assert.ok(candidates.find(c=>c.subject==='团体队员1').reason.includes('不可兼项'));
  const duplicate=await fetch(base+'/api/categories/'+individual.id+'/enrollments/individual',{
    method:'POST',headers:{'Content-Type':'application/json','X-Client-Protocol':'2',Authorization:'Bearer '+token,'X-Event-ID':String(identity.event_id)},
    body:JSON.stringify({school_id:school.id,athlete:{name:'团体队员1',gender:'male'}})});
  assert.equal(duplicate.status,400);
  await page.goto(workspace(individual,'registration'));
  const open=async()=>{
    await page.getByRole('button',{name:'添加参赛运动员',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'添加项目报名',exact:true});await dialog.waitFor();return dialog;
  };
  let dialog=await open();
  assert.equal(await dialog.getByPlaceholder('搜索或填写运动员姓名').count(),0);
  await dialog.getByPlaceholder('搜索或新建学校').fill('测试大学');
  await dialog.getByRole('option',{name:'测试大学',exact:true}).click();
  const name=dialog.getByPlaceholder('搜索或填写运动员姓名');await name.fill('团体队员1');
  await dialog.getByRole('option').filter({hasText:'新增另一位同名人员'}).waitFor();
  assert.equal(await dialog.getByRole('option').filter({hasText:'不可兼项'}).count(),0);
  assert.equal(await dialog.getByRole('option').filter({hasText:'新增另一位同名人员'}).count(),1);
  await dialog.locator('.athlete-blocked summary').click();
  assert.ok((await dialog.locator('.athlete-blocked').textContent()).includes('不可兼项'));
  assert.equal(await dialog.getByRole('button',{name:'确认报名',exact:true}).isDisabled(),true);
  await name.fill('可报名选手');await dialog.locator('[role=option][data-value]').filter({hasText:'可报名选手'}).click();
  await dialog.screenshot({path:path.join(artifacts,'individual-enrollment-desktop.png')});
  await dialog.getByRole('button',{name:'确认报名',exact:true}).click();await dialog.waitFor({state:'detached'});
  assert.equal((await api('GET','/api/categories/'+individual.id+'/participations')).participations.length,1);
  dialog=await open();await dialog.getByPlaceholder('搜索或新建学校').fill('测试大学');
  await dialog.getByRole('option',{name:'测试大学',exact:true}).click();
  await dialog.getByRole('button',{name:'编辑已报名运动员资料',exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'确认报名',exact:true}).isDisabled(),true);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  if(await page.getByRole('dialog',{name:'有未保存的修改',exact:true}).count()) {
    await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  }
  dialog=await open();await dialog.getByPlaceholder('搜索或新建学校').fill('新学校');
  await dialog.getByRole('option',{name:'＋ 新建“新学校”',exact:true}).click();
  await dialog.getByPlaceholder('搜索或填写运动员姓名').fill('新选手');
  await dialog.getByRole('option',{name:'＋ 新建“新选手”',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await dialog.screenshot({path:path.join(artifacts,'individual-enrollment-mobile.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await dialog.getByRole('button',{name:'确认报名',exact:true}).click();await dialog.waitFor({state:'detached'});
  assert.equal((await api('GET','/api/categories/'+individual.id+'/participations')).participations.length,2);

  // 同名且已有人员不可兼项：在本窗口核对后新增另一人，保留原档案。
  const sameSchool=await api('POST','/api/events/'+identity.event_id+'/schools',{name:'同名测试学校',group_id:group.id});
  const oldPerson=await api('POST','/api/schools/'+sameSchool.school_id+'/athletes',{
    name:'同名选手',gender:'male',jersey_no:'7',note:'一年级 1 班'});
  await api('POST','/api/categories/'+team.id+'/enrollments',{
    school_id:sameSchool.school_id,members:[{athlete_id:oldPerson.athlete_id,jersey_no:'7'}]});
  dialog=await open();await dialog.getByPlaceholder('搜索或新建学校').fill('同名测试学校');
  await dialog.getByRole('option',{name:'同名测试学校',exact:true}).click();
  await dialog.getByPlaceholder('搜索或填写运动员姓名').fill('同名选手');
  await dialog.getByRole('option').filter({hasText:'新增另一位同名人员'}).click();
  await dialog.locator('.same-name-review').getByText('一年级 1 班',{exact:false}).waitFor();
  const submit=dialog.getByRole('button',{name:'确认报名',exact:true});
  const confirm=dialog.getByRole('checkbox',{name:'已核对以上人员，确认新增的是另一位同名人员'});
  assert.equal(await submit.isDisabled(),true);
  await dialog.getByPlaceholder('例如：二年级 3 班，或学号').fill('二年级 3 班');
  assert.equal(await submit.isDisabled(),true);
  await confirm.check();assert.equal(await submit.isDisabled(),false);
  await dialog.screenshot({path:path.join(artifacts,'individual-same-name-mobile.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  // 核对后新增了另一份同名档案：提交拒绝、保留区分信息、清除旧确认。
  await api('POST','/api/schools/'+sameSchool.school_id+'/athletes',{
    name:'同名选手',gender:'female',note:'一年级 2 班'});
  await submit.click();await dialog.getByRole('alert').filter({hasText:'档案已变化'}).waitFor();
  assert.equal(await dialog.getByPlaceholder('例如：二年级 3 班，或学号').inputValue(),'二年级 3 班');
  assert.equal(await confirm.isChecked(),false);assert.equal(await submit.isDisabled(),true);
  assert.equal((await api('GET','/api/schools/'+sameSchool.school_id+'/athletes')).athletes.length,2);
  await confirm.check();
  // 网络失败保留全部输入，重试仍只保存一份人员和一条报名。
  await page.route('**/enrollments/individual',route=>route.abort('failed'),{times:1});
  await submit.click();await dialog.getByRole('alert').filter({hasText:'网络不可用'}).waitFor();
  assert.equal(await confirm.isChecked(),true);
  await submit.click();await dialog.waitFor({state:'detached'});
  const saved=(await api('GET','/api/schools/'+sameSchool.school_id+'/athletes')).athletes;
  assert.equal(saved.length,3);assert.equal(saved.find(a=>a.id===oldPerson.athlete_id).note,'一年级 1 班');
  assert.equal(saved.filter(a=>a.note==='二年级 3 班').length,1);
  assert.equal((await api('GET','/api/categories/'+individual.id+'/participations')).participations.length,3);

  // 重名的可选人员按备注区分，选择后复用正确的 ID。
  await page.setViewportSize({width:1360,height:1000});
  const reuseSchool=await api('POST','/api/events/'+identity.event_id+'/schools',{name:'重名复用学校',group_id:group.id});
  await api('POST','/api/schools/'+reuseSchool.school_id+'/athletes',{name:'张三',gender:'male',note:'一年级',jersey_no:'9'});
  const correct=await api('POST','/api/schools/'+reuseSchool.school_id+'/athletes',{name:'张三',gender:'male',note:'二年级'});
  dialog=await open();await dialog.getByPlaceholder('搜索或新建学校').fill('重名复用学校');
  await dialog.getByRole('option',{name:'重名复用学校',exact:true}).click();
  await dialog.getByPlaceholder('搜索或填写运动员姓名').fill('张三');
  await dialog.getByRole('option').filter({hasText:'一年级'}).click();
  assert.equal(await dialog.getByPlaceholder('号码（可选）').inputValue(),'9');
  await dialog.locator('[data-field="athlete"]').fill('张三');
  assert.equal(await dialog.getByRole('button',{name:'确认报名',exact:true}).isDisabled(),true);
  assert.equal(await dialog.getByPlaceholder('号码（可选）').inputValue(),'');
  await dialog.getByRole('option').filter({hasText:'二年级'}).click();
  await dialog.screenshot({path:path.join(artifacts,'individual-same-name-reuse-desktop.png')});
  await dialog.getByRole('button',{name:'确认报名',exact:true}).click();await dialog.waitFor({state:'detached'});
  assert.equal((await api('GET','/api/schools/'+reuseSchool.school_id+'/athletes')).athletes.length,2);
  assert.ok((await api('GET','/api/categories/'+individual.id+'/participations')).participations.some(p=>p.athlete_id===correct.athlete_id));
  assert.deepEqual(pageErrors,[]);
  await page.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    const cacheName=(await caches.keys()).find(name=>name.startsWith('stss-shell-'));
    if(!cacheName) throw new Error('Missing offline shell cache');
    const cache=await caches.open(cacheName);
    for(const resource of ['/js/athletePicker.js','/vendor/tom-select/tom-select.base.min.js','/vendor/tom-select/tom-select.default.min.css']) {
      if(!await cache.match(resource)) throw new Error('Missing offline resource: '+resource);
    }
  });
  console.log('PASS: 学校优先、资格禁选、同名就地核对、资料变化重新确认、网络失败保留输入、按备注复用正确人员、学校名额、新学校和人员一次报名、手机布局');
} finally {if(browser) await browser.close();child.kill();}
