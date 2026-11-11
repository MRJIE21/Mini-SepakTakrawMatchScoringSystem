"""账号赛事范围、模块边界与记录归属。权限从当前登录账号读取，不信任请求中的记录员。"""
import json
import re
import uuid
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
    if kind == 'individual':
        part = db.q1(conn, 'SELECT category_id FROM participations WHERE id=?', (sid,))
        project = assignment(conn, 'individual_project', part['category_id']) if part else None
        if project:
            return project
    row = db.q1(conn, 'SELECT v FROM settings WHERE k=?', (f'recording:{kind}:{sid}',))
    return json.loads(row['v']) if row else None


def owner_info(conn, kind, sid):
    owner = assignment(conn, kind, sid)
    if not owner:
        return {'recorder_id': None, 'recorder_name': '', 'claim_token': None, 'recording_started': False}
    user = db.q1(conn, 'SELECT display_name FROM users WHERE id=?', (owner['user_id'],))
    return {'recorder_id': owner['user_id'], 'recorder_name': user['display_name'] if user else '账号资料待同步',
            'claim_token': owner.get('token'), 'recording_started': owner.get('started', True)}


def claim(ctx, kind, sid, transfer=False):
    with db.tx(ctx.conn):
        result = _claim(ctx, kind, sid, transfer)
        if kind == 'match':
            from . import team_rules_store
            row = db.q1(ctx.conn, 'SELECT * FROM matches WHERE id=?', (sid,))
            result.update(team_rules_store.freeze(ctx.conn, row))
        return result


def _claim(ctx, kind, sid, transfer=False):
    if kind not in ('match', 'individual', 'individual_project'):
        raise bad_request('记录类型无效')
    if kind == 'individual':
        raise conflict('个人赛不再支持逐人领取，请领取整个项目录入任务', code='project_claim_required')
    if kind == 'match':
        row = db.q1(ctx.conn, 'SELECT * FROM matches WHERE id=?', (sid,))
        if not row: raise not_found('场次不存在')
        if row['status'] != 'ready': raise conflict('只有待记录场次可以领取或转交')
        from .api.common import recording_blocker
        blocker = recording_blocker(ctx.conn, row)
        if blocker:
            raise conflict(blocker, code='plan_not_locked')
    elif kind == 'individual_project':
        info = project_recording_state(ctx, sid)
        legacy_transfer = transfer and info['claim_block_reason'].startswith('部分人员已由其他记录员领取')
        if info['claim_block_reason'] and info['claim_block_reason'] != '该记录已被领取' and not legacy_transfer:
            raise conflict(info['claim_block_reason'])
    else:
        row = db.q1(ctx.conn, "SELECT p.id,p.category_id FROM participations p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.deleted_at IS NULL AND c.kind='individual' AND p.status='active'", (sid,))
        if not row: raise not_found('个人赛报名不存在')
        if assignment(ctx.conn, 'individual_project', row['category_id']):
            raise conflict('本项目已整体领取，请从项目成绩录入继续或转交整个项目')
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
           (f'recording:{kind}:{sid}', json.dumps({'user_id': uid, 'token': uuid.uuid4().hex,
                          'started': (old.get('started', True) if old else False) or
                          kind == 'individual_project'})))
    security.audit(ctx.conn, ctx.user, 'transfer_recording' if transfer else 'claim_recording', kind, sid,
                   {'previous': old, 'user_id': uid, 'reason': ctx.body.get('reason', ''), 'result': 'success'})
    return {'message': '已转交' if transfer else '已领取', **owner_info(ctx.conn, kind, sid)}


def project_recording_state(ctx, cid):
    from .individual_draw_store import category, read
    category(ctx.conn, cid)
    pending = db.q(ctx.conn, '''SELECT p.id FROM participations p WHERE p.category_id=?
        AND p.status='active' AND p.deleted_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM individual_results r WHERE r.participation_id=p.id)''', (cid,))
    info = owner_info(ctx.conn, 'individual_project', cid)
    legacy = [json.loads(row['v']) for row in db.q(ctx.conn, '''SELECT s.v FROM settings s
        JOIN participations p ON s.k='recording:individual:' || p.id
        WHERE p.category_id=? AND p.status='active' AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM individual_results r WHERE r.participation_id=p.id)''', (cid,))]
    reason = ('本项目没有待录入人员' if not pending else
              '请先重新核对出场顺序' if read(ctx.conn, cid)['status'] == 'stale' else
              '部分人员已由其他记录员领取，请先转交给同一记录员' if not info['recorder_id'] and
              any(o and o['user_id'] != ctx.user['id'] for o in legacy) else '')
    started = info['recording_started'] or any(o and o.get('started', True) for o in legacy) or bool(db.q1(
        ctx.conn, 'SELECT id FROM individual_results WHERE category_id=? LIMIT 1', (cid,)))
    confirmed = bool(db.q1(ctx.conn, 'SELECT id FROM individual_results WHERE category_id=? AND confirmed=1 LIMIT 1', (cid,)))
    blocked = ('仅领取人可以取消领取' if info['recorder_id'] != ctx.user['id'] else
               '项目已有确认成绩，不能取消领取' if confirmed else '')
    return {**info, 'recording_started': started, 'can_claim': not reason and not info['recorder_id'],
            'claim_block_reason': reason or ('该记录已被领取' if info['recorder_id'] else ''),
            'can_release': not blocked, 'release_block_reason': blocked}


