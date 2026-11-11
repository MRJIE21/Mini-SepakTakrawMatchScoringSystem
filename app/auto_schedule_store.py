"""Read a stable scheduling basis and adapt existing official stage data."""
import json
import hashlib
from . import db, idempotency
from .domain import auto_schedule as model
from .errors import bad_request, conflict


def policy(conn, category_id):
    row = db.q1(conn, 'SELECT * FROM schedule_policies WHERE category_id=?', (category_id,))
    return json.loads(row['settings_json']) if row else None


def match_policy(conn, row, policies):
    """Keep each match's saved windows when another stage is scheduled later."""
    own = db.q1(conn, 'SELECT policy_json FROM match_schedule_meta WHERE match_id=?', (row['id'],))
    if own:
        return json.loads(own['policy_json'])
    cfg = policies.get(row['category_id'])
    if cfg and row['stage_id'] in cfg['stage_ids']:
        return cfg
    sibling = db.q1(conn, '''SELECT mm.policy_json FROM match_schedule_meta mm
        JOIN matches m ON m.id=mm.match_id WHERE m.stage_id=? ORDER BY mm.match_id DESC LIMIT 1''', (row['stage_id'],))
    return json.loads(sibling['policy_json']) if sibling else None


def live_rows(conn, default_duration=30, default_rest=30):
    policies = {r['category_id']: json.loads(r['settings_json']) for r in db.q(conn, 'SELECT * FROM schedule_policies')}
    metadata = {r['match_id']: dict(r) for r in db.q(conn, 'SELECT match_id,duration_minutes,rest_minutes FROM match_schedule_meta')}
    stage_defaults = {r['stage_id']: dict(r) for r in db.q(conn, '''SELECT m.stage_id,mm.duration_minutes,mm.rest_minutes
        FROM match_schedule_meta mm JOIN matches m ON m.id=mm.match_id ORDER BY mm.match_id''')}
    claimed = {int(r['k'].split(':')[-1]) for r in db.q(conn, "SELECT k FROM settings WHERE k LIKE 'recording:match:%'")}
    claimed.update(r['match_id'] for r in db.q(conn, 'SELECT DISTINCT match_id FROM score_events WHERE match_id IS NOT NULL'))
    claimed.update(r['match_id'] for r in db.q(conn, 'SELECT DISTINCT match_id FROM submissions WHERE match_id IS NOT NULL'))
    rows = []
    for raw in db.q(conn, """SELECT m.* FROM matches m LEFT JOIN plans p ON p.id=m.plan_id
        WHERE (p.status IS NULL OR p.status<>'archived') AND m.reset_state IN ('none','active')
        AND m.status<>'void' AND COALESCE(m.result_status,'')<>'cancelled' ORDER BY m.id"""):
        r = dict(raw); cfg = policies.get(r['category_id'], {})
        if r['stage_id'] not in cfg.get('stage_ids', []):
            cfg = stage_defaults.get(r['stage_id'], {})
        r.pop('rules_snapshot_json',None); r.pop('note',None)
        meta = metadata.get(r['id'], {})
        r.update(duration_minutes=meta.get('duration_minutes', cfg.get('duration_minutes', default_duration)),
                 rest_minutes=meta.get('rest_minutes', cfg.get('rest_minutes', default_rest)),
                 protected=bool(r['id'] in claimed or r['status'] == 'finished' or r['result_version']),
                 estimated_legacy=not bool(meta))
        rows.append(r)
    pools = {r['id']: [m['participation_id'] for m in db.q(conn,
        'SELECT participation_id FROM pool_members WHERE pool_id=? ORDER BY seed_no,id', (r['id'],))]
        for r in db.q(conn, 'SELECT id FROM pools')}
    return rows, pools


