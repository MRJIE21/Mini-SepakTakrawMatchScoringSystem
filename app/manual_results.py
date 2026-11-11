"""人工结果是独立的最终快照；不调用抽签、排序或成绩积分算法。"""
import json
from collections import OrderedDict

from . import db, idempotency
from .errors import conflict


def snapshot(conn, cid):
    saved = db.q1(conn, 'SELECT * FROM manual_result_sets WHERE category_id=?', (cid,))
    if not saved:
        return None
    from .api.group_draw import roster_for
    from .individual_draw_store import roster, same_roster
    cat = db.q1(conn, 'SELECT kind FROM categories WHERE id=?', (cid,))
    active = roster_for(conn, cid) if cat['kind'] == 'team' else roster(conn, cid)
    by_id = {r['id']: r for r in active}
    entries = []
    for row in db.q(conn, 'SELECT * FROM manual_result_rows WHERE category_id=? ORDER BY row_seq,participation_id', (cid,)):
        person = by_id.get(row['participation_id'])
        if person:
            entries.append({**person, 'participation_id': person['id'], 'group_name': row['group_name'],
                            'draw_order': row['rank_no']})
    groups = OrderedDict()
    for entry in entries:
        if cat['kind'] == 'team':
            groups.setdefault(entry['group_name'], []).append(entry)
    return {'category_id': cid, 'revision': saved['revision'], 'source': 'manual',
            'status': 'current' if same_roster(json.loads(saved['roster_json']), active) else 'stale',
            'entries': entries, 'groups': [{'name': key, 'members': value} for key, value in groups.items()],
            'confirmed_at': saved['imported_at'], 'confirmed_by': saved['imported_by']}


def require_current(conn, cid, revision):
    result = snapshot(conn, cid)
    if not result or result['status'] != 'current' or result['revision'] != revision:
        raise conflict('人工结果或报名名单已变化，请重新预览', code='manual_result_changed')
    return result


def existing(conn, cat):
    manual = snapshot(conn, cat['id'])
    if manual:
        return {e['id']: e['group_name'] if cat['kind'] == 'team' else e['draw_order'] for e in manual['entries']}
    if cat['kind'] == 'individual':
        from .individual_draw_store import read
        return {e['id']: e['draw_order'] for e in read(conn, cat['id'])['entries']}
    from .api.group_draw import latest_draw, draw_detail
    draw = draw_detail(conn, latest_draw(conn, cat['id']))
    if draw and draw['status'] == 'confirmed':
        return {m['participation_id']: g['name'] for g in draw['groups'] for m in g['members']}
    return {}


def guard(conn, cat):
    if cat['kind'] == 'team':
        from .api.group_draw import ensure_editable, latest_draw
        ensure_editable(conn, cat['id'])
        draw = latest_draw(conn, cat['id'])
        if draw and draw['status'] in ('drawing', 'complete'):
            raise conflict('请先确认或撤销当前抽签过程，再导入人工结果')
    else:
        from .individual_draw_store import locked_reason
        reason = locked_reason(conn, cat['id'])
        if reason:
            raise conflict(reason, code='individual_draw_locked')
        if db.q1(conn, "SELECT id FROM individual_draw_sessions WHERE category_id=? AND status IN ('drawing','complete')", (cat['id'],)):
            raise conflict('请先确认或撤销当前抽取过程，再导入人工结果')


def basis(conn, cat):
    # 绑定当前结果、名单、保护状态和修订；提交时在写事务中重新验证。
    from .api.group_draw import roster_for, latest_draw
    from .individual_draw_store import roster
    active = roster_for(conn, cat['id']) if cat['kind'] == 'team' else roster(conn, cat['id'])
    draw = latest_draw(conn, cat['id']) if cat['kind'] == 'team' else db.q1(conn, 'SELECT * FROM individual_draws WHERE category_id=?', (cat['id'],))
    return idempotency.content_hash({'category': cat, 'roster': active, 'existing': existing(conn, cat),
                                     'manual': snapshot(conn, cat['id']), 'draw': dict(draw) if draw else None})
