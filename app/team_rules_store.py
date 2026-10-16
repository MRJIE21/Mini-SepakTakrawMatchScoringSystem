"""Event-owned rules, explicit legacy unification and immutable match snapshots."""
import hashlib
import json
import sqlite3
from pathlib import Path

from . import db
from .domain import team_rules as rules
from .errors import ApiError, bad_request, conflict, not_found

MARKER = 'migration:team-rules-v1'
EVENT_MARKER = 'migration:event-team-rules-v2'


def backup_before_upgrade(conn):
    tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'settings' not in tables:
        return
    for marker, suffix in ((MARKER, '.before-team-rules-v1.db'),
                           (EVENT_MARKER, '.before-event-team-rules-v2.db')):
        if not conn.execute('SELECT v FROM settings WHERE k=?', (marker,)).fetchone():
            _backup(conn, suffix)


def _backup(conn, suffix):
    path = conn.execute('PRAGMA database_list').fetchone()['file']
    if not path:
        return
    backup = Path(path + suffix)
    if backup.exists():
        saved = sqlite3.connect(backup.resolve().as_uri() + '?mode=ro', uri=True)
        try:
            if (saved.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or
                    not saved.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'").fetchone()):
                raise RuntimeError('升级前备份无效，请保留文件并核对：' + str(backup))
        finally:
            saved.close()
        return  # Preserve a verified first pre-upgrade backup on retry.
    target = sqlite3.connect(backup)
    try:
        conn.backup(target)
    finally:
        target.close()


def install(conn):
    with db.tx(conn):
        for table, definitions in {
            'events': ['team_rules_json TEXT', 'team_rules_revision INTEGER NOT NULL DEFAULT 1',
                       "team_rules_state TEXT NOT NULL DEFAULT 'unified'"],
            'categories': ['team_rules_json TEXT', 'rules_revision INTEGER NOT NULL DEFAULT 1'],
            'matches': ['rules_snapshot_json TEXT', 'rules_revision INTEGER', 'rules_hash TEXT'],
        }.items():
            existing = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
            for definition in definitions:
                if definition.split()[0] not in existing:
                    conn.execute(f'ALTER TABLE {table} ADD COLUMN {definition}')
        if conn.execute('SELECT v FROM settings WHERE k=?', (MARKER,)).fetchone():
            _install_event_rules(conn)
            return
        old = conn.execute('''SELECT m.id FROM matches m WHERE m.rules_snapshot_json IS NULL AND
            (m.status='finished' OR m.result_version>0 OR
             EXISTS(SELECT 1 FROM settings s WHERE s.k='recording:match:' || m.id) OR
             EXISTS(SELECT 1 FROM match_sets s WHERE s.match_id=m.id) OR
             EXISTS(SELECT 1 FROM score_events s WHERE s.match_id=m.id) OR
             EXISTS(SELECT 1 FROM submissions s WHERE s.match_id=m.id))''').fetchall()
        for row in old:
            db.update(conn, 'matches', row['id'], {'rules_snapshot_json': rules.canonical(None),
                      'rules_revision': 1, 'rules_hash': rules.fingerprint(None)})
        conn.execute('INSERT INTO settings(k,v) VALUES(?,?)', (MARKER, '1'))
        _install_event_rules(conn)


def _revision(value):
    if type(value) is not int or value < 1:
        raise conflict('已保存规则修订号异常，请联系管理员核对', code='invalid_saved_rules')
    return value


def _categories(conn, event_id):
    return db.q(conn, '''SELECT c.*,g.event_id,g.name AS group_name,g.code AS group_code
        FROM categories c JOIN groups g ON g.id=c.group_id
        WHERE g.event_id=? AND c.kind='team' ORDER BY g.id,c.id''', (event_id,))


def _install_event_rules(conn):
    if conn.execute('SELECT v FROM settings WHERE k=?', (EVENT_MARKER,)).fetchone():
        return
    for row in db.q(conn, 'SELECT id FROM events ORDER BY id'):
        categories = _categories(conn, row['id'])
        values = {rules.canonical(decode(c['team_rules_json'])) for c in categories}
        revision = max((_revision(c['rules_revision']) for c in categories), default=1)
        db.update(conn, 'events', row['id'], {
            'team_rules_json': next(iter(values)) if len(values) == 1 else None,
            'team_rules_revision': revision,
            'team_rules_state': 'legacy_mixed' if len(values) > 1 else 'unified',
        })
    conn.execute('INSERT INTO settings(k,v) VALUES(?,?)', (EVENT_MARKER, '1'))


def decode(value):
    try:
        if value is None:
            return rules.normalize()
        parsed = json.loads(value)
        if not isinstance(parsed, dict):
            raise ValueError('已保存规则必须是对象')
        return rules.normalize(parsed)
    except (ValueError, TypeError) as exc:
        raise ApiError(409, 'invalid_saved_rules', f'已保存比赛规则异常：{exc}；请联系管理员核对') from exc


def project(conn, category_id):
    cat = db.q1(conn, 'SELECT * FROM categories WHERE id=?', (category_id,))
    if cat is None:
        raise not_found('项目不存在')
    if cat['kind'] != 'team':
        raise bad_request('个人赛不使用三人赛规则')
    group = db.q1(conn, 'SELECT * FROM groups WHERE id=?', (cat['group_id'],))
    current = event(conn, group['event_id'])
    if current['rules_state'] == 'legacy_mixed':
        value = decode(cat['team_rules_json'])
        return {**_value(value, _revision(cat['rules_revision'])), 'rules_scope': 'legacy_project',
                'event_rules_state': 'legacy_mixed'}
    return {**_value(current['rules'], current['rules_revision']), 'rules_scope': 'event',
            'event_rules_state': 'unified'}


def _value(value, revision):
    return {'rules': value, 'rules_revision': revision, 'rules_hash': rules.fingerprint(value),
            'rules_summary': rules.summary(value)}


def event(conn, event_id):
    row = db.q1(conn, 'SELECT * FROM events WHERE id=?', (event_id,))
    if row is None:
        raise not_found('赛事不存在')
    state = row['team_rules_state']
    if state not in ('unified', 'legacy_mixed') or (state == 'legacy_mixed' and row['team_rules_json'] is not None):
        raise conflict('赛事规则状态异常，请联系管理员核对', code='invalid_saved_rules')
    value = decode(row['team_rules_json'])
    return {**_value(value, _revision(row['team_rules_revision'])), 'event_id': event_id,
            'rules_scope': 'event', 'rules_state': state}


def match_rules(conn, match):
    row = dict(match)
    snapshot = row.get('rules_snapshot_json')
    if snapshot is None:
        return {**project(conn, row['category_id']), 'rules_state': 'inherited'}
    value = decode(snapshot)
    digest = rules.fingerprint(value)
    if row.get('rules_hash') != digest or type(row.get('rules_revision')) is not int or row['rules_revision'] < 1:
        raise conflict('该场规则快照校验失败，请联系管理员核对', code='invalid_saved_rules')
    return {'rules': value, 'rules_revision': row['rules_revision'], 'rules_hash': digest,
            'rules_state': 'frozen', 'rules_summary': rules.summary(value)}


def freeze(conn, match):
    if not conn.in_transaction:
        raise RuntimeError('Rule freeze requires the claim/submit transaction')
    current = db.q1(conn, 'SELECT * FROM matches WHERE id=?', (match['id'],))
    value = match_rules(conn, current)
    if value['rules_state'] == 'inherited':
        db.update(conn, 'matches', current['id'], {'rules_snapshot_json': rules.canonical(value['rules']),
                  'rules_revision': value['rules_revision'], 'rules_hash': value['rules_hash']})
        value['rules_state'] = 'frozen'
    return value


def check_payload(payload, value):
    given = payload.get('rules_hash')
    if given is None and value['rules_hash'] == rules.fingerprint(None):
        return  # Original immutable legacy default packets retain their digest.
    if given != value['rules_hash']:
        raise conflict('记录采用的比赛规则与本场不一致，请刷新核对；已保存输入保留',
                       code='rule_conflict', detail={'rules_hash': value['rules_hash'], 'rules': value['rules']})


def _match_rows(conn, event_id):
    return db.q(conn, '''SELECT m.id,m.category_id,m.status,m.result_version,m.rules_hash,
        m.rules_snapshot_json,m.rules_revision,p.status AS plan_status,
        EXISTS(SELECT 1 FROM settings s WHERE s.k='recording:match:' || m.id) AS claimed,
        EXISTS(SELECT 1 FROM match_sets s WHERE s.match_id=m.id) AS has_sets,
        EXISTS(SELECT 1 FROM score_events s WHERE s.match_id=m.id) AS has_events,
        EXISTS(SELECT 1 FROM submissions s WHERE s.match_id=m.id) AS has_submissions
        FROM matches m JOIN plans p ON p.id=m.plan_id
        JOIN categories c ON c.id=m.category_id JOIN groups g ON g.id=c.group_id
        WHERE g.event_id=? AND c.kind='team' ORDER BY m.id''', (event_id,))


def _started(row):
    return (row['rules_snapshot_json'] is not None or row['claimed'] or row['has_sets'] or
            row['has_events'] or row['has_submissions'] or row['result_version'] or row['status'] == 'finished')


def event_impact(conn, event_id):
    current = event(conn, event_id)
    categories = _categories(conn, event_id)
    legacy = []
    if current['rules_state'] == 'legacy_mixed':
        for cat in categories:
            value = decode(cat['team_rules_json'])
            legacy.append({'category_id': cat['id'], 'category_name': cat['name'],
                           'group_name': cat['group_name'], **_value(value, _revision(cat['rules_revision']))})
    rows = _match_rows(conn, event_id)
    active = [r for r in rows if r['plan_status'] != 'archived' and r['status'] != 'void']
    preserved = [r for r in active if _started(r)]
    material = {'event': event_id, 'revision': current['rules_revision'], 'state': current['rules_state'],
                'hash': current['rules_hash'], 'categories': [dict(c) for c in categories],
                'groups': [dict(g) for g in db.q(conn, 'SELECT * FROM groups WHERE event_id=? ORDER BY id', (event_id,))],
                'matches': [dict(r) for r in rows]}
    token = hashlib.sha256(json.dumps(material, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {**current, 'impact_token': token, 'future_matches': len(active) - len(preserved),
            'frozen_matches': len(preserved), 'team_projects': len(categories), 'legacy_rules': legacy}


def impact(conn, category_id):
    """Read compatibility only; a category write must never widen to an event."""
    value = project(conn, category_id)
    cat = db.q1(conn, 'SELECT * FROM categories WHERE id=?', (category_id,))
    group = db.q1(conn, 'SELECT * FROM groups WHERE id=?', (cat['group_id'],))
    return {**event_impact(conn, group['event_id']), **value}


def save_event(conn, event_id, value, body):
    if not conn.in_transaction:
        raise RuntimeError('Event rules require a write transaction')
    before = event_impact(conn, event_id)
    if type(body.get('expected_revision')) is not int or body['expected_revision'] != before['rules_revision']:
        raise conflict('比赛规则已被修改，请核对后台规则后重新保存', code='rules_revision_conflict', detail=before)
    if body.get('impact_token') != before['impact_token']:
        raise conflict('适用场次范围已变化，请重新核对后保存', code='rules_impact_changed', detail=before)
    if before['rules_state'] == 'legacy_mixed' and body.get('acknowledge_legacy_unification') is not True:
        raise conflict('旧项目规则不同，请明确确认统一本赛事三人赛规则', code='rules_unification_required', detail=before)
    if before['rules_state'] == 'unified' and rules.fingerprint(value) == before['rules_hash']:
        return before, False
    # Freeze under the OLD resolver before changing the event. Include archived
    # plans and all historical evidence, even if a legacy snapshot was omitted.
    for row in _match_rows(conn, event_id):
        if _started(row):
            freeze(conn, row)
    db.update(conn, 'events', event_id, {'team_rules_json': rules.canonical(value),
              'team_rules_revision': before['rules_revision'] + 1, 'team_rules_state': 'unified'})
    return before, True
