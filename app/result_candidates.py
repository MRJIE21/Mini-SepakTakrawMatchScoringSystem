"""Immutable candidate reception. No official result is written by receive()."""
import json
import re
import sqlite3
import uuid
from pathlib import Path

from . import access, db, review_access, security, team_rules_store
from .domain import validation
from .errors import ApiError, bad_request, conflict, forbidden, not_found

PROTOCOL = 3
KINDS = ('match', 'individual')


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def initialize(conn):
    existing = db.q1(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name='result_candidates'")
    marker = db.q1(conn, "SELECT v FROM settings WHERE k='result_review_schema'")
    if marker and marker['v'] != '3':
        raise RuntimeError('不支持的独立复核数据版本，禁止写入')
    sql = ''
    if not existing:
        from .team_rules_store import _backup
        # The schema is additive; backup the previous business state before it is added.
        if db.q1(conn, 'SELECT id FROM matches LIMIT 1') or db.q1(conn, 'SELECT id FROM individual_results LIMIT 1'):
            _backup(conn, '.before-independent-review-v3.sqlite')
        sql = Path(__file__).with_name('result_review_schema.sql').read_text(encoding='utf-8')
    with db.tx(conn):
        # executescript commits an existing transaction. Execute complete SQL
        # statements ourselves so tables, history and marker all roll back.
        statement = ''
        for line in sql.splitlines(keepends=True):
            statement += line
            if sqlite3.complete_statement(statement):
                conn.execute(statement)
                statement = ''
        if statement.strip():
            raise RuntimeError('独立复核迁移SQL不完整')
        columns={r['name'] for r in db.q(conn,'PRAGMA table_info(display_live)')}
        if 'stream_epoch' not in columns:
            conn.execute('ALTER TABLE display_live ADD COLUMN stream_epoch INTEGER NOT NULL DEFAULT 0')
        marker = db.q1(conn, "SELECT v FROM settings WHERE k='result_review_schema'")
        if marker:
            return
        for kind, rows in (
            ('match', db.q(conn, 'SELECT id FROM matches WHERE result_version>0')),
            ('individual', db.q(conn, 'SELECT participation_id AS id FROM individual_results WHERE version>0'))):
            for row in rows:
                snapshot = official_snapshot(conn, kind, row['id'])
                authors = legacy_authors(conn, kind, row['id'])
                save_official_history(conn, kind, row['id'], snapshot, authors, legacy=True)
        # Fail old executables closed, including offline restart against a new-schema database.
        for table in ('matches','match_sets','score_events','individual_results','placements',
                      'pool_rank_snapshots','school_points'):
            if not db.q1(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)):
                continue
            for verb in ('INSERT','UPDATE','DELETE'):
                name = f'review_writer_{table}_{verb.lower()}'
                conn.execute(f'''CREATE TRIGGER IF NOT EXISTS {name} BEFORE {verb} ON {table}
                    BEGIN SELECT CASE WHEN review_writer_version()<3 THEN
                    RAISE(ABORT,'result review writer upgrade required') END; END''')
        conn.execute("INSERT INTO settings(k,v) VALUES('result_review_schema','3')")


def subject(conn, kind, sid):
    if kind not in KINDS or type(sid) is not int or sid < 1:
        raise bad_request('结果对象无效')
    if kind == 'match':
        row = db.q1(conn,'SELECT * FROM matches WHERE id=?',(sid,))
    else:
        row = db.q1(conn,'''SELECT p.*,c.kind FROM participations p
            JOIN categories c ON c.id=p.category_id WHERE p.id=?''',(sid,))
        if row and row['kind'] != 'individual':
            raise bad_request('不是个人赛报名')
    if row is None:
        raise not_found('结果对象不存在')
    return row


