/* Independent review is separate from the legacy interrupted-submission recovery view. */
import { api,captureRequestContext,newUid } from '../api.js';
import { registerView,state,go } from '../main.js';
import { localStore } from '../store.js';
import { performDecision,pendingDecision,sendCandidate } from '../resultReviewModel.js';
import { openCandidateEditor } from '../resultCandidateEditor.js';
import { h,clear,field,selectInput,textInput,numberInput,textarea,table,toast,statusBadge,
  loadingState,errorState,emptyState,formDialog,confirmAsync,fmtDateTime,pageHeader,categoryLabel,
  bindFilterInput } from '../ui.js';

const LABELS={submitted:'待独立复核',approved:'正式已确认',returned:'已退回',withdrawn:'已撤回'};
const OPERATIONS={initial:'首次结果',correction:'正式更正',cancel:'取消/未完成',reset_review:'重置赛处置',resolve_dispute:'解决争议'};
const packetKind={normal:'正常完成',home_forfeit:'主队弃权',away_forfeit:'客队弃权',pending:'结果待补',dnf:'未完成',dns:'未参加',dsq:'取消成绩',cancelled:'取消',unfinished:'未完成'};
const IMPACT_ACTIONS={preserve:'核对保留',cancel:'取消并保留历史',deactivate:'停用重置赛'};

/* 官方结果与候选的字段级差异：只做对照展示，不推断孰对孰错。 */
function diffRows(kind,official,candidate){
  if(kind==='individual'){
    const before=official.result||{};
    const fields=[['result_value','有效次数'],['error_count','失误次数'],['violation_count','违规次数'],['result_status','结果状态']];
    return fields.map(([key,label])=>{
      const from=before[key]==null?'—':(key==='result_status'?(packetKind[before[key]]||before[key]):before[key]);
      const to=candidate[key]==null?'—':(key==='result_status'?(packetKind[candidate[key]]||candidate[key]):candidate[key]);
      return {label,from,to,changed:String(from)!==String(to)};
    });
  }
  const officialSets=new Map((official.sets||[]).map(s=>[s.set_no,s]));
  const candidateSets=new Map((candidate.sets||[]).map(s=>[s.set_no,s]));
  const numbers=[...new Set([...officialSets.keys(),...candidateSets.keys()])].sort((a,b)=>a-b);
  const text=s=>s?`${s.home_points}:${s.away_points}`:'—';
  const rows=numbers.map(no=>({label:`第 ${no} 局`,from:text(officialSets.get(no)),to:text(candidateSets.get(no)),changed:text(officialSets.get(no))!==text(candidateSets.get(no))}));
  rows.push({label:'结果状态',from:packetKind[official.match?.result_status]||'—',to:packetKind[candidate.result_status]||candidate.result_status,changed:official.match?.result_status!==candidate.result_status});
  return rows;
}

