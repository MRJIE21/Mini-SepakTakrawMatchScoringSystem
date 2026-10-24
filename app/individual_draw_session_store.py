"""逐人抽取过程的持久化存储。

一次完整预览改为「后台逐人抽取会话」：本项目最多一份 drawing/complete 会话，
名单快照与已揭晓顺序独立于正式签表 individual_draws。
正式顺序只在最终确认时替换，抽取过程本身不改成绩、名次或比赛记录。

本模块只负责存取与不变量校验，不生成随机数、不决定候选人；随机抽取由
``app.domain.individual_draw.pick_one`` 在调用方事务内完成。
"""
import json
import sqlite3
from . import db
from .domain.individual_draw import validate_progress
from .errors import bad_request, conflict, not_found

ACTIVE_STATUSES = ('drawing', 'complete')
MAX_SESSION_BYTES = 1024 * 1024
MAX_STORED_SESSIONS = 32
ORDERING_LOCK = '项目已有记录任务领取或成绩，不能继续逐人抽取'


def backup_before_upgrade(conn):
    """升级前为不含新表的旧库留 .sqlite 快照；serve() 只扫 event_*.db，故用 .sqlite 后缀。"""
    tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'categories' in tables and 'individual_draw_sessions' not in tables:
        from .team_rules_store import _backup
        _backup(conn, '.before-individual-draw-session-v1.sqlite')


def _category(conn, cid):
    row = db.q1(conn, '''SELECT c.id,c.kind,c.group_id,g.event_id FROM categories c
        JOIN groups g ON g.id=c.group_id WHERE c.id=?''', (cid,))
    if not row:
        raise not_found('个人赛项目不存在')
    if row['kind'] != 'individual':
        raise bad_request('该项目不是个人赛')
    return dict(row)


def _roster(conn, cid):
    return db.rows_to_dicts(db.q(conn, '''SELECT p.id,p.athlete_id,a.school_id,a.group_id,a.gender,
        a.name AS name,s.name AS school_name,s.short_name AS school_short
        FROM participations p JOIN athletes a ON a.id=p.athlete_id
        JOIN schools s ON s.id=a.school_id WHERE p.category_id=? AND p.status='active'
        ORDER BY p.id''', (cid,)))


def _locked_reason(conn, cid):
    """开赛保护：已领取记录、已有成绩或名次时不得继续抽取或确认。"""
    if db.q1(conn,"SELECT name FROM sqlite_master WHERE type='table' AND name='result_candidates'") and db.q1(
            conn,'SELECT id FROM result_candidates WHERE category_id=? LIMIT 1',(cid,)):
        return ORDERING_LOCK
    if db.q1(conn, '''SELECT p.id FROM participations p WHERE p.category_id=? AND
        (EXISTS(SELECT 1 FROM settings s WHERE s.k='recording:individual:' || p.id)
        OR EXISTS(SELECT 1 FROM individual_results r WHERE r.participation_id=p.id)
        OR EXISTS(SELECT 1 FROM placements r WHERE r.participation_id=p.id)) LIMIT 1''', (cid,)):
        return ORDERING_LOCK
    return ''


def formal_revision(conn, cid):
    row = db.q1(conn, 'SELECT revision FROM individual_draws WHERE category_id=?', (cid,))
    return int(row['revision']) if row else 0


def roster_basis(conn, cid):
    """活动报名与正式签表修订的摘要；GET 与各 POST 都按同一算法复核。"""
    from .domain.individual_draw import fingerprint
    active = _roster(conn, cid)
    return fingerprint({'category_id': cid, 'roster': active, 'revision': formal_revision(conn, cid)}), active


def encode_roster(active):
    text = json.dumps(active, ensure_ascii=False)
    if len(text.encode('utf-8')) > MAX_SESSION_BYTES:
        raise bad_request('抽签名单过大，无法保存抽取过程，请联系管理员核对')
    return text


def _decode_fields(row):
    session_id, cid, status = row['id'], row['category_id'], row['status']
    if status not in ('drawing', 'complete', 'confirmed', 'cancelled'):
        raise conflict('本项目抽取过程状态异常，请联系管理员核对', code='draw_session_corrupt')
    try:
        roster = json.loads(row['roster_json'])
        order = json.loads(row['order_json'])
        roster_hash = row['roster_hash']
        base_revision, revision = row['base_revision'], row['revision']
        if not isinstance(roster, list) or not roster:
            raise ValueError('名单快照为空')
        if not isinstance(roster_hash, str) or not roster_hash:
            raise ValueError('名单摘要缺失')
        if type(base_revision) is not int or base_revision < 0:
            raise ValueError('基础修订无效')
        if type(revision) is not int or revision < 1:
            raise ValueError('会话修订无效')
        validate_progress(order, roster)
    except (ValueError, TypeError, KeyError) as exc:
        raise conflict('本项目抽取过程数据异常，请联系管理员核对', code='draw_session_corrupt') from exc
    return {'session_id': session_id, 'category_id': cid, 'status': status,
            'roster_hash': roster_hash, 'base_revision': base_revision, 'revision': revision,
            'roster': roster, 'order': order,
            'created_by': row['created_by'], 'picked_by': row['picked_by'],
            'created_at': row['created_at'], 'updated_at': row['updated_at'],
            'confirmed_at': row['confirmed_at']}


