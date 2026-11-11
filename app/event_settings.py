"""Persistent event setup lock; registration and competition remain independent."""
import json
import re
import threading
from contextlib import nullcontext
from . import db
from .errors import conflict

_writes = threading.RLock()


def write_guard(ctx):
    # Serialize setup changes with lock/unlock before either database transaction starts.
    relevant = re.fullmatch(r'/api/events/\d+(?:/(?:bootstrap|groups|venues|team-rules|settings-lock))?', ctx.path) \
        or re.fullmatch(r'/api/(?:groups|categories|venues)/\d+(?:/(?:categories|team-rules))?', ctx.path)
    return _writes if ctx.method != 'GET' and relevant else nullcontext()


def read(event_id):
    row = db.q1(db.get_conn(), 'SELECT v FROM settings WHERE k=?', (f'event-settings-lock:{event_id}',))
    return json.loads(row['v']) if row else {'locked': False, 'version': 0}


def guard(ctx):
    if ctx.method == 'GET':
        return
    event = re.fullmatch(r'/api/events/(\d+)(?:/(bootstrap|groups|venues|team-rules))?', ctx.path)
    if event:
        eid = int(event[1])
    else:
        resource = re.fullmatch(r'/api/(groups|categories|venues)/(\d+)(?:/(categories|team-rules))?', ctx.path)
        if not resource:
            return
        table, sid = resource[1], int(resource[2])
        sql = ('SELECT g.event_id FROM categories c JOIN groups g ON g.id=c.group_id WHERE c.id=?'
               if table == 'categories' else f'SELECT event_id FROM {table} WHERE id=?')
        row = db.q1(ctx.conn, sql, (sid,))
        if not row:
            return
        eid = row['event_id']
    if read(eid)['locked']:
        raise conflict('赛事设置已锁定，请由赛事管理员解锁后修改', code='event_settings_locked')
