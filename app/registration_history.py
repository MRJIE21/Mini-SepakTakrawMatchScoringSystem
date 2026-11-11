"""Event deletion retains original participation IDs and immutable name/result snapshots."""
import json

from . import backup, db


def install(conn, schema):
    columns = {r['name'] for r in conn.execute('PRAGMA table_info(participations)')}
    if not columns:
        return
    if 'archived_at' in columns:
        conn.execute('''UPDATE participations SET event_id=(SELECT g.event_id FROM categories c
            JOIN groups g ON g.id=c.group_id WHERE c.id=participations.category_id)
            WHERE event_id IS NULL AND category_id IS NOT NULL AND archived_at IS NULL''')
        return
    backup.online_backup(conn, '.before-registration-history-v1.db')
    start = schema.index('CREATE TABLE IF NOT EXISTS participations (')
    end = schema.index('\n);', start) + 3
    statement = schema[start:end].replace('IF NOT EXISTS participations', 'participations_history_new')
    old_sequence = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='participations'").fetchone()
    old_sequence = old_sequence[0] if old_sequence else 0
    indexes = [r['sql'] for r in conn.execute(
        "SELECT sql FROM sqlite_master WHERE tbl_name='participations' AND type IN ('index','trigger') AND sql IS NOT NULL")]
    if conn.in_transaction:
        raise RuntimeError('Registration history migration requires an independent transaction')
    conn.execute('PRAGMA foreign_keys=OFF')
    try:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute(statement)
        names = ','.join('"' + name + '"' for name in sorted(columns))
        conn.execute(f'INSERT INTO participations_history_new({names}) SELECT {names} FROM participations')
        conn.execute('DROP TABLE participations')
        conn.execute('ALTER TABLE participations_history_new RENAME TO participations')
        conn.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='participations'", (old_sequence,))
        conn.execute('''UPDATE participations SET event_id=(SELECT g.event_id FROM categories c
            JOIN groups g ON g.id=c.group_id WHERE c.id=participations.category_id)
            WHERE category_id IS NOT NULL AND archived_at IS NULL''')
        for sql in indexes:
            conn.execute(sql)
        if conn.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('Registration history migration found foreign key violations')
        conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction:
            conn.execute('ROLLBACK')
        raise
    finally:
        conn.execute('PRAGMA foreign_keys=ON')


def current_rows(conn, event):
    result = []
    for row in db.q(conn, '''SELECT p.*,c.name category_name,c.kind,c.gender,g.name group_name,
            t.name team_name,a.name athlete_name,COALESCE(ts.name,sa.name) school_name
        FROM participations p JOIN categories c ON c.id=p.category_id
        JOIN groups g ON g.id=c.group_id
        LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN schools ts ON ts.id=t.school_id
        LEFT JOIN athletes a ON a.id=p.athlete_id LEFT JOIN schools sa ON sa.id=a.school_id
        WHERE g.event_id=? ORDER BY p.id''', (event['id'],)):
        item = dict(row)
        item.update(event_id=event['id'], original_event_id=event['id'], event_uuid=event['uuid'],
                    event_name=event['name'], event_deleted=False,
                    subject_name=row['team_name'] or row['athlete_name'] or '')
        for table, key in [('individual_results', 'results'), ('placements', 'placements'), ('school_points', 'points')]:
            item[key] = [dict(r) for r in db.q(conn, f'SELECT * FROM {table} WHERE participation_id=?', (row['id'],))]
        if row['team_id']:
            item['members'] = [dict(r) for r in db.q(conn, '''SELECT a.name,tm.jersey_no,tm.is_captain
                FROM team_members tm JOIN athletes a ON a.id=tm.athlete_id WHERE tm.team_id=?''', (row['team_id'],))]
        result.append(item)
    return result


def retain(conn, event, user_id):
    """Called inside the existing attached-database delete transaction; no independent commit."""
    # Snapshot reads use the same attached connection, so they cannot race a result writer.
    class Attached:
        def execute(self, sql, args=()):
            import re
            tables = ('participations', 'categories', 'groups', 'teams', 'schools', 'athletes',
                      'individual_results', 'placements', 'school_points', 'team_members')
            for table in tables:
                sql = re.sub(r'\b(FROM|JOIN)\s+' + table + r'\b', r'\1 deleting_event.' + table, sql)
            return conn.execute(sql, args)
    source = Attached()
    snapshots = current_rows(source, event)
    stamp = conn.execute("SELECT datetime('now','localtime')").fetchone()[0]
    tables = [r['name'] for r in conn.execute("SELECT name FROM deleting_event.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    counts = {name: conn.execute(f'SELECT COUNT(*) FROM deleting_event."{name}"').fetchone()[0] for name in tables}
    for item in snapshots:
        item.update(original_category_id=item['category_id'], original_team_id=item['team_id'],
                    original_athlete_id=item['athlete_id'], category_id=None, team_id=None, athlete_id=None,
                    event_id=None, event_deleted=True, event_name_snapshot=event['name'], archived_at=stamp)
        conn.execute('''UPDATE deleting_event.participations SET event_id=NULL,category_id=NULL,
            team_id=NULL,athlete_id=NULL,event_name_snapshot=?,archived_at=?,history_json=? WHERE id=?''',
            (event['name'], stamp, json.dumps(item, ensure_ascii=False), item['id']))
    conn.execute('''INSERT INTO event_deletion_history
        (event_id,event_uuid,event_name,deleted_at,deleted_by,counts_json,registrations_retained)
        VALUES(?,?,?,?,?,?,?)''', (event['id'], event['uuid'], event['name'], stamp, user_id,
                                   json.dumps(counts), len(snapshots)))
    return {'before': counts, 'registrations_retained': len(snapshots), 'policy': 'detach_and_snapshot_v1'}


def all_rows(registry):
    result = []
    for event in db.q(registry, 'SELECT id,uuid,name FROM events ORDER BY id'):
        path = db.event_db_path(event['id'])
        if not path.exists():
            raise RuntimeError(f"赛事数据库缺失：{event['id']}")
        conn = db.connect(path, existing=True)
        try:
            result.extend(current_rows(conn, event))
        finally:
            conn.close()
    for tombstone in db.q(registry, 'SELECT * FROM event_deletion_history ORDER BY event_id'):
        path = db.event_db_path(tombstone['event_id'])
        conn = db.connect(path, existing=True)
        try:
            rows = db.q(conn, 'SELECT history_json,event_name_snapshot FROM participations WHERE archived_at IS NOT NULL ORDER BY id')
            if len(rows) != tombstone['registrations_retained']:
                raise RuntimeError('历史报名数量与删除审计不一致')
            for row in rows:
                item = json.loads(row['history_json'])
                for key in ('category_id', 'team_id', 'athlete_id'):
                    item.setdefault('original_' + key, item.get(key))
                    item[key] = None
                item['event_name_snapshot'] = row['event_name_snapshot']
                result.append(item)
        finally:
            conn.close()
    return result