def _derive(conn, data):
    """只读派生：本轮是否仍可继续、失效或阻塞原因，以及运行所需名单。"""
    cid = data['category_id']
    basis, active = roster_basis(conn, cid)
    stale = basis != data['roster_hash']
    locked = _locked_reason(conn, cid) if not stale else ''
    if stale:
        block_reason = '报名名单或正式签表已变化，本轮抽取已失效，请核对后撤销并重新开始'
    elif locked:
        block_reason = locked
    else:
        block_reason = ''
    recorded = len(data['order'])
    remaining_count = max(len(data['roster']) - recorded, 0)
    if stale:
        remaining_count = len(active) - recorded if len(active) > recorded else 0
    return {'session_id': data['session_id'], 'category_id': cid, 'status': data['status'],
            'revision': data['revision'], 'base_revision': data['base_revision'],
            'stale': stale, 'block_reason': block_reason,
            'roster': active, 'session_roster': data['roster'],
            'order': data['order'], 'picked': recorded,
            'remaining': remaining_count,
            'can_pick': data['status'] == 'drawing' and not stale and not locked,
            'can_confirm': data['status'] == 'complete' and not stale and not locked,
            'created_at': data['created_at'], 'updated_at': data['updated_at']}


def _read_session(conn, cid):
    """读取当前活动会话（只读，无副作用）。没有活动会话时返回 None。"""
    _category(conn, cid)
    row = db.q1(conn, '''SELECT * FROM individual_draw_sessions WHERE category_id=?
        AND status IN ('drawing','complete') ORDER BY id DESC LIMIT 1''', (cid,))
    if not row:
        return None
    # 部分唯一索引保证至多一份；这里只防御手工改库造成的多重活动会话。
    if db.q1(conn, '''SELECT COUNT(*) AS n FROM individual_draw_sessions
            WHERE category_id=? AND status IN ('drawing','complete')''', (cid,))['n'] > 1:
        raise conflict('本项目存在多轮未收尾的抽取过程，请先撤销其中一个', code='draw_session_conflict')
    return _derive(conn, _decode_fields(row))


def read(conn, cid):
    """HTTP GET 入口：读取当前会话进度，不写库、不派生随机结果。"""
    return _read_session(conn, cid)


def create(conn, cid, user):
    """建立空顺序会话；每项目至多一份，已存在活动会话或不可抽签时明确拒绝。"""
    _category(conn, cid)
    if _read_session(conn, cid):
        raise conflict('本项目已有进行中的抽取过程，请继续或先撤销', code='draw_session_exists')
    locked = _locked_reason(conn, cid)
    if locked:
        raise conflict(locked, code='individual_draw_locked')
    basis, active = roster_basis(conn, cid)
    if not active:
        raise conflict('请先完成运动员报名', code='individual_draw_empty')
    uid = str(user['id']) if user else None
    try:
        session_id = db.insert(conn, 'individual_draw_sessions', {
            'category_id': cid, 'roster_json': encode_roster(active), 'order_json': '[]',
            'roster_hash': basis, 'base_revision': formal_revision(conn, cid), 'revision': 1,
            'status': 'drawing', 'created_by': uid, 'picked_by': uid})
    except sqlite3.IntegrityError as exc:
        raise conflict('本项目已有进行中的抽取过程，请继续或先撤销', code='draw_session_exists') from exc
    row = db.q1(conn, 'SELECT * FROM individual_draw_sessions WHERE id=?', (session_id,))
    return _derive(conn, _decode_fields(row))


def mismatch(conn, cid, session_id):
    """修订竞争或身份不符时的统一响应体（HTTP 层转 409 not_committed）。"""
    current = _read_session(conn, cid)
    server = current['revision'] if current else 0
    if current and session_id is not None and current['session_id'] != session_id:
        return '抽取会话已更换，请读取最新进度后继续', server
    if current is None:
        return '本轮抽取过程已结束或已被撤销，请读取最新进度', server
    return f'抽取进度已更新到第 {server} 步，请读取最新进度后继续', server


