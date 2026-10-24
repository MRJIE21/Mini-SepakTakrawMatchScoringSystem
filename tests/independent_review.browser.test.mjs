/* Real browser/HTTP workflow, isolated data and explicit independent reviewer. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(process.env.STSS_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(import.meta.dirname,'..'),data=await mkdtemp(path.join(tmpdir(),'review-browser-'));
const artifacts=process.env.STSS_BROWSER_ARTIFACTS||path.join(data,'artifacts');await mkdir(artifacts,{recursive:true});
const child=spawn(process.env.STSS_PYTHON||'python',['-B','-u','-c',`
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db();c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class QuietHandler(Handler):
    def log_message(self,*args):pass
s=create_server(('127.0.0.1',0),QuietHandler,background_sync=False)
print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
`],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',
  STSS_DATA_DIR:data,STSS_DB:path.join(data,'registry.db'),STSS_EVENTS_DIR:path.join(data,'events'),STSS_ADMIN_PASSWORD:'ReviewTest123'}});
let browser,page,serverErrors='',identity,token='',reviewerToken='';const errors=[],checks=[];
child.stderr.on('data',d=>serverErrors+=d);
try {
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(serverErrors||'Startup timeout')),15000);let out='';
    child.once('error',reject);child.once('exit',code=>reject(new Error(`Server ${code}: ${serverErrors}`)));
    child.stdout.on('data',d=>{out+=d;try{const p=JSON.parse(out.split('\n')[0]);clearTimeout(timer);resolve(p.port);}catch{}});});
  const base=`http://127.0.0.1:${port}`;
  const api=async(method,url,body,as=token)=>{
    const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Client-Protocol':'3',
      ...(as?{Authorization:`Bearer ${as}`} : {}),...(identity?{'X-Event-ID':String(identity.event_id),'X-Event-UUID':identity.event_uuid}: {})},
      body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
  token=(await api('POST','/api/login',{username:'admin',password:'ReviewTest123'})).token;
  identity=await api('POST','/api/events',{name:'独立复核浏览器验证赛事'});
  identity.deployment_id=(await api('GET','/api/events')).deployment_id;
  await api('POST',`/api/events/${identity.event_id}/bootstrap`,{});
  const group=(await api('GET',`/api/events/${identity.event_id}/structure`)).groups[0];
  const category=group.categories.find(c=>c.kind==='team'&&c.gender==='male');
  const user=(await api('POST','/api/users',{username:'reviewer',password:'ReviewUser123',role:'organizer',display_name:'独立复核员',event_ids:[identity.event_id]})).user_id;
  reviewerToken=(await api('POST','/api/login',{username:'reviewer',password:'ReviewUser123'})).token;
  await api('POST',`/api/events/${identity.event_id}/review-grants`,{user_id:user,active:true,base_version:0,reason:'隔离验证独立复核'});
  for(const name of ['测试学校甲','很长的测试学校名称用于验证换行与可访问操作乙'])await api('POST',`/api/categories/${category.id}/enrollments`,{
    school:{name},captain_index:0,members:[1,2,3].map(n=>({name:`${name}队员${n}`,gender:'male',jersey_no:String(n)}))});
  const parts=(await api('GET',`/api/categories/${category.id}/participations`)).participations;
  const makeMatch=async()=>(await api('POST','/api/matches',{category_id:category.id,home_participation:parts[0].id,away_participation:parts[1].id})).match_id;
  const mid=await makeMatch();
  browser=await chromium.launch({headless:true,executablePath:process.env.STSS_BROWSER_PATH||undefined});
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  await ctx.addInitScript(({token,event})=>{localStorage.setItem('stss_token',token);localStorage.setItem('stss_event',String(event));},{token,event:identity.event_id});
  page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/#/workspace?category=${category.id}&event=${identity.event_id}`);
  await page.locator('.ctx-tabs a.active').filter({ hasText: '概况' }).waitFor();
  checks.push('管理默认进入概况，原上游导航保留');
  await page.goto(`${base}/#/scoring?match=${mid}&category=${category.id}`);
  await page.getByLabel('结果状态',{exact:true}).selectOption('home_forfeit');
  const receivedResponse=page.waitForResponse(r=>r.url().endsWith('/api/result-candidates')&&r.status()===200);
  await page.getByRole('button',{name:'核对无误，提交待复核',exact:true}).click();
  await receivedResponse;
  const queue=await api('GET',`/api/result-candidates?category_id=${category.id}`);assert.equal(queue.total,1);
  const candidate=queue.candidates[0];assert.equal((await api('GET',`/api/matches/${mid}`)).match.result_version,0);
  checks.push('真实现场提交只接收候选，正式版本不变');
  await page.goto(`${base}/#/resultReview?candidate=${candidate.id}`);
  await page.getByRole('heading',{name:'处理候选',exact:true}).waitFor();
  /* 1.5.0 起本人录入的候选直接不渲染确认/退回按钮，改为提示“未获授权或已参与录入”，
     不再提供可点击但 disabled 的按钮（web/js/views/resultReview.js:157-180）。 */
  assert.equal(await page.getByRole('button',{name:'确认本候选为正式结果',exact:true}).count(),0,
    '管理员本人录入时不应出现正式确认按钮');
  await page.getByText('当前账号未获本项目复核能力、参与过录入或已回避。请安排独立复核人员，不会自动批准。',{exact:true}).waitFor();
  checks.push('管理员本人录入，界面不提供自审确认入口并说明须独立复核人员');
  const reviewCtx=await browser.newContext({viewport:{width:1280,height:900}});
  await reviewCtx.addInitScript(({token,event})=>{localStorage.setItem('stss_token',token);localStorage.setItem('stss_event',String(event));},{token:reviewerToken,event:identity.event_id});
  const reviewPage=await reviewCtx.newPage();reviewPage.on('pageerror',e=>errors.push(e.message));
  await reviewPage.goto(`${base}/#/resultReview?candidate=${candidate.id}`);
  await reviewPage.getByRole('heading',{name:'处理候选',exact:true}).waitFor();
  for(const width of [360,768,1280]) {
    await reviewPage.setViewportSize({width,height:800});
    assert.ok(await reviewPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow ${width}`);
    const height=await reviewPage.getByRole('button',{name:'确认本候选为正式结果',exact:true}).evaluate(e=>e.getBoundingClientRect().height);assert.ok(height>=44);
    await reviewPage.screenshot({path:path.join(artifacts,`review-${width}.png`),fullPage:true});
  }
  checks.push('真实复核详情360/768/1280无整页横溢，主动作44px');
  await reviewPage.setViewportSize({width:360,height:400});
  const confirmAction=reviewPage.getByRole('button',{name:'确认本候选为正式结果',exact:true});
  await confirmAction.focus();
  const focusBox=await confirmAction.boundingBox();assert.ok(focusBox.y>=0&&focusBox.y+focusBox.height<=400,'short viewport focus remains visible');
  await reviewPage.screenshot({path:path.join(artifacts,'review-short-keyboard.png')});
  await reviewPage.keyboard.press('Enter');
  await reviewPage.getByRole('button',{name:'确认',exact:true}).focus();
  await reviewPage.keyboard.press('Enter');
  await reviewPage.getByRole('heading',{name:'已记录决定',exact:true}).waitFor();
  assert.equal((await api('GET',`/api/matches/${mid}`)).match.result_version,1);
  assert.equal((await api('GET',`/api/matches/${mid}`)).match.result_status,'home_forfeit');
  checks.push('独立复核真实确认，正式版本只提升一次');
  checks.push('360×400短视口，键盘焦点可见并以Enter完成独立确认');
  const original=(await api('GET',`/api/matches/${mid}`)).match;
  const lost=(await api('POST','/api/matches',{category_id:original.category_id,home_participation:original.home.participation_id,
    away_participation:original.away.participation_id,round_label:'响应丢失原包核实'})).match_id;
  await page.goto(`${base}/#/scoring?match=${lost}`);
  await page.getByRole('button',{name:'开始第 1 局记录',exact:true}).waitFor();
  await page.locator('select').last().selectOption('home_forfeit');
  await page.route('**/api/result-candidates',async route=>{await route.fetch();await route.abort('failed');});
  await page.route('**/api/candidate-receipts/*',route=>route.abort('failed'));
  await page.getByRole('button',{name:'核对无误，提交待复核',exact:true}).click();
  await page.getByRole('button',{name:'重试原包提交',exact:true}).waitFor();
  const beforeRetry=await page.evaluate(async id=>(await (await import('/js/store.js')).localStore.all()).find(d=>d.match_id===id),lost);
  await page.unroute('**/api/result-candidates');await page.unroute('**/api/candidate-receipts/*');
  await page.reload();await page.getByRole('button',{name:'查看待复核候选',exact:true}).waitFor();
  const recovered=await page.evaluate(async id=>(await (await import('/js/store.js')).localStore.all()).find(d=>d.match_id===id),lost);
  assert.equal(recovered.uid,beforeRetry.uid);assert.equal(recovered.status,'received');
  assert.equal(await page.locator('.add-btn').count(),0);
  assert.equal((await api('GET',`/api/matches/${lost}`)).match.result_version,0);
  checks.push('响应丢失后先以原UID核实接收，原件只读保留，待审场次不会重新开放计分');
  const personal=group.categories.find(c=>c.kind==='individual'&&c.gender==='male');
  await page.goto(`${base}/#/workspace?category=${personal.id}&event=${identity.event_id}`);
  await page.getByText('尚无有效报名，不表示成绩已完成。',{exact:true}).waitFor();
  checks.push('零报名个人赛不伪造完成');
  await page.goto(`${base}/#/review`);
  await page.getByText('已接收待复核（原件只读保留）',{exact:true}).first().waitFor();
  checks.push('本机已接收原包仍可查看并导出');
  const regGroup=(await api('GET',`/api/events/${identity.event_id}/structure`)).groups[1];
  const regTeam=regGroup.categories.find(c=>c.kind==='team'&&c.gender==='male');
  const regIndividual=regGroup.categories.find(c=>c.kind==='individual'&&c.gender==='male');
  const school=(await api('POST',`/api/events/${identity.event_id}/schools`,{name:'合并报名验证学校',group_id:regGroup.id})).school_id;
  await page.bringToFront();
  await page.goto(`${base}/#/workspace?${new URLSearchParams({event:identity.event_id,group:regGroup.id,category:regTeam.id,tab:'registration',school})}`);
  await page.getByRole('heading',{name:'合并报名验证学校',exact:true}).waitFor();
  assert.equal(await page.locator('.school-registration-tabs [role=tab]').count(),2);
  const people=page.locator('.school-registration-people'),project=page.locator('.school-registration-active-project');
  await people.getByText('＋ 新增人员',{exact:true}).click();
  await people.getByLabel('新增人员姓名',{exact:true}).fill('尚未添加的半输入');
  await people.getByLabel('搜索学校人员',{exact:true}).fill('无匹配');
  assert.equal(await people.getByLabel('新增人员姓名',{exact:true}).inputValue(),'尚未添加的半输入');
  // Hold the real navigation autofocus until the user has already focused a
  // different field. This reproduces a late animation frame without sleeps.
  await page.evaluate(()=>{
    const original=requestAnimationFrame,callbacks=[];
    window.__registrationFocusFrames={original,callbacks};
    window.requestAnimationFrame=callback=>{callbacks.push(callback);return 0;};
  });
  await page.locator('.school-registration-catalog button').filter({hasText:regIndividual.name}).click();
  assert.equal(await people.getByLabel('新增人员姓名',{exact:true}).inputValue(),'尚未添加的半输入');
  await people.getByLabel('新增人员姓名',{exact:true}).focus();
  const deferredFocus=await page.evaluate(()=>{
    const held=window.__registrationFocusFrames,focused=document.activeElement;
    window.requestAnimationFrame=held.original;delete window.__registrationFocusFrames;
    for(const callback of held.callbacks)callback(performance.now());
    return {frames:held.callbacks.length,keptFocus:document.activeElement===focused};
  });
  assert.ok(deferredFocus.frames>0,'项目导航确实安排了延迟焦点');
  assert.equal(deferredFocus.keptFocus,true,'用户已进入人员输入后，旧项目导航不得抢回焦点');
  checks.push('延迟项目定位不抢走用户已移动的输入焦点');
  await people.getByLabel('搜索学校人员',{exact:true}).fill('');
  await people.getByLabel('新增人员姓名',{exact:true}).focus();
  await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type('共享人员甲');
  await page.keyboard.press('Tab');await page.keyboard.press('ArrowDown');
  assert.equal(await people.locator('.school-registration-add select').evaluate(e=>e===document.activeElement),true);
  assert.equal(await people.locator('.school-registration-add select').inputValue(),'male');
  await page.keyboard.press('Tab');await page.keyboard.type('25');
  assert.equal(await people.getByLabel('新增人员常用号码',{exact:true}).inputValue(),'25');
  await page.keyboard.press('Tab');await page.keyboard.type('键盘录入的区分信息');
  assert.equal(await people.getByLabel('新增人员区分信息',{exact:true}).inputValue(),'键盘录入的区分信息');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'添加人员');
  await page.keyboard.press('Enter');
  await page.locator('.school-registration-catalog button').filter({hasText:regTeam.name}).click();
  await project.getByLabel('参赛选择',{exact:true}).selectOption('participate');
  const selectedKey=await project.getByLabel(`${regTeam.name}选人`,{exact:true}).locator('option').evaluateAll(options=>options.find(o=>o.textContent.startsWith('共享人员甲'))?.value);
  await project.getByLabel(`${regTeam.name}选人`,{exact:true}).selectOption(selectedKey);
  assert.equal(await project.getByLabel('共享人员甲本项目号码',{exact:true}).inputValue(),'');
  await project.getByLabel('共享人员甲本项目号码',{exact:true}).fill('7');
  await project.getByLabel('队长',{exact:true}).selectOption(selectedKey);
  await project.getByRole('button',{name:'编辑人员资料',exact:true}).click();
  assert.equal(await people.getByLabel('常用号码',{exact:true}).inputValue(),'25');
  await people.getByLabel('常用号码',{exact:true}).fill('26');
  assert.equal(await project.getByLabel('共享人员甲本项目号码',{exact:true}).inputValue(),'7');
  checks.push('统一编辑：部分新增输入不丢、人员项目双向定位、常用号码与项目号码分离');
  await page.locator('.school-registration-catalog button').filter({hasText:regIndividual.name}).click();
  await project.getByLabel('参赛选择',{exact:true}).selectOption('participate');
  await project.getByText('查看暂不可报名人员（1）',{exact:true}).click();
  assert.match(await project.innerText(),/已参加/);
  await project.getByText('＋ 就地新增人员',{exact:true}).click();
  await project.getByLabel('新增人员姓名',{exact:true}).fill('个人参赛甲');
  await project.getByRole('button',{name:'添加人员并加入本项目',exact:true}).click();
  await project.getByText('＋ 就地新增人员',{exact:true}).click();
  await project.getByLabel('新增人员姓名',{exact:true}).fill('仅学校档案乙');
  await project.getByRole('button',{name:'添加到学校人员名单',exact:true}).click();
  assert.match(await project.locator('.school-registration-member strong').innerText(),/个人参赛甲/);
  assert.match(await page.locator('.school-registration-changes').innerText(),/本次新增 3 位.*项目调整 2 项/);
  checks.push('个人赛新增第二份档案不替换已选运动员，不可兼项保留');
  for(const width of [360,768,1280]) {
    await page.setViewportSize({width,height:800});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`registration overflow ${width}`);
    await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:path.join(artifacts,`registration-unified-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:360,height:400});
  const keyboardPreview=page.getByRole('button',{name:'预览整批变更',exact:true});
  await keyboardPreview.focus();
  assert.ok(await keyboardPreview.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
  await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'核对整批变更',exact:true}).waitFor();
  await page.getByRole('tab',{name:'统一编辑',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'确认整批提交',exact:true}).isEnabled(),true,'展示切换不使业务预览失效');
  await page.getByRole('tab',{name:'整批核对',exact:true}).click();
  const commitResponse=page.waitForResponse(r=>r.url().includes('/registration-commit')&&r.status()===200);
  const keyboardCommit=page.getByRole('button',{name:'确认整批提交',exact:true});
  await keyboardCommit.focus();
  assert.ok(await keyboardCommit.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.height>=44;}));
  await page.screenshot({path:path.join(artifacts,'registration-short-keyboard.png')});
  await page.keyboard.press('Enter');
  await commitResponse;
  await page.getByRole('tab',{name:'统一编辑',exact:true}).waitFor();
  const saved=await api('GET',`/api/schools/${school}/registration-workspace`);
  assert.equal(saved.people.length,3);
  const personalSaved=saved.projects.find(p=>p.category_id===regIndividual.id);
  assert.equal(saved.people.find(p=>p.key===personalSaved.athlete_key).name,'个人参赛甲');
  const teamSaved=saved.projects.find(p=>p.category_id===regTeam.id);
  assert.equal(teamSaved.members[0].jersey_no,'7');assert.equal(saved.people.find(p=>p.name==='共享人员甲').jersey_no,'26');
  checks.push('整批预览/合法待补/原子保存与重读，三人和个人必要差异保留');
  checks.push('Tab/方向键/Enter添加共享人员，360×400短视口键盘预览及提交焦点可见');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(artifacts,'independent-review-checks.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks,artifacts}));
}catch(e){if(page)await page.screenshot({path:path.join(artifacts,'review-failure.png'),fullPage:true}).catch(()=>{});throw e;}
finally{if(browser)await browser.close();child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));}
