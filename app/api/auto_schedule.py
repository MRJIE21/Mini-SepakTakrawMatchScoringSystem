"""Server-held previews, exact atomic confirmation and idempotent recovery."""
import copy
import json
import secrets
import threading
import time
from .. import db, security, auto_schedule_store as store
from ..domain import auto_schedule as model, advancement
from ..errors import bad_request, conflict
from ..http_server import route
from .common import category_context
from .schedule import mutation

ORG = ('admin','organizer')
PREVIEWS = {}
LOCK = threading.Lock()
TTL = 600
MAX_PREVIEW_BYTES = 2 * 1024 * 1024


def owner(ctx, cid):
    cat = category_context(ctx.conn, cid)
    if cat['kind'] != 'team':
        raise bad_request('个人赛没有对阵赛程')
    event = db.q1(ctx.conn, 'SELECT uuid FROM events WHERE id=?', (cat['event_id'],))
    deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k='deployment_id'")
    return (ctx.user['id'], cat['event_id'], event['uuid'], deployment['v'], cid)


def remember(value):
    if len(json.dumps(value,ensure_ascii=False).encode('utf-8')) > MAX_PREVIEW_BYTES:
        raise bad_request('预览数据过大，请减少本次阶段或场地时段后重试')
    token = secrets.token_urlsafe(32)
    with LOCK:
        now = time.monotonic()
        for key in [k for k,v in PREVIEWS.items() if v['expires'] <= now]:
            PREVIEWS.pop(key)
        owned = [k for k,v in PREVIEWS.items() if v['owner'] == value['owner']]
        for key in owned[:-4]: PREVIEWS.pop(key)
        while len(PREVIEWS) >= 50: PREVIEWS.pop(next(iter(PREVIEWS)))
        value['expires'] = now + TTL
        PREVIEWS[token] = value
    return token


@route('GET', r'/api/categories/(?P<category_id>\d+)/auto-schedule', roles=ORG)
def get_config(ctx):
    cid = int(ctx.params['category_id']); owner(ctx,cid)
    return {'settings': store.policy(ctx.conn,cid)}


@route('POST', r'/api/categories/(?P<category_id>\d+)/auto-schedule/preview', roles=ORG)
def preview(ctx):
    cid = int(ctx.params['category_id'])
    try:
        config = model.settings(ctx.body.get('settings'))
        with db.read_tx(ctx.conn):
            identity = owner(ctx,cid)
            rows,pools,stages,venues = store.prepare(ctx.conn,cid,config)
            basis = store.basis(ctx.conn,cid)
            names,pool_names = store.label_maps(ctx.conn)
        result = model.arrange(rows,pools,config)
    except ValueError as exc:
        raise bad_request(str(exc)) from None
    changes = {r['id']:r for r in result['changes']}
    selected = [changes.get(r['id'],r) for r in rows if r['category_id']==cid and r['stage_id'] in config['stage_ids']]
    schedule = [store.present(r,names,pool_names,venues,stages) for r in selected]
    schedule.sort(key=lambda r:(r['start'] or '9999',r['venue_id'] or 0,r['id']))
    value = {'owner':identity,'basis':basis,'config':config,'changes':result['changes'],'rows':rows,'pools':pools,'complete':result['complete']}
    token = remember(value)
    unplaced = set(result['unplaced'])
    return {'preview_id':token,'expires_in':TTL,'complete':result['complete'],'status':result['status'],
        'schedule':schedule,'unplaced':[r for r in schedule if r['id'] in unplaced],
        'reason':'' if result['complete'] else result['reason'],'changed':len(changes),
        'new':sum(k<0 for k in changes),'kept':len(selected)-len(changes),
        'legacy_estimates':sum(bool(r.get('estimated_legacy') and r['scheduled_at']) for r in rows),
        'settings':config,'message':'预览未保存；全部安排完整后才可确认'}


preview.http_transaction = False