async function render({el,params={},signal,requestContext=captureRequestContext(),isCurrent=()=>true}) {
  const alive=()=>el.isConnected&&!signal?.aborted&&isCurrent();
  if(!state.eventId){el.append(emptyState({text:'当前没有赛事',hint:'请先选择赛事。'}));return;}
  if(params.candidate) return renderDetail(el,params,requestContext,alive);
  const cats=state.structure?.groups.flatMap(g=>g.categories.map(c=>({...c,group_name:g.name})))||[];
  const readonly=state.user.role==='recorder';
  let categoryFilter=params.category?Number(params.category):'';
  let generation=0,last=null,searchTimer=null;
  const status=selectInput([['submitted','待复核'],['returned','退回'],['approved','正式已确认'],['withdrawn','撤回'],['all','全部']],params.status || 'submitted',{'aria-label':'审核状态'});
  const category=selectInput([['','全部项目'],...cats.map(c=>[c.id,`${c.group_name.split('：')[0]} · ${categoryLabel(c)}`])],categoryFilter,{'aria-label':'比赛项目'});
  const operation=selectInput([['','全部操作类型'],...Object.entries(OPERATIONS).map(([key,label])=>[key,label])],'',{'aria-label':'操作类型'});
  const searchInput=textInput('',{type:'search',placeholder:'按场次/选手编号或记录人查找','aria-label':'查找复核候选'});
  /* 筛选值以状态化输入框为准：浏览器自动填充不会过滤候选列表，静止的填充值也会被纠正。 */
  let search=null;
  const message=h('div',{'aria-live':'polite'}),list=h('div');
  el.append(pageHeader({
    crumbs:[{label:'成绩复核'}],
    title:'成绩复核',
    badges:[readonly?statusBadge('只读 · 我的提交',''):statusBadge('独立复核','info')],
    meta:[h('span','接收不代表正式确认；只有显式授权且未参与录入的人可以决定，缺少独立复核人时保持待审。')],
    actions:[h('button.btn',{onclick:()=>load()},'刷新候选'),
      state.user.role==='admin'?h('button.btn',{onclick:()=>grantDialog(categoryFilter||undefined,load)},'配置复核授权'):null],
  }));
  el.append(h('section.panel.review-queue',
    readonly?h('div.info-box','记录员仅可查看本人提交的候选及其状态；确认、退回与授权由独立复核人员完成。'):null,
    h('div.form-grid.review-filters',field('审核状态',status),field('比赛项目',category),field('操作类型',operation),field('查找',searchInput)),
    message,list));
  status.onchange=()=>load();
  category.onchange=()=>{categoryFilter=category.value?Number(category.value):'';load();};
  operation.onchange=()=>{if(last)draw();};
  search=bindFilterInput(searchInput,()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250);});
  async function load(append=false) {
    const seq=++generation;
    clear(message);message.append(h('div.info-box',last?'正在刷新，暂保留上次快照…':'正在读取候选…'));
    try {
      const q=new URLSearchParams({status:status.value,q:search.value().trim()});if(categoryFilter)q.set('category_id',categoryFilter);
      if(append&&last?.next_cursor)q.set('cursor',last.next_cursor);
      const data=await api.get('/api/result-candidates?'+q,{context:requestContext,signal});
      if(seq!==generation||!alive())return;
      const candidates=append&&last?[...new Map([...last.candidates,...data.candidates].map(c=>[c.id,c])).values()]:data.candidates;
      last={...data,candidates,read_at:new Date().toISOString()};draw();
    }catch(e){if(seq!==generation||!alive()||e.cancelled)return;
      if(e.status===403){last=null;clear(list);}clear(message);message.append(errorState(e,()=>load()));
      if(last)message.append(h('p.small',`保留上次快照 ${fmtDateTime(last.read_at)}，读取已过期。`));}
  }
  function draw() {
    if(!last)return;clear(message);clear(list);
    const all=last.candidates;
    const rows=operation.value?all.filter(c=>c.operation===operation.value):all;
    message.append(h('p.small.muted',`读取于 ${fmtDateTime(last.read_at)} · 已加载 ${all.length} / ${last.total} 份候选${rows.length!==all.length?`；当前筛选后 ${rows.length} 份`:''}`));
    if(!rows.length){list.append(h('section.panel',emptyState({text:'当前没有符合条件的候选',hint:'未提交的本机稿不会出现在服务器候选列表；可调整筛选条件或等待作者提交。'})));return;}
    list.append(h('section.panel',h('div.table-scroll',table([
      {label:'项目',render:c=>{const cat=cats.find(x=>x.id===c.category_id);return cat?h('div',h('b',categoryLabel(cat)),h('div.small.muted',cat.group_name.split('：')[0])):h('span.muted','—');}},
      {label:'对象',render:c=>h('div',h('b',`${c.subject_kind==='match'?'场次':'个人赛报名'} ${c.subject_id}`),h('div.small.muted',OPERATIONS[c.operation]))},
      {label:'状态',render:c=>h('div',statusBadge(LABELS[c.status],c.status==='approved'?'ok':'warn'),h('div.small',packetKind[c.result_status]||c.result_status))},
      {label:'记录与版本',render:c=>h('div',c.author_name,h('div.small.muted',`候选r${c.revision} · 正式基版本${c.base_version}`))},
      {label:'时间',render:c=>fmtDateTime(c.created_at)},
      {label:'操作',render:c=>h('div.row.tight',h('button.btn.small',{onclick:()=>go('resultReview',{category:c.category_id,candidate:c.id})},c.can_review&&c.status==='submitted'?'核对候选':'查看'),
        c.status==='submitted'&&!c.can_review?h('span.small.muted','只读'):null)},
    ],rows,{responsive:true}))));
    if(last.next_cursor)list.append(h('button.btn',{onclick:()=>load(true)},'加载更多候选'));
  }
  await load();
}

