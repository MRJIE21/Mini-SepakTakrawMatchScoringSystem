import { scheduleFixture } from './helpers/schedule_fixture.mjs';
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
  const adminToken=token;
  const accounts={};
  for (const [name,role] of [['rec1','recorder'],['rec2','recorder'],['organizer','organizer'],['viewer','viewer']]) {
    const user=await api('POST','/api/users',{username:name,display_name:name,role,password:'Permission123',event_ids:[identity.event_id]});
    const login=await api('POST','/api/login',{username:name,password:'Permission123'});
    accounts[name]={...user,token:login.token};
  }
  const otherEvent=await api('POST','/api/events',{name:'不可访问的赛事'});
  const longEventName = '首都高校第十八届藤球比赛·春季联赛与大学生体育交流活动赛事名称较长的展示测试';
  await api('POST', '/api/events', { name: longEventName });
  for (let index = 1; index <= 8; index += 1) await api('POST', '/api/events', { name: `多选滚动测试赛事 ${index}` });
  for(let i=1;i<=2;i++) await api('POST','/api/categories/'+team.id+'/enrollments',{
    school:{name:'权限学校'+i},members:[1,2,3].map(n=>({name:'队员'+i+'-'+n,gender:'male',jersey_no:String(n)})),captain_index:0,
  });
  const fixture = await scheduleFixture(api, identity, team.id, { confirmed: false });
  const plan = fixture.plan_id;
  token=accounts.viewer.token;
  assert.equal((await api('GET','/api/categories/'+team.id+'/plan')).plan,null);
  assert.equal((await api('GET','/api/matches?category_id='+team.id)).matches.length,0);
  token=adminToken;
  await fixture.confirm();
  const match=(await api('GET','/api/matches?category_id='+team.id)).matches[0];
  const deny=async(method,url,body,status=403,auth=token,headerIdentity=identity)=>{
    const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Client-Protocol':'2',Authorization:'Bearer '+auth,
      'X-Event-ID':String(headerIdentity.event_id),'X-Event-UUID':headerIdentity.event_uuid},body:body?JSON.stringify(body):undefined});
    const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;
  };
  token=accounts.rec1.token;
  assert.deepEqual((await api('GET','/api/events')).events.map(e=>e.id),[identity.event_id]);
  await deny('GET','/api/users');
  await deny('GET','/api/events/'+identity.event_id+'/schools');
  await deny('GET','/api/events/'+otherEvent.event_id+'/structure',null,403,token,otherEvent);
  await deny('PUT','/api/categories/'+team.id,{name:'越权修改'});
  const payload={event_identity:identity,submission_uid:'permission-match',match_id:match.id,base_version:0,
    plan_version:match.plan_version,home_participation:match.home.participation_id,away_participation:match.away.participation_id,
    result_status:'away_forfeit',sets:[],events:[],user_id:accounts.rec2.user_id};
  await deny('POST','/api/scoring/submit',payload);
  const claimed=await api('POST','/api/recording/match/'+match.id+'/claim',{});
  assert.equal(claimed.recorder_id,accounts.rec1.user_id);
  await deny('POST','/api/recording/match/'+match.id+'/claim',{},409,accounts.rec2.token);
  await deny('POST','/api/scoring/submit',payload,403,accounts.rec2.token);
  token=accounts.organizer.token;
  await deny('POST','/api/events/'+identity.event_id+'/venues',{name:'越权场地'});
  const school=await api('POST','/api/events/'+identity.event_id+'/schools',{name:'个人赛学校',group_id:group.id});
  const person=await api('POST','/api/categories/'+individual.id+'/enrollments/individual',{
    school:{id:school.school_id},school_id:school.school_id,athlete:{name:'个人赛选手',gender:'male'}});
  await deny('POST','/api/recording/match/'+match.id+'/transfer',{user_id:accounts.rec2.user_id},400);
  await api('POST','/api/recording/match/'+match.id+'/transfer',{user_id:accounts.rec2.user_id,reason:'轮班交接'});
  await deny('POST','/api/scoring/submit',payload,403,accounts.rec1.token);
  token=accounts.rec2.token;
  await api('POST','/api/scoring/submit',payload);
  assert.equal((await api('POST','/api/scoring/submit',payload)).duplicate,true);
  await deny('POST','/api/scoring/submit',{...payload,submission_uid:'forbidden-edit',base_version:1});
  token=accounts.organizer.token;
  await api('POST','/api/matches/'+match.id+'/correction',{reason:'裁判复核',result_status:'home_forfeit',sets:[],events:[]});
  const result=(await api('GET','/api/matches/'+match.id)).match;
  assert.equal(result.recorder_name,'rec2');assert.equal(result.corrector_name,'organizer');
  token=accounts.rec1.token;
  await api('POST','/api/recording/individual/'+person.participation_id+'/claim',{});
  const individualPayload={event_identity:identity,submission_uid:'permission-individual',participation_id:person.participation_id,
    base_version:0,result_status:'normal',result_value:20,error_count:0,violation_count:0};
  await deny('POST','/api/scoring/individual',individualPayload,403,accounts.rec2.token);
  await api('POST','/api/scoring/individual',individualPayload);
  assert.equal((await api('POST','/api/scoring/individual',individualPayload)).duplicate,true);
  await deny('POST','/api/scoring/individual',{...individualPayload,submission_uid:'individual-change',base_version:1});
  token=accounts.organizer.token;
  await api('POST','/api/scoring/individual',{...individualPayload,submission_uid:'individual-correction',base_version:1,reason:'复核次数',result_value:21});
  const individualResult=(await api('GET','/api/categories/'+individual.id+'/individual-results')).results[0];
  assert.equal(individualResult.recorder_name,'rec1');assert.equal(individualResult.corrector_name,'organizer');
  token=accounts.viewer.token;
  const pool=(await api('GET','/api/categories/'+team.id+'/plan')).plan.stages[0].pools[0];
  await deny('GET','/api/pools/'+pool.id+'/standings');
  await deny('GET','/api/exports/results.csv?category_id='+team.id);
  await api('GET','/api/groups/'+group.id+'/school-totals');
  browser=await chromium.launch({headless:true,executablePath:process.env.STSS_BROWSER_PATH||undefined});
  const pageErrors=[];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile, locale: 'zh-CN' });
    if (mobile) await context.addInitScript(() => {
      Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined });
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base + '/#/users');
    await page.locator('#login-screen').waitFor();
    assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '');
    await page.getByLabel('用户名', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('BrowserTest123');
    if (mobile) await page.getByRole('button', { name: '登录', exact: true }).click();
    else await page.getByLabel('密码', { exact: true }).press('Enter');
    await page.getByRole('heading', { name: '账号列表', exact: true }).waitFor();
    assert.equal(await page.locator('#sidenav a[data-view="scoring"]').count(), 0);
    const form = page.locator('#create-account-form');
    for (const label of ['登录名', '显示名称', '初始密码']) {
      assert.equal(await form.getByLabel(label, { exact: true }).inputValue(), '');
    }
    assert.equal(await form.getAttribute('autocomplete'), 'off');
    assert.equal(await form.getByLabel('初始密码', { exact: true }).getAttribute('autocomplete'), 'new-password');
    const username = mobile ? 'phone-created-user' : 'desktop-created-user';
    await form.getByLabel('登录名', { exact: true }).fill(username);
    await form.getByLabel('显示名称', { exact: true }).fill('新增记录员');
    await form.getByLabel('初始密码', { exact: true }).fill('NewRecorder123');
    const eventPicker = form.locator('.event-scope-picker');
    const eventTrigger = eventPicker.getByRole('button', { name: '所属赛事', exact: true });
    assert.equal(await eventTrigger.getAttribute('aria-expanded'), 'false');
    await eventTrigger.click();
    const search = eventPicker.getByRole('searchbox', { name: '搜索赛事', exact: true });
    await search.fill('不存在的赛事');
    await eventPicker.getByText('没有匹配的赛事', { exact: true }).waitFor();
    let createRequests = 0;
    const observeCreate = request => {
      if (request.url().endsWith('/api/users') && request.method() === 'POST') createRequests += 1;
    };
    page.on('request', observeCreate);
    await search.press('Enter');
    assert.equal(createRequests, 0, '赛事搜索回车不能创建账号');
    await search.fill('');
    const listLayout = await eventPicker.locator('.event-scope-options').evaluate(element => ({
      height: element.clientHeight, scroll: element.scrollHeight,
    }));
    assert.ok(listLayout.scroll > listLayout.height, '赛事较多时列表内部滚动');
    await eventPicker.getByRole('checkbox', { name: longEventName, exact: true }).check();
    await eventPicker.screenshot({ path: path.join(artifacts, `event-scope-${mobile ? 'mobile' : 'desktop'}-open.png`) });
    assert.ok(await eventPicker.evaluate(element => element.scrollWidth <= element.clientWidth + 1), '长名称不能撑出选择器');
    await eventPicker.getByRole('button', { name: '清空', exact: true }).click();
    assert.equal(await eventPicker.locator('input[data-field="event_ids"]').inputValue(), '[]');
    await search.fill('学校报名');
    if (mobile) await eventPicker.getByRole('checkbox', { name: '学校报名浏览器回归测试', exact: true }).check();
    else { await search.press('Tab'); await page.keyboard.press('Space'); }
    await search.fill('不可访问');
    await eventPicker.getByRole('checkbox', { name: '不可访问的赛事', exact: true }).check();
    assert.deepEqual(JSON.parse(await eventPicker.locator('input[data-field="event_ids"]').inputValue()),
      [identity.event_id, otherEvent.event_id]);
    assert.equal(await eventTrigger.locator('.event-scope-count').innerText(), '2 项');
    await search.press('Escape');
    assert.equal(await eventTrigger.getAttribute('aria-expanded'), 'false');
    await eventTrigger.click();
    await form.getByRole('heading', { name: '新增账号', exact: true }).click();
    assert.equal(await eventTrigger.getAttribute('aria-expanded'), 'false', '点击选择器外收起列表');
    await page.route('**/api/users', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ ok: false, message: '测试创建失败' }) }) : route.continue());
    await form.getByRole('button', { name: '创建', exact: true }).click();
    await form.getByText('测试创建失败', { exact: true }).waitFor();
    assert.equal(await form.getByLabel('登录名', { exact: true }).inputValue(), username);
    assert.equal(await form.getByLabel('显示名称', { exact: true }).inputValue(), '新增记录员');
    assert.equal(await form.getByLabel('初始密码', { exact: true }).inputValue(), 'NewRecorder123');
    assert.deepEqual(JSON.parse(await eventPicker.locator('input[data-field="event_ids"]').inputValue()),
      [identity.event_id, otherEvent.event_id], '创建失败保留所属赛事选择');
    await page.unroute('**/api/users');
    const created = page.waitForResponse(response => response.url().endsWith('/api/users')
      && response.request().method() === 'POST' && response.status() === 200);
    await form.getByLabel('初始密码', { exact: true }).press('Enter');
    await created;
    page.off('request', observeCreate);
    await page.waitForFunction(() => document.getElementById('new-account-username')?.value === '');
    for (const label of ['登录名', '显示名称', '初始密码']) {
      assert.equal(await form.getByLabel(label, { exact: true }).inputValue(), '');
    }
    await page.screenshot({ path: path.join(artifacts, `account-create-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    token = adminToken;
    const createdUser = (await api('GET', '/api/users')).users.find(user => user.username === username);
    assert.deepEqual(createdUser.event_ids, [identity.event_id, otherEvent.event_id], '创建提交完整赛事范围');
    const userRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: username, exact: true }) });
    await userRow.getByRole('button', { name: '角色与赛事', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '角色与赛事 · 新增记录员', exact: true });
    let editPicker = dialog.locator('.event-scope-picker');
    await editPicker.getByRole('button', { name: '所属赛事', exact: true }).click();
    assert.ok(await editPicker.getByRole('checkbox', { name: '学校报名浏览器回归测试', exact: true }).isChecked());
    assert.ok(await editPicker.getByRole('checkbox', { name: '不可访问的赛事', exact: true }).isChecked());
    await editPicker.getByRole('searchbox', { name: '搜索赛事', exact: true }).press('Escape');
    assert.ok(await dialog.isVisible(), 'Escape 只收起下拉，不关闭编辑弹窗');
    await editPicker.getByRole('button', { name: '所属赛事', exact: true }).click();
    await editPicker.getByRole('checkbox', { name: '不可访问的赛事', exact: true }).uncheck();
    await editPicker.getByRole('button', { name: '完成', exact: true }).click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    const discard = page.getByRole('dialog', { name: '有未保存的修改', exact: true });
    await discard.waitFor();
    await discard.getByRole('button', { name: '继续编辑', exact: true }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual((await api('GET', '/api/users')).users.find(user => user.id === createdUser.id).event_ids,
      [identity.event_id], '编辑移除第二项后保存准确范围');
    await userRow.getByRole('button', { name: '角色与赛事', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '角色与赛事 · 新增记录员', exact: true });
    editPicker = dialog.locator('.event-scope-picker');
    await editPicker.getByRole('button', { name: '所属赛事', exact: true }).click();
    assert.equal(await editPicker.getByRole('checkbox', { name: '不可访问的赛事', exact: true }).isChecked(), false);
    await dialog.screenshot({ path: path.join(artifacts, `event-scope-${mobile ? 'mobile' : 'desktop'}-dialog.png`) });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1280), '弹窗不超出屏幕宽度');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.route('**/api/events', route => route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, events: [], deployment_id: identity.deployment_id }) }) : route.continue());
    await page.reload();
    await page.getByRole('heading', { name: '新增账号', exact: true }).waitFor();
    assert.ok(await page.locator('#create-account-form').getByRole('button', { name: '所属赛事', exact: true }).isDisabled());
    await page.getByText('请先创建赛事，稍后在“角色与赛事”中分配。', { exact: true }).waitFor();
    await context.close();
  }
  console.log('PASS: 电脑与手机登录不预填 admin；新增账号空白、新密码语义、失败保留输入和回车创建');
  console.log('PASS: 电脑与手机赛事多选下拉、搜索、清空、回填、范围提交、未保存保护、Escape、长名称与内部滚动');
  accounts.admin={token:adminToken};
  for(const role of ['rec1','viewer','organizer','admin']) {
    const context=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN'});
    await context.addInitScript(({token,event})=>{localStorage.setItem('stss_token',token);localStorage.setItem('stss_event',String(event));},
      {token:accounts[role].token,event:identity.event_id});
    const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
    await page.goto(base+'/#/account');
    await page.getByRole('heading',{name:'修改我的密码'}).waitFor();
    const nav=await page.locator('#sidenav').innerText();
    assert.equal(await page.locator('#sidenav a[data-view="scoring"]').count(),0);
    assert.equal(await page.locator('#sidenav').getByRole('link',{name:'三人赛记录',exact:true}).count(),0);
    assert.equal(await page.locator('#sidenav a[data-view="workspace"]').count(),role==='rec1'?0:1);
    assert.equal(await page.locator('#sidenav a[data-view="field"]').count(),role==='viewer'?0:1);
    if(['rec1','viewer'].includes(role)) {assert.ok(nav.includes('赛事设置'));assert.ok(!nav.includes('账号管理'));}
    if(role==='rec1') {
      await page.goto(base+'/#/setup');await page.locator('.setup-readonly-group').first().waitFor();
      assert.equal(await page.getByRole('button',{name:'保存规则',exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'修改资料',exact:true}).count(),0);
      await page.goto(base+`/#/workspace?event=${identity.event_id}&category=${team.id}&tab=registration`);
      await page.getByRole('heading',{name:/待记录场次/}).first().waitFor();
      assert.equal(await page.getByRole('button',{name:'添加参赛学校',exact:true}).count(),0);
      await page.locator('#sidenav').getByRole('link',{name:'现场任务',exact:true}).click();
      await page.getByRole('heading',{name:'现场任务',exact:true}).waitFor();
      await page.locator('.workspace-choice').filter({hasText:'男子三人赛'}).first().click();
      await page.getByRole('heading',{name:'待记录场次',exact:true}).waitFor();
      assert.match(page.url(),new RegExp(`category=${team.id}.*tab=matches`));
      await page.getByRole('button',{name:'查看成绩',exact:true}).first().click();
      await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();
      assert.equal(await page.locator('#sidenav a.active').getAttribute('data-view'),'field');
      await page.reload();
      await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();
      assert.equal(await page.locator('#sidenav a.active').getAttribute('data-view'),'field');
      await page.screenshot({path:path.join(artifacts,'team-scoring-nav-recorder.png'),fullPage:true});
      await page.getByRole('button',{name:'返回列表',exact:true}).click();
      await page.getByRole('heading',{name:'待记录场次',exact:true}).waitFor();
      assert.match(page.url(),new RegExp(`category=${team.id}.*tab=matches`));
      const isolated=await page.evaluate(async({a,b})=>{
        const s=await import('/js/store.js');s.setStoreUser({id:a,role:'recorder'});
        await s.localStore.begin({key:'permission-draft',kind:'match',uid:'permission-cache',base_version:0,
          event_identity:{event_uuid:'permission-event'},status:'recording',events:[]});
        const own=await s.localStore.get('permission-draft');s.setStoreUser({id:b,role:'recorder'});
        const other=await s.localStore.get('permission-draft');const all=await s.localStore.all();
        s.setStoreUser({id:a,role:'recorder'});return {own:!!own,other,all:all.length};
      },{a:accounts.rec1.user_id,b:accounts.rec2.user_id});
      assert.deepEqual(isolated,{own:true,other:null,all:0});
    } else if(role==='viewer') {
      await page.goto(base+`/#/scoring?match=${match.id}`);
      await page.waitForURL('**/#/school');
      assert.equal(await page.getByRole('button',{name:'返回列表',exact:true}).count(),0);
      await page.goto(base+'/#/matches?category='+team.id);
      await page.getByRole('heading',{name:'比赛赛程',exact:true}).waitFor();
      await page.locator('.schedule-match').first().waitFor();
      await page.locator('.schedule-match').getByText(/记录员：rec2/).waitFor();
      assert.ok((await page.locator('body').innerText()).includes('rec2'));
      assert.equal(await page.getByRole('button',{name:'记录',exact:true}).count(),0);
      await page.goto(base+'/#/results?category='+team.id);
      await page.getByRole('heading',{name:'小组排名',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:/导出|打印|确认小组/}).count(),0);
    } else {
      await page.goto(base+`/#/scoring?match=${match.id}&category=${team.id}`);
      await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();
      assert.equal(await page.locator('#sidenav a.active').getAttribute('data-view'),'workspace');
      await page.reload();
      await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();
      assert.equal(await page.locator('#sidenav a.active').getAttribute('data-view'),'workspace');
      await page.getByRole('button',{name:'返回列表',exact:true}).click();
      await page.getByRole('heading',{name:'三人赛记录',exact:true}).waitFor();
      assert.equal(await page.locator('#sidenav a.active').getAttribute('data-view'),'workspace');
    }
    if(role==='admin') {
      await page.goto(base+'/#/users');
      await page.getByRole('heading',{name:'账号列表',exact:true}).waitFor();
      await page.getByRole('button',{name:'角色与赛事',exact:true}).nth(1).click();
      const dialog=page.getByRole('dialog');await dialog.waitFor();
      await dialog.getByRole('button',{name:'所属赛事',exact:true}).click();
      assert.ok(await dialog.getByRole('checkbox').first().isChecked());
    }
    await page.screenshot({path:path.join(artifacts,`permissions-${role}.png`),fullPage:true});
    await context.close();
  }
  assert.deepEqual(pageErrors,[]);
  console.log('PASS: 四角色侧栏无三人赛记录；工作台/现场任务入口、旧场次与列表链接、刷新和返回及角色高亮均可用');
  console.log('PASS: 赛事隔离、角色导航、深链接拦截、领取互斥、转交、提交归属、正式更正追溯、查看者只读、草稿账号隔离');
} finally {if(browser) await browser.close();child.kill();}
