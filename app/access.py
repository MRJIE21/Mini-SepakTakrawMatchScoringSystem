"""账号赛事范围、模块边界与记录归属。权限从当前登录账号读取，不信任请求中的记录员。"""
import json
import re
from . import db, security
from .errors import forbidden, bad_request, conflict, not_found


def event_ids(conn, user):
    if user['role'] == 'admin':
        return None
    row = db.q1(conn, 'SELECT v FROM settings WHERE k = ?', (f"access:user:{user['id']}",))
    return json.loads(row['v']) if row else []


def set_events(conn, uid, ids):
    if not isinstance(ids, list) or any(type(i) is not int for i in ids):
        raise bad_request('请选择账号所属赛事')
    for eid in ids:
        if not db.q1(conn, 'SELECT id FROM events WHERE id=?', (eid,)):
            raise bad_request('所属赛事不存在')
    db.run(conn, 'INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)', (f'access:user:{uid}', json.dumps(sorted(set(ids)))))


def assignment(conn, kind, sid):
    row = db.q1(conn, 'SELECT v FROM settings WHERE k=?', (f'recording:{kind}:{sid}',))
    return json.loads(row['v']) if row else None


def owner_info(conn, kind, sid):
    owner = assignment(conn, kind, sid)
    if not owner:
        return {'recorder_id': None, 'recorder_name': ''}
    user = db.q1(conn, 'SELECT display_name FROM users WHERE id=?', (owner['user_id'],))
    return {'recorder_id': owner['user_id'], 'recorder_name': user['display_name'] if user else '账号资料待同步'}


def claim(ctx, kind, sid, transfer=False):
    with db.tx(ctx.conn):
        result = _claim(ctx, kind, sid, transfer)
        if kind == 'match':
            from . import team_rules_store
            row = db.q1(ctx.conn, 'SELECT * FROM matches WHERE id=?', (sid,))
            result.update(team_rules_store.freeze(ctx.conn, row))
        return result


def _claim(ctx, kind, sid, transfer=False):
    if kind not in ('match', 'individual'):
        raise bad_request('记录类型无效')
    if kind == 'match':
        row = db.q1(ctx.conn, 'SELECT * FROM matches WHERE id=?', (sid,))
        if not row: raise not_found('场次不存在')
        if row['status'] != 'ready': raise conflict('只有待记录场次可以领取或转交')
        from .api.common import recording_blocker
        blocker = recording_blocker(ctx.conn, row)
        if blocker:
            raise conflict(blocker, code='plan_not_locked')
    else:
        row = db.q1(ctx.conn, "SELECT p.id,p.category_id FROM participations p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND c.kind='individual' AND p.status='active'", (sid,))
        if not row: raise not_found('个人赛报名不存在')
        from .individual_draw_store import guard_recording
        guard_recording(ctx.conn, row['category_id'])
        if db.q1(ctx.conn, 'SELECT id FROM individual_results WHERE participation_id=?', (sid,)):
            raise conflict('已提交成绩请通过更正流程修改')
    old = assignment(ctx.conn, kind, sid)
    uid = ctx.user['id']
    if transfer:
        if ctx.user['role'] not in ('admin', 'organizer'): raise forbidden('只有管理员或成绩人员可以转交')
        if not str(ctx.body.get('reason') or '').strip(): raise bad_request('请填写转交原因')
        uid = int(ctx.body.get('user_id') or 0)
        registry = db.get_conn()
        target = db.q1(registry, 'SELECT * FROM users WHERE id=? AND active=1', (uid,))
        if not target or target['role'] not in ('admin', 'organizer', 'recorder'): raise bad_request('请选择可记录比赛的账号')
        scopes = event_ids(registry, target)
        eid = db.q1(ctx.conn, 'SELECT id FROM events LIMIT 1')['id']
        if scopes is not None and eid not in scopes: raise forbidden('该账号未分配本赛事')
        if ctx.conn is not registry:
            db.ensure_user_snapshot(ctx.conn, target)
    elif old and old['user_id'] != uid:
        raise conflict('该场次已由其他记录员领取，请联系成绩人员转交', code='recording_owned')
    elif old and old['user_id'] == uid:
        return {'message': '已领取', **owner_info(ctx.conn, kind, sid)}
    db.run(ctx.conn, 'INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)',
           (f'recording:{kind}:{sid}', json.dumps({'user_id': uid})))
    security.audit(ctx.conn, ctx.user, 'transfer_recording' if transfer else 'claim_recording', kind, sid,
                   {'previous': old, 'user_id': uid, 'reason': ctx.body.get('reason', '')})
    return {'message': '已转交' if transfer else '已领取', **owner_info(ctx.conn, kind, sid)}


def require_owner(ctx, kind, sid):
    # 成绩人员可以走正式更正；记录员必须先领取，且只能提交本人负责的场次。
    if ctx.user['role'] != 'recorder': return
    owner = assignment(ctx.conn, kind, sid)
    if not owner or owner['user_id'] != ctx.user['id']:
        raise forbidden('请先领取记录任务；其他记录员的任务需由成绩人员转交')


