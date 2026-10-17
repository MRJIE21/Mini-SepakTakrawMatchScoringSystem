"""个人赛逐人抽取接口、严格幂等回执与旧一次性预览收口。

DESIGN_V3「逐次抽取接口」+「既有规则衔接」：

- 抽取过程持久化在 ``individual_draw_sessions``（见 app/individual_draw_session_store.py），
  本模块只负责鉴权、事件身份核对、事务边界、幂等回执与响应形状；每一步的随机抽取
  由 :func:`app.domain.individual_draw.default_pick` 在调用方事务内完成，客户端不能
  提交候选、随机种子或排列。
- 每个 POST 都在 http_server 的 ``db.tx``（BEGIN IMMEDIATE）里调用
  ``idempotency.replay_or_run(..., strict=True)``：同一 request_uid 原包只重放原回执，
  **绝不再次调用随机源**；同一 UID 换包、换账号或换 scope 一律 409 ``request_uid_reused``。
- ``request_log`` 只保存精简回执与项目号，不保存整份名单（避免每步平方增长）；
  POST 响应里的 ``session`` 每次都重新读取当前会话。
- 会话冲突在 HTTP 上是 409 且响应体带 ``not_committed``（detail 显式标记，顶层
  ``outcome`` 由 http_server 在事务回滚时同样标记），前端据此安全丢弃本地待核实包。
- 旧一次性预览入口关闭：``preview`` 一律 426 ``client_upgrade_required`` 且不写库；
  旧 ``confirm`` 只允许升级前已成功回执按原包幂等重放，未提交请求同样 426。
  ``GET /individual-draw``（正式签表）与旧 ``/requests/{uid}`` 查询保持不变。
"""
from __future__ import annotations

import functools
import json
import re
import secrets
import threading
import time

from .. import db, idempotency, security
from .. import individual_draw_session_store as sessions
from .. import individual_draw_store as store
from ..domain.individual_draw import default_pick, fingerprint
from ..errors import ApiError, bad_request, conflict
from ..http_server import route

ORG = ('admin', 'organizer')
SESSION_SCOPE = 'individual_draw_session'
LEGACY_SCOPE = 'individual_draw'
UID_PATTERN = re.compile(r'[A-Za-z0-9_.-]{1,120}')
START_BODY = frozenset({'event_identity', 'request_uid'})
SESSION_BODY = frozenset({'event_identity', 'request_uid', 'session_id', 'base_revision'})
LEGACY_BODY = frozenset({'event_identity', 'request_uid', 'preview_id', 'base_revision'})
RECEIPT_OPS = ('start', 'stop', 'confirm', 'cancel')
UPGRADE_MESSAGE = '页面已升级，请刷新后使用逐人抽签过程'

# 旧预览内存表只保留做历史回执核实；本模块不再生成新的可写预览。
PREVIEWS = {}
LOCK = threading.Lock()
TTL = 600
MAX_PREVIEW_BYTES = 1024 * 1024
START_MESSAGE = '已开始逐人抽取，请逐位揭晓'
STOP_MESSAGE = '全部人员已抽取完成，请核对后确认正式出场顺序'
CONFIRM_MESSAGE = '个人赛出场顺序已保存'
CANCEL_MESSAGE = '已撤销本轮抽取过程，原正式顺序保持'


def identity(ctx, cid):
    """当前项目的冻结赛事身份；非个人赛沿用既有 400，项目不存在为 404。"""
    cat = store.category(ctx.conn, cid)
    event = db.q1(ctx.conn, 'SELECT uuid FROM events WHERE id=?', (cat['event_id'],))
    deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k='deployment_id'")
    expected = {'event_id': cat['event_id'], 'event_uuid': event['uuid'], 'deployment_id': deployment['v']}
    return expected, (ctx.user['id'], expected['event_uuid'], expected['deployment_id'], cid)


