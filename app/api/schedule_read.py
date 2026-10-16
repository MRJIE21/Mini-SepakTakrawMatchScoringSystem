"""Shared read projection for historical and managed schedules."""
from .. import db
from .common import serialize_matches
import json

STAGE_KIND_NAMES = {'round_robin': '小组赛', 'single_elim': '淘汰赛', 'placement': '名次赛',
                    'custom': '手工比赛', 'double_elim': '历史双淘汰', 'swiss': '历史瑞士制', 'gauntlet': '历史阶梯赛'}
def plan_detail(conn, plan, include_matches=True, include_pools=None) -> dict:
    from collections import defaultdict
    plan = dict(plan)
    stages = db.q(conn, "SELECT * FROM stages WHERE plan_id = ? ORDER BY seq", (plan["id"],))
    counts = {r['stage_id']: dict(r) for r in db.q(conn, """SELECT stage_id,COUNT(*) AS match_count,
        SUM(CASE WHEN status <> 'finished' THEN 1 ELSE 0 END) AS unstarted_count
        FROM matches WHERE plan_id=? GROUP BY stage_id""", (plan['id'],))}
    pools_by_stage, members_by_pool, matches_by_stage = defaultdict(list), defaultdict(list), defaultdict(list)
    if include_matches if include_pools is None else include_pools:
        for pool in db.q(conn, """SELECT p.* FROM pools p JOIN stages s ON s.id=p.stage_id
            WHERE s.plan_id=? ORDER BY p.seq,p.id""", (plan['id'],)):
            pools_by_stage[pool['stage_id']].append(dict(pool))
        for m in db.q(conn, """SELECT pm.*,p.team_id,COALESCE(t.name,a.name) AS subject,
            COALESCE(NULLIF(s.short_name,''),s.name) AS school FROM pool_members pm
            JOIN pools po ON po.id=pm.pool_id JOIN stages st ON st.id=po.stage_id
            JOIN participations p ON p.id=pm.participation_id LEFT JOIN teams t ON t.id=p.team_id
            LEFT JOIN athletes a ON a.id=p.athlete_id LEFT JOIN schools s ON s.id=COALESCE(t.school_id,a.school_id)
            WHERE st.plan_id=? ORDER BY pm.seed_no IS NULL,pm.seed_no,pm.id""", (plan['id'],)):
            members_by_pool[m['pool_id']].append({'participation_id': m['participation_id'],
                'seed_no': m['seed_no'], 'display': m['school'] if m['team_id'] else f"{m['school']}·{m['subject']}"})
        rows = db.q(conn, "SELECT * FROM matches WHERE plan_id=? ORDER BY stage_id,seq,id", (plan['id'],)) if include_matches else []
        for m in serialize_matches(conn, rows):
            matches_by_stage[m['stage_id']].append(m)
    stage_items = []
    for st in stages:
        pools = pools_by_stage[st['id']]
        for pool in pools:
            pool['members'] = members_by_pool[pool['id']]
        stage_items.append({**dict(st), 'kind_name': STAGE_KIND_NAMES.get(st['kind'], st['kind']),
            'params': _loads(st['params_json']), 'pools': pools, 'matches': matches_by_stage[st['id']],
            'match_count': counts.get(st['id'], {}).get('match_count', 0),
            'unstarted_count': counts.get(st['id'], {}).get('unstarted_count', 0)})
    plan['stages'] = stage_items
    plan['params'] = _loads(plan['params_json'])
    plan['kind_names'] = STAGE_KIND_NAMES
    plan['matches_included'] = include_matches
    return plan


def _loads(text: str) -> dict:
    try:
        return json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}