def basis(conn, category_id):
    # Excludes tokens, audit and request logs; includes every mutable scheduling input.
    tables = ['events','categories','stages','plans','pools','pool_members','participations','group_draws',
              'pool_rank_snapshots','matches','match_schedule_meta','schedule_policies','venues']
    value = {}
    for table in tables:
        if table == 'match_schedule_meta':
            continue
        where = ' WHERE deleted_at IS NULL' if table == 'participations' else ''
        value[table] = db.rows_to_dicts(db.q(conn, f'SELECT * FROM {table}{where} ORDER BY rowid'))
    value['match_schedule_meta']=[{'match_id':r['match_id'],'duration_minutes':r['duration_minutes'],
        'rest_minutes':r['rest_minutes'],'batch_uid':r['batch_uid'],
        'policy_hash':hashlib.sha256(r['policy_json'].encode('utf-8')).hexdigest()}
        for r in conn.execute('SELECT * FROM match_schedule_meta ORDER BY match_id')]
    value['recording'] = db.rows_to_dicts(db.q(conn, "SELECT * FROM settings WHERE k LIKE 'recording:match:%' OR k='deployment_id' ORDER BY k"))
    value['scores'] = db.rows_to_dicts(db.q(conn, 'SELECT id,match_id FROM score_events ORDER BY id'))
    value['submissions'] = db.rows_to_dicts(db.q(conn, 'SELECT id,match_id FROM submissions ORDER BY id'))
    value['category_id'] = category_id
    return idempotency.content_hash(value)


def prepare(conn, category_id, config):
    plan = db.q1(conn, "SELECT * FROM plans WHERE category_id=? AND status<>'archived' ORDER BY id DESC LIMIT 1", (category_id,))
    if not plan:
        raise bad_request('请先确认分组并建立正式比赛阶段')
    stages = {r['id']: dict(r) for r in db.q(conn, 'SELECT * FROM stages WHERE plan_id=? ORDER BY seq,id', (plan['id'],))}
    for sid in config['stage_ids']:
        if sid not in stages:
            raise bad_request('所选阶段不属于本项目当前赛程')
        data = json.loads(stages[sid]['params_json'] or '{}').get('schedule_meta')
        if not data or data['state'] != 'confirmed':
            raise conflict('请先核对并确认所选阶段，再自动编排', code='stage_not_confirmed')
    venues = {r['id']: r['name'] for r in db.q(conn, 'SELECT * FROM venues')}
    if any(w['venue_id'] not in venues for w in config['windows']):
        raise bad_request('可用场地不属于当前赛事')
    rows, pools = live_rows(conn, config['duration_minutes'], config['rest_minutes'])
    selected = set(config['stage_ids']); virtual = -1
    for sid in selected:
        stage = stages[sid]
        if stage['kind'] != 'round_robin':
            continue
        for pool in db.q(conn, "SELECT * FROM pools WHERE stage_id=? AND kind='group' ORDER BY seq,id", (sid,)):
            if db.q1(conn, "SELECT id FROM matches WHERE pool_id=? AND reset_state IN ('none','active') AND (status='void' OR result_status='cancelled') LIMIT 1", (pool['id'],)):
                raise conflict('小组存在已取消的比赛，请先人工核对，不自动恢复已取消对阵')
            members = pools[pool['id']]
            for pid in members:
                part = db.q1(conn, 'SELECT * FROM participations WHERE id=? AND deleted_at IS NULL', (pid,))
                if not part or part['category_id'] != category_id or part['status'] != 'active':
                    raise conflict('正式分组成员已变化，请先核对分组')
            existing = set()
            for row in rows:
                if row['pool_id'] != pool['id']:
                    continue
                a, b = row['home_participation'], row['away_participation']
                key = frozenset((a,b))
                if not a or not b or a == b or not key <= set(members) or key in existing:
                    raise conflict('小组赛已有重复或无效对阵，请先人工核对')
                existing.add(key)
            for rnd, a, b in model.round_robin(members):
                if frozenset((a,b)) in existing:
                    continue
                if pool['status'] == 'confirmed':
                    raise conflict('小组名次已确认，不能自动新增比赛')
                rows.append({'id': virtual, 'category_id': category_id, 'stage_id': sid, 'plan_id': plan['id'],
                    'plan_version': plan['version'], 'pool_id': pool['id'], 'round_no': rnd,
                    'round_label': f"{pool['name']}第{rnd}轮", 'home_source_type': 'participation',
                    'home_participation': a, 'away_source_type': 'participation', 'away_participation': b,
                    'home_actual': None, 'away_actual': None, 'venue_id': None, 'scheduled_at': '',
                    'status': 'pending', 'result_version': 0, 'protected': False,
                    'duration_minutes': config['duration_minutes'], 'rest_minutes': config['rest_minutes']})
                virtual -= 1
    selected_rows = [r for r in rows if r['stage_id'] in selected and r['category_id'] == category_id]
    if not selected_rows:
        raise bad_request('所选阶段没有可安排的比赛；小组赛至少需要两所有效学校')
    for row in rows:
        row['movable'] = row in selected_rows and not row['protected'] and (config['mode'] == 'replan' or not row['venue_id'] or not row['scheduled_at'])
        if row['movable']:
            if config['mode'] == 'fill':
                row['fixed_venue'], row['fixed_start'] = row['venue_id'], row['scheduled_at']
            row.update(duration_minutes=config['duration_minutes'], rest_minutes=config['rest_minutes'])
        elif row in selected_rows and not row['protected']:
            row['rest_minutes'] = max(row['rest_minutes'], config['rest_minutes'])
            row['validate_fixed'] = True
    for row in selected_rows:
        for side in ('home','away'):
            if row.get(side+'_source_type') != 'pool_rank':
                continue
            pool_id=row[side+'_source_pool']
            pool=db.q1(conn,'SELECT status FROM pools WHERE id=?',(pool_id,))
            count=len(pools[pool_id]);expected=count*(count-1)//2
            if pool['status']!='confirmed' and sum(r['pool_id']==pool_id for r in rows) < expected:
                raise conflict('来源小组赛对阵尚未完整，请同时选中小组赛，或先补齐小组赛后再编排后续阶段')
    sources=model.Sources(rows,pools)
    unknown=[r for r in rows if r['protected'] and not r['scheduled_at']]
    if any(sources.share(a['id'],b['id']) for a in rows if a.get('movable') for b in unknown):
        raise conflict('有同队已领取或已记录的比赛缺少时间，无法核对休息；请先完善该场比赛时间')
    return rows, pools, stages, venues