async function renderDetail(el,params,context,alive) {
  const root=h('div.result-review');el.append(root);root.append(loadingState('正在读取候选原包…'));
  try {
    const {candidate:c}=await api.get(`/api/result-candidates/${params.candidate}`,{context});
    if(!alive())return;clear(root);
    const p=c.payload,official=c.context.official_snapshot,pending=await pendingDecision(c);
    const current=state.structure?.groups.flatMap(g=>g.categories.map(x=>({...x,group_name:g.name}))).find(x=>x.id===c.category_id);
    const back=()=>go('resultReview',{category:c.category_id});
    root.append(h('section.panel.review-detail-head',
      h('div.panel-head',h('div',h('div.small.muted',current?`${current.group_name} · ${current.name}`:'当前赛事'),
        h('h1.review-title',`${c.subject_kind==='match'?'场次':'个人赛报名'} ${c.subject_id} · ${OPERATIONS[c.operation]}`)),
        h('button.btn',{onclick:back},'返回复核列表')),
      h('div.row',statusBadge(LABELS[c.status],c.status==='approved'?'ok':'warn'),statusBadge(packetKind[p.result_status]||'处置候选','info')),
      c.context.subject_labels?h('h3',c.context.subject_labels.join(' vs ')):null,
      h('p',`候选修订 ${c.revision} · 正式基础版本 ${c.base_version} · 记录人 ${c.context.author_name||c.created_by} · ${fmtDateTime(c.created_at)}`),
      h('div.review-banner','本页仅核对与决定，不改比分；如需修改，请退回后由录入人提交新修订。')));
    const diff=diffRows(c.subject_kind,official,p);
    root.append(h('div.review-triple',
      h('section.panel.review-col',h('h3','最后正式版本'),
        h('p.small.muted',c.base_version?`版本 ${c.base_version}`:'尚无正式结果'),
        renderScores(c.subject_kind,c.subject_kind==='match'?{sets:official.sets}:official.result)),
      h('section.panel.review-col',h('h3','本次候选'),
        h('p.small.muted',`结果：${packetKind[p.result_status]||p.result_status}`),
        renderScores(c.subject_kind,p),
        h('p.small',p.reason?`原因：${p.reason}`:''),h('p.small',p.note?`现场说明：${p.note}`:'')),
      h('section.panel.review-col.review-diff',h('h3','差异'),
        diff.length?h('div.diff-list',...diff.map(d=>h(`div.diff-row${d.changed?'.changed':''}`,
          h('span.diff-label',d.label),
          h('span.diff-from',String(d.from??'—')),
          h('span.diff-arrow',{ 'aria-hidden':'true' },'→'),
          h('span.diff-to',String(d.to??'—')),
          d.changed?h('span.diff-flag','已变更'):null)))
          :h('p.small.muted','与最后正式版本一致，无字段差异。'))));
    if(c.subject_kind==='match') {
      const events=p.events_mode==='retain'?official.events:p.events;
      root.append(h('section.panel',h('h3','规则、对阵与过程'),h('p',c.context.rules_summary||'采用本场冻结规则'),
        p.events_mode==='retain'?h('div.warn-box','本次保留原逐分过程，仅更正汇总。下面是原过程，不表示它与更正后的局分一致。'):null,
        h('details',h('summary',`查看${p.events_mode==='retain'?'原':'候选'}逐分过程（${events?.length||0}条）`),
          h('div.table-scroll',table([{label:'序号',key:'seq'},{label:'局次',key:'set_no'},{label:'动作',key:'kind'},
            {label:'一方',key:'side'},{label:'比分',render:e=>`${e.home_after??'—'}:${e.away_after??'—'}`}],events||[],{responsive:true})))));
    }
    const impact=c.context.impact;
    if(impact?.affected?.length)root.append(h('section.panel.review-impact',h('h3','更正影响与显式处置'),
      impact.unresolved?.length?h('div.warn-box',`仍未决定：${impact.unresolved.join('、')}。当前不能批准，请退回后补齐处置。`):null,
      h('div.table-scroll',table([
        {label:'受影响场次',render:m=>`场次 ${m.match_id}`},
        {label:'版本',render:m=>String(m.version)},
        {label:'处置',render:m=>{const a=impact.actions.find(x=>x.match_id===m.match_id);return a?statusBadge(IMPACT_ACTIONS[a.action]||a.action,a.action==='preserve'?'info':'warn'):statusBadge('待决定','warn');}},
        {label:'说明',render:m=>impact.actions.find(x=>x.match_id===m.match_id)?.reason||'—'},
      ],impact.affected,{responsive:true}))));
    if(c.decision)root.append(h('section.panel',h('h3','已记录决定'),h('p',`账号 ${c.decision.actor_id} · ${LABELS[c.status]} · ${fmtDateTime(c.decision.created_at)}`),h('p',c.decision.reason||'已核对确认')));
    const reason=textarea(pending?.payload?.reason||'',{placeholder:'退回、撤回或回避时必须说明原因','aria-label':'复核处理原因'});
    const attestation=h('input',{type:'checkbox',checked:!!pending?.payload?.legacy_authorship_attested});
    const feedback=h('div',{'aria-live':'polite'}),actions=h('div.review-actions');
    let busy=false;
    const canWithdraw=c.authors.includes(state.user.id)||['admin','organizer'].includes(state.user.role);
    const run=async action=>{
      if(busy)return;
      if(!pending&&action!=='approve'&&!reason.value.trim()){reason.focus();feedback.textContent='请填写具体原因。';return;}
      if(action==='approve'&&!pending&&!await confirmAsync('确认正式结果',`将本候选r${c.revision}按已展示内容和处置方案正式确认，关联核算随事务生效。`,'确认'))return;
      busy=true;actions.querySelectorAll('button').forEach(b=>b.disabled=true);feedback.textContent='正在核实原请求并处理…';
      try {const res=await performDecision(c,action,reason.value.trim(),attestation.checked);toast(res.message,'ok');go('resultReview',{category:c.category_id,candidate:c.id,reload:Date.now()});}
      catch(e){feedback.textContent=e.message;toast(e.message,'error');busy=false;go('resultReview',{category:c.category_id,candidate:c.id,reload:Date.now()});}
    };
    if(c.status==='submitted') {
      if(pending?.payload) {reason.disabled=attestation.disabled=true;actions.append(h('button.btn.btn-primary',{onclick:()=>run(pending.payload.action)},`核实并重试原决定（${pending.payload.action==='approve'?'确认':pending.payload.action==='return'?'退回':'撤回'}）`));}
      else {
        if(c.can_review){
          actions.append(h('button.btn.btn-primary',{disabled:p.result_status==='pending'||!!impact?.unresolved?.length,
            onclick:()=>run('approve')},'确认本候选为正式结果'),
            h('button.btn',{onclick:()=>run('return')},'带原因退回'),
            h('button.btn',{onclick:async()=>{if(!reason.value.trim()){reason.focus();feedback.textContent='请填写回避原因。';return;}
              try{await api.post(`/api/result-candidates/${c.id}/recuse`,{reason:reason.value.trim()},{context});go('resultReview',{category:c.category_id,candidate:c.id,reload:Date.now()});}catch(e){feedback.textContent=e.message;}}},'声明回避'));
        }
        if(canWithdraw)actions.append(h('button.btn',{onclick:()=>run('withdraw')},'带原因撤回候选'));
      }
      root.append(h('section.panel',h('h3','处理候选'),
        !c.can_review?h('div.warn-box',state.user.role==='recorder'
          ? '记录员仅可查看本人提交的候选；确认与退回需具备授权且未参与录入的复核人员完成。'
          : '当前账号未获本项目复核能力、参与过录入或已回避。请安排独立复核人员，不会自动批准。'):null,
        p.result_status==='pending'?h('div.warn-box','结果仍待补全，不能正式确认。请退回或撤回后修订。'):null,
        field('处理原因（退回、撤回或回避必填）',reason),c.context.legacy_authorship_unknown?h('label.row',attestation,'已核对历史作者来源，并声明本人未参与该内容'):null,
        actions,feedback));
    }
    if(['returned','withdrawn'].includes(c.status)&&canWithdraw)root.append(h('section.panel',h('h3','作者修订'),
      h('p','原包保留，新修订需再次独立复核。不会修改原候选或直接改变正式结果。'),
      h('button.btn.btn-primary',{onclick:async()=>{try{await revise(c,context,back);}catch(e){toast(e.message,'error');}}},'按原候选内容补正')));
    root.append(h('section.panel',h('details',h('summary','审计关联'),h('p.small.review-hash',`候选 ${c.id} · ${c.candidate_hash}`),
      h('p.small.review-hash',`冻结对阵ID ${p.home_participation||'—'} vs ${p.away_participation||'—'} · 规则指纹 ${p.rules_hash||'旧默认兼容'}`),
      h('p.small',`已知内容作者账号：${c.authors.join('、')}。历史未知保留UNKNOWN，不生成补签。`))));
  }catch(e){if(alive()){clear(root);root.append(errorState(e,()=>go('resultReview',{category:params.category})));}}
}