def require_identity(ctx, cid):
    """事件身份不符时明确冲突；沿用原一次性预览的校验口径。"""
    expected, owner = identity(ctx, cid)
    if ctx.body.get('event_identity') != expected:
        raise conflict('赛事身份已变化，请返回当前项目核对', code='event_identity_mismatch')
    return expected, owner


def public(data):
    """旧正式签表读取：对外不暴露内部项目行与活动名单。"""
    return {k: v for k, v in data.items() if k not in ('category', 'roster')}


def remember(value):
    """旧预览内存记录；仅保留给历史回执核实，抽取流程不再调用。"""
    if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) > MAX_PREVIEW_BYTES:
        raise bad_request('抽签名单过大，无法生成完整预览，请联系管理员核对')
    token = secrets.token_urlsafe(32)
    with LOCK:
        now = time.monotonic()
        for key in [k for k, v in PREVIEWS.items() if v['expires'] <= now]:
            PREVIEWS.pop(key)
        owned = [k for k, v in PREVIEWS.items() if v['owner'] == value['owner']]
        for key in owned[:-4]:
            PREVIEWS.pop(key)
        while len(PREVIEWS) >= 50:
            PREVIEWS.pop(next(iter(PREVIEWS)))
        PREVIEWS[token] = {**value, 'expires': now + TTL}
    return token


# ------------------------------------------------------------------ 会话派生
def session_view(data):
    """把存储层会话派生为前端契约形状。

    ``candidates`` 与 ``revealed`` 完全由服务端按名单与已抽顺序复算，不信任客户端；
    已抽行优先取会话快照（名单变化后仍能完整复算揭示顺序），候选取当前活动名单。
    """
    if not data:
        return None
    snapshot = {row['id']: row for row in data['session_roster']}
    active = {row['id']: row for row in data['roster']}
    revealed = []
    for index, participation_id in enumerate(data['order'], 1):
        row = snapshot.get(participation_id) or active.get(participation_id)
        if row is not None:
            revealed.append({**row, 'draw_order': index})
    taken = set(data['order'])
    return {'session_id': data['session_id'], 'status': data['status'],
            'revision': data['revision'], 'base_revision': data['base_revision'],
            'stale': data['stale'], 'block_reason': data['block_reason'],
            'picked': data['picked'], 'remaining': data['remaining'],
            'can_pick': data['can_pick'], 'can_confirm': data['can_confirm'],
            'roster': data['roster'], 'session_roster': data['session_roster'],
            'order': list(data['order']),
            'candidates': [row for row in data['roster'] if row['id'] not in taken],
            'revealed': revealed,
            'created_at': data['created_at'], 'updated_at': data['updated_at']}


def session_response(ctx, cid, result):
    """会话 POST 的统一响应：session 重新读取当前会话，receipt 来自精简幂等回执。

    确认/撤销后已没有活动会话，此时 ``session`` 与紧随其后的 ``GET /session`` 一样为
    ``null``，前端不会看到可误点的确认按钮。
    """
    payload = {'session': session_view(sessions.read(ctx.conn, cid)),
               'receipt': result.get('receipt') or {},
               'message': result.get('message', '')}
    if result.get('replayed'):
        payload['replayed'] = True
    return payload


def _mark_not_committed(exc):
    detail = dict(exc.detail) if isinstance(exc.detail, dict) else {}
    detail['not_committed'] = True
    return ApiError(exc.status, exc.code, exc.message, detail)


def commit_guard(view):
    """会话冲突统一带 ``not_committed``：可证明未提交，前端可安全丢弃本地待核实包。"""

    @functools.wraps(view)
    def guarded(ctx):
        try:
            return view(ctx)
        except ApiError as exc:
            if exc.status == 409:
                raise _mark_not_committed(exc) from exc
            raise

    return guarded


# ------------------------------------------------------------------ 请求校验
def request_uid(ctx):
    """request_uid 校验收紧，并禁止与 submissions 表或其他 scope 复用。"""
    uid = ctx.body.get('request_uid')
    if not isinstance(uid, str) or not UID_PATTERN.fullmatch(uid):
        raise bad_request('请求标识无效')
    if db.q1(ctx.conn, 'SELECT id FROM submissions WHERE uid=?', (uid,)):
        raise conflict('此请求标识已用于其他提交', code='request_uid_reused')
    return uid