def label_maps(conn):
    names = {r['id']: r['label'] for r in db.q(conn, """SELECT p.id,COALESCE(s.name,t.name,a.name,'队伍') AS label
        FROM participations p LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN schools s ON s.id=t.school_id
        LEFT JOIN athletes a ON a.id=p.athlete_id WHERE p.deleted_at IS NULL""")}
    pool_names = {r['id']: r['name'] for r in db.q(conn, 'SELECT id,name FROM pools')}
    return names, pool_names


def present(row, names, pools, venues, stages):
    def side(prefix):
        src = model.source(row, prefix)
        if src[0] == 'p': return names.get(src[1], '队伍待确定')
        if src[0] == 'r': return f"{pools.get(src[1], '小组')}第{src[2]}名"
        if src[0] in ('w','l'): return f"M{src[1]:03d}{'胜者' if src[0]=='w' else '负者'}"
        return '轮空'
    span = model.interval(row)
    return {'id': row['id'], 'code': f"新增{abs(row['id'])}" if row['id'] < 0 else f"M{row['id']:03d}",
        'stage': stages.get(row['stage_id'], {}).get('name',''), 'home': side('home'), 'away': side('away'),
        'venue_id': row['venue_id'], 'venue': venues.get(row['venue_id'],'场地待安排'),
        'start': model.text_time(span[0]) if span else '', 'end': model.text_time(span[1]) if span else '',
        'duration_minutes': row['duration_minutes'], 'rest_minutes': row['rest_minutes'],
        'action': '新增' if row['id'] < 0 else '重排' if row.get('movable') else '保留', 'protected': row['protected']}


def validate_manual(conn, changes):
    policies = {r['category_id']: json.loads(r['settings_json']) for r in db.q(conn, 'SELECT * FROM schedule_policies')}
    if not policies:
        return
    rows, pools = live_rows(conn)
    for row in rows:
        if row['id'] in changes:
            row.update(changes[row['id']])
            cfg = match_policy(conn, row, policies)
            if cfg and row['scheduled_at'] and row['venue_id'] and not any(w['venue_id'] == row['venue_id'] and model.stamp(w['start']) <= model.interval(row)[0] and model.interval(row)[1] <= model.stamp(w['end']) for w in cfg['windows']):
                raise conflict('该安排超出已保存的可用场地时段，请先在自动编排中调整规则', code='schedule_window_conflict')
    try:
        errors = model.violations(rows, pools, affected=set(changes) & {r['id'] for r in rows})
    except ValueError as exc:
        raise conflict(str(exc), code='schedule_conflict') from None
    if errors:
        raise conflict('；'.join(errors[:3]), code='schedule_rest_conflict')
