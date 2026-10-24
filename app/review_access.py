"""Explicit review capabilities; admin is subject to the same authorship guards."""
from . import access, clock, db, security
from .errors import bad_request, conflict, forbidden


def event_for_category(conn, category_id):
    event = db.q1(conn, '''SELECT e.* FROM events e JOIN groups g ON g.event_id=e.id
        JOIN categories c ON c.group_id=g.id WHERE c.id=?''', (category_id,))
    if event is None:
        raise bad_request('项目不存在')
    return event


def current_user(ctx):
    """Called under the registry write fence for mutations, never from a snapshot."""
    registry = db.get_conn()
    token = getattr(ctx, 'token', None)
    if not token:
        raise forbidden('独立复核需要有效登录')
    user = db.q1(registry, '''SELECT u.*,t.expires_at,t.expires_at_epoch FROM users u
        JOIN tokens t ON t.user_id=u.id WHERE t.token=? AND u.active=1''', (security.token_hash(token),))
    expiry = (user['expires_at_epoch'] or clock.parse_local_text(user['expires_at']) or 0) if user else 0
    if not user or user['id'] != ctx.user['id'] or max(clock.utc_epoch(),clock.read_high_water(registry)) >= expiry:
        raise forbidden('账号或登录已失效')
    return dict(user)


def in_event(ctx, user, event_id):
    scopes = access.event_ids(db.get_conn(), user)
    return scopes is None or event_id in scopes


def can_review(ctx, category_id, user=None):
    user = user or current_user(ctx)
    eid = event_for_category(ctx.conn, category_id)['id']
    if user['role'] not in ('admin', 'organizer') or not in_event(ctx, user, eid):
        return False
    return bool(db.q1(ctx.conn, '''SELECT 1 FROM review_grants WHERE user_id=?
        AND event_id=? AND active=1 AND ((scope_kind='event' AND scope_id=?)
        OR (scope_kind='category' AND scope_id=?))''', (user['id'], eid, eid, category_id)))


def require_review(ctx, candidate):
    import json
    user = current_user(ctx)
    if not can_review(ctx, candidate['category_id'], user):
        raise forbidden('没有本项目当前有效的独立复核授权')
    if user['id'] in json.loads(candidate['authors_json']):
        raise forbidden('本人参与过该内容录入，不能复核确认或退回')
    if db.q1(ctx.conn, 'SELECT 1 FROM review_recusals WHERE candidate_id=? AND user_id=?',
              (candidate['id'], user['id'])):
        raise forbidden('已声明回避，请分配其他独立复核人')
    return user


def require_record(ctx, category_id):
    user = current_user(ctx)
    if user['role'] not in ('admin', 'organizer', 'recorder'):
        raise forbidden()
    if not in_event(ctx, user, event_for_category(ctx.conn, category_id)['id']):
        raise forbidden('未分配本赛事')
    return user


def set_grant(ctx, event_id):
    user = current_user(ctx)
    if user['role'] != 'admin':
        raise forbidden('仅管理员可授予或撤销复核能力')
    body = ctx.body
    uid = body.get('user_id')
    if type(uid) is not int or type(body.get('active')) is not bool:
        raise bad_request('请选择账号及启用状态')
    target = db.q1(db.get_conn(), 'SELECT * FROM users WHERE id=?', (uid,))
    if not target or target['role'] not in ('admin', 'organizer') or not target['active']:
        raise bad_request('仅可向启用的管理员或成绩人员授予复核能力')
    if not in_event(ctx, target, event_id):
        raise forbidden('目标账号不在本赛事范围')
    if not str(body.get('reason') or '').strip():
        raise bad_request('请填写授权或撤销原因')
    kind = 'category' if body.get('category_id') else 'event'
    sid = body.get('category_id') if kind == 'category' else event_id
    if type(sid) is not int or (kind == 'category' and event_for_category(ctx.conn, sid)['id'] != event_id):
        raise bad_request('项目与赛事不一致')
    if not db.q1(ctx.conn, 'SELECT id FROM events WHERE id=?', (event_id,)):
        raise bad_request('赛事不存在')
    old = db.q1(ctx.conn, '''SELECT * FROM review_grants
        WHERE user_id=? AND event_id=? AND scope_kind=? AND scope_id=?''', (uid,event_id,kind,sid))
    version = old['version'] if old else 0
    if type(body.get('base_version')) is not int or body['base_version'] != version:
        raise conflict('授权已变化，请刷新后核对', code='grant_version_conflict')
    db.ensure_user_snapshot(ctx.conn, target)
    ctx.conn.execute('''INSERT INTO review_grants VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id,event_id,scope_kind,scope_id) DO UPDATE SET
        version=excluded.version,active=excluded.active,granted_by=excluded.granted_by,
        reason=excluded.reason,updated_at=excluded.updated_at''',
        (uid,event_id,kind,sid,version+1,int(body['active']),user['id'],body['reason'].strip(),db.now(ctx.conn)))
    security.audit(ctx.conn,user,'review_grant','user',uid,
        {'before':dict(old) if old else None,'scope_kind':kind,'scope_id':sid,
         'version':version+1,'active':body['active'],'reason':body['reason'].strip()})
    return {'message':'复核授权已更新','version':version+1}
