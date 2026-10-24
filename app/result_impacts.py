"""Version-bound impact plans and persistent dispute protection."""
import json
import re
import uuid

from . import access, db, security
from .domain import validation
from .errors import bad_request, conflict


def preview(conn, kind, sid):
    from .result_candidates import subject, official_snapshot, epoch_info, legacy_authors
    root=subject(conn,kind,sid)
    rows=db.q(conn,'SELECT * FROM matches WHERE category_id=? ORDER BY id',(root['category_id'],)) if kind=='match' else []
    reached={sid} if kind=='match' else set()
    pools={root['pool_id']} - {None} if kind=='match' else set()
    changed=True
    while changed:
        changed=False
        for row in rows:
            if row['id'] in reached:continue
            dependent=row['reset_parent_id'] in reached or any(
                row[f'{side}_source_match'] in reached or row[f'{side}_source_pool'] in pools for side in ('home','away'))
            if dependent:
                reached.add(row['id']);changed=True
                if row['pool_id']:pools.add(row['pool_id'])
    affected=[]; authors=set(legacy_authors(conn,kind,sid))
    for row in rows:
        if row['id'] not in reached or row['id']==sid:continue
        claim=epoch_info(conn,'match',row['id'])
        head=db.q1(conn,"SELECT candidate_id FROM candidate_heads WHERE subject_kind='match' AND subject_id=? AND status='submitted'",(row['id'],))
        history=bool(row['result_version'] or db.q1(conn,'SELECT 1 FROM score_events WHERE match_id=?',(row['id'],)))
        item={'match_id':row['id'],'version':row['result_version'],'lineup':[row['home_actual'],row['away_actual']],
              'status':row['status'],'reset_state':row['reset_state'],'claim_epoch':claim['epoch'],
              'protected':bool(claim['epoch'] or history or head),'candidate_id':head['candidate_id'] if head else None}
        affected.append(item)
        authors.update(claim['authors']);authors.update(legacy_authors(conn,'match',row['id']))
        for c in db.q(conn,"SELECT authors_json FROM result_candidates WHERE subject_kind='match' AND subject_id=?",(row['id'],)):
            authors.update(json.loads(c['authors_json']))
    vector={'root':official_snapshot(conn,kind,sid),'claim':epoch_info(conn,kind,sid),'affected':affected,
            'placements':[dict(r) for r in db.q(conn,'SELECT * FROM placements WHERE category_id=? ORDER BY id',(root['category_id'],))],
            'pools':[dict(r) for r in db.q(conn,'SELECT * FROM pools WHERE id IN (SELECT pool_id FROM matches WHERE category_id=?) ORDER BY id',(root['category_id'],))]}
    if kind=='match':
        # Freezing an unchanged effective rule at reception must not invalidate
        # the preview itself. Bind its semantic rule identity instead.
        from . import team_rules_store
        rules=team_rules_store.match_rules(conn,root)
        for key in ('rules_snapshot_json','rules_revision','rules_hash'):
            vector['root']['match'].pop(key,None)
        vector['rules']={'rules':rules['rules'],'hash':rules['rules_hash'],'revision':rules['rules_revision']}
    if kind=='individual':
        vector['results']=[dict(r) for r in db.q(conn,'SELECT * FROM individual_results WHERE category_id=? ORDER BY id',(root['category_id'],))]
    if kind=='match' and root['plan_id']:
        vector['plan']=dict(db.q1(conn,'SELECT * FROM plans WHERE id=?',(root['plan_id'],)))
    return {'impact_hash':validation.payload_hash(vector),'affected':affected,'authors':sorted(authors),'vector':vector}


def prepare(ctx,kind,sid,operation,body):
    if operation=='initial':
        guard_subject(ctx.conn,kind,sid)
        return {}
    impact=preview(ctx.conn,kind,sid)
    if body.get('impact_hash')!=impact['impact_hash']:
        raise conflict('请先核对当前更正影响',code='impact_conflict',detail={'impact_hash':impact['impact_hash'],'affected':impact['affected']})
    actions=body.get('impact_actions',[])
    if not isinstance(actions,list):raise bad_request('影响处置必须为列表')
    ids=set(); normalized=[]
    protected={r['match_id']:r for r in impact['affected'] if r['protected']}
    for action in actions:
        if (not isinstance(action,dict) or type(action.get('match_id')) is not int or action['match_id'] in ids
                or action.get('action') not in ('preserve','cancel','deactivate') or not str(action.get('reason') or '').strip()):
            raise bad_request('请逐场填写保留/取消/停用处置及原因')
        mid=action['match_id'];ids.add(mid)
        if mid not in protected or type(action.get('base_version')) is not int or action['base_version']!=protected[mid]['version']:
            raise conflict('下游处置与当前版本不一致',code='impact_conflict')
        if protected[mid]['candidate_id']:
            raise conflict('下游尚有未决候选，请先核实原包或退回撤回',code='downstream_candidate_pending')
        if action['action'] in ('cancel','deactivate') and action.get('draft_acknowledged') is not True:
            raise conflict('请先核实本机原包并确认已留存，不会清除远端记录',code='draft_acknowledgment_required')
        normalized.append(action)
    # Missing dispositions may be saved for discussion, but never approved.
    impact['actions']=normalized
    impact['unresolved']=sorted(set(protected)-ids)
    return impact


