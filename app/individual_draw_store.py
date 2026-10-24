"""One saved starting order per individual category; historical labels stay in audit."""
import json
from . import db
from .domain.individual_draw import fingerprint, validate_order
from .errors import bad_request, conflict, not_found


def backup_before_upgrade(conn):
    tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'categories' in tables and 'individual_draws' not in tables:
        from .team_rules_store import _backup
        # serve() scans event_*.db; snapshots must never enter that upgrade scan.
        _backup(conn, '.before-individual-draw-v1.sqlite')


def category(conn, cid):
    row = db.q1(conn, '''SELECT c.*,g.event_id FROM categories c
        JOIN groups g ON g.id=c.group_id WHERE c.id=?''', (cid,))
    if not row:
        raise not_found('个人赛项目不存在')
    if row['kind'] != 'individual':
        raise bad_request('该项目不是个人赛')
    return dict(row)


def roster(conn, cid):
    return db.rows_to_dicts(db.q(conn, '''SELECT p.id,p.athlete_id,a.school_id,a.group_id,a.gender,
        a.name AS name,s.name AS school_name,s.short_name AS school_short
        FROM participations p JOIN athletes a ON a.id=p.athlete_id
        JOIN schools s ON s.id=a.school_id WHERE p.category_id=? AND p.status='active'
        ORDER BY p.id''', (cid,)))


def locked_reason(conn, cid):
    if db.q1(conn,"SELECT name FROM sqlite_master WHERE type='table' AND name='result_candidates'") and db.q1(
            conn,'SELECT id FROM result_candidates WHERE category_id=? LIMIT 1',(cid,)):
        return '项目已有结果候选或成绩，不能重新抽签'
    if db.q1(conn, '''SELECT p.id FROM participations p WHERE p.category_id=? AND
        (EXISTS(SELECT 1 FROM settings s WHERE s.k='recording:individual:' || p.id)
        OR EXISTS(SELECT 1 FROM individual_results r WHERE r.participation_id=p.id)
        OR EXISTS(SELECT 1 FROM placements r WHERE r.participation_id=p.id)) LIMIT 1''', (cid,)):
        return '项目已有记录任务领取或成绩，不能重新抽签'
    return ''


def read(conn, cid):
    cat = category(conn, cid)
    active = roster(conn, cid)
    saved = db.q1(conn, 'SELECT * FROM individual_draws WHERE category_id=?', (cid,))
    status, revision, entries = 'none', 0, []
    if saved:
        try:
            old_roster, order = json.loads(saved['roster_json']), json.loads(saved['order_json'])
            validate_order(order, old_roster)
            if type(saved['revision']) is not int or saved['revision'] < 1:
                raise ValueError('无效修订')
        except (ValueError, TypeError, KeyError) as exc:
            raise conflict('已保存抽签数据异常，请联系管理员核对', code='invalid_saved_draw') from exc
        revision = saved['revision']
        status = 'current' if old_roster == active else 'stale'
        by_id = {r['id']: r for r in old_roster}
        active_ids = {r['id'] for r in active}
        entries = [{**by_id[pid], 'draw_order': i, 'active': pid in active_ids}
                   for i, pid in enumerate(order, 1)]
    reason = locked_reason(conn, cid)
    return {'category_id': cid, 'status': status, 'revision': revision, 'entries': entries,
            'roster': active, 'can_draw': bool(active) and not reason,
            'block_reason': reason or ('' if active else '请先完成运动员报名'),
            'confirmed_at': saved['confirmed_at'] if saved else None,
            'order_hash': fingerprint([r['id'] for r in entries]) if saved else None,
            'category': cat}


def basis(conn, cid):
    data = read(conn, cid)
    return fingerprint({k: data[k] for k in ('category', 'roster', 'revision', 'block_reason')})


def guard_recording(conn, cid):
    if read(conn, cid)['status'] == 'stale':
        raise conflict('报名名单已变化，请先重新核对个人赛出场抽签顺序', code='individual_draw_stale')


def attach(conn, cid, participations):
    data = read(conn, cid)
    positions = {r['id']: r['draw_order'] for r in data['entries']}
    for row in participations:
        row['draw_order'] = positions.get(row['id'])
        row['draw_status'] = data['status']
    if data['status'] == 'current':
        participations.sort(key=lambda r: (r['status'] != 'active', positions.get(r['id'], 10**12), r['id']))
    return data
