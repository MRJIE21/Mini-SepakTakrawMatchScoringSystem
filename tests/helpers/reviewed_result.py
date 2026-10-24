"""Explicit test fixture: real candidate HTTP, distinct reviewer, real decision.

Old business-vector tests call this by name to prepare reviewed results. Retired
HTTP endpoints remain closed and are tested directly in independent_review.
There is no application fallback or automatic production reviewer.
"""
import copy
import json
import re
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from app import config,db,security,result_candidates,result_impacts,team_rules_store
from app.domain import validation

_lock=threading.RLock()


def reviewed_result(test,method,path,body=None,token=None,expected=200,code=None,**kwargs):
    if method!='POST':raise AssertionError('Reviewed fixture only supports result POST')
    if config.DB_PATH.resolve().is_relative_to((Path(__file__).resolve().parents[2]/'data').resolve()):
        raise RuntimeError('Reviewed fixture cannot touch product data')
    headers=getattr(test,'event_headers',None) or getattr(test,'headers',{})
    database=db.event_db_path(int(headers['X-Event-ID'])) if headers.get('X-Event-ID') else config.DB_PATH
    base=getattr(test,'base',None) or f'http://127.0.0.1:{test.port}'
    current_token=test.token if token is None else token

    def request(verb,url,data=None,as_token=current_token,expect=200):
        req=urllib.request.Request(base+url,method=verb,data=json.dumps(data).encode() if data is not None else None,
            headers={**headers,'Content-Type':'application/json','X-Client-Protocol':'3','Authorization':'Bearer '+as_token})
        try:
            with urllib.request.urlopen(req,timeout=20) as response:
                status=response.status;result=json.loads(response.read())
        except urllib.error.HTTPError as exc:
            try:status=exc.code;result=json.loads(exc.read())
            finally:exc.close()
        if expect is not None:test.assertEqual(status,expect,(url,result))
        return result

    old=copy.deepcopy(body or {})
    match=re.fullmatch(r'/api/matches/(\d+)/(correction|cancel|reset-review)',path)
    kind='individual' if path.endswith('/individual') else 'match'
    sid=int(match[1]) if match else int(old.get('participation_id') if kind=='individual' else old.get('match_id') or 0)
    if not match and path not in ('/api/scoring/submit','/api/scoring/individual'):
        raise AssertionError('Unknown reviewed fixture endpoint: '+path)
    operation=match[2].replace('-','_') if match else ('correction' if old.get('base_version',0)>0 else 'initial')
    conn=db.connect(database)
    try:
        subject=result_candidates.subject(conn,kind,sid)
        ident=result_candidates.identity(conn,subject['category_id'])
        actor=request('GET','/api/me')['user']['id']
        uid=old.get('submission_uid') or old.get('request_uid')
        if not uid and expected==200:uid='fixture.'+uuid.uuid4().hex
        key=(str(database),actor,uid)
        cache=getattr(test,'_review_fixture_packets',{})
        metadata=cache.get(key)
        payload=copy.deepcopy(old)
        payload.pop('submission_uid',None);payload.pop('request_uid',None);payload.pop('match_id',None);payload.pop('participation_id',None)
        frozen=payload.get('event_identity') or ident
        payload['event_identity']={k:frozen.get(k) for k in ident}
        payload.setdefault('claim_epoch',result_candidates.epoch_info(conn,kind,sid)['epoch'])
        if match:
            payload.setdefault('rules_hash',team_rules_store.match_rules(conn,subject)['rules_hash'])
            payload.setdefault('base_version',subject['result_version'])
            payload.setdefault('plan_version',subject['plan_version'])
            payload.setdefault('home_participation',subject['home_actual'])
            payload.setdefault('away_participation',subject['away_actual'])
            if match[2]=='cancel':payload.setdefault('result_status','cancelled')
        if operation=='correction' and kind=='match':
            if not match:payload.setdefault('reason','历史计分向量独立复核')
            if not payload.get('events'):
                payload['events_mode']='retain'
                payload['retained_events_hash']=validation.payload_hash(result_candidates.official_snapshot(conn,kind,sid)['events'])
        packet={'payload_schema':3,'subject_kind':kind,'subject_id':sid,'operation':operation,'submission_uid':uid,'payload':payload}
        if operation!='initial':
            packet['impact_hash']=result_impacts.preview(conn,kind,sid)['impact_hash']
            packet['impact_actions']=[]
        if metadata:
            # Keep the originally frozen context on retry; business content stays
            # supplied by the caller so altered original UIDs still conflict.
            for name in ('claim_epoch','event_identity','retained_events_hash'):
                if name not in old and name in metadata['payload']:payload[name]=metadata['payload'][name]
            if 'impact_hash' in metadata:packet['impact_hash']=metadata['impact_hash']
        cache.setdefault(key,copy.deepcopy(packet));test._review_fixture_packets=cache
    finally:conn.close()
    received=request('POST','/api/result-candidates',packet,expect=expected)
    if expected!=200:
        if code:test.assertEqual(received.get('code'),code,received)
        return received
    candidate_id=received['candidate_id'];detail=request('GET','/api/result-candidates/'+candidate_id)['candidate']
    if detail['status']=='approved':
        result=request('GET','/api/review-receipts/'+detail['decision']['uid'],as_token=test._review_fixture_users['reviewer'])
        return {**result.get('effects',{}),'receipt':result['receipt'],'candidate_receipt':received['receipt'],'duplicate':True,'replayed':True}
    # Pending is deliberately not converted into a formal row by the fixture.
    if payload.get('result_status')=='pending':return received
    with _lock:
        fixture=getattr(test,'_review_fixture_users',None)
        if not fixture or fixture['database']!=str(config.DB_PATH):
            registry=db.connect()
            try:
                suffix=uuid.uuid4().hex
                issuer=security.create_user(registry,'fixture-issuer-'+suffix,'FixturePass123','admin','测试授权人')
                reviewer=security.create_user(registry,'fixture-reviewer-'+suffix,'FixturePass123','admin','独立测试复核人')
                fixture={'database':str(config.DB_PATH),'reviewer_id':reviewer,
                         'issuer':security.issue_token(registry,issuer),'reviewer':security.issue_token(registry,reviewer)}
                test._review_fixture_users=fixture
            finally:registry.close()
        grants=request('GET',f"/api/events/{ident['event_id']}/review-grants",as_token=fixture['issuer'])['grants']
        grant=next((g for g in grants if g['user_id']==fixture['reviewer_id'] and g['scope_kind']=='event'),None)
        if not grant or not grant['active']:
            request('POST',f"/api/events/{ident['event_id']}/review-grants",{'user_id':fixture['reviewer_id'],'active':True,
                'base_version':grant['version'] if grant else 0,'reason':'隔离回归夹具的独立复核'},as_token=fixture['issuer'])
    receipt=received['receipt']
    result=request('POST',f'/api/result-candidates/{candidate_id}/decision',{
        'decision_uid':'fixture.decision.'+uuid.uuid4().hex,'action':'approve','revision':receipt['revision'],
        'candidate_hash':receipt['candidate_hash'],'base_version':packet['payload']['base_version'],
        'legacy_authorship_attested':True},as_token=fixture['reviewer'])
    test.assertNotEqual(detail['created_by'],fixture['reviewer_id'])
    return {**result.get('effects',{}),'receipt':result['receipt'],'candidate_receipt':received['receipt'],'duplicate':False,'replayed':False}
