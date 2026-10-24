"""Thin HTTP adapters for immutable result candidates and independent review."""
import json
from .. import access, db, result_candidates as candidates, result_impacts, result_review, review_access, security
from ..errors import ApiError, bad_request, forbidden
from ..http_server import route
from ..read_projection import text_integer_rows

REC=('admin','organizer','recorder')
ORG=('admin','organizer')


def protocol(ctx):
    if ctx.headers.get('X-Client-Protocol')!='3':
        raise ApiError(426,'client_upgrade_required','请保留原件并升级到独立复核版本')
    if not ctx.headers.get('X-Event-ID') or not ctx.headers.get('X-Event-UUID') or ctx.conn is db.get_conn():
        raise bad_request('请明确选择当前赛事后核实原请求，复核写入不能使用默认登记库',code='event_context_required')


@route('GET',r'/api/result-capabilities',roles=None)
def capabilities(ctx):
    user=review_access.current_user(ctx)
    grants=db.rows_to_dicts(db.q(ctx.conn,'SELECT * FROM review_grants WHERE user_id=? AND active=1',(user['id'],)))
    return {'protocol':3,'payload_schema':3,'independent_review':True,'grants':grants if user['role'] in ORG else [],
            'can_record':user['role'] in REC,'can_grant':user['role']=='admin'}


@route('POST',r'/api/result-candidates',roles=REC)
def receive(ctx):
    protocol(ctx)
    return candidates.receive(ctx)


@route('GET',r'/api/result-candidates',roles=REC)
def queue(ctx):
    user=review_access.current_user(ctx)
    status=ctx.query.get('status',['submitted'])[0]
    category=ctx.query.get('category_id',[''])[0]
    if status not in ('submitted','approved','returned','withdrawn','all'):raise bad_request('筛选状态无效')
    try:
        limit=int(ctx.arg('limit','100'));cursor=int(ctx.arg('cursor','0'))
    except (ValueError,TypeError):raise bad_request('分页参数无效') from None
    if not 1<=limit<=200 or cursor<0:raise bad_request('分页范围无效')
    query=str(ctx.arg('q','')).strip()
    if len(query)>100:raise bad_request('查询文字过长')
    params=[];where=[]
    if status!='all':where.append('h.status=?');params.append(status)
    if category:
        try:category=int(category)
        except (ValueError,TypeError):raise bad_request('项目无效') from None
        where.append('c.category_id=?');params.append(category)
    scopes=access.event_ids(db.get_conn(),user)
    if scopes is not None:
        where.append('g.event_id IN ('+','.join('?' for _ in scopes)+')' if scopes else '0')
        params.extend(scopes)
    if user['role']=='recorder':
        where.append('EXISTS(SELECT 1 FROM json_each(c.authors_json) a WHERE a.value=?)');params.append(user['id'])
    author_name="COALESCE(json_extract(c.context_json,'$.author_name'),u.display_name,'UNKNOWN')"
    if query:
        pattern='%'+query.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
        where.append(f"(CAST(c.subject_id AS TEXT) LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\' OR {author_name} LIKE ? ESCAPE '\\')")
        params.extend([pattern]*3)
    source=''' FROM result_candidates c JOIN candidate_heads h ON h.candidate_id=c.id
        JOIN categories cat ON cat.id=c.category_id JOIN groups g ON g.id=cat.group_id
        LEFT JOIN users u ON u.id=c.created_by WHERE '''+(' AND '.join(where) if where else '1')
    total=db.q1(ctx.conn,'SELECT COUNT(*) AS n'+source,params)['n']
    selected=text_integer_rows(ctx.conn,f'''SELECT c.id,c.category_id,c.subject_kind,c.subject_id,c.operation,c.revision,
        c.created_by,c.created_at,c.candidate_hash,c.base_version,c.authors_json,c.rowid AS queue_cursor,
        g.event_id,h.status,{author_name} AS author_name,
        COALESCE(json_extract(c.payload_json,'$.result_status'),'normal') AS result_status'''+source+
        (' AND c.rowid<?' if cursor else '')+' ORDER BY c.rowid DESC LIMIT ?',
        ('id','category_id','subject_kind','subject_id','operation','revision','created_by','created_at',
         'candidate_hash','base_version','authors_json','queue_cursor','event_id','status','author_name','result_status'),
        params+([cursor] if cursor else [])+[limit+1])
    more=len(selected)>limit;selected=selected[:limit]
    grants={(r['event_id'],r['scope_kind'],r['scope_id']) for r in db.q(ctx.conn,
        'SELECT event_id,scope_kind,scope_id FROM review_grants WHERE user_id=? AND active=1',(user['id'],))}
    recusals={r['candidate_id'] for r in db.q(ctx.conn,'SELECT candidate_id FROM review_recusals WHERE user_id=?',(user['id'],))}
    rows=[]
    for row in selected:
        item={k:row[k] for k in ('id','category_id','subject_kind','subject_id','operation','revision','status','created_by','created_at','candidate_hash','base_version','author_name','result_status')}
        eid=row['event_id']
        item['can_review']=user['role'] in ORG and user['id'] not in json.loads(row['authors_json']) and row['id'] not in recusals and (
            (eid,'event',eid) in grants or (eid,'category',row['category_id']) in grants)
        rows.append(item)
    return {'candidates':rows,'total':total,'truncated':more,'next_cursor':selected[-1]['queue_cursor'] if more else None}


