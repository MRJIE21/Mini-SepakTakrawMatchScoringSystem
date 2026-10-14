"""Shared enrollment rules, evaluated against the final transactional state."""
from . import db
from .errors import conflict, invalid_fields


def guard_change(conn, category_id):
    locked = db.q1(conn, """SELECT id FROM plans WHERE category_id=?
        AND status IN ('locked','running') LIMIT 1""", (category_id,))
    if locked and db.q1(conn, 'SELECT id FROM matches WHERE category_id=? LIMIT 1', (category_id,)):
        raise conflict('项目赛程已确认，变更参赛学校、报名状态或种子须先处理赛程锁定', code='plan_locked')
    if (db.q1(conn, """SELECT m.id FROM matches m WHERE m.category_id=? AND m.status<>'void'
            AND EXISTS (SELECT 1 FROM settings s WHERE s.k='recording:match:' || m.id) LIMIT 1""", (category_id,))
            or db.q1(conn, """SELECT p.id FROM participations p WHERE p.category_id=? AND
            EXISTS (SELECT 1 FROM settings s WHERE s.k='recording:individual:' || p.id) LIMIT 1""", (category_id,))):
        raise conflict('项目已有记录任务领取，报名和种子已冻结', code='registration_in_use')
    if db.q1(conn, """SELECT p.id FROM participations p WHERE p.category_id=? AND
        (EXISTS (SELECT 1 FROM placements x WHERE x.participation_id=p.id) OR
         EXISTS (SELECT 1 FROM individual_results x WHERE x.participation_id=p.id) OR
         EXISTS (SELECT 1 FROM matches m WHERE m.status='finished' AND
           (m.home_actual=p.id OR m.away_actual=p.id OR m.home_participation=p.id OR m.away_participation=p.id))) LIMIT 1""", (category_id,)):
        raise conflict('项目已有成绩，报名或阵容变更须进入成绩更正流程', code='registration_in_use')


def guard_team_roster(conn, team_id):
    """A team's players do not change its schedule slot. Freeze at recording/results."""
    if db.q1(conn, """SELECT p.id FROM participations p WHERE p.team_id=? AND
        (EXISTS (SELECT 1 FROM placements x WHERE x.participation_id=p.id) OR
         EXISTS (SELECT 1 FROM matches m WHERE m.status='finished' AND
           (m.home_actual=p.id OR m.away_actual=p.id OR
            m.home_participation=p.id OR m.away_participation=p.id))) LIMIT 1""", (team_id,)):
        raise conflict('该校已有比赛成绩或名次，阵容已冻结', code='roster_in_use')
    if db.q1(conn, """SELECT m.id FROM matches m JOIN participations p ON
        (m.home_actual=p.id OR m.away_actual=p.id OR
         m.home_participation=p.id OR m.away_participation=p.id)
        WHERE p.team_id=? AND m.status<>'void' AND
        EXISTS (SELECT 1 FROM settings s WHERE s.k='recording:match:' || m.id)
        LIMIT 1""", (team_id,)):
        raise conflict('该校场次已领取记录，阵容已冻结，请联系赛事管理员核对', code='roster_in_use')


def guard_athlete_identity(conn, athlete_id):
    for row in db.q(conn, """SELECT DISTINCT p.category_id,p.team_id FROM participations p
        LEFT JOIN team_members tm ON tm.team_id=p.team_id WHERE p.status='active'
        AND (p.athlete_id=? OR tm.athlete_id=?)""", (athlete_id, athlete_id)):
        if row['team_id']:
            guard_team_roster(conn, row['team_id'])
        else:
            guard_change(conn, row['category_id'])