def session_packet(ctx):
    """抽取/确认/撤销都必须是完整原始包：不接受候选、种子或排列。"""
    if set(ctx.body) != SESSION_BODY:
        raise bad_request('请使用完整原始抽取包，不能自定义候选或出场顺序')
    session_id, revision = ctx.body.get('session_id'), ctx.body.get('base_revision')
    if type(session_id) is not int or session_id <= 0 or type(revision) is not int or revision < 0:
        raise bad_request('抽取会话标识或修订号无效')
    return session_id, revision


def payload_for(ctx, op):
    """严格幂等摘要：绑定路径、方法、操作者、操作与完整包体，同一 UID 换包被拒。"""
    return {'path': ctx.path, 'method': ctx.method, 'actor': ctx.user['id'], 'op': op,
            'body': ctx.body}


def run_once(ctx, uid, op, save):
    """在调用方事务内做严格幂等：重放命中时不执行 save，因此不会再次调用随机源。"""
    return idempotency.replay_or_run(ctx.conn, ctx.user, uid, payload_for(ctx, op), save,
                                     scope=SESSION_SCOPE, strict=True)


# ------------------------------------------------------------------ 新会话接口
@route('GET', r'/api/categories/(?P<category_id>\d+)/individual-draw/session', roles=ORG)
def get_session(ctx):
    """读取当前抽取会话进度；没有活动会话时为 null，不写库、不派生随机结果。"""
    return {'session': session_view(sessions.read(ctx.conn, int(ctx.params['category_id'])))}


@route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/session/start', roles=ORG)
@commit_guard
def start_session(ctx):
    """建立空顺序会话：只记录名单快照与基线，不预排、不调用随机源。"""
    cid = int(ctx.params['category_id'])
    expected, _ = require_identity(ctx, cid)
    if set(ctx.body) != START_BODY:
        raise bad_request('开始抽取只接受赛事身份与请求标识')
    uid = request_uid(ctx)

    def save():
        session = sessions.create(ctx.conn, cid, ctx.user)
        security.audit(ctx.conn, ctx.user, 'individual_draw_session_start', 'category', cid,
                       {'session_id': session['session_id'], 'revision': session['revision'],
                        'base_revision': session['base_revision'],
                        'roster_size': len(session['session_roster']), 'event_identity': expected})
        return {'category_id': cid,
                'receipt': {'request_uid': uid, 'op': 'start', 'session_id': session['session_id'],
                            'revision': session['revision'], 'base_revision': session['base_revision'],
                            'picked_id': None, 'order_hash': fingerprint(list(session['order'])),
                            'event_identity': expected},
                'message': START_MESSAGE}

    return session_response(ctx, cid, run_once(ctx, uid, 'start', save))


@route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/session/stop', roles=ORG)
@commit_guard
def stop_session(ctx):
    """抽取下一位：服务端在事务内调用一次随机源，追加一人后立即揭晓。"""
    cid = int(ctx.params['category_id'])
    expected, _ = require_identity(ctx, cid)
    session_id, client_revision = session_packet(ctx)
    uid = request_uid(ctx)

    def save():
        session = sessions.append_pick(ctx.conn, cid, session_id, client_revision, ctx.user,
                                       default_pick)
        picked_id = session['order'][-1]
        order_hash = fingerprint(list(session['order']))
        security.audit(ctx.conn, ctx.user, 'individual_draw_session_pick', 'category', cid,
                       {'session_id': session['session_id'], 'revision': session['revision'],
                        'picked_id': picked_id, 'picked': session['picked'],
                        'status': session['status'], 'order_hash': order_hash,
                        'event_identity': expected})
        message = STOP_MESSAGE if session['status'] == 'complete' else (
            f"已揭晓第 {session['picked']} 位")
        return {'category_id': cid,
                'receipt': {'request_uid': uid, 'op': 'stop', 'session_id': session['session_id'],
                            'revision': session['revision'], 'base_revision': session['base_revision'],
                            'picked_id': picked_id, 'order_hash': order_hash,
                            'event_identity': expected},
                'message': message}

    return session_response(ctx, cid, run_once(ctx, uid, 'stop', save))