@route('GET',r'/api/result-candidates/impact',roles=ORG)
def impact(ctx):
    try:kind=ctx.query.get('subject_kind',[''])[0];sid=int(ctx.query.get('subject_id',['0'])[0])
    except (ValueError,TypeError):raise bad_request('对象无效') from None
    row=candidates.subject(ctx.conn,kind,sid)
    review_access.require_record(ctx,row['category_id'])
    data=result_impacts.preview(ctx.conn,kind,sid)
    return {'impact_hash':data['impact_hash'],'affected':data['affected']}


@route('GET',r'/api/result-candidates/(?P<candidate_id>[a-f0-9]{32})',roles=REC)
def detail(ctx):
    return candidates.detail(ctx,ctx.params['candidate_id'])


@route('POST',r'/api/result-candidates/(?P<candidate_id>[a-f0-9]{32})/decision',roles=ORG)
def decide(ctx):
    protocol(ctx)
    return result_review.decide(ctx,ctx.params['candidate_id'])


def _decision_replay(ctx):
    """Only an existing immutable receipt can take the read-only path.

    Current token, scope, grant, authorship and exact UID/body checks still run
    in decide(). A new decision always enters the registry -> event write fence.
    """
    protocol(ctx)
    uid=ctx.body.get('decision_uid')
    if not isinstance(uid,str) or not db.q1(ctx.conn,'SELECT 1 FROM review_receipts WHERE uid=?',(uid,)):
        return None
    return result_review.decide(ctx,ctx.params['candidate_id'],replay_only=True)


decide.http_readonly_replay=_decision_replay


@route('POST',r'/api/result-candidates/(?P<candidate_id>[a-f0-9]{32})/withdraw',roles=REC)
def withdraw(ctx):
    protocol(ctx)
    return result_review.decide(ctx,ctx.params['candidate_id'],withdraw=True)


@route('POST',r'/api/result-candidates/(?P<candidate_id>[a-f0-9]{32})/recuse',roles=ORG)
def recuse(ctx):
    protocol(ctx)
    row=candidates.candidate(ctx.conn,ctx.params['candidate_id'])
    if not review_access.can_review(ctx,row['category_id']):raise forbidden()
    reason=str(ctx.body.get('reason') or '').strip()
    if not reason:raise bad_request('请填写回避原因')
    ctx.conn.execute('INSERT OR IGNORE INTO review_recusals VALUES(?,?,?,?)',(row['id'],ctx.user['id'],reason,db.now(ctx.conn)))
    security.audit(ctx.conn,ctx.user,'review_recuse',row['subject_kind'],row['subject_id'],{'candidate_id':row['id'],'reason':reason})
    return {'message':'已声明回避，请安排其他复核人'}


@route('GET',r'/api/(?:candidate|review)-receipts/(?P<uid>[A-Za-z0-9_.-]+)',roles=REC)
def receipt(ctx):
    row=db.q1(ctx.conn,'SELECT * FROM review_receipts WHERE uid=?',(ctx.params['uid'],))
    user=review_access.current_user(ctx)
    if not row or (row['actor_id']!=user['id'] and user['role'] not in ORG):return {'found':False}
    subject=candidates.subject(ctx.conn,row['subject_kind'],row['subject_id'])
    if not review_access.in_event(ctx,user,review_access.event_for_category(ctx.conn,subject['category_id'])['id']):return {'found':False}
    result=json.loads(row['result_json'])
    return {'found':True,**result}


@route('GET',r'/api/events/(?P<event_id>\d+)/review-grants',roles=('admin',))
def grants(ctx):
    return {'grants':db.rows_to_dicts(db.q(ctx.conn,'SELECT * FROM review_grants WHERE event_id=?',(int(ctx.params['event_id']),)))}


@route('POST',r'/api/events/(?P<event_id>\d+)/review-grants',roles=('admin',))
def grant(ctx):
    protocol(ctx)
    return review_access.set_grant(ctx,int(ctx.params['event_id']))


@route('GET',r'/api/result-history/(?P<kind>match|individual)/(?P<subject_id>\d+)',roles=ORG)
def history(ctx):
    row=candidates.subject(ctx.conn,ctx.params['kind'],int(ctx.params['subject_id']))
    review_access.require_record(ctx,row['category_id'])
    rows=db.rows_to_dicts(db.q(ctx.conn,'''SELECT * FROM official_versions WHERE subject_kind=? AND subject_id=? ORDER BY version''',
        (ctx.params['kind'],int(ctx.params['subject_id']))))
    return {'versions':rows,'disputes':db.rows_to_dicts(db.q(ctx.conn,'SELECT * FROM result_disputes WHERE category_id=?',(row['category_id'],)))}
