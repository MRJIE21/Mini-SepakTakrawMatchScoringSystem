"""从后台正式记录推导项目进度和操作入口；读取不改变赛程或成绩。"""
import json
from collections import defaultdict
from . import db
from .read_projection import text_integer_rows
from .api.common import (active_plan, category_context, participation_profile_map,
                         plan_effective, match_plan_effective_from_state,
                         recording_blocker_from_state, serialize_match)


def category_snapshot(conn, category_id, role):
    # 资料判断与报名名单共用，保持两个入口的口径一致。
    from .api.catalog import team_profile_gaps_from_members
    from .api.batch_matches import BatchReadConnection

    cat = category_context(conn, category_id)
    parts = text_integer_rows(conn, "SELECT id,team_id,status FROM participations WHERE category_id = ? ORDER BY id",
                 ('id','team_id','status'), (category_id,))
    active = [p for p in parts if p["status"] == "active"]
    # Request-local reads use the same profile and serialization rules. There
    # is no cross-request cache: a later request sees new claims and decisions.
    info_by_id = participation_profile_map(conn, category_id)
    members_by_team = defaultdict(list)
    if cat['kind'] == 'team':
        for member in db.q(conn, """SELECT tm.team_id,a.id,a.name,a.gender,tm.is_captain
                FROM team_members tm JOIN athletes a ON a.id=tm.athlete_id
                JOIN participations p ON p.team_id=tm.team_id
                WHERE p.category_id=? AND p.status='active' ORDER BY tm.id""", (category_id,)):
            members_by_team[member['team_id']].append(member)
    incomplete = []
    for part in active:
        if cat["kind"] == "team":
            members = members_by_team[part['team_id']]
            captain = next((m['id'] for m in members if m['is_captain']), None)
            gaps = team_profile_gaps_from_members(members, captain)
        else:
            gaps = ["性别待补充"] if not info_by_id[part['id']]['athlete_gender'] else []
        if gaps:
            info = info_by_id[part['id']]
            incomplete.append({"participation_id": part["id"], "school_id": info["school_id"],
                               "display": info["display"], "gaps": gaps})

    plan = active_plan(conn, category_id)
    matches = text_integer_rows(conn, """SELECT id,category_id,plan_id,stage_id,status,reset_state,venue_id,scheduled_at
        FROM matches WHERE category_id = ?
        ORDER BY NULLIF(TRIM(scheduled_at), '') IS NULL, NULLIF(TRIM(scheduled_at), ''),
                 stage_id, round_no, seq, id""",
        ('id','category_id','plan_id','stage_id','status','reset_state','venue_id','scheduled_at'), (category_id,))
    actual = [m for m in matches if m["status"] != "void"]
    ready = [m for m in actual if m["status"] == "ready"]
    candidate_matches = {r['subject_id'] for r in db.q(conn, """SELECT h.subject_id
        FROM candidate_heads h JOIN result_candidates c ON c.id=h.candidate_id
        WHERE c.category_id=? AND h.subject_kind='match' AND h.status='submitted'""", (category_id,))}
    disputed = bool(db.q1(conn, "SELECT 1 FROM result_disputes WHERE category_id=? AND status='open'", (category_id,)))
    plans = {p['id']: p for p in db.q(conn, 'SELECT * FROM plans WHERE category_id=?', (category_id,))}
    stages = {s['id']: s for s in db.q(conn, '''SELECT s.* FROM stages s JOIN plans p ON p.id=s.plan_id
        WHERE p.category_id=?''', (category_id,))}
    effective = {}
    def stage_effective(match):
        key = (match['plan_id'], match['stage_id'])
        if key not in effective:
            stage = stages.get(match['stage_id'])
            if stage and stage['plan_id'] != match['plan_id']:
                stage = None
            effective[key] = match_plan_effective_from_state(plans.get(match['plan_id']), stage)
        return effective[key]
    scoreable = [m for m in ready if not recording_blocker_from_state(
        m, m['id'] in candidate_matches, disputed, lambda: stage_effective(m))]
    pending = [m for m in actual if m["status"] == "pending"]
    finished = [m for m in actual if m["status"] == "finished"]
    unscheduled = [m for m in actual if m["status"] != "finished"
                   and (not m["venue_id"] or not (m["scheduled_at"] or "").strip())]
    results = db.q(conn, """SELECT r.* FROM individual_results r JOIN participations p
        ON p.id = r.participation_id WHERE r.category_id = ? AND p.status = 'active'""", (category_id,))
    placements = db.q(conn, """SELECT r.* FROM placements r JOIN participations p
        ON p.id = r.participation_id WHERE r.category_id = ? AND p.status = 'active'""", (category_id,))
    confirmed = sum(p["status"] == "confirmed" for p in placements)
    missing_results = max(0, len(active) - len({r["participation_id"] for r in results}))
    pools = []
    if plan and plan["status"] != "archived" and plan_effective(conn, plan):
        pools = db.q(conn, """SELECT p.id, p.name, p.stage_id, s.name AS stage_name FROM pools p
            JOIN stages s ON s.id = p.stage_id WHERE s.plan_id = ?
            AND p.kind != 'bracket' AND p.status != 'confirmed'
            AND EXISTS (SELECT 1 FROM pool_members pm WHERE pm.pool_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.pool_id = p.id
                            AND m.status NOT IN ('finished', 'void'))
            ORDER BY s.seq, p.seq, p.id""", (plan["id"],))
    from .api.schedule import meta
    stage_rows = db.q(conn, 'SELECT * FROM stages WHERE plan_id=? ORDER BY seq', (plan['id'],)) if plan else []
    draft_stages = [s for s in stage_rows if meta(s) and meta(s)['state'] == 'draft']
    needs_plan = bool(draft_stages)
    draw = db.q1(conn, "SELECT status FROM group_draws WHERE category_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1",
                 (category_id,)) if cat["kind"] == "team" else None
    all_played = bool(matches) and len(finished) == len(actual)
    counts = {
        "enrolled": len(active), "withdrawn": sum(p["status"] == "withdrawn" for p in parts),
        "profiles_incomplete": len(incomplete), "matches_total": len(actual),
        "matches_void": len(matches) - len(actual), "matches_ready": len(ready),
        "matches_scoreable": len(scoreable), "matches_pending": len(pending),
        "matches_finished": len(finished), "matches_unscheduled": len(unscheduled),
        "pools_to_confirm": len(pools), "individual_results": len(results),
        "individual_results_missing": missing_results,
        "individual_results_confirmed": sum(r["confirmed"] == 1 for r in results),
        "individual_results_unconfirmed": sum(r["confirmed"] != 1 for r in results),
        "placements_total": len(placements), "placements_confirmed": confirmed,
        "placements_pending": len(placements) - confirmed,
    }
    for status,key in (('submitted','candidates_pending'),('returned','candidates_returned')):
        counts[key] = db.q1(conn,'''SELECT COUNT(*) AS n FROM result_candidates c
            JOIN candidate_heads h ON h.candidate_id=c.id WHERE c.category_id=? AND h.status=?''',(category_id,status))['n']
    counts['disputes_open'] = db.q1(conn,"SELECT COUNT(*) AS n FROM result_disputes WHERE category_id=? AND status='open'",(category_id,))['n']
    blockers = []
    reminders = []
    if not active:
        blockers.append({"code": "no_entries", "tab": "registration", "message": "尚无有效报名，先添加参赛名单。"})
    if incomplete:
        reminders.append({"code": "profiles_incomplete", "tab": "registration",
            "message": f"{len(incomplete)} 项参赛资料待补充；允许继续准备，相关场次正式记录前须补齐。",
            "items": incomplete})

    if not active:
        primary, task = {"tab": "registration", "label": "添加参赛学校"}, "建立报名名单"
    elif cat["kind"] == "individual":
        if missing_results:
            primary, task = {"tab": "entry", "label": "录入成绩"}, f"还有 {missing_results} 位运动员待录入成绩"
        elif counts["individual_results_unconfirmed"]:
            primary, task = {"tab": "entry", "label": "核对并确认成绩"}, f"{counts['individual_results_unconfirmed']} 位运动员的成绩待确认"
        else:
            primary = {"tab": "results", "label": "核对成绩与名次" if not confirmed or counts["placements_pending"] else "查看成绩与名次"}
            task = "核对并确认个人赛名次" if not confirmed or counts["placements_pending"] else "个人赛成绩已录入，查看已确认名次"
    elif needs_plan:
        primary = {"tab": "schedule", "view": "fixtures", "stage": draft_stages[0]["id"], "label": ("核对并确认赛程" if role == "admin" else "核对赛程") if plan["status"] == "previewed" else "核对阶段设置"}
        task = "赛程预览尚未确认，先核对分组、晋级关系和场地时间" if plan["status"] == "previewed" else "核对阶段参赛来源、首轮对阵与名次范围"
        if plan["status"] == "previewed" and role != "admin":
            task += "；核对后请赛事管理员确认方案"
    elif not matches and not plan and (not draw or draw['status'] != 'confirmed'):
        primary, task = {"tab": "groups", "label": "完成学校分组"}, "先完成学校抽签与分组确认，再进入赛程安排比赛"
    elif not matches:
        primary, task = {"tab": "schedule", "label": "安排比赛"}, "在赛程中建立阶段并维护比赛安排"
    elif pools:
        primary = {"tab": "results", "pool": pools[0]["id"], "label": "核对小组排名"}
        task = f"{len(pools)} 个小组比赛已结束，核对并确认排名后才能继续晋级"
    elif scoreable:
        primary, task = {"tab": "matches", "status": "ready", "label": "进入待记录场次"}, f"{len(scoreable)} 场比赛可进入记录"
    elif pending:
        primary, task = {"tab": "schedule", "status": "pending", "label": "查看待晋级场次"}, "后续场次正在等待前序结果或晋级名单"
    elif ready:
        primary, task = {"tab": "schedule", "view": "fixtures", "label": "核对赛程状态"}, "待记录场次的编排方案尚未生效"
    elif all_played:
        primary = {"tab": "results", "label": "核对名次" if not confirmed or counts["placements_pending"] else "查看成绩与名次"}
        task = "比赛已全部确认，核对并确认项目名次" if not confirmed or counts["placements_pending"] else "比赛已全部确认，查看项目名次"
    else:
        primary, task = {"tab": "schedule", "label": "核对赛程"}, "核对比赛安排"

    if counts['disputes_open']:
        primary,task={'tab':'review','label':'核对成绩争议'},'最后正式结果保留，先核对争议与明确处置'
        blockers.append({'code':'result_disputed','tab':'review','message':'存在未解决的成绩争议，新的推进受保护。'})
    elif counts['candidates_pending']:
        primary,task={'tab':'review','label':'核对待审候选'},f"{counts['candidates_pending']} 份候选待独立复核"
        blockers.append({'code':'review_pending','tab':'review','message':'候选已接收，独立复核后才成为正式结果。'})

    schedule_summary = "未安排比赛"
    schedule_state = "pending"
    if needs_plan:
        schedule_summary = "预览待确认" if plan["status"] == "previewed" else "阶段待确认"
        schedule_state = "attention"
    elif matches:
        schedule_summary = "赛程已确认" if plan and plan["status"] in ("locked", "running") else "场次已录入"
        schedule_state = "complete"
    elif draw:
        schedule_summary = "分组已确认，待安排比赛" if draw["status"] == "confirmed" else "抽签待完成或确认"
        schedule_state = "attention"
    steps = [{"tab": "registration", "label": "报名", "summary": f"{len(active)} 所学校已报名",
              "detail": f"{len(incomplete)} 项资料待补充" if incomplete else "参赛名单与人员资料",
              "state": "attention" if incomplete else "complete" if active else "pending"}]
    if cat["kind"] == "team":
        steps.extend([
            {"tab": "groups", "label": "分组", "summary": "分组已确认" if draw and draw['status'] == 'confirmed' else "抽签待完成或确认" if draw else "尚未分组",
             "detail": "学校抽签与组员核对", "state": "complete" if draw and draw['status'] == 'confirmed' else "attention" if draw else "pending"},
            {"tab": "schedule", "label": "赛程", "summary": schedule_summary,
             "detail": f"{len(actual)} 场比赛 · {len(matches) - len(actual)} 场轮空", "state": schedule_state},
            {"tab": "matches", "label": "比赛", "summary": f"{len(finished)} / {len(actual)} 场已确认",
             "detail": f"{len(scoreable)} 场可记录 · {len(pending)} 场待晋级",
             "state": "complete" if all_played else "ready" if scoreable else "pending"},
        ])
    else:
        steps.append({"tab": "entry", "label": "成绩录入", "summary": f"{len(results)} / {len(active)} 位已录成绩",
                      "detail": f"{missing_results} 位待录入 · {counts['individual_results_unconfirmed']} 位待确认",
                      "state": "complete" if active and not missing_results and not counts["individual_results_unconfirmed"] else "pending"})
    steps.append({"tab": "results", "label": "成绩", "summary": f"{confirmed} 项名次已确认",
                  "detail": f"{len(pools)} 个小组排名待核对" if pools else f"{counts['placements_pending']} 项名次待确认",
                  "state": "attention" if pools or counts["placements_pending"] else "complete" if confirmed else "pending"})

    tasks = [{"code": "pool_confirmation", "message": f"{p['stage_name']} / {p['name']} 的比赛已结束",
              "detail": "核对并确认排名，系统据此解析后续晋级名单。",
              "action": {"tab": "results", "pool": p["id"], "label": "核对排名"}} for p in pools]
    if incomplete:
        tasks.append({"code": "profiles_incomplete", "message": f"{len(incomplete)} 所学校的参赛资料待补充",
            "detail": "进入学校报名，补齐队员、队长或性别。", "items": incomplete,
            "action": {"tab": "registration", "label": "检查名单"}})
    if unscheduled:
        tasks.append({"code": "unscheduled", "message": f"{len(unscheduled)} 场比赛的场地或时间尚未安排",
            "detail": "在比赛列表中补齐安排，便于现场查找。",
            "action": {"tab": "schedule", "view": "fixtures", "label": "安排场地与时间"}})
    if counts["placements_pending"]:
        tasks.append({"code": "placements_pending", "message": f"{counts['placements_pending']} 项名次待确认",
            "detail": "核对来源与名次后提交确认。", "action": {"tab": "results", "label": "核对名次"}})
    # Only these eight cards need full match serialization. Counts above use
    # the shared rules over this request's database snapshot, without building
    # thousands of unrelated card dependencies or intercepting per-row SQL.
    card_ids = [m['id'] for m in scoreable[:5] + pending[:3]]
    cards = {r['id']:dict(r) for r in db.q(conn,
        'SELECT * FROM matches WHERE id IN (' + ','.join('?' for _ in card_ids) + ')', card_ids)} if card_ids else {}
    match_reads = BatchReadConnection(conn, cards.values(), with_sets=False)
    return {
        "category": cat, "counts": counts,
        "plan": {k: plan[k] for k in ("id", "name", "status", "version")} if plan else None,
        "task": task, "primary_action": primary, "steps": steps, "tasks": tasks,
        "blockers": blockers, "reminders": reminders,
        "upcoming_matches": [serialize_match(match_reads, cards[m['id']], with_sets=False) for m in scoreable[:5]],
        "waiting_matches": [serialize_match(match_reads, cards[m['id']], with_sets=False) for m in pending[:3]],
        "allowed_actions": {"registration": role in ("admin", "organizer"),
                            "schedule": cat["kind"] == "team" and role in ("admin", "organizer"),
                            "record": role in ("admin", "organizer", "recorder"), "view_results": True},
    }