@route('POST', r'/api/categories/(?P<category_id>\d+)/auto-schedule/confirm', roles=ORG)
def confirm(ctx):
    cid = int(ctx.params['category_id'])
    def save():
        identity = owner(ctx,cid)
        token=ctx.body.get('preview_id')
        if not isinstance(token,str) or not token or len(token)>100:
            raise bad_request('请选择有效预览后确认')
        with LOCK:
            value = copy.deepcopy(PREVIEWS.get(token))
        if not value or value['expires'] <= time.monotonic() or value['owner'] != identity:
            raise conflict('预览已过期或不属于当前账号，请重新生成', code='preview_expired')
        if not value['complete']:
            raise bad_request('还有未安排比赛，请先调整规则并重新预览')
        if value['basis'] != store.basis(ctx.conn,cid):
            raise conflict('分组、场地或比赛状态已变化，请重新生成预览', code='preview_changed')
        config = value['config']; changes = value['changes']
        combined = {r['id']:r for r in value['rows']}
        combined.update({r['id']:r for r in changes})
        errors = model.violations(list(combined.values()),value['pools'],config['windows'],{r['id'] for r in changes})
        fixed_checks={r['id'] for r in combined.values() if r.get('validate_fixed')}
        if fixed_checks: errors.extend(model.violations(list(combined.values()),value['pools'],affected=fixed_checks))
        if errors: raise conflict('；'.join(errors[:3]),code='schedule_conflict')
        ids=[]
        def save_rules(mid, row, rules):
            rules = {**rules, 'duration_minutes':row['duration_minutes'], 'rest_minutes':row['rest_minutes']}
            ctx.conn.execute('''INSERT INTO match_schedule_meta(match_id,duration_minutes,rest_minutes,policy_json,batch_uid)
                VALUES(?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET duration_minutes=excluded.duration_minutes,
                rest_minutes=excluded.rest_minutes,policy_json=excluded.policy_json,batch_uid=excluded.batch_uid''',
                (mid,row['duration_minutes'],row['rest_minutes'],json.dumps(rules,ensure_ascii=False),ctx.body['request_uid']))
        for row in changes:
            mid=row['id']
            if mid < 0:
                seq=db.q1(ctx.conn,'SELECT COALESCE(MAX(seq),0)+1 AS n FROM matches WHERE stage_id=?',(row['stage_id'],))['n']
                fields={k:row[k] for k in ('category_id','stage_id','plan_id','plan_version','pool_id','round_no','round_label',
                    'home_source_type','home_participation','away_source_type','away_participation','venue_id','scheduled_at')}
                mid=db.insert(ctx.conn,'matches',{**fields,'seq':seq,'status':'pending'})
            else:
                old=db.q1(ctx.conn,'SELECT schedule_revision FROM matches WHERE id=?',(mid,))
                db.update(ctx.conn,'matches',mid,{'venue_id':row['venue_id'],'scheduled_at':row['scheduled_at'],
                    'updated_at':db.now(ctx.conn),'schedule_revision':old['schedule_revision']+1})
            save_rules(mid, row, config)
            ids.append(mid)
        old_policy = store.policy(ctx.conn,cid)
        for mid in fixed_checks:
            row = combined[mid]
            rules = store.match_policy(ctx.conn,row,{cid:old_policy} if old_policy else {}) or config
            save_rules(mid,row,rules)
        ctx.conn.execute('''INSERT INTO schedule_policies(category_id,settings_json) VALUES(?,?)
            ON CONFLICT(category_id) DO UPDATE SET settings_json=excluded.settings_json,revision=revision+1,
            updated_at=datetime('now','localtime')''',(cid,json.dumps(config,ensure_ascii=False)))
        plans={r['plan_id'] for r in changes if r.get('plan_id')}
        for pid in plans: advancement.refresh_plan(ctx.conn,pid)
        security.audit(ctx.conn,ctx.user,'auto_schedule','category',cid,{'match_ids':ids,'rules_updated':len(fixed_checks),'settings':config})
        message = f'已保存{len(ids)}场比赛安排'
        if fixed_checks: message += f'，另已保存{len(fixed_checks)}场保留比赛的休息规则'
        return {'match_ids':ids,'new':sum(r['id']<0 for r in changes),'changed':len(ids),'rules_updated':len(fixed_checks),'message':message}
    return mutation(ctx,cid,save)