def authorize(ctx, scope):
    role, path, method = ctx.user['role'], ctx.path, ctx.method
    if role == 'admin': return
    registry = db.get_conn()
    scopes = event_ids(registry, ctx.user)
    event_match = re.match(r'/api/events/(\d+)', path)
    headers = {k.lower(): v for k, v in ctx.headers.items()}
    eid = int(headers.get('x-event-id') or (event_match[1] if event_match else 0))
    if scope == 'event' or event_match:
        if scope == 'event' and not headers.get('x-event-id'):
            raise forbidden('请先选择赛事')
        if not eid or eid not in scopes: raise forbidden('账号未分配该赛事，请联系管理员')
        if event_match and int(event_match[1]) != eid: raise forbidden('赛事范围不一致')
    if role == 'organizer':
        structure_routes = r'/api/(events(?:/full|/\d+(?:/(?:bootstrap|groups|venues))?)?|groups/\d+(?:/categories)?|venues/\d+)'
        if method != 'GET' and re.fullmatch(structure_routes, path):
            raise forbidden('赛事结构只能由管理员维护')
        if method != 'GET' and re.fullmatch(r'/api/categories/\d+', path): raise forbidden('项目设置只能由管理员维护')
        return
    if role == 'display_operator':
        if method == 'GET' and path in ('/api/display/console', '/api/display/preview'):
            return
        if method == 'POST' and path in ('/api/display/pair/claim', '/api/display/publish',
                                         '/api/display/revoke'):
            return
        # 其余只读页面走下方 viewer 白名单；组 2/3 的写操作仍被拒绝。
    if path in ('/api/me', '/api/me/password', '/api/me/logout-all', '/api/logout', '/api/events'): return
    if method != 'GET':
        if role == 'recorder' and (path in ('/api/scoring/submit', '/api/scoring/individual', '/api/display/live') or re.fullmatch(r'/api/recording/(match|individual)/\d+/claim', path)):
            return
        raise forbidden('当前角色没有该操作权限')
    shared = [r'/api/events/\d+/structure', r'/api/events/\d+/team-rules', r'/api/events/\d+/venues', r'/api/matches', r'/api/matches/\d+', r'/api/receipts/[\w.-]+', r'/api/categories/\d+/team-rules', r'/api/categories/\d+/individual-draw']
    recorder = [r'/api/scoring/queue', r'/api/scoring/match/\d+', r'/api/submissions/[\w.-]+',
                r'/api/matches/\d+/submissions', r'/api/categories/\d+/participations', r'/api/categories/\d+/individual-results']
    viewer = [r'/api/categories/\d+/(?:plan|schedule)', r'/api/plans/\d+', r'/api/pools/\d+/standings',
              r'/api/categories/\d+/placements', r'/api/groups/\d+/school-totals', r'/api/events/\d+/school-totals']
    if not any(re.fullmatch(pattern, path) for pattern in shared + (recorder if role == 'recorder' else viewer)):
        raise forbidden('当前角色不能查看该部分')
    if role in ('viewer', 'display_operator') and re.fullmatch(r'/api/pools/\d+/standings', path):
        pool = db.q1(ctx.conn, 'SELECT status FROM pools WHERE id=?', (int(ctx.params['pool_id']),))
        if not pool or pool['status'] != 'confirmed': raise forbidden('该小组名次尚未确认')


def filter_result(ctx, result):
    if not isinstance(result, dict): return result
    role = ctx.user['role']
    if result.get('category', {}).get('kind') == 'individual' and 'participations' in result:
        for part in result['participations']:
            part.update(owner_info(ctx.conn, 'individual', part['id']))
    if role == 'admin': return result
    if ctx.path == '/api/events':
        scopes = event_ids(db.get_conn(), ctx.user)
        result['events'] = [e for e in result['events'] if e['id'] in scopes]
    if role == 'recorder':
        if 'submissions' in result: result['submissions'] = [s for s in result['submissions'] if s['user_id'] == ctx.user['id']]
        if result.get('submission') and result['submission']['user_id'] != ctx.user['id']: return {'found': False}
    if role in ('viewer', 'display_operator'):
        if 'placements' in result: result['placements'] = [p for p in result['placements'] if p['status'] == 'confirmed']
        if result.get('plan'):
            plan = result['plan']
            public_stages = [s for s in plan.get('stages', []) if
                s.get('params', {}).get('schedule_meta', {}).get('state') == 'confirmed' or
                (not s.get('params', {}).get('schedule_meta') and plan['status'] in ('locked', 'running', 'archived'))]
            if public_stages:
                plan['stages'] = public_stages
            else:
                result['plan'] = None
        if 'available_formats' in result: result['available_formats'] = []
        if 'matches' in result and 'list_revision' not in result:
            from .api.common import match_plan_effective
            result['matches'] = [m for m in result['matches'] if m['status'] in ('ready', 'finished') and
                (not m.get('plan_id') or match_plan_effective(ctx.conn, m))]
        if result.get('match'):
            match = result['match']
            from .api.common import match_plan_effective
            if match.get('plan_id') and not match_plan_effective(ctx.conn, match):
                raise forbidden('赛程尚未发布')
    return result