def append_pick(conn, cid, session_id, client_revision, user, pick):
    """把一名新抽中者追加到已揭晓顺序；修订竞争或状态不符时拒绝且不写入。"""
    current = read(conn, cid)
    if not current or current['session_id'] != session_id:
        message, server = mismatch(conn, cid, session_id)
        raise conflict(message, code='session_revision_conflict', detail={'revision': server})
    if current['revision'] != client_revision:
        raise conflict('抽取进度已变化，请读取最新进度后继续', code='session_revision_conflict',
                       detail={'revision': current['revision']})
    if current['status'] != 'drawing':
        raise conflict('本轮抽取已完成，不能继续抽取', code='draw_session_not_drawing',
                       detail={'revision': current['revision']})
    if current['stale']:
        raise conflict(current['block_reason'], code='draw_session_stale',
                       detail={'revision': current['revision']})
    if current['block_reason']:
        raise conflict(current['block_reason'], code='individual_draw_locked',
                       detail={'revision': current['revision']})
    try:
        participation_id = pick(current['session_roster'], current['order'])
    except ValueError as exc:
        raise conflict(str(exc), code='draw_session_illegal_pick',
                       detail={'revision': current['revision']}) from exc
    order = validate_progress([*current['order'], participation_id], current['session_roster'])
    status = 'complete' if len(order) == len(current['session_roster']) else 'drawing'
    uid = str(user['id']) if user else None
    db.run(conn, '''UPDATE individual_draw_sessions SET order_json=?, revision=revision+1,
        status=?, picked_by=?, updated_at=datetime('now','localtime') WHERE id=?''',
           (json.dumps(order), status, uid, session_id))
    row = db.q1(conn, 'SELECT * FROM individual_draw_sessions WHERE id=?', (session_id,))
    return _derive(conn, _decode_fields(row))


def confirm(conn, cid, session_id, client_revision, request_uid, user):
    """把完整顺序写入正式签表；未抽完、失效、阻塞或修订竞争时拒绝。"""
    current = read(conn, cid)
    if not current or current['session_id'] != session_id:
        message, server = mismatch(conn, cid, session_id)
        raise conflict(message, code='session_revision_conflict', detail={'revision': server})
    if current['revision'] != client_revision:
        raise conflict('抽取进度已变化，请读取最新进度后继续', code='session_revision_conflict',
                       detail={'revision': current['revision']})
    if current['status'] != 'complete':
        raise conflict(f"还有 {max(current['remaining'], 0)} 人未抽完，不能确认正式出场顺序",
                       code='draw_session_incomplete', detail={'revision': current['revision']})
    if current['stale']:
        raise conflict(current['block_reason'], code='draw_session_stale',
                       detail={'revision': current['revision']})
    if current['block_reason']:
        raise conflict(current['block_reason'], code='individual_draw_locked',
                       detail={'revision': current['revision']})
    from .domain.individual_draw import fingerprint, validate_order
    roster = current['session_roster']
    try:
        validate_order(current['order'], roster)
    except ValueError as exc:
        raise conflict('抽取顺序与本轮名单不一致，不能确认', code='draw_session_corrupt') from exc
    revision = formal_revision(conn, cid) + 1
    db.run(conn, '''INSERT INTO individual_draws
        (category_id,revision,roster_json,order_json,confirmed_by,request_uid) VALUES(?,?,?,?,?,?)
        ON CONFLICT(category_id) DO UPDATE SET revision=excluded.revision,
        roster_json=excluded.roster_json,order_json=excluded.order_json,
        confirmed_by=excluded.confirmed_by,request_uid=excluded.request_uid,
        confirmed_at=datetime('now','localtime')''',
           (cid, revision, json.dumps(roster, ensure_ascii=False), json.dumps(current['order']),
            user['id'] if user else None, request_uid))
    db.run(conn, '''UPDATE individual_draw_sessions SET status='confirmed',
        confirmed_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?''',
           (session_id,))
    _trim_history(conn, cid)
    return {'draw': {'revision': revision, 'order': list(current['order']), 'roster': roster,
                     'confirmed_at': db.q1(conn, 'SELECT confirmed_at FROM individual_draws WHERE category_id=?',
                                           (cid,))['confirmed_at']},
            'order_hash': fingerprint(current['order']),
            'entries': [{**{r['id']: r for r in roster}[pid], 'draw_order': i}
                        for i, pid in enumerate(current['order'], 1)]}


def cancel(conn, cid, session_id, client_revision, user):
    """撤销当前会话并保留已抽快照；不改动原正式签表。"""
    current = read(conn, cid)
    if not current or current['session_id'] != session_id:
        message, server = mismatch(conn, cid, session_id)
        raise conflict(message, code='session_revision_conflict', detail={'revision': server})
    if current['revision'] != client_revision:
        raise conflict('抽取进度已变化，请读取最新进度后继续', code='session_revision_conflict',
                       detail={'revision': current['revision']})
    db.run(conn, '''UPDATE individual_draw_sessions SET status='cancelled',
        updated_at=datetime('now','localtime') WHERE id=?''', (session_id,))
    return {'cancelled': True, 'picked': len(current['order']), 'session_id': session_id}


def _trim_history(conn, cid):
    """只保留最近若干条已收尾历史快照，避免过程历史无限增长；活动会话绝不删除。"""
    rows = db.q(conn, '''SELECT id FROM individual_draw_sessions WHERE category_id=?
        AND status IN ('confirmed','cancelled') ORDER BY id DESC LIMIT -1 OFFSET ?''',
                (cid, MAX_STORED_SESSIONS))
    for row in rows:
        db.run(conn, 'DELETE FROM individual_draw_sessions WHERE id=?', (row['id'],))


def has_history(conn, cid):
    """类别删除前的冲突提示：有会话历史时给出明确冲突而非外键 500。"""
    return bool(db.q1(conn, 'SELECT id FROM individual_draw_sessions WHERE category_id=? LIMIT 1', (cid,)))
