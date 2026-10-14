"""Monotonic membership/order version for bounded match lists."""
from __future__ import annotations


def install(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS match_list_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0)')
    conn.execute('INSERT OR IGNORE INTO match_list_meta(id,revision) VALUES(1,0)')
    dependencies = {
        'matches': ('category_id', 'plan_id', 'stage_id', 'pool_id', 'venue_id', 'scheduled_at',
                    'status', 'result_status', 'round_no', 'round_label', 'seq', 'home_actual',
                    'away_actual', 'home_participation', 'away_participation', 'reset_state'),
        'groups': ('event_id', 'name', 'code', 'seq'),
        'categories': ('group_id', 'name', 'kind', 'gender', 'seq'),
        'stages': ('plan_id', 'name', 'seq', 'kind'),
        'schools': ('name', 'short_name'),
        'teams': ('name', 'school_id'),
        'athletes': ('name', 'school_id'),
        'participations': ('team_id', 'athlete_id', 'category_id', 'status'),
        'venues': ('name',),
        'plans': ('category_id',),
    }
    for table, fields in dependencies.items():
        cols = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
        fields = [f for f in fields if f in cols]
        condition = ' OR '.join(f'OLD.{f} IS NOT NEW.{f}' for f in fields)
        if table == 'plans':
            condition += " OR (OLD.status IN ('locked','running','archived')) IS NOT (NEW.status IN ('locked','running','archived'))"
        for op in ('INSERT', 'DELETE', 'UPDATE'):
            name = f'list_rev_{table}_{op.lower()}'
            conn.execute(f'DROP TRIGGER IF EXISTS {name}')
            when = f' WHEN {condition}' if op == 'UPDATE' else ''
            conn.execute(f'''CREATE TRIGGER {name} AFTER {op} ON {table}{when}
                BEGIN UPDATE match_list_meta SET revision=revision+1 WHERE id=1; END''')
    conn.execute('DROP TRIGGER IF EXISTS list_rev_owner_update')
    conn.execute('''CREATE TRIGGER list_rev_owner_update AFTER UPDATE OF v ON settings
        WHEN NEW.k LIKE 'recording:match:%' AND OLD.v IS NOT NEW.v
        BEGIN UPDATE match_list_meta SET revision=revision+1 WHERE id=1; END''')
    for op in ('INSERT', 'DELETE'):
        name = 'list_rev_owner_' + op.lower()
        conn.execute(f'DROP TRIGGER IF EXISTS {name}')
        ref = 'NEW' if op == 'INSERT' else 'OLD'
        conn.execute(f'''CREATE TRIGGER {name} AFTER {op} ON settings
            WHEN {ref}.k LIKE 'recording:match:%'
            BEGIN UPDATE match_list_meta SET revision=revision+1 WHERE id=1; END''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_matches_page ON matches(category_id,status,scheduled_at,stage_id,round_no,seq,id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_submissions_match ON submissions(match_id,id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_audit_match_latest ON audit_logs(entity_type,entity_id,action,id)')


def value(conn):
    row = conn.execute('SELECT revision FROM match_list_meta WHERE id=1').fetchone()
    return row['revision']