def validate_categories(conn, category_ids):
    """Check affected active entries, comparing occupancy with every other category."""
    for cid in set(category_ids):
        cat = db.q1(conn, 'SELECT c.*,g.event_id FROM categories c JOIN groups g ON g.id=c.group_id WHERE c.id=?', (cid,))
        if not cat:
            raise invalid_fields('项目不存在', {'projects': '项目不存在'})
        school_seen = set()
        for p in db.q(conn, "SELECT * FROM participations WHERE category_id=? AND status='active'", (cid,)):
            if cat['kind'] == 'team':
                team = db.q1(conn, 'SELECT * FROM teams WHERE id=?', (p['team_id'],))
                if not team or team['category_id'] != cid:
                    raise invalid_fields('学校项目名单与项目不符', {'members': '学校项目名单与项目不符'})
                school_id = team['school_id']
                members = db.q(conn, 'SELECT * FROM team_members WHERE team_id=?', (team['id'],))
                if len(members) > 6 or len({m['athlete_id'] for m in members}) != len(members):
                    raise invalid_fields('三人赛每队最多 6 人且不得重复', {'members': '人数超限或队员重复'})
                if sum(m['is_captain'] for m in members) > 1:
                    raise invalid_fields('每队只能有一名队长', {'captain_id': '队长重复'})
                ids = [m['athlete_id'] for m in members]
                for m in members:
                    jersey = m['jersey_no']
                    if jersey and (not jersey.isdecimal() or not 1 <= int(jersey) <= 20 or str(int(jersey)) != jersey):
                        raise invalid_fields('项目号码必须为 1—20 的整数', {'members': '项目号码无效'})
            else:
                athlete = db.q1(conn, 'SELECT * FROM athletes WHERE id=?', (p['athlete_id'],))
                if not athlete or p['team_id']:
                    raise invalid_fields('个人项目必须选择运动员', {'athlete_id': '参赛人员不存在'})
                school_id, ids = athlete['school_id'], [athlete['id']]
            if school_id in school_seen:
                raise conflict('同一学校在同一个人项目最多报名 1 人', code='school_individual_limit')
            school_seen.add(school_id)
            entry = db.q1(conn, 'SELECT id FROM school_entries WHERE school_id=? AND group_id=? AND event_id=?', (school_id, cat['group_id'], cat['event_id']))
            if not entry:
                raise invalid_fields('学校不属于项目所在组别', {'school_id': '学校组别不符'})
            for aid in ids:
                a = db.q1(conn, 'SELECT * FROM athletes WHERE id=?', (aid,))
                if not a or a['school_id'] != school_id or a['group_id'] != cat['group_id']:
                    raise invalid_fields('运动员学校或组别与项目不符', {'members': '运动员学校或组别不符'})
                if a['gender'] and a['gender'] != cat['gender']:
                    raise invalid_fields('运动员性别与项目不符', {'members': f"{a['name']}性别与项目不符", 'athlete_id': '运动员性别与项目不符'})
                hit = db.q1(conn, """SELECT c.name FROM participations p JOIN categories c ON c.id=p.category_id
                    JOIN groups g ON g.id=c.group_id LEFT JOIN team_members tm ON tm.team_id=p.team_id
                    WHERE g.event_id=? AND p.status='active' AND c.id<>?
                    AND (p.athlete_id=? OR tm.athlete_id=?) LIMIT 1""", (cat['event_id'], cid, aid, aid))
                if hit:
                    raise conflict(f"{a['name']}已参加「{hit['name']}」，不可兼项", code='athlete_already_entered')


def athlete_categories(conn, athlete_id):
    return [r['category_id'] for r in db.q(conn, """SELECT DISTINCT p.category_id FROM participations p
        LEFT JOIN team_members tm ON tm.team_id=p.team_id WHERE p.status='active'
        AND (p.athlete_id=? OR tm.athlete_id=?)""", (athlete_id, athlete_id))]


def sync_choice(conn, category_id, school_id):
    """Old project edits invalidate a previously explicit school decision."""
    db.run(conn, 'DELETE FROM school_registration_choices WHERE category_id=? AND school_id=?', (category_id, school_id))
