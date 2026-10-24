"""Independent decisions; caller holds registry -> event transaction fence."""
import json
import uuid
from types import SimpleNamespace

from . import db, result_candidates as candidates, result_impacts, review_access, security
from .errors import ApiError, bad_request, conflict, forbidden


def decide(ctx,cid,*,withdraw=False,replay_only=False):
    row=candidates.candidate(ctx.conn,cid)
    if withdraw:
        user=review_access.current_user(ctx)
        if not candidates.can_read(ctx,row) or (user['id'] not in json.loads(row['authors_json']) and user['role'] not in ('admin','organizer')):
            raise forbidden()
    else:
        user=review_access.require_review(ctx,row)
    action='withdraw' if withdraw else ctx.body.get('action')
    if action not in ('approve','return','withdraw') or (not withdraw and action=='withdraw'):
        raise bad_request('复核动作无效')
    uid=candidates.require_uid(ctx.body,'decision_uid')
    ident=json.loads(row['context_json'])['identity']
    replay=candidates.replay(ctx,uid,ctx.body,action,row['subject_kind'],row['subject_id'],ident)
    if replay:return replay
    if replay_only:return None
    body=ctx.body
    if type(body.get('revision')) is not int or type(body.get('base_version')) is not int:
        raise bad_request('候选修订与正式基础版本必须为整数')
    if 'legacy_authorship_attested' in body and type(body['legacy_authorship_attested']) is not bool:
        raise bad_request('历史作者核对声明必须为明确的布尔值')
    # Reject score-editing fields instead of silently ignoring them in a decision.
    if set(body)-{'decision_uid','action','revision','candidate_hash','base_version','reason','legacy_authorship_attested'}:
        raise bad_request('复核只能确认或退回，不能编辑候选内容')
    if (body.get('revision'),body.get('candidate_hash'),body.get('base_version')) != (row['revision'],row['candidate_hash'],row['base_version']):
        raise conflict('候选修订或版本不一致',code='candidate_version_conflict')
    if row['status']!='submitted':raise conflict('该候选已处理',code='candidate_decided')
    reason=str(body.get('reason') or '').strip()
    if action in ('return','withdraw') and not reason:raise bad_request('请填写退回或撤回原因')
    context=json.loads(row['context_json']);payload=json.loads(row['payload_json'])
    if candidates.identity(ctx.conn,row['category_id'])!=ident:
        raise conflict('候选不属于当前赛事/部署',code='event_identity_mismatch')
    applied=None;materialized={}
    if action=='approve':
        if context.get('legacy_authorship_unknown') and body.get('legacy_authorship_attested') is not True:
            raise conflict('历史作者未知，需先核对并声明本人未参与该内容',code='legacy_authorship_unverified')
        if row['subject_kind']=='individual' and payload.get('result_status')=='pending':
            raise ApiError(422,'nonfinal_result','结果尚待补全，不能正式确认')
        candidates.validate(ctx,row['subject_kind'],row['subject_id'],row['operation'],payload,accepting=False)
        result_impacts.verify_and_apply(ctx,row,context.get('impact',{}))
        before=candidates.official_snapshot(ctx.conn,row['subject_kind'],row['subject_id'])
        candidates.save_official_history(ctx.conn,row['subject_kind'],row['subject_id'],before,
            candidates.legacy_authors(ctx.conn,row['subject_kind'],row['subject_id']),legacy=True)
        result_impacts.apply_actions(ctx,context.get('impact',{}))
        materialized=materialize(ctx,row,payload)
        result_impacts.finish(ctx,row,context.get('impact',{}))
        after=candidates.official_snapshot(ctx.conn,row['subject_kind'],row['subject_id']);applied=after['version']
        candidates.save_official_history(ctx.conn,row['subject_kind'],row['subject_id'],after,
            json.loads(row['authors_json']),row['id'],user['id'],uid)
        for item in context.get('impact',{}).get('actions',[]):
            if item['action']!='preserve':
                snapshot=candidates.official_snapshot(ctx.conn,'match',item['match_id'])
                candidates.save_official_history(ctx.conn,'match',item['match_id'],snapshot,json.loads(row['authors_json']),row['id'],user['id'],uid)
    state={'approve':'approved','return':'returned','withdraw':'withdrawn'}[action]
    # Expiration is checked again after potentially expensive derived calculations.
    if withdraw:review_access.current_user(ctx)
    else:review_access.require_review(ctx,row)
    cursor=ctx.conn.execute("UPDATE candidate_heads SET status=?,updated_at=? WHERE candidate_id=? AND status='submitted'",(state,db.now(ctx.conn),cid))
    if cursor.rowcount!=1:raise conflict('其他人员已处理候选',code='candidate_decided')
    rid=uuid.uuid4().hex
    db.insert(ctx.conn,'review_decisions',{'id':rid,'candidate_id':cid,'action':action,'reason':reason,
        'actor_id':user['id'],'uid':uid,'candidate_hash':row['candidate_hash'],'base_version':row['base_version'],
        'applied_version':applied,'created_at':db.now(ctx.conn)})
    receipt={'receipt_kind':'review_decision','uid':uid,'candidate_id':cid,'revision':row['revision'],
        'candidate_hash':row['candidate_hash'],'action':action,'status':state,'identity':ident,
        'subject_kind':row['subject_kind'],'subject_id':row['subject_id'],'payload_hash':candidates.validation.payload_hash(body)}
    if applied is not None:receipt['applied_version']=applied
    result={'status':state,'message':{'approve':'正式已确认','return':'已退回，原包保留','withdraw':'已撤回，原包保留'}[action], 'receipt':receipt}
    if action=='approve':
        result['effects']=materialized
    candidates.store_receipt(ctx,uid,body,action,row['subject_kind'],row['subject_id'],ident,result)
    security.audit(ctx.conn,user,'review_'+action,row['subject_kind'],row['subject_id'],
        {'candidate_id':cid,'revision':row['revision'],'candidate_hash':row['candidate_hash'],
         'base_version':row['base_version'],'applied_version':applied,'reason':reason,'legacy_authorship_attested':bool(body.get('legacy_authorship_attested'))})
    return result


def materialize(ctx,row,payload):
    """Use extracted, undecorated scoring services, never invoke an HTTP handler."""
    from .api import scoring
    body=dict(payload)
    body['submission_uid']='formal.'+row['id']
    if row['subject_kind']=='match':body['match_id']=row['subject_id']
    else:body['participation_id']=row['subject_id']
    author=db.q1(db.get_conn(),'SELECT * FROM users WHERE id=?',(row['created_by'],))
    # Historic author attribution is separate from the current authenticated reviewer.
    internal=SimpleNamespace(conn=ctx.conn,user=dict(author),body=body,params={'match_id':str(row['subject_id'])},
        headers={},path='/internal/official-result',method='POST',_review_materialization=True)
    op=row['operation']
    if op=='resolve_dispute':return {}
    if row['subject_kind']=='individual':return scoring._submit_individual(internal)
    if op=='initial':return scoring._commit_team_submission(internal)
    if op=='correction':
        if body.get('events_mode')=='retain':body['events']=[]
        return scoring._correct_match(internal)
    if op=='cancel':return scoring._cancel_match(internal)
    if op=='reset_review':return scoring._review_reset_match(internal)
    raise bad_request('正式写入操作无效')
