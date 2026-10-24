/* Explicit isolated fixtures: real reception + a different authorized reviewer.
   This module is test-only; browser UI submissions are never auto-approved. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const reviewers=new Map(),packets=new Map();
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

async function send(context,method,path,body,token=context.token,expected=200) {
  const identity=context.identity;
  const response=await fetch(context.base+path,{method,headers:{'Content-Type':'application/json','X-Client-Protocol':'3',
    ...(token?{Authorization:`Bearer ${token}`} : {}),...(identity?{'X-Event-ID':String(identity.event_id),'X-Event-UUID':identity.event_uuid}: {})},
    body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(expected!==null)assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

export async function prepareReviewedFixture(context) {
  assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(context.base),'Fixtures require a loopback server');
  const key=context.base+':'+context.identity.event_uuid;
  if(reviewers.has(key))return reviewers.get(key);
  const issuer=context.issuerToken||context.token,username='fixture-review-'+randomUUID();
  const created=await send(context,'POST','/api/users',{username,display_name:'独立测试复核人',role:'organizer',
    password:'FixtureReview123',event_ids:[context.identity.event_id]},issuer);
  const login=await send(context,'POST','/api/login',{username,password:'FixtureReview123'},'');
  await send(context,'POST',`/api/events/${context.identity.event_id}/review-grants`,{
    user_id:created.user_id,active:true,base_version:0,reason:'隔离浏览器业务回归夹具'},issuer);
  const fixture={issuer,reviewer:login.token,user_id:created.user_id};reviewers.set(key,fixture);return fixture;
}

export async function candidatePacket(context,path,body) {
  const fixture=await prepareReviewedFixture(context),source=structuredClone(body||{});
  const ident={event_id:context.identity.event_id,event_uuid:context.identity.event_uuid,
    deployment_id:context.identity.deployment_id||(await send(context,'GET','/api/events')).deployment_id};
  const match=path.match(/^\/api\/matches\/(\d+)\/(correction|cancel|reset-review)$/);
  const kind=path.endsWith('/individual')?'individual':'match',sid=Number(match?.[1]||(kind==='match'?source.match_id:source.participation_id));
  let current,category;
  if(kind==='match') {
    current=(await send(context,'GET',`/api/matches/${sid}`,undefined,fixture.issuer)).match;category=current.category_id;
  }else {
    const structure=await send(context,'GET',`/api/events/${ident.event_id}/structure`,undefined,fixture.issuer);
    for(const cat of structure.groups.flatMap(g=>g.categories).filter(c=>c.kind==='individual')) {
      const data=await send(context,'GET',`/api/categories/${cat.id}/participations`,undefined,fixture.issuer);
      const found=data.participations.find(p=>p.id===sid);if(!found)continue;
      category=cat.id;const results=(await send(context,'GET',`/api/categories/${cat.id}/individual-results`,undefined,fixture.issuer)).results;
      current={...found,result_version:results.find(r=>r.participation_id===sid)?.version||0};break;
    }
  }
  assert.ok(current,'Fixture subject exists');
  const actor=(await send(context,'GET','/api/me')).user.id;
  const uid=source.submission_uid||source.request_uid||randomUUID(),key=context.base+':'+actor+':'+uid;
  const old=packets.get(key),payload=structuredClone(source);
  for(const name of ['submission_uid','request_uid','match_id','participation_id'])delete payload[name];
  const frozen=source.event_identity||ident;payload.event_identity=Object.fromEntries(Object.keys(ident).map(k=>[k,frozen[k]]));
  payload.claim_epoch??=old?.payload.claim_epoch??current.claim_epoch??0;
  let operation=match?match[2].replace('-','_'):source.base_version>0?'correction':'initial';
  if(match) {
    payload.base_version??=current.result_version;payload.plan_version??=current.plan_version;
    payload.home_participation??=current.home.participation_id;payload.away_participation??=current.away.participation_id;
    payload.rules_hash??=current.rules_hash;
    if(operation==='cancel')payload.result_status??='cancelled';
  }
  const packet={payload_schema:3,subject_kind:kind,subject_id:sid,submission_uid:uid,operation,payload};
  if(operation!=='initial') {
    const impact=await send(context,'GET',`/api/result-candidates/impact?subject_kind=${kind}&subject_id=${sid}`,undefined,fixture.issuer);
    packet.impact_hash=old?.impact_hash||impact.impact_hash;packet.impact_actions=[];
    if(kind==='match'&&operation==='correction'&&!payload.events?.length) {
      payload.events_mode='retain';
      const detail=await send(context,'GET',`/api/result-history/match/${sid}`,undefined,fixture.issuer);
      const snapshot=detail.versions.find(v=>v.version===current.result_version);
      payload.retained_events_hash=old?.payload.retained_events_hash||hash(snapshot?JSON.parse(snapshot.snapshot_json).events:[]);
    }
  }
  return {packet,key,fixture,actor};
}

export async function approveCandidate(context,idOrResult) {
  const fixture=await prepareReviewedFixture(context),id=typeof idOrResult==='string'?idOrResult:idOrResult.candidate_id;
  const detail=(await send(context,'GET','/api/result-candidates/'+id,undefined,fixture.issuer)).candidate;
  if(detail.status==='approved')return {...await send(context,'GET','/api/review-receipts/'+detail.decision.uid,undefined,fixture.reviewer),duplicate:true,replayed:true};
  assert.notEqual(detail.created_by,fixture.user_id,'Reviewer must be a different account');
  return send(context,'POST',`/api/result-candidates/${id}/decision`,{decision_uid:randomUUID(),action:'approve',
    revision:detail.revision,candidate_hash:detail.candidate_hash,base_version:detail.base_version,
    legacy_authorship_attested:true},fixture.reviewer);
}

export async function reviewedResult(context,method,path,body,expected=200) {
  assert.equal(method,'POST');
  const {packet,key}=await candidatePacket(context,path,body);
  const received=await send(context,'POST','/api/result-candidates',packet,context.token,expected);
  if(expected!==200)return received;
  packets.set(key,structuredClone(packet));
  if(packet.payload.result_status==='pending')return received;
  const result=await approveCandidate(context,received);
  return {...result.effects,receipt:result.receipt,candidate_receipt:received.receipt,
    candidate_id:received.candidate_id,duplicate:!!result.duplicate,replayed:!!result.replayed};
}

export async function liveFixture(base,options) {
  const headers={...options.headers,'X-Client-Protocol':'3'},payload=JSON.parse(options.body);
  const matchResponse=await fetch(base+`/api/matches/${payload.match_id}`,{headers});const detail=await matchResponse.json();assert.equal(matchResponse.status,200,JSON.stringify(detail));
  const current=detail.match;
  const start=await fetch(base+'/api/display/live/start',{method:'POST',headers,body:JSON.stringify({match_id:payload.match_id,
    draft_uid:payload.draft_uid,claim_epoch:current.claim_epoch,expected_stream_epoch:current.live_stream_epoch})});
  const stream=await start.json();assert.equal(start.status,200,JSON.stringify(stream));
  const response=await fetch(base+'/api/display/live',{method:'POST',headers,body:JSON.stringify({...payload,claim_epoch:current.claim_epoch,stream_epoch:stream.stream_epoch})});
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
}