# DESIGN_V3 模块原文把「停止并揭晓」写作 /session/pick；它与 /session/stop 共用同一处理
# 函数、同一 scope 与同一 payload（op 恒为 "stop"），因此两个路径共享 UID 幂等。
route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/session/pick',
      roles=ORG)(stop_session)


@route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/session/confirm', roles=ORG)
@commit_guard
def confirm_session(ctx):
    """把完整顺序写入正式签表：未抽完、失效或阻塞时不提交，也不改动原正式顺序。"""
    cid = int(ctx.params['category_id'])
    expected, _ = require_identity(ctx, cid)
    session_id, client_revision = session_packet(ctx)
    uid = request_uid(ctx)

    def save():
        current = sessions.read(ctx.conn, cid)
        saved = sessions.confirm(ctx.conn, cid, session_id, client_revision, uid, ctx.user)
        security.audit(ctx.conn, ctx.user, 'individual_draw_session_confirm', 'category', cid,
                       {'session_id': session_id, 'revision': current['revision'],
                        'base_revision': current['base_revision'], 'order_hash': saved['order_hash'],
                        'formal_revision': saved['draw']['revision'], 'event_identity': expected})
        return {'category_id': cid,
                'receipt': {'request_uid': uid, 'op': 'confirm', 'session_id': session_id,
                            'revision': current['revision'], 'base_revision': current['base_revision'],
                            'picked_id': None, 'order_hash': saved['order_hash'],
                            'event_identity': expected},
                'message': CONFIRM_MESSAGE}

    return session_response(ctx, cid, run_once(ctx, uid, 'confirm', save))


@route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/session/cancel', roles=ORG)
@commit_guard
def cancel_session(ctx):
    """撤销本轮抽取并保留已抽快照；名单失效或开赛阻塞时仍可明确撤销。"""
    cid = int(ctx.params['category_id'])
    expected, _ = require_identity(ctx, cid)
    session_id, client_revision = session_packet(ctx)
    uid = request_uid(ctx)

    def save():
        current = sessions.read(ctx.conn, cid)
        cancelled = sessions.cancel(ctx.conn, cid, session_id, client_revision, ctx.user)
        order_hash = fingerprint(list(current['order']))
        security.audit(ctx.conn, ctx.user, 'individual_draw_session_cancel', 'category', cid,
                       {'session_id': session_id, 'revision': current['revision'],
                        'base_revision': current['base_revision'], 'picked': cancelled['picked'],
                        'order_hash': order_hash, 'event_identity': expected})
        return {'category_id': cid,
                'receipt': {'request_uid': uid, 'op': 'cancel', 'session_id': session_id,
                            'revision': current['revision'], 'base_revision': current['base_revision'],
                            'picked_id': None, 'order_hash': order_hash,
                            'event_identity': expected},
                'message': CANCEL_MESSAGE}

    return session_response(ctx, cid, run_once(ctx, uid, 'cancel', save))


@route('GET', r'/api/categories/(?P<category_id>\d+)/individual-draw/session/requests/'
             r'(?P<uid>[A-Za-z0-9_.-]{1,120})', roles=ORG)
def session_request_result(ctx):
    """按原账号 + 项目 + 事件身份 + scope 精确命中回执；不同账号或项目不得命中。"""
    cid = int(ctx.params['category_id'])
    expected, _ = identity(ctx, cid)
    uid = ctx.params['uid']
    row = db.q1(ctx.conn, 'SELECT * FROM request_log WHERE uid=? AND scope=? AND user_id=?',
                (uid, SESSION_SCOPE, ctx.user['id']))
    if not row:
        return {'found': False}
    try:
        result = json.loads(row['result_json'] or '{}')
    except ValueError:
        return {'found': False}
    receipt = result.get('receipt') if isinstance(result, dict) else None
    if (isinstance(receipt, dict) and result.get('category_id') == cid
            and receipt.get('request_uid') == uid and receipt.get('op') in RECEIPT_OPS
            and receipt.get('event_identity') == expected
            and type(receipt.get('session_id')) is int
            and type(receipt.get('revision')) is int
            and type(receipt.get('base_revision')) is int):
        return {'found': True, 'receipt': receipt}
    return {'found': False}


