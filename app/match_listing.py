"""Authorized, bounded match pages. Counts and rows use one read snapshot."""
from __future__ import annotations

from contextlib import contextmanager

from . import db, list_revision
from .errors import bad_request, conflict
from .api.common import serialize_matches


@contextmanager
def read_snapshot(conn):
    nested = conn.in_transaction
    if not nested:
        conn.execute('BEGIN')
    try:
        yield
    finally:
        if not nested and conn.in_transaction:
            conn.execute('ROLLBACK')


def _integer(ctx, name, default=None, minimum=0, maximum=None):
    raw = ctx.arg(name)
    if raw is None:
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise bad_request(f'{name} 必须是整数') from None
    if n < minimum or (maximum is not None and n > maximum):
        raise bad_request(f'{name} 超出允许范围')
    return n


def list_page(ctx, queue=False):
    explicit = ctx.arg('offset') is not None
    offset = _integer(ctx, 'offset', 0)
    limit = _integer(ctx, 'limit', 100 if explicit else 500, 1, 200 if explicit else 500)
    where, args = [], []
    for name, col in (('category_id', 'm.category_id'), ('group_id', 'g.id'),
                      ('event_id', 'g.event_id'), ('stage_id', 'm.stage_id'),
                      ('pool_id', 'm.pool_id'), ('venue_id', 'm.venue_id'), ('round_no', 'm.round_no')):
        if ctx.arg(name):
            where.append(col + '=?')
            args.append(_integer(ctx, name, minimum=1))
    for name, col in (('status', 'm.status'), ('result_status', 'm.result_status'), ('kind', 'c.kind')):
        if ctx.arg(name):
            where.append(col + '=?')
            args.append(ctx.arg(name))
    if ctx.arg('date'):
        where.append('substr(m.scheduled_at,1,10)=?')
        args.append(ctx.arg('date'))
    if queue:
        where.append("m.status IN ('ready','finished') AND m.reset_state IN ('none','active')")
    if (ctx.user or {}).get('role') == 'viewer':
        where.append("""(m.status IN ('pending','ready','finished') AND json_extract(st.params_json,'$.schedule_meta.state')='confirmed' OR
             m.status IN ('ready','finished') AND json_extract(st.params_json,'$.schedule_meta') IS NULL AND pl.status IN ('locked','running','archived'))""")
    joins = '''FROM matches m JOIN categories c ON c.id=m.category_id
        JOIN groups g ON g.id=c.group_id JOIN plans pl ON pl.id=m.plan_id
        LEFT JOIN venues v ON v.id=m.venue_id LEFT JOIN stages st ON st.id=m.stage_id'''
    if ctx.arg('q'):
        joins += ''' LEFT JOIN participations hp ON hp.id=COALESCE(m.home_actual,m.home_participation)
                AND hp.deleted_at IS NULL
            LEFT JOIN teams ht ON ht.id=hp.team_id LEFT JOIN athletes ha ON ha.id=hp.athlete_id
            LEFT JOIN schools hs ON hs.id=COALESCE(ht.school_id,ha.school_id)
            LEFT JOIN participations ap ON ap.id=COALESCE(m.away_actual,m.away_participation)
                AND ap.deleted_at IS NULL
            LEFT JOIN teams at ON at.id=ap.team_id LEFT JOIN athletes aa ON aa.id=ap.athlete_id
            LEFT JOIN schools ass ON ass.id=COALESCE(at.school_id,aa.school_id)'''
        search = '%' + ctx.arg('q').strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        cols = ('m.round_label', 'c.name', 'g.name', 'ht.name', 'ha.name', 'hs.name', 'hs.short_name',
                'at.name', 'aa.name', 'ass.name', 'ass.short_name')
        where.append('(' + ' OR '.join(f"{col} LIKE ? ESCAPE '\\'" for col in cols) + ')')
        args.extend([search] * len(cols))
    predicate = ' WHERE ' + ' AND '.join(where) if where else ''
    sort = ctx.arg('sort') or ('queue' if queue else 'schedule')
    if sort not in ('queue', 'schedule', 'recent', 'round'):
        raise bad_request('排序方式无效')
    order = "g.seq,c.seq,NULLIF(TRIM(m.scheduled_at),'') IS NULL,NULLIF(TRIM(m.scheduled_at),''),m.stage_id,m.round_no,m.seq,m.id"
    if sort == 'queue':
        order = "CASE m.status WHEN 'ready' THEN 0 ELSE 1 END," + order
    elif sort == 'round':
        order = 'g.seq,c.seq,st.seq,m.round_no,m.seq,m.id'
    elif sort == 'recent':
        if offset:
            raise bad_request('最近成绩只支持单页查询')
        order = 'm.updated_at DESC,m.id DESC'
    with read_snapshot(ctx.conn):
        rev = list_revision.value(ctx.conn)
        requested = _integer(ctx, 'list_revision')
        if offset and requested is None:
            raise bad_request('翻页必须携带 list_revision')
        if offset and requested != rev:
            raise conflict('比赛列表已更新，请刷新后继续查看', code='list_changed', detail={'list_revision': rev})
        total = db.q1(ctx.conn, 'SELECT COUNT(*) AS n ' + joins + predicate, args)['n']
        if not explicit and total > limit:
            raise conflict('场次较多，请升级页面并使用分页读取', code='pagination_required',
                           detail={'total': total, 'max_limit': 200})
        rows = db.q(ctx.conn, '''SELECT m.*,c.name AS category_name,c.kind AS category_kind,
            c.gender AS category_gender,g.name AS group_name ''' + joins + predicate
                    + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', args + [limit, offset])
        out = serialize_matches(ctx.conn, rows, with_sets=ctx.arg('with_sets', '0') == '1')
        for item, row in zip(out, rows):
            item.update({'category_name': row['category_name'], 'category_kind': row['category_kind'],
                         'category_gender': row['category_gender'], 'group_name': row['group_name'],
                         'category_label': f"{row['group_name']} / {row['category_name']}",
                         'scoreable': item['can_score']})
    return {'matches': out, 'total': total, 'offset': offset, 'limit': limit,
            'has_more': offset + len(out) < total, 'list_revision': rev}