def official_snapshot(conn, kind, sid):
    row = subject(conn,kind,sid)
    if kind == 'match':
        return {'version':row['result_version'],'match':dict(row),
                'sets':[dict(x) for x in db.q(conn,'SELECT * FROM match_sets WHERE match_id=? ORDER BY set_no',(sid,))],
                'events':[dict(x) for x in db.q(conn,'SELECT * FROM score_events WHERE match_id=? ORDER BY seq',(sid,))]}
    result = db.q1(conn,'SELECT * FROM individual_results WHERE participation_id=?',(sid,))
    return {'version':result['version'] if result else 0,'result':dict(result) if result else None}


def legacy_authors(conn, kind, sid):
    if kind == 'match':
        rows=db.q(conn,'SELECT user_id FROM submissions WHERE match_id=?',(sid,))
    else:
        rows=db.q(conn,'''SELECT s.user_id FROM submissions s JOIN individual_results r
            ON r.id=s.individual_result_id WHERE r.participation_id=?''',(sid,))
    return sorted({r['user_id'] for r in rows if r['user_id'] is not None})


def save_official_history(conn, kind, sid, snapshot, authors, candidate=None, reviewer=None, decision_uid=None, legacy=False):
    conn.execute('''INSERT OR IGNORE INTO official_versions VALUES(?,?,?,?,?,?,?,?,?,?)''',
        (kind,sid,snapshot['version'],encode(snapshot),encode(sorted(set(authors))),
         candidate,reviewer,decision_uid,int(legacy),db.now(conn)))


def epoch_info(conn, kind, sid):
    row=db.q1(conn,'SELECT * FROM recording_epochs WHERE subject_kind=? AND subject_id=?',(kind,sid))
    if row:return {'epoch':row['epoch'],'authors':json.loads(row['authors_json'])}
    old=access.assignment(conn,kind,sid)
    return {'epoch':1 if old else 0,'authors':[old['user_id']] if old else []}


def record_claim(conn, kind, sid, actor_id, previous=None):
    info=epoch_info(conn,kind,sid)
    epoch=max(1,info['epoch']+int(bool(previous and previous['user_id']!=actor_id)))
    authors=set(info['authors'])|{actor_id}
    if previous:authors.add(previous['user_id'])
    conn.execute('''INSERT INTO recording_epochs VALUES(?,?,?,?) ON CONFLICT(subject_kind,subject_id)
        DO UPDATE SET epoch=excluded.epoch,authors_json=excluded.authors_json''',
        (kind,sid,epoch,encode(sorted(authors))))
    return epoch


def active(conn, kind, sid):
    return db.q1(conn,'''SELECT c.id,c.revision,c.created_by,c.category_id,h.status FROM result_candidates c
        JOIN candidate_heads h ON h.candidate_id=c.id WHERE h.subject_kind=? AND h.subject_id=?
        AND h.status='submitted' ''',(kind,sid))


def candidate(conn, cid):
    row=db.q1(conn,'''SELECT c.*,h.status FROM result_candidates c
        JOIN candidate_heads h ON h.candidate_id=c.id WHERE c.id=?''',(cid,))
    if row is None:raise not_found('候选不存在')
    return row


def identity(conn, category_id):
    e=review_access.event_for_category(conn,category_id)
    d=db.q1(conn,"SELECT v FROM settings WHERE k='deployment_id'")
    return {'event_id':e['id'],'event_uuid':e['uuid'],'deployment_id':d['v'] if d else ''}


def require_uid(body, key):
    uid=body.get(key)
    if not isinstance(uid,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}',uid) or uid.startswith('formal.'):
        raise bad_request('请求标识无效，请保留原包核对',code='invalid_uid')
    return uid


def replay(ctx, uid, body, action, kind, sid, ident):
    old=db.q1(ctx.conn,'SELECT * FROM review_receipts WHERE uid=?',(uid,))
    if old:
        if (old['actor_id'],old['action'],old['subject_kind'],old['subject_id'],old['payload_hash'],old['identity_json']) != (
                ctx.user['id'],action,kind,sid,validation.payload_hash(body),encode(ident)):
            raise conflict('同一请求标识已用于不同账号、内容或操作',code='uid_conflict')
        return json.loads(old['result_json'])
    if db.q1(ctx.conn,'SELECT uid FROM submissions WHERE uid=?',(uid,)) or db.q1(ctx.conn,'SELECT uid FROM request_log WHERE uid=?',(uid,)):
        raise conflict('标识已用于旧请求，请核对原回执',code='uid_conflict')
    return None


