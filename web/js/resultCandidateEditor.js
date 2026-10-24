/* A correction is a candidate with an explicit impact plan, never a direct write. */
import { api,newUid,captureRequestContext,payloadHash } from './api.js';
import { localStore } from './store.js';
import { sendCandidate } from './resultReviewModel.js';
import { h,field,selectInput,numberInput,textarea,textInput,formDialog,toast,table,statusBadge } from './ui.js';
import { normalizeRules,ruleForSet,winner } from './teamRules.js';

export async function openCandidateEditor(match,operation,reload,parent=null) {
  const context=captureRequestContext(),key=`${context.identity?.deployment_id}:${context.identity?.event_uuid}:${operation}:${match.id}`;
  let draft=await localStore.get(key);
  if(draft?.payload&&draft.payload.payload_schema!==3) {
    return formDialog({title:'保留的旧更正原包',sections:[{body:h('p','此原包需要先到“待核实提交”核实原UID，并导出恢复副本；不能自动转换为新候选。')}],
      actions:[{label:'前往待核实提交',primary:true,run:({close})=>{close();location.hash='#/review';}}]});
  }
  const [impact,history]=await Promise.all([
    api.get(`/api/result-candidates/impact?subject_kind=match&subject_id=${match.id}`,{context}),
    api.get(`/api/result-history/match/${match.id}`,{context})]);
  const before=history.versions.find(v=>v.version===match.result_version);
  const snapshot=before ? JSON.parse(before.snapshot_json) : {events:[]};
  const source=parent?.payload || draft?.payload?.payload || {};
  const rules=normalizeRules(match.rules),sets=[];
  for(let no=1;no<=rules.max_sets;no++) {
    const prior=(source.sets || match.sets || []).find(s=>s.set_no===no) || {};
    sets.push({no,home:numberInput(prior.home_points??'',{min:0,step:1,'aria-label':`第${no}局主队分数`}),
      away:numberInput(prior.away_points??'',{min:0,step:1,'aria-label':`第${no}局客队分数`})});
  }
  const status=selectInput(operation==='cancel' ? [['cancelled','取消'],['unfinished','未完成']]
    : [['normal','正常完成'],['home_forfeit','主队弃权'],['away_forfeit','客队弃权'],['unfinished','未完成'],['cancelled','取消']],
    source.result_status || (operation==='cancel' ? 'cancelled' : match.result_status || 'normal'));
  const reason=textarea(source.reason || '',{placeholder:'填写更正或处置原因（必填）'});
  const resetAction=selectInput([['deactivate','停用并保留历史'],['reuse','核对后复用（保留原结果身份）']],source.action || 'deactivate');
  const parentId=numberInput(source.parent_match_id || match.reset_parent_id || '',{min:1,step:1});
  const parentVersion=numberInput(source.parent_base_version ?? '',{min:0,step:1});
  const actions=impact.affected.filter(m=>m.protected).map(m=>({...m,
    choice:selectInput([['','待决定（暂不能批准）'],['preserve','核对后保留'],['cancel','取消并保留历史'],
      ...(m.reset_state!=='none' ? [['deactivate','停用重置赛并保留历史']] : [])],''),
    reason:textInput('',{placeholder:'本场处置原因'}),ack:h('input',{type:'checkbox','aria-label':`场次${m.match_id}本机原包已核实留存`})}));
  const oldActions=draft?.payload?.impact_actions || parent?.context?.impact?.actions || [];
  actions.forEach(item=>{const old=oldActions.find(a=>a.match_id===item.match_id);if(old){item.choice.value=old.action;item.reason.value=old.reason;item.ack.checked=!!old.draft_acknowledged;}});
  const controls=[status,reason,resetAction,parentId,parentVersion,...sets.flatMap(s=>[s.home,s.away]),...actions.flatMap(a=>[a.choice,a.reason,a.ack])];
  if (draft?.payload) controls.forEach(c=>c.disabled=true);
  const operationLabel={correction:'更正',cancel:'取消或未完成',reset_review:'重置赛处置',resolve_dispute:'解决成绩争议'}[operation];
  const processImport=h('input',{type:'file',accept:'.json,application/json','aria-label':'导入替换逐分恢复副本'});
  let replacementEvents=null;
  processImport.onchange=async()=>{
    const file=processImport.files[0];if(!file)return;
    if(file.size>4*1024*1024){toast('恢复副本过大，请核对文件','error');return;}
    try {const parsed=JSON.parse(await file.text());const data=parsed.drafts?.[0] || parsed;
      if(!Array.isArray(data.events))throw new Error('副本中没有逐分过程');replacementEvents=data.events;toast('已载入替换过程，提交时由服务器重新回放校验','ok');}
    catch(e){replacementEvents=null;toast(e.message,'error');}
  };
  if(draft?.payload)processImport.disabled=true;
  return formDialog({title:`提交${operationLabel}待复核 · 场次 ${match.id}`,
    subtitle:`${match.home?.label || ''} vs ${match.away?.label || ''} · 正式基础版本 ${match.result_version}`,
    width:'min(820px,96vw)',sections:[
      {body:h('div',h('div.info-box','提交后保留最后正式结果；由非内容作者独立复核后生效。争议未解决前保护新任务推进。'),
        operation==='correction' ? h('div',h('h3','更正后的局分'),...sets.map(s=>h('div.form-grid',field(`第${s.no}局 · 主队`,s.home),field(`第${s.no}局 · 客队`,s.away))),
          h('details.mt',h('summary','需要替换逐分过程'),h('p.small','默认保留原过程，按汇总更正留痕。仅在有实际恢复副本时导入替换，不能自动生成过程。'),processImport)) : null,
        ['correction','cancel'].includes(operation) ? field('结果状态',status) : null,
        operation==='reset_review' ? h('div.form-grid',field('处置动作',resetAction),field('父决赛ID（原关系缺失时填写）',parentId),field('父决赛版本',parentVersion)) : null,
        field('原因',reason,{required:true}),
        actions.length ? h('div',h('h3','已领取或已有历史的下游'),h('div.warn-box','请核实原包和外部决定。未作决定可保存候选，但复核不能批准；不会远程删除本机稿。'),
          ...actions.map(a=>h('section.panel',h('b',`场次 ${a.match_id} · 正式版本 ${a.version}`),
            h('div.form-grid',field('处置',a.choice),field('原因',a.reason)),
            h('label.row',a.ack,'已核实本机原包并留存（取消或停用时必须）'))))
          : h('p.small','当前无已领取或已有历史的下游需逐场处置。'),
        draft?.payload ? h('div.warn-box','存在未核实请求，内容已冻结；下方仅重试原包原UID。') : null)},
    ],actions:[{label:draft?.payload ? '重试原候选请求' : '核对后提交待复核',primary:true,run:async({close})=>{
      if(!draft) {
        if(!reason.value.trim())throw new Error('请填写原因');
        const resultSets=sets.map(s=>({set_no:s.no,home_points:Number(s.home.value||0),away_points:Number(s.away.value||0)}))
          .filter(s=>s.home_points||s.away_points).map(s=>({...s,winner_side:winner(s.home_points,s.away_points,ruleForSet(rules,s.set_no))||''}));
        const payload={event_identity:context.identity,base_version:match.result_version,claim_epoch:match.claim_epoch??0,
          plan_version:match.plan_version,home_participation:match.home?.participation_id,away_participation:match.away?.participation_id,
          rules_hash:match.rules_hash,reason:reason.value.trim(),result_status:status.value,
          sets:resultSets,events:replacementEvents || [],events_mode:replacementEvents ? 'replace' : 'retain',
          retained_events_hash:await payloadHash(snapshot.events || [])};
        if(operation==='reset_review')Object.assign(payload,{action:resetAction.value,parent_match_id:Number(parentId.value)||null,parent_base_version:Number(parentVersion.value)});
        const uid=newUid(operation);
        const currentParent=parent || (await api.get(`/api/result-candidates?status=all&category_id=${match.category_id}`,{context})).candidates
          .find(c=>c.subject_kind==='match' && c.subject_id===match.id && c.base_version===match.result_version && ['returned','withdrawn'].includes(c.status));
        const packet={payload_schema:3,subject_kind:'match',subject_id:match.id,submission_uid:uid,operation,payload,
          impact_hash:impact.impact_hash,impact_actions:actions.filter(a=>a.choice.value).map(a=>({match_id:a.match_id,
            base_version:a.version,action:a.choice.value,reason:a.reason.value.trim(),draft_acknowledged:a.ack.checked})),
          ...(currentParent ? {parent_id:currentParent.id} : {})};
        draft={key,kind:operation,match_id:match.id,uid,payload:packet,event_identity:context.identity,
          request_context:context,base_version:match.result_version,status:'submitting'};
      }
      try {const res=await sendCandidate(draft);toast(res.message,'ok');close();await reload();}
      catch(e){if(e.request_released){draft=null;controls.forEach(c=>c.disabled=false);}else controls.forEach(c=>c.disabled=true);throw e;}
    }}]});
}
