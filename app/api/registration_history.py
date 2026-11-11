"""Administrator-only live/deleted registration history, with explicit statistical scope."""
from .. import registration_history as store
from ..errors import bad_request, not_found
from ..http_server import route


@route('GET', r'/api/registration-history', roles=('admin',), scope='registry')
def listing(ctx):
    scope = ctx.arg('scope') or 'all'
    if scope not in ('all', 'live', 'deleted'):
        raise bad_request('历史范围应为 all/live/deleted')
    try:
        offset = max(0, int(ctx.arg('offset') or 0))
        limit = min(100, max(1, int(ctx.arg('limit') or 20)))
        event_id = int(ctx.arg('event_id')) if ctx.arg('event_id') else None
    except ValueError:
        raise bad_request('分页或赛事编号不合法') from None
    query = (ctx.arg('q') or '').strip().casefold()
    rows = [row for row in store.all_rows(ctx.conn)
            if (scope == 'all' or row['event_deleted'] == (scope == 'deleted'))
            and (event_id is None or row['original_event_id'] == event_id)
            and (not query or query in ' '.join(str(row.get(k) or '') for k in
                 ('event_name', 'school_name', 'subject_name', 'category_name', 'group_name')).casefold())]
    rows.sort(key=lambda row: (row['original_event_id'], row['id']))
    counts = {'registrations': len(rows), 'live': sum(not r['event_deleted'] for r in rows),
              'archived': sum(r['event_deleted'] for r in rows),
              'withdrawn': sum(r['status'] == 'withdrawn' for r in rows),
              'registration_deleted': sum(bool(r.get('deleted_at')) for r in rows)}
    return {'rows': rows[offset:offset+limit], 'total': len(rows), 'offset': offset,
            'limit': limit, 'statistics': counts, 'statistics_scope': 'filtered_history_not_official_points'}


@route('GET', r'/api/registration-history/(?P<event_key>\d+)/(?P<participation_id>\d+)',
       roles=('admin',), scope='registry')
def detail(ctx):
    for row in store.all_rows(ctx.conn):
        if row['original_event_id'] == int(ctx.params['event_key']) and row['id'] == int(ctx.params['participation_id']):
            return {'registration': row, 'read_only': True}
    raise not_found('报名记录不存在')
