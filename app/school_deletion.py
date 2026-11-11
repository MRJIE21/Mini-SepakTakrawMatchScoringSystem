"""学校硬删除：保留既有级联外键，显式清除非级联的赛程与名单快照。"""
from contextlib import contextmanager
import json
import uuid

from . import db, security
from .errors import not_found


@contextmanager
def _ids(conn, values):
    # 场次有自引用，必须一次 DELETE 整个依赖闭包，不能拆成参数批次。
    name = 'school_delete_' + uuid.uuid4().hex
    conn.execute(f'CREATE TEMP TABLE {name}(id INTEGER PRIMARY KEY)')
    try:
        conn.executemany(f'INSERT INTO {name}(id) VALUES(?)', ((value,) for value in set(values)))
        yield name
    finally:
        conn.execute(f'DROP TABLE {name}')


def _retire_receipts(conn, pids, mids, categories, school_ids):
    teams = {row['id'] for row in db.q(conn, 'SELECT id,school_id FROM teams') if row['school_id'] in school_ids}
    people = {row['id'] for row in db.q(conn, 'SELECT id,school_id FROM athletes') if row['school_id'] in school_ids}
    def refers(value):
        if isinstance(value, list):
            return any(refers(item) for item in value)
        if not isinstance(value, dict):
            return False
        return any(type(value.get(key)) is int and value[key] in ids for key, ids in (
            ('school_id', school_ids), ('participation_id', pids), ('match_id', mids),
            ('team_id', teams), ('athlete_id', people),
            ('home_participation', pids), ('away_participation', pids))) or any(refers(item) for item in value.values())
    for row in db.q(conn, 'SELECT uid,scope,result_json FROM request_log'):
        try:
            result = json.loads(row['result_json'])
        except (ValueError, TypeError):
            continue
        category_receipt = row['scope'] in ('group_draw', 'individual_draw', 'individual_draw_session', 'schedule', 'manual_result_import') and refers_category(result, categories)
        if row['scope'] in {f'school-registration:{sid}' for sid in school_ids} or refers(result) or category_receipt:
            # 保留 UID 和摘要以阻止旧请求重新创建已删除报名，清除其中的旧名单。
            conn.execute("""UPDATE request_log SET status='conflict',result_json='{}',
                message='school_cascade_deleted' WHERE uid=?""", (row['uid'],))


def refers_category(value, categories):
    if isinstance(value, list):
        return any(refers_category(item, categories) for item in value)
    if isinstance(value, dict):
        return (type(value.get('category_id')) is int and value['category_id'] in categories) or any(refers_category(item, categories) for item in value.values())
    return False


def _snapshot_categories(conn, school_ids):
    categories = set()
    for table in ('group_draws', 'individual_draws', 'individual_draw_sessions', 'manual_result_sets'):
        for row in db.q(conn, f'SELECT category_id,roster_json FROM {table}'):
            try:
                roster = json.loads(row['roster_json'])
            except (ValueError, TypeError):
                continue
            if isinstance(roster, list) and any(isinstance(item, dict)
                    and type(item.get('school_id')) is int and item['school_id'] in school_ids for item in roster):
                categories.add(row['category_id'])
    return categories


def _purge(conn, parts, school_ids=(), affected_categories=()):
    pids = {row['id'] for row in parts}
    categories = {row['category_id'] for row in parts} | set(affected_categories)
    matches = db.q(conn, 'SELECT * FROM matches')
    pools = {row['pool_id'] for row in db.q(conn, 'SELECT pool_id,participation_id FROM pool_members')
             if row['participation_id'] in pids}
    mids = {row['id'] for row in matches if any(row[key] in pids for key in
            ('home_participation', 'away_participation', 'home_actual', 'away_actual'))}
    # 删除名单或场次会使其小组排名来源失效；递归包含依赖比赛及重置赛。
    while True:
        previous = len(mids), len(pools)
        pools.update(row['pool_id'] for row in matches if row['id'] in mids and row['pool_id'] is not None)
        mids.update(row['id'] for row in matches if any(row[key] in mids for key in
                    ('home_source_match', 'away_source_match', 'reset_parent_id'))
                    or any(row[key] in pools for key in ('home_source_pool', 'away_source_pool')))
        if previous == (len(mids), len(pools)):
            break
    categories.update(row['category_id'] for row in matches if row['id'] in mids)
    detail = {'school_ids': sorted(school_ids), 'participation_ids': sorted(pids), 'match_ids': sorted(mids),
              'category_ids': sorted(categories), 'pool_ids': sorted(pools)}
    config = db.q1(conn, 'SELECT slots_json FROM display_config WHERE id=1')
    if config and mids:
        slots = json.loads(config['slots_json'])
        refreshed = [None if isinstance(slot, dict) and slot.get('match_id') in mids else slot for slot in slots]
        if refreshed != slots:
            conn.execute('UPDATE display_config SET slots_json=?,revision=revision+1 WHERE id=1', (json.dumps(refreshed),))
    with _ids(conn, mids) as removed:
        conn.execute(f"DELETE FROM settings WHERE k IN (SELECT 'recording:match:' || id FROM {removed})")
        # match_sets / score_events / submissions / schedule_meta / display_live 由外键级联。
        conn.execute(f'DELETE FROM matches WHERE id IN (SELECT id FROM {removed})')
    with _ids(conn, pools) as affected:
        conn.execute(f'DELETE FROM pool_rank_snapshots WHERE pool_id IN (SELECT id FROM {affected})')
        conn.execute(f'DELETE FROM draw_lots WHERE pool_id IN (SELECT id FROM {affected})')
        conn.execute(f"""UPDATE pools SET status='pending',confirmed_by=NULL,confirmed_at=NULL,
            confirmation_basis='',confirmation_resolutions='[]' WHERE id IN (SELECT id FROM {affected})""")
    with _ids(conn, categories) as affected:
        # JSON 名单不是外键，清除整个失效快照，避免历史详情继续返回已删除报名。
        for table in ('group_draws', 'individual_draws', 'individual_draw_sessions', 'manual_result_sets'):
            conn.execute(f'DELETE FROM {table} WHERE category_id IN (SELECT id FROM {affected})')
        conn.execute(f'''DELETE FROM plan_archive WHERE plan_id IN
            (SELECT id FROM plans WHERE category_id IN (SELECT id FROM {affected}))''')
        conn.execute(f'''UPDATE placements SET status='pending',version=version+1,
            confirmed_by=NULL,confirmed_at=NULL,note='学校级联删除后需重新确认名次'
            WHERE category_id IN (SELECT id FROM {affected}) AND status='confirmed' ''')
        conn.execute(f'DELETE FROM school_points WHERE category_id IN (SELECT id FROM {affected})')
        # 使已打开的编排/记录页面版本失效，避免提交旧名单。
        conn.execute(f'UPDATE plans SET version=version+1 WHERE category_id IN (SELECT id FROM {affected})')
        conn.execute(f'''UPDATE matches SET plan_version=(SELECT version FROM plans WHERE id=matches.plan_id)
            WHERE category_id IN (SELECT id FROM {affected})''')
    with _ids(conn, pids) as removed:
        conn.execute(f"DELETE FROM settings WHERE k IN (SELECT 'recording:individual:' || id FROM {removed})")
        # 也覆盖无结果外键但有参与者 ID 的旧提交回执。
        conn.execute(f'''DELETE FROM submissions WHERE home_participation IN (SELECT id FROM {removed})
            OR away_participation IN (SELECT id FROM {removed})''')
        # 学校删除与单独删除报名不同：包括软删除历史，物理清除及级联其所有明细。
        conn.execute(f'DELETE FROM participations WHERE id IN (SELECT id FROM {removed})')
    _retire_receipts(conn, pids, mids, categories, set(school_ids))
    return detail