def store_receipt(ctx, uid, body, action, kind, sid, ident, result):
    db.insert(ctx.conn,'review_receipts',{'uid':uid,'actor_id':ctx.user['id'],'action':action,
        'subject_kind':kind,'subject_id':sid,'payload_hash':validation.payload_hash(body),
        'identity_json':encode(ident),'result_json':encode(result),'created_at':db.now(ctx.conn)})


def validate(ctx, kind, sid, operation, payload, *, accepting=True):
    from .api.common import match_plan_effective
    row=subject(ctx.conn,kind,sid)
    user=review_access.require_record(ctx,row['category_id']) if accepting else ctx.user
    if accepting and kind=='match':
        team_rules_store.freeze(ctx.conn,row)
        row=subject(ctx.conn,kind,sid)
    if accepting and operation=='initial':access.require_owner(ctx,kind,sid)
    if operation!='initial' and accepting and user['role'] not in ('admin','organizer'):
        raise forbidden('正式更正需要有权成绩人员发起')
    snap=official_snapshot(ctx.conn,kind,sid)
    version=snap['version']
    if payload.get('base_version')!=version or type(payload.get('base_version')) is not int:
        raise conflict('正式基础版本已变化，请保留原包核对',code='version_conflict')
    ident=identity(ctx.conn,row['category_id'])
    if payload.get('event_identity')!=ident:
        raise conflict('结果包赛事/部署身份不一致',code='event_identity_mismatch')
    if operation not in ('initial','correction','cancel','reset_review','resolve_dispute'):
        raise bad_request('候选操作无效')
    if operation!='initial' and not str(payload.get('reason') or '').strip():
        raise bad_request('请填写更正或处置原因',code='correction_reason_required')
    claim=epoch_info(ctx.conn,kind,sid)
    if type(payload.get('claim_epoch')) is not int:
        raise bad_request('记录归属版本必须为整数')
    if payload.get('claim_epoch')!=claim['epoch']:
        raise conflict('记录归属已变化，请保留原件核对',code='claim_epoch_conflict')
    if operation=='initial' and version:
        raise conflict('已有正式记录，请发起带原因更正',code='correction_required')
    if operation=='initial':
        from . import result_impacts
        result_impacts.guard_subject(ctx.conn,kind,sid)
    if kind=='match':
        if row['reset_state'] in ('inactive','review') and operation!='reset_review':
            raise conflict('重置赛需显式复核',code='reset_requires_review')
        if operation=='initial' and row['status']!='ready':
            raise conflict('场次尚未可记录',code='not_ready')
        plan=db.q1(ctx.conn,'SELECT * FROM plans WHERE id=?',(row['plan_id'],)) if row['plan_id'] else None
        if plan and not match_plan_effective(ctx.conn,row,plan):
            raise conflict('方案尚未生效',code='plan_not_locked')
        if any(key not in payload for key in ('plan_version','home_participation','away_participation')):
            raise bad_request('结果包缺少下载时的对阵，请保留原件重新核对',code='missing_lineup')
        if any(type(payload[key]) is not int for key in ('plan_version','home_participation','away_participation')):
            raise bad_request('对阵标识和方案版本必须为整数')
        if payload.get('plan_version')!=row['plan_version']:
            raise conflict('编排依据已变化',code='plan_version_conflict')
        if [payload.get('home_participation'),payload.get('away_participation')]!=[row['home_actual'],row['away_actual']]:
            raise conflict('对阵已变化，请保留原件核对',code='lineup_changed',detail={
                'recorded':[payload.get('home_participation'),payload.get('away_participation')],
                'current':[row['home_actual'],row['away_actual']]})
        rules=team_rules_store.match_rules(ctx.conn,row)
        team_rules_store.check_payload(payload,rules)
        if operation in ('reset_review','resolve_dispute'):errors=[]
        elif operation=='cancel':
            errors=[] if payload.get('result_status') in ('cancelled','unfinished') else ['只能取消或标记未完成']
        else:
            mode=payload.get('events_mode','replace')
            if mode not in ('replace','retain') or (mode=='retain' and operation!='correction'):
                raise bad_request('过程保留模式无效')
            if mode=='retain' and payload.get('retained_events_hash')!=validation.payload_hash(snap['events']):
                raise conflict('原过程已变化，不能保留',code='events_changed')
            errors=validation.validate_team_package(sets=payload.get('sets') or [],
                events=[] if mode=='retain' else payload.get('events') or [],
                result_status=payload.get('result_status') or 'normal', require_events=mode!='retain',rules=rules['rules'])
    else:
        if row['status']!='active':raise conflict('报名不再有效',code='participation_changed')
        if not version:
            from .individual_draw_store import guard_recording
            guard_recording(ctx.conn,row['category_id'])
        if payload.get('rank_no') not in (None,''):
            raise bad_request('原始成绩不能直接确认名次',code='rank_requires_project_confirmation')
        errors=validation.validate_individual_package(result_status=payload.get('result_status') or 'normal',
            result_value=payload.get('result_value'),result_text=payload.get('result_text') or '',rank_no=None,
            events=payload.get('events'),error_count=payload.get('error_count'),violation_count=payload.get('violation_count'))
    if errors:raise ApiError(422,'invalid_package','结果包校验失败',{'errors':errors})
    return row,snap,ident,claim


