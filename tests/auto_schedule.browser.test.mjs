/* Real isolated service and user-visible automatic scheduling, never live data. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const {chromium}=createRequire(import.meta.url)(process.env.STSS_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(import.meta.dirname,'..'), data=await mkdtemp(path.join(tmpdir(),'auto-browser-'));
const artifacts=process.env.STSS_BROWSER_ARTIFACTS||path.join(data,'artifacts');await mkdir(artifacts,{recursive:true});
const child=spawn(process.env.STSS_PYTHON||'python',['-B','-u','-c',`
import json
from app import db,security
from app.http_server import Handler,load_routes,create_server
db.init_db();c=db.connect();security.ensure_default_users(c);c.close();load_routes()
class Quiet(Handler):
 def log_message(self,*args):pass
s=create_server(('127.0.0.1',0),Quiet);print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
`],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,STSS_DATA_DIR:data,STSS_DB:path.join(data,'registry.db'),STSS_EVENTS_DIR:path.join(data,'events'),STSS_ADMIN_PASSWORD:'AutoTests123',PYTHONUTF8:'1'}});
let browser,page,stderr='',token='',identity;const errors=[],checks=[],geometry=[];
child.stderr.on('data',c=>{stderr+=c;});
const pass=text=>{checks.push(text);console.log('PASS '+text);};
try{
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'Startup timeout')),10000);let output='';child.once('error',reject);child.stdout.on('data',c=>{output+=c;try{const r=JSON.parse(output.split('\n')[0]);clearTimeout(timer);resolve(r.port);}catch{}});});
 const base=`http://127.0.0.1:${port}`;
 const api=async(method,url,body,loginToken=token)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Client-Protocol':'2',...(loginToken?{Authorization:`Bearer ${loginToken}`} :{}),...(identity?{'X-Event-ID':String(identity.event_id),'X-Event-UUID':identity.event_uuid}:{})},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;};
 token=(await api('POST','/api/login',{username:'admin',password:'AutoTests123'})).token;
 const event=await api('POST','/api/events/full',{event:{name:'自动编排真实验证',start_date:'2026-10-18'},groups:[{code:'S',name:'S组',categories:[{name:'男子三人赛',gender:'male',kind:'team'}]}],venues:[{name:'一号场地'},{name:'二号场地'}]});
 identity={event_id:event.event_id,event_uuid:event.event_uuid,deployment_id:(await api('GET','/api/events')).deployment_id};
 const structure=await api('GET',`/api/events/${event.event_id}/structure`), group=structure.groups[0],cat=group.categories[0];
 for(let i=1;i<=8;i++)await api('POST',`/api/categories/${cat.id}/enrollments`,{school:{name:`自动编排${i}校`},seed_no:i,captain_index:0,members:[1,2,3].map(n=>({name:`队员${i}-${n}`,gender:'male',jersey_no:String(n)}))});
 const packet=body=>({event_identity:identity,request_uid:randomUUID(),...body});
 const drawPath=`/api/categories/${cat.id}/group-draw`;const roster=await api('GET',drawPath);
 let draw=(await api('POST',drawPath,packet({method:'seeded',capacities:[4,4],roster_hash:roster.roster_hash}))).draw;
 for(const action of ['complete','confirm'])draw=(await api('POST',drawPath+'/'+action,packet({draw_id:draw.id,base_rev:draw.rev}))).draw;
 const stage=async definition=>{const s=await api('POST',`/api/categories/${cat.id}/schedule/stages`,packet({base_revision:0,definition}));const p=await api('POST',`/api/schedule-stages/${s.stage_id}/preview`,packet({base_revision:1}));await api('POST',`/api/schedule-stages/${s.stage_id}/confirm`,packet({base_revision:1,definition_hash:p.definition_hash,basis_hash:p.basis_hash,approved_byes:p.graph.byes}));return s.stage_id;};
 const groupStage=await stage({purpose:'group',name:'小组赛',draw_id:draw.id});
 const pools=(await api('GET',`/api/categories/${cat.id}/schedule`)).plan.stages[0].pools.map(p=>p.id);
 await stage({purpose:'knockout',name:'淘汰赛',pool_ids:pools});
 for(const [rank,start]of[[3,5],[4,7]])await stage({purpose:'placement',name:`第${start}—${start+1}名`,pool_ids:pools,source_rank:rank,rank_from:start,rank_to:start+1});
 browser=await chromium.launch({headless:true,executablePath:process.env.STSS_BROWSER_PATH});
 const makePage=async t=>{const context=await browser.newContext({viewport:{width:1365,height:1000},locale:'zh-CN',serviceWorkers:'block'});await context.addInitScript(({token,event})=>{localStorage.setItem('stss_token',token);localStorage.setItem('stss_event',String(event));},{token:t,event:event.event_id});const p=await context.newPage();p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));return p;};
 page=await makePage(token);
 const url=`${base}/#/workspace?event=${event.event_id}&group=${group.id}&category=${cat.id}&tab=schedule&stage=${groupStage}`;
 await page.goto(url);await page.getByRole('button',{name:'自动编排',exact:true}).click();
 await page.getByLabel('同队最短休息（分钟）',{exact:true}).waitFor();
 for(const box of await page.locator('.auto-choices input').all())await box.check();
 const capture=async state=>{for(const width of [320,390,768,1365]){await page.setViewportSize({width,height:1000});const dims=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,outside:[...document.querySelectorAll('.auto-schedule input,.auto-schedule button')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left< -1||r.right>innerWidth+1;}).length}));assert.ok(dims.scroll<=width+1,JSON.stringify({state,...dims}));assert.equal(dims.outside,0);geometry.push({state,...dims});await page.screenshot({path:path.join(artifacts,`auto-${state}-${width}.png`),fullPage:true});}};
 await capture('rules');
 const rest=page.getByLabel('同队最短休息（分钟）',{exact:true});await rest.fill('0');await page.getByRole('button',{name:'生成预览',exact:true}).click();await page.getByRole('alert').filter({hasText:'1至1440'}).waitFor();
 await rest.fill('45');assert.match(await page.locator('.auto-hint').innerText(),/10:15/);
 await page.getByRole('navigation',{name:'项目工作台导航',exact:true}).getByRole('link',{name:'报名',exact:true}).click();
 await page.getByRole('dialog',{name:'有未保存的编排',exact:true}).getByRole('button',{name:'取消',exact:true}).click();assert.equal(await rest.inputValue(),'45');assert.match(page.url(),/tab=schedule/);
 await rest.fill('30');
 for(const end of await page.getByLabel('结束时间',{exact:true}).all())await end.fill('2026-10-18T09:30');
 await page.getByRole('button',{name:'生成预览',exact:true}).click();await page.getByRole('button',{name:'需调整规则后保存',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'需调整规则后保存',exact:true}).isDisabled(),true);await capture('blocked');
 assert.equal((await api('GET',`/api/categories/${cat.id}/plan`)).plan.stages.reduce((n,s)=>n+s.matches.length,0),6);
 pass('正休息输入、从预计结束计算、取消离页保留；容量不足禁用确认且预览不新增比赛');
 await page.getByRole('button',{name:'返回修改规则',exact:true}).click();
 for(const end of await page.getByLabel('结束时间',{exact:true}).all())await end.fill('2026-10-18T17:00');
 await page.getByRole('button',{name:'生成预览',exact:true}).click();
 const save=page.getByRole('button',{name:'确认并保存18场安排',exact:true});await save.waitFor();await capture('preview');assert.equal((await api('GET',`/api/categories/${cat.id}/plan`)).plan.stages.reduce((n,s)=>n+s.matches.length,0),6);
 await save.click();await page.getByRole('heading',{name:'比赛赛程',exact:true}).waitFor();
 const actual=(await api('GET',`/api/categories/${cat.id}/plan`)).plan;assert.equal(actual.stages[0].matches.length,12);assert.equal(actual.stages.reduce((n,s)=>n+s.matches.length,0),18);
 assert.equal((await api('GET',`/api/categories/${cat.id}/auto-schedule`)).settings.rest_minutes,30);
 pass('真实8校2组小组赛补齐12场，沿用淘汰和名次图；18场预览确认并保存且不重复创建');
 const games=actual.stages[0].matches;const first=games[0],other=games.find(m=>m.scheduled_at===first.scheduled_at&&m.venue_id!==first.venue_id);assert.ok(other);
 await page.locator(`[data-match-id="${first.id}"]`).getByRole('button',{name:'调整场地时间',exact:true}).click();const edit=page.getByRole('dialog',{name:new RegExp(`调整场地时间.*${first.public_code}`)});
 await edit.locator('select[data-field="venue_id"]').selectOption(String(other.venue_id));await edit.getByRole('button',{name:'保存安排',exact:true}).click();await edit.getByText(/重叠|冲突/).first().waitFor();assert.equal((await api('GET',`/api/matches/${first.id}`)).match.venue_id,first.venue_id);
 await edit.getByRole('button',{name:'取消',exact:true}).click();const discard=page.getByRole('dialog',{name:'有未保存的修改',exact:true});if(await discard.count())await discard.getByRole('button',{name:'放弃修改',exact:true}).click();
 pass('编排后人工移动仍执行场地重叠校验，失败保留输入并保持原数据');
 for(const role of ['organizer','recorder','viewer']){await api('POST','/api/users',{username:`auto-${role}`,password:'AutoRole123',role,display_name:role,event_ids:[event.event_id]});const login=await api('POST','/api/login',{username:`auto-${role}`,password:'AutoRole123'});const p=await makePage(login.token);await p.goto(url);await p.getByRole('navigation',{name:'项目工作台导航',exact:true}).waitFor();if(role==='organizer')await p.getByRole('button',{name:'自动编排',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'自动编排',exact:true}).count(),role==='organizer'?1:0);await p.context().close();}
 pass('原管理角色可编排，记录员和查看者保持边界；四屏宽规则、完整/不足预览没有横向溢出');
 assert.deepEqual(errors,[]);await writeFile(path.join(artifacts,'auto-schedule-browser-report.json'),JSON.stringify({status:'PASS',checks,geometry,errors},null,2));
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:path.join(artifacts,'auto-failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-3500));}throw error;}
finally{if(browser)await browser.close();child.kill();}