# ------------------------------------------------------------------ 旧接口兼容
@route('GET', r'/api/categories/(?P<category_id>\d+)/individual-draw')
def get_draw(ctx):
    """正式签表读取保持不变，沿用正式签表查看权限。"""
    return {'draw': public(store.read(ctx.conn, int(ctx.params['category_id'])))}


@route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/preview', roles=ORG)
@commit_guard
def preview(ctx):
    """旧一次性预览入口关闭：明确 426 且不生成预览、不写库。"""
    cid = int(ctx.params['category_id'])
    if set(ctx.body) - {'event_identity'}:
        raise bad_request('预览不接受自定义出场顺序')
    require_identity(ctx, cid)
    raise ApiError(426, 'client_upgrade_required', UPGRADE_MESSAGE,
                   {'not_committed': True,
                    'message': '请刷新页面，改用逐人抽取过程重新开始'})


@route('POST', r'/api/categories/(?P<category_id>\d+)/individual-draw/confirm', roles=ORG)
@commit_guard
def confirm(ctx):
    """旧一次性确认：先按原账号与历史回执幂等重放，未提交请求明确 426。

    payload 必须与升级前的旧版本完全一致（``{'path','method','actor','body'}``），
    否则升级前已提交的请求无法按原包重放。重放只返回原结果，不写任何业务数据。
    """
    cid = int(ctx.params['category_id'])
    require_identity(ctx, cid)
    if set(ctx.body) != LEGACY_BODY:
        raise bad_request('请使用完整原始预览确认包，不能指定出场序号')
    uid = ctx.body.get('request_uid')
    token, revision = ctx.body.get('preview_id'), ctx.body.get('base_revision')
    if (not isinstance(uid, str) or not UID_PATTERN.fullmatch(uid)
            or not isinstance(token, str) or not 1 <= len(token) <= 100
            or type(revision) is not int or revision < 0):
        raise bad_request('抽签确认标识或修订号无效')
    if db.q1(ctx.conn, 'SELECT id FROM submissions WHERE uid=?', (uid,)):
        raise conflict('此请求标识已用于其他提交', code='request_uid_reused')
    payload = {'path': ctx.path, 'method': ctx.method, 'actor': ctx.user['id'], 'body': ctx.body}

    def save():
        raise ApiError(426, 'client_upgrade_required', UPGRADE_MESSAGE,
                       {'not_committed': True,
                        'message': '旧预览未能提交，请核对后放弃并改用逐人抽取过程'})

    return idempotency.replay_or_run(ctx.conn, ctx.user, uid, payload, save,
                                     scope=LEGACY_SCOPE, strict=True)


@route('GET', r'/api/categories/(?P<category_id>\d+)/individual-draw/requests/'
             r'(?P<uid>[A-Za-z0-9_.-]{1,120})', roles=ORG)
def request_result(ctx):
    """旧路径继续可查询已提交的一次性预览回执。"""
    cid = int(ctx.params['category_id'])
    expected, _ = identity(ctx, cid)
    row = db.q1(ctx.conn, "SELECT * FROM request_log WHERE uid=? AND scope=? AND user_id=?",
                (ctx.params['uid'], LEGACY_SCOPE, ctx.user['id']))
    if row:
        result = json.loads(row['result_json'])
        receipt = result.get('receipt', {})
        if receipt.get('category_id') == cid and receipt.get('event_identity') == expected:
            return {'found': True, 'receipt': receipt}
    return {'found': False}
