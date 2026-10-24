/* Persistence and exact-receipt recovery shared by review and correction views. */
import { api,newUid,captureRequestContext,recordRequestContext,validateCandidateReceipt,validateReviewReceipt } from './api.js';
import { localStore } from './store.js';

export const reviewKey=(identity,id)=>`${identity?.deployment_id}:${identity?.event_uuid}:review-decision:${id}`;

export async function sendCandidate(draft) {
  const packet=draft.payload;
  if (packet?.payload_schema!==3) throw new Error('此为旧协议原包，请到“待核实提交”页核实，不能自动换包');
  draft.request_context ||= recordRequestContext(draft);
  const unknown=!!draft.submission_unknown;
  if (!(draft.generation ? await localStore.put(draft) : await localStore.begin(draft))) throw new Error('原请求未能安全保存在本机，未发送');
  try {
    let response;
    if (unknown) {
      const found=await api.get(`/api/candidate-receipts/${encodeURIComponent(draft.uid)}`,{context:draft.request_context});
      if (found.found) { await validateCandidateReceipt(found,packet);response=found; }
    }
    response ||= await api.post('/api/result-candidates',packet,{context:draft.request_context,validate:r=>validateCandidateReceipt(r,packet)});
    if (!await localStore.markReceived(draft,response.receipt)) throw Object.assign(new Error('服务器已接收，本机回执保存失败；请核实原请求'),{outcome_unknown:true});
    return response;
  } catch(error) {
    draft.status='failed';draft.submission_unknown=unknown||!!error.outcome_unknown||[404,426].includes(error.status);
    if (!draft.submission_unknown && error.not_committed && error.status>=400 && error.status<500
        && ![404,426].includes(error.status)) {
      if(await localStore.remove(draft.key,draft))error.request_released=true;
      throw error;
    }
    await localStore.put(draft);
    throw error;
  }
}

export async function performDecision(candidate,action,reason,attested=false) {
  const context=captureRequestContext(),key=reviewKey(context.identity,candidate.id);
  let draft=await localStore.get(key);
  if (!draft) {
    const uid=newUid('decision');
    draft={key,kind:'review_decision',uid,base_version:candidate.base_version,event_identity:context.identity,
      request_context:context,status:'submitting',payload:{decision_uid:uid,action,
        revision:candidate.revision,candidate_hash:candidate.candidate_hash,base_version:candidate.base_version,
        reason:reason||'',legacy_authorship_attested:!!attested}};
    if (!await localStore.begin(draft)) throw new Error('原决定未能安全保存在本机，未发送');
  }
  const packet=draft.payload;
  const unknown=!!draft.submission_unknown;
  draft.request_context=recordRequestContext(draft);
  try {
    let response;
    const found=await api.get(`/api/review-receipts/${encodeURIComponent(packet.decision_uid)}`,{context:draft.request_context});
    if (found.found) { await validateReviewReceipt(found,packet,candidate);response=found; }
    const endpoint=packet.action==='withdraw' ? 'withdraw' : 'decision';
    response ||= await api.post(`/api/result-candidates/${candidate.id}/${endpoint}`,packet,
      {context:draft.request_context,validate:r=>validateReviewReceipt(r,packet,candidate)});
    if (!await localStore.finishReview(draft,response.receipt)) throw Object.assign(new Error('复核回执未保存，请用原决定核实'),{outcome_unknown:true});
    return response;
  } catch(error) {
    draft.status='failed';draft.submission_unknown=unknown||!!error.outcome_unknown||[404,426].includes(error.status);
    if (!draft.submission_unknown && error.not_committed && error.status>=400 && error.status<500) {
      await localStore.remove(key,draft);
    } else await localStore.put(draft);
    throw error;
  }
}

export async function pendingDecision(candidate) {
  return localStore.get(reviewKey(captureRequestContext().identity,candidate.id));
}