def receive(ctx):
    body=ctx.body or {}
    kind,sid=body.get('subject_kind'),body.get('subject_id')
    row=subject(ctx.conn,kind,sid)
    review_access.require_record(ctx,row['category_id'])
    ident=identity(ctx.conn,row['category_id'])
    uid=require_uid(body,'submission_uid')
    old=replay(ctx,uid,body,'receive',kind,sid,ident)
    if old:return old
    if body.get('payload_schema')!=3 or not isinstance(body.get('payload'),dict):
        raise ApiError(426,'client_upgrade_required','请保存原件并升级记录页面')
    payload=body['payload']; operation=body.get('operation','initial')
    row,snap,ident,claim=validate(ctx,kind,sid,operation,payload)
    if active(ctx.conn,kind,sid):
        raise conflict('已有待复核候选，不能重复记录',code='candidate_active')
    parent=None
    parent_id=body.get('parent_id')
    if not parent_id:
        previous=db.q1(ctx.conn,'''SELECT c.id,h.status FROM result_candidates c JOIN candidate_heads h ON h.candidate_id=c.id
            WHERE c.subject_kind=? AND c.subject_id=? AND c.base_version=? ORDER BY c.rowid DESC LIMIT 1''',(kind,sid,snap['version']))
        if previous and previous['status'] in ('returned','withdrawn'):parent_id=previous['id']
    if parent_id:
        parent=candidate(ctx.conn,parent_id)
        if ((parent['subject_kind'],parent['subject_id'])!=(kind,sid) or parent['status'] not in ('returned','withdrawn')
                or parent['base_version']!=snap['version']):
            raise conflict('仅可从同一对象已退回或撤回的候选修订',code='revision_conflict')
        if ctx.user['id'] not in json.loads(parent['authors_json']) and ctx.user['role'] not in ('admin','organizer'):
            # A new explicitly assigned recorder may create new content, while
            # inheriting the old provenance without gaining access to its packet.
            access.require_owner(ctx,kind,sid)
    authors=set(claim['authors'])|{ctx.user['id']}
    authors.update(legacy_authors(ctx.conn,kind,sid))
    if parent:authors.update(json.loads(parent['authors_json']))
    for row_author in db.q(ctx.conn,'SELECT authors_json FROM result_candidates WHERE subject_kind=? AND subject_id=?',(kind,sid)):
        authors.update(json.loads(row_author['authors_json']))
    cid=uuid.uuid4().hex; chain=parent['chain_id'] if parent else cid
    rev=1+db.q1(ctx.conn,'SELECT COALESCE(MAX(revision),0) AS v FROM result_candidates WHERE chain_id=?',(chain,))['v']
    context={'identity':ident,'claim_epoch':claim['epoch'],'official_snapshot':snap,
             'legacy_authorship_unknown':bool(snap['version'] and not legacy_authors(ctx.conn,kind,sid))}
    context['author_name']=ctx.user.get('display_name') or ctx.user.get('username') or str(ctx.user['id'])
    if kind=='match':
        from .api.common import match_full_context
        info=match_full_context(ctx.conn,sid)
        context['subject_labels']=[info['home']['label'],info['away']['label']]
        context['rules_summary']=info.get('rules_summary','')
    from . import result_impacts
    impact=result_impacts.prepare(ctx,kind,sid,operation,body)
    context['impact']=impact
    authors.update(impact.get('authors',[]))
    content={'payload':payload,'context':context,'authors':sorted(authors),'operation':operation,'chain_id':chain,'revision':rev,
             'parent_id':parent['id'] if parent else None}
    digest=validation.payload_hash(content)
    db.insert(ctx.conn,'result_candidates',{'id':cid,'chain_id':chain,'revision':rev,'parent_id':parent['id'] if parent else None,
        'subject_kind':kind,'subject_id':sid,'category_id':row['category_id'],'operation':operation,'base_version':snap['version'],
        'payload_json':encode(payload),'payload_hash':validation.payload_hash(payload),'candidate_hash':digest,
        'context_json':encode(context),'authors_json':encode(sorted(authors)),'created_by':ctx.user['id'],'created_at':db.now(ctx.conn)})
    db.insert(ctx.conn,'candidate_heads',{'candidate_id':cid,'subject_kind':kind,'subject_id':sid,'status':'submitted','updated_at':db.now(ctx.conn)})
    result_impacts.open_dispute(ctx,cid,kind,sid,row['category_id'],operation,impact,payload)
    receipt={'receipt_kind':'candidate_received','uid':uid,'candidate_id':cid,'revision':rev,'candidate_hash':digest,
             'subject_kind':kind,'subject_id':sid,'payload_hash':validation.payload_hash(body),'identity':ident,'status':'received'}
    result={'candidate_id':cid,'revision':rev,'status':'submitted','message':'已接收，待独立复核；尚未正式确认','receipt':receipt}
    store_receipt(ctx,uid,body,'receive',kind,sid,ident,result)
    security.audit(ctx.conn,ctx.user,'receive_candidate',kind,sid,{'candidate_id':cid,'hash':digest,'authors':sorted(authors),'operation':operation})
    return result


def can_read(ctx,row,user=None):
    user=user or review_access.current_user(ctx)
    if not review_access.in_event(ctx,user,review_access.event_for_category(ctx.conn,row['category_id'])['id']):return False
    return user['role'] in ('admin','organizer') or (user['role']=='recorder' and user['id'] in json.loads(row['authors_json']))


def detail(ctx,cid):
    row=candidate(ctx.conn,cid)
    if not can_read(ctx,row):raise forbidden()
    out=dict(row)
    for key in ('payload','context','authors'):out[key]=json.loads(out.pop(key+'_json'))
    out['can_review']=review_access.can_review(ctx,row['category_id']) and ctx.user['id'] not in out['authors'] and not db.q1(
        ctx.conn,'SELECT 1 FROM review_recusals WHERE candidate_id=? AND user_id=?',(cid,ctx.user['id']))
    decision=db.q1(ctx.conn,'SELECT * FROM review_decisions WHERE candidate_id=?',(cid,))
    out['decision']=dict(decision) if decision else None
    return {'candidate':out}