def delete_school(conn, user, school_id):
    with db.tx(conn), db.savepoint(conn, 'school_delete'):
        school = db.q1(conn, 'SELECT * FROM schools WHERE id=?', (school_id,))
        if not school:
            raise not_found('学校不存在')
        # 包括活动、退出及软删除报名；审计保留 ID 和影响范围，不保留业务名单副本。
        parts = db.q(conn, '''SELECT p.id,p.category_id FROM participations p
            LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN athletes a ON a.id=p.athlete_id
            WHERE t.school_id=? OR a.school_id=?''', (school_id, school_id))
        detail = _purge(conn, parts, [school_id], _snapshot_categories(conn, {school_id}))
        # school_entries / athletes / teams / team_members / choices / drafts / points / tiebreaks 级联。
        conn.execute('DELETE FROM schools WHERE id=?', (school_id,))
        security.audit(conn, user, 'delete_school', 'school', school_id,
                       {'name': school['name'], 'event_id': school['event_id'], **detail})
        return school['event_id']


def clean_orphan_history(conn):
    """启动时清理旧库关闭外键留下的已删除学校历史；幂等数据修复，不改表结构。"""
    parts = db.q(conn, '''SELECT p.id,p.category_id FROM participations p
        LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN schools ts ON ts.id=t.school_id
        LEFT JOIN athletes a ON a.id=p.athlete_id LEFT JOIN schools sa ON sa.id=a.school_id
        WHERE (p.team_id IS NOT NULL AND ts.id IS NULL)
           OR (p.athlete_id IS NOT NULL AND sa.id IS NULL)''')
    orphan_teams = db.q(conn, 'SELECT id FROM teams WHERE school_id NOT IN (SELECT id FROM schools)')
    orphan_people = db.q(conn, 'SELECT id FROM athletes WHERE school_id NOT IN (SELECT id FROM schools)')
    orphan_tables = ('school_entries', 'school_registration_choices', 'school_registration_drafts', 'school_points', 'school_tiebreaks')
    missing_schools = {row['school_id'] for table in (*orphan_tables, 'teams', 'athletes')
                      for row in db.q(conn, f'SELECT DISTINCT school_id FROM {table} WHERE school_id NOT IN (SELECT id FROM schools)')}
    schools = {row['id'] for row in db.q(conn, 'SELECT id FROM schools')}
    categories = set()
    for table in ('group_draws', 'individual_draws', 'individual_draw_sessions', 'manual_result_sets'):
        for row in db.q(conn, f'SELECT category_id,roster_json FROM {table}'):
            try:
                roster = json.loads(row['roster_json'])
            except (ValueError, TypeError):
                continue
            absent = {item['school_id'] for item in roster if isinstance(item, dict)
                      and type(item.get('school_id')) is int and item['school_id'] not in schools} if isinstance(roster, list) else set()
            if absent:
                categories.add(row['category_id']); missing_schools.update(absent)
    if not (parts or orphan_teams or orphan_people or missing_schools or categories):
        return
    with db.tx(conn), db.savepoint(conn, 'school_history_cleanup'):
        detail = _purge(conn, parts, missing_schools, categories)
        conn.execute('DELETE FROM teams WHERE school_id NOT IN (SELECT id FROM schools)')
        conn.execute('DELETE FROM athletes WHERE school_id NOT IN (SELECT id FROM schools)')
        for table in orphan_tables:
            conn.execute(f'DELETE FROM {table} WHERE school_id NOT IN (SELECT id FROM schools)')
        security.audit(conn, None, 'cleanup_deleted_school_history', 'school', None, detail)