function renderScores(kind,payload) {
  if(!payload)return h('p','—');
  if(kind==='individual')return h('dl.review-values',h('dt','有效次数'),h('dd',String(payload.result_value??'—')),
    h('dt','失误次数'),h('dd',String(payload.error_count??'—')),h('dt','违规次数'),h('dd',String(payload.violation_count??'—')));
  return payload.sets?.length?h('div.table-scroll',table([{label:'局次',key:'set_no'},{label:'主队',key:'home_points'},{label:'客队',key:'away_points'}],payload.sets,{responsive:true})):h('p','无逐局比分，不补造分数。');
}

async function grantDialog(categoryId,reload) {
  const [data,current]=await Promise.all([api.get('/api/users'),api.get(`/api/events/${state.eventId}/review-grants`)]);
  const users=data.users.filter(u=>u.active&&['admin','organizer'].includes(u.role));
  const user=selectInput(users.map(u=>[u.id,`${u.display_name||u.username}（${u.role}）`]),users[0]?.id);
  const scope=selectInput([['event','本赛事'],...(categoryId?[['category','本项目']]:[])],categoryId?'category':'event');
  const enabled=selectInput([['true','授予'],['false','撤销']],'true'),reason=textarea('',{placeholder:'授权或撤销原因'});
  formDialog({title:'显式配置独立复核能力',sections:[{body:h('div',h('div.warn-box','新能力默认无授权；管理员也不能自审。账号适格与赛事范围仍由服务器检查。'),
    h('div.form-grid',field('账号',user),field('范围',scope),field('操作',enabled)),field('原因',reason,{required:true}))}],
    actions:[{label:'保存授权配置',primary:true,run:async({close})=>{
      const sid=scope.value==='category'?Number(categoryId):state.eventId;
      const old=current.grants.find(g=>g.user_id===Number(user.value)&&g.scope_kind===scope.value&&g.scope_id===sid);
      await api.post(`/api/events/${state.eventId}/review-grants`,{user_id:Number(user.value),active:enabled.value==='true',
        ...(scope.value==='category'?{category_id:Number(categoryId)}:{}),base_version:old?.version||0,reason:reason.value.trim()});
      close();await reload();toast('复核授权已更新','ok');}}]});
}

