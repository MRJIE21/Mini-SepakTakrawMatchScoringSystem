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
        AND p.deleted_at IS NULL
        ORDER BY p.id''', (cid,)))


def same_roster(saved, current):
    """名称变更不改变参赛身份或已确认的出场顺序。"""
    display_fields = {'name', 'school_name', 'school_short', 'display'}
    def identity(rows):
        return [{key: value for key, value in row.items() if key not in display_fields}
                for row in rows]
    return identity(saved) == identity(current)


def locked_reason(conn, cid):
    if db.q1(conn, 'SELECT k FROM settings WHERE k=?', (f'recording:individual_project:{cid}',)):
        return '项目已有记录任务领取或成绩，不能重新抽签'
    if db.q1(conn, '''SELECT p.id FROM participations p WHERE p.category_id=? AND p.deleted_at IS NULL AND
        (EXISTS(SELECT 1 FROM settings s WHERE s.k='recording:individual:' || p.id)
        OR EXISTS(SELECT 1 FROM individual_results r WHERE r.participation_id=p.id)
        OR EXISTS(SELECT 1 FROM placements r WHERE r.participation_id=p.id)) LIMIT 1''', (cid,)):
        return '项目已有记录任务领取或成绩，不能重新抽签'
    return ''


def read(conn, cid):
    cat = category(conn, cid)
    active = roster(conn, cid)
    from .manual_results import snapshot
    manual = snapshot(conn, cid)
    if manual:
        reason = locked_reason(conn, cid)
        return {'category_id': cid, 'status': manual['status'], 'revision': manual['revision'],
                'entries': [{**e, 'active': True} for e in manual['entries']], 'roster': active,
                'can_draw': False, 'source': 'manual',
                'block_reason': reason or '已录入人工出场顺序；可通过导入显式覆盖，不自动重新抽取',
                'confirmed_at': manual['confirmed_at'],
                'order_hash': fingerprint([(e['id'], e['draw_order']) for e in manual['entries']]), 'category': cat}
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
        status = 'current' if same_roster(old_roster, active) else 'stale'
        by_id = {r['id']: r for r in old_roster}
        by_id.update({r['id']: r for r in active})
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