def open_dispute(ctx,cid,kind,sid,category_id,operation,impact,payload):
    if operation=='initial':return
    existing=db.q1(ctx.conn,"SELECT id FROM result_disputes WHERE subject_kind=? AND subject_id=? AND status='open'",(kind,sid))
    if existing:return
    db.insert(ctx.conn,'result_disputes',{'id':uuid.uuid4().hex,'category_id':category_id,
        'subject_kind':kind,'subject_id':sid,'candidate_id':cid,'affected_json':json.dumps(impact.get('affected',[])),
        'reason':payload['reason'],'status':'open','updated_at':db.now(ctx.conn)})


def guard_category(conn, category_id):
    if db.q1(conn,"SELECT 1 FROM result_disputes WHERE category_id=? AND status='open'",(category_id,)):
        raise conflict('本项目存在未解决的正式成绩争议，请先核对处置；最后正式结果仍保留',code='result_disputed')


def guard_subject(conn,kind,sid):
    from .result_candidates import subject
    guard_category(conn,subject(conn,kind,sid)['category_id'])


def guard_request(ctx):
    """Protect dependency mutations as well as the UI; review services check their own plans."""
    path=ctx.path
    if path.startswith('/api/result-') or '/review-grants' in path:return
    cat=None
    m=re.fullmatch(r'/api/recording/(match|individual)/(\d+)/(claim|transfer)',path)
    if m:
        guard_subject(ctx.conn,m[1],int(m[2]));return
    m=re.match(r'/api/(matches|plans|pools)/(\d+)',path)
    if m:
        table=m[1];row=db.q1(ctx.conn,f'SELECT * FROM {table} WHERE id=?',(int(m[2]),))
        if row:
            if table=='pools':
                r=db.q1(ctx.conn,'SELECT p.category_id FROM stages s JOIN plans p ON p.id=s.plan_id WHERE s.id=?',(row['stage_id'],))
                cat=r['category_id'] if r else None
            else:cat=row['category_id']
    m=re.match(r'/api/categories/(\d+)/(schedule|plan|stages|matches|placements|individual-rankings|individual-draw|auto-schedule)',path)
    if m:cat=int(m[1])
    m=re.match(r'/api/(?:schedule-stages|stages)/(\d+)',path)
    if m:
        row=db.q1(ctx.conn,'SELECT p.category_id FROM stages s JOIN plans p ON p.id=s.plan_id WHERE s.id=?',(int(m[1]),))
        if row:cat=row['category_id']
    if cat:guard_category(ctx.conn,cat)


def verify_and_apply(ctx,row,impact):
    if not impact:return
    current=preview(ctx.conn,row['subject_kind'],row['subject_id'])
    if current['impact_hash']!=impact['impact_hash']:
        raise conflict('影响依据已变化，请退回形成新修订',code='impact_conflict')
    if impact.get('unresolved'):
        raise conflict('已领取或已有历史的下游尚未显式处置',code='impact_unresolved',detail={'match_ids':impact['unresolved']})
    # Preserve actions are checked against projected lineups after materialization by finish().


def apply_actions(ctx,impact):
    from .result_candidates import official_snapshot, save_official_history, legacy_authors
    for action in impact.get('actions',[]):
        if action['action']=='preserve':continue
        mid=action['match_id'];before=official_snapshot(ctx.conn,'match',mid)
        save_official_history(ctx.conn,'match',mid,before,legacy_authors(ctx.conn,'match',mid),legacy=True)
        # Preserve all old rows/events; only add an explicit stopped/invalid current version.
        updates={'status':'finished','result_status':'cancelled','result_version':before['version']+1,
                 'note':action['reason'],'updated_at':db.now(ctx.conn)}
        old=db.q1(ctx.conn,'SELECT reset_state FROM matches WHERE id=?',(mid,))
        if action['action']=='deactivate':
            if old['reset_state']=='none':raise bad_request('仅重置赛可以停用，请选择取消')
            updates['reset_state']='inactive'
        db.update(ctx.conn,'matches',mid,updates)
        security.audit(ctx.conn,ctx.user,'review_impact_action','match',mid,action)


def finish(ctx,row,impact):
    from .domain import advancement
    for action in impact.get('actions',[]):
        if action['action']!='preserve':continue
        match=db.q1(ctx.conn,'SELECT * FROM matches WHERE id=?',(action['match_id'],))
        resolved=(advancement.resolve_slot(ctx.conn,match,'home')[0],advancement.resolve_slot(ctx.conn,match,'away')[0])
        if resolved!=(match['home_actual'],match['away_actual']):
            raise conflict('保留场次的对阵依据已不一致，不能沿用旧比分',code='impact_preserve_invalid')
    ctx.conn.execute("UPDATE result_disputes SET status='resolved',updated_at=? WHERE subject_kind=? AND subject_id=? AND status='open'",
        (db.now(ctx.conn),row['subject_kind'],row['subject_id']))