async function revise(c,context,reload) {
  if(c.subject_kind==='match') {
    const match=(await api.get(`/api/scoring/match/${c.subject_id}`,{context})).match;
    if(c.operation!=='initial')return openCandidateEditor(match,c.operation,reload,c);
    const claim=await api.post(`/api/recording/match/${c.subject_id}/claim`,{},{context});
    const key=`${context.identity.deployment_id}:${context.identity.event_uuid}:match:${c.subject_id}`;
    const draft={key,kind:'match',match_id:c.subject_id,category_id:c.category_id,event_identity:context.identity,
      protocol_schema:3,operation:'initial',parent_id:c.id,uid:newUid('revision'),base_version:c.base_version,
      claim_epoch:claim.claim_epoch??match.claim_epoch,plan_version:c.payload.plan_version,rules:match.rules,rules_hash:c.payload.rules_hash,
      live_base_epoch:match.live_stream_epoch??0,
      lineup:{home:c.payload.home_participation,away:c.payload.away_participation},events:structuredClone(c.payload.events||[]),
      result_status:c.payload.result_status,note:c.payload.note,status:'review',request_context:context,active_set:null};
    if(!await localStore.begin(draft))throw new Error('本机仍有未核实记录，不能覆盖；请先核对或导出。');
    go('scoring',{match:c.subject_id,category:c.category_id});return;
  }
  const p=c.payload,value=numberInput(p.result_value??'',{min:0,step:1}),errors=numberInput(p.error_count??'',{min:0,step:1}),
    violations=numberInput(p.violation_count??'',{min:0,step:1}),status=selectInput([['normal','正常完成'],['pending','待补全'],['dnf','未完成'],['dns','未参加'],['dsq','取消成绩']],p.result_status),
    reason=textarea(p.reason||'',{placeholder:'修订说明'});
  let draft;
  return formDialog({title:`补正个人赛报名 ${c.subject_id}`,sections:[{body:h('div.form-grid',field('有效次数',value),field('失误次数',errors),field('违规次数',violations),field('结果状态',status),field('修订说明',reason))}],
    actions:[{label:'提交新修订待复核',primary:true,run:async({close})=>{
      if(!draft){const uid=newUid('revision'),impact=c.operation==='initial'?null:await api.get(`/api/result-candidates/impact?subject_kind=individual&subject_id=${c.subject_id}`,{context});
        const packet={payload_schema:3,subject_kind:'individual',subject_id:c.subject_id,operation:c.operation,parent_id:c.id,submission_uid:uid,
          ...(impact?{impact_hash:impact.impact_hash,impact_actions:[]}:{}),payload:{...p,result_value:value.value===''?null:Number(value.value),
            error_count:errors.value===''?null:Number(errors.value),violation_count:violations.value===''?null:Number(violations.value),result_status:status.value,reason:reason.value.trim()}};
        draft={key:`${context.identity.deployment_id}:${context.identity.event_uuid}:revision:${c.id}`,kind:'individual',uid,payload:packet,
          event_identity:context.identity,base_version:c.base_version,participation_id:c.subject_id,request_context:context,status:'submitting'};}
      try{const res=await sendCandidate(draft);toast(res.message,'ok');close();await reload();}
      catch(e){if(e.request_released)draft=null;throw e;}
    }}]});
}

registerView({name:'resultReview',label:'成绩复核',roles:['admin','organizer','recorder'],render});