def recording_state(ctx, kind, sid):
    if kind == 'individual_project':
        return project_recording_state(ctx, sid)
    if kind == 'match':
        row = db.q1(ctx.conn, 'SELECT * FROM matches WHERE id=?', (sid,))
        if not row: raise not_found('场次不存在')
        from .api.common import recording_blocker
        reason = recording_blocker(ctx.conn, row)
        submitted = row['status'] != 'ready'
        # Older server-side process data must also block release.
        processed = any(db.q1(ctx.conn, f'SELECT id FROM {table} WHERE match_id=? LIMIT 1', (sid,))
                        for table in ('submissions', 'match_sets', 'score_events'))
    else:
        row = db.q1(ctx.conn, "SELECT p.* FROM participations p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.deleted_at IS NULL AND c.kind='individual'", (sid,))
        if not row: raise not_found('个人赛报名不存在')
        if assignment(ctx.conn, 'individual_project', row['category_id']):
            raise conflict('本项目已整体领取，请从项目成绩录入继续')
        submitted = bool(db.q1(ctx.conn, 'SELECT id FROM individual_results WHERE participation_id=?', (sid,)))
        processed = submitted
        from .individual_draw_store import read
        reason = ('已提交成绩' if submitted else '报名已退出' if row['status'] != 'active'
                  else '请先重新核对出场顺序' if read(ctx.conn, row['category_id'])['status'] == 'stale' else '')
    info = owner_info(ctx.conn, kind, sid)
    owned = info['recorder_id'] == ctx.user['id']
    blocked = ('仅领取人可以取消领取' if not owned else
               '已开始处理或已提交，不能取消领取' if info['recording_started'] or submitted or processed else '')
    return {**info, 'can_claim': not reason and not info['recorder_id'],
            'claim_block_reason': reason or ('该记录已被领取' if info['recorder_id'] else ''),
            'can_release': not blocked, 'release_block_reason': blocked}


def change_recording(ctx, kind, sid, action):
    if kind == 'individual':
        raise conflict('个人赛不再支持逐人任务操作，请使用整个项目录入任务', code='project_claim_required')
    with db.tx(ctx.conn):
        info = recording_state(ctx, kind, sid)
        owner = assignment(ctx.conn, kind, sid)
        if not owner or owner['user_id'] != ctx.user['id']:
            raise conflict('记录归属已变化，仅当前领取人可以操作', code='recording_owned')
        if not ctx.body.get('claim_token') or ctx.body['claim_token'] != owner.get('token'):
            raise conflict('领取版本已变化，请刷新后核对', code='recording_changed')
        if action == 'release':
            if not info['can_release']: raise conflict(info['release_block_reason'])
            db.run(ctx.conn, 'DELETE FROM settings WHERE k=?', (f'recording:{kind}:{sid}',))
        else:
            if info['claim_block_reason'] and info['claim_block_reason'] != '该记录已被领取':
                raise conflict(info['claim_block_reason'])
            owner['started'] = True
            db.run(ctx.conn, 'UPDATE settings SET v=? WHERE k=?',
                   (json.dumps(owner), f'recording:{kind}:{sid}'))
        security.audit(ctx.conn, ctx.user, action + '_recording', kind, sid,
                       {'result': 'success', 'previous': owner})
        return {'message': '已取消领取，记录可重新领取' if action == 'release' else '已开始处理',
                **recording_state(ctx, kind, sid)}


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
    # 报名删除必须让所有已认证、且拥有当前赛事范围的角色进入处理器，
    # 再由独立 capability 强制判定并把越权尝试写入赛事审计。
    if ((method == 'DELETE' and re.fullmatch(r'/api/participations/\d+', path)) or
            (method == 'POST' and path == '/api/participations/batch-delete')):
        return
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
        if role == 'recorder' and (path in ('/api/scoring/submit', '/api/scoring/individual', '/api/display/live') or re.fullmatch(r'/api/recording/(match|individual|individual_project)/\d+/(?:claim|release|start)', path)):
            return
        raise forbidden('当前角色没有该操作权限')
    shared = [r'/api/recording/(?:match|individual|individual_project)/\d+', r'/api/events/\d+/structure', r'/api/events/\d+/team-rules', r'/api/events/\d+/venues', r'/api/matches', r'/api/matches/\d+', r'/api/receipts/[\w.-]+', r'/api/categories/\d+/team-rules', r'/api/categories/\d+/individual-draw']
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
