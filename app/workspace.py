"""从后台正式记录推导项目进度和操作入口；读取不改变赛程或成绩。"""
import json
from . import db
from .api.common import (active_plan, category_context, participation_info,
                         plan_effective, recording_blocker, serialize_match)


def category_snapshot(conn, category_id, role):
    # 资料判断与报名名单共用，保持两个入口的口径一致。
    from .api.catalog import team_captain_id, team_profile_gaps

    cat = category_context(conn, category_id)
    parts = db.q(conn, "SELECT * FROM participations WHERE category_id = ? ORDER BY id",
                 (category_id,))
    active = [p for p in parts if p["status"] == "active"]
    incomplete = []
    for part in active:
        if cat["kind"] == "team":
            gaps = team_profile_gaps(conn, part["team_id"], team_captain_id(conn, part["team_id"]))
        else:
            athlete = db.q1(conn, "SELECT gender FROM athletes WHERE id = ?", (part["athlete_id"],))
            gaps = ["性别待补充"] if athlete and not athlete["gender"] else []
        if gaps:
            info = participation_info(conn, part["id"])
            incomplete.append({"participation_id": part["id"], "school_id": info["school_id"],
                               "display": info["display"], "gaps": gaps})

    plan = active_plan(conn, category_id)
    matches = db.q(conn, """SELECT * FROM matches WHERE category_id = ?
        ORDER BY NULLIF(TRIM(scheduled_at), '') IS NULL, NULLIF(TRIM(scheduled_at), ''),
                 stage_id, round_no, seq, id""", (category_id,))
    actual = [m for m in matches if m["status"] != "void"]
    ready = [m for m in actual if m["status"] == "ready"]
    scoreable = [m for m in ready if not recording_blocker(conn, m)]
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
    remaining_rounds = []
    next_rounds = []
    if plan:
        for stage in db.q(conn, "SELECT * FROM stages WHERE plan_id = ? AND kind = 'swiss' ORDER BY seq, id", (plan["id"],)):
            rounds = int(json.loads(stage["params_json"] or "{}").get("rounds") or 0)
            stage_matches = [m for m in matches if m["stage_id"] == stage["id"]]
            generated = max((m["round_no"] for m in stage_matches), default=0)
            if rounds > generated:
                remaining_rounds.append(stage["id"])
                if generated and plan["status"] in ("locked", "running") and all(
                        m["status"] in ("finished", "void") for m in stage_matches if m["round_no"] == generated):
                    next_rounds.append({"stage_id": stage["id"], "name": stage["name"],
                                        "next_round": generated + 1, "rounds": rounds})
    pools = []
    if plan and plan["status"] != "archived" and plan_effective(conn, plan):
        pools = db.q(conn, """SELECT p.id, p.name, p.stage_id, s.name AS stage_name FROM pools p
            JOIN stages s ON s.id = p.stage_id WHERE s.plan_id = ?
            AND p.kind != 'bracket' AND p.status != 'confirmed'
            AND EXISTS (SELECT 1 FROM pool_members pm WHERE pm.pool_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.pool_id = p.id
                            AND m.status NOT IN ('finished', 'void'))
            ORDER BY s.seq, p.seq, p.id""", (plan["id"],))
        # 瑞士赛还有计划轮次时，应继续生成对阵，不能把首轮结果当最终小组排名。
        if remaining_rounds:
            pools = [p for p in pools if p["stage_id"] not in remaining_rounds]
    config = json.loads(plan["params_json"] or "{}") if plan else {}
    # 尚未生成预览时 stages 表为空，编排配置仍保存在后台方案中。
    auto_stages = bool(plan and (any(s["kind"] != "custom" for s in config.get("stages", []))
                                or db.q1(conn, "SELECT id FROM stages WHERE plan_id = ? AND kind != 'custom' LIMIT 1",
                                         (plan["id"],))))
    needs_plan = bool(auto_stages and plan["status"] in ("draft", "previewed"))
    draw = db.q1(conn, "SELECT status FROM group_draws WHERE category_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1",
                 (category_id,)) if cat["kind"] == "team" else None
    all_played = bool(matches) and len(finished) == len(actual) and not remaining_rounds
    counts = {
        "enrolled": len(active), "withdrawn": sum(p["status"] == "withdrawn" for p in parts),
        "profiles_incomplete": len(incomplete), "matches_total": len(actual),
        "matches_void": len(matches) - len(actual), "matches_ready": len(ready),
        "matches_scoreable": len(scoreable), "matches_pending": len(pending),
        "matches_finished": len(finished), "matches_unscheduled": len(unscheduled),
        "pools_to_confirm": len(pools), "individual_results": len(results),
        "stages_next_round": len(next_rounds),
        "individual_results_missing": missing_results,
        "individual_results_confirmed": sum(r["confirmed"] == 1 for r in results),
        "individual_results_unconfirmed": sum(r["confirmed"] != 1 for r in results),
        "placements_total": len(placements), "placements_confirmed": confirmed,
        "placements_pending": len(placements) - confirmed,
    }
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
        primary = {"tab": "schedule", "view": "planning", "label": ("核对并确认赛程" if role == "admin" else "核对赛程") if plan["status"] == "previewed" else "继续编排赛程"}
        task = "赛程预览尚未确认，先核对分组、晋级关系和场地时间" if plan["status"] == "previewed" else "完善比赛流程并生成赛程预览"
        if plan["status"] == "previewed" and role != "admin":
            task += "；核对后请赛事管理员确认方案"
    elif not matches:
        primary, task = {"tab": "schedule", "label": "安排比赛"}, "安排分组与赛程，可逐场录入或使用抽签编排"
    elif pools:
        primary = {"tab": "results", "pool": pools[0]["id"], "label": "核对小组排名"}
        task = f"{len(pools)} 个小组比赛已结束，核对并确认排名后才能继续晋级"
    elif next_rounds:
        primary = {"tab": "schedule", "view": "planning", "stage": next_rounds[0]["stage_id"], "label": "生成下一轮对阵"}
        task = f"{next_rounds[0]['name']} 当前轮已完成，继续生成第 {next_rounds[0]['next_round']} 轮对阵"
    elif scoreable:
        primary, task = {"tab": "matches", "status": "ready", "label": "进入待记录场次"}, f"{len(scoreable)} 场比赛可进入记录"
    elif pending:
        primary, task = {"tab": "schedule", "status": "pending", "label": "查看待晋级场次"}, "后续场次正在等待前序结果或晋级名单"
    elif ready:
        primary, task = {"tab": "schedule", "view": "planning", "label": "核对赛程状态"}, "待记录场次的编排方案尚未生效"
    elif all_played:
        primary = {"tab": "results", "label": "核对名次" if not confirmed or counts["placements_pending"] else "查看成绩与名次"}
        task = "比赛已全部确认，核对并确认项目名次" if not confirmed or counts["placements_pending"] else "比赛已全部确认，查看项目名次"
    else:
        primary, task = {"tab": "schedule", "label": "核对赛程"}, "核对比赛安排"

    schedule_summary = "未安排比赛"
    schedule_state = "pending"
    if needs_plan:
        schedule_summary = "预览待确认" if plan["status"] == "previewed" else "编排待完善"
        schedule_state = "attention"
    elif matches:
        schedule_summary = "赛程已确认" if plan and plan["status"] in ("locked", "running") else "场次已录入"
        schedule_state = "complete"
    elif draw:
        schedule_summary = "分组已确认，待编排" if draw["status"] == "confirmed" else "抽签待完成或确认"
        schedule_state = "attention"
    steps = [{"tab": "registration", "label": "报名名单", "summary": f"{len(active)} 所学校已报名",
              "detail": f"{len(incomplete)} 项资料待补充" if incomplete else "参赛名单与人员资料",
              "state": "attention" if incomplete else "complete" if active else "pending"}]
    if cat["kind"] == "team":
        steps.extend([
            {"tab": "schedule", "label": "分组与赛程", "summary": schedule_summary,
             "detail": f"{len(actual)} 场比赛 · {len(matches) - len(actual)} 场轮空", "state": schedule_state},
            {"tab": "matches", "label": "比赛记录", "summary": f"{len(finished)} / {len(actual)} 场已确认",
             "detail": "当前轮已确认，待生成下一轮" if next_rounds else f"{len(scoreable)} 场可记录 · {len(pending)} 场待晋级",
             "state": "complete" if all_played else "ready" if scoreable else "pending"},
        ])
    else:
        steps.append({"tab": "entry", "label": "成绩录入", "summary": f"{len(results)} / {len(active)} 位已录成绩",
                      "detail": f"{missing_results} 位待录入 · {counts['individual_results_unconfirmed']} 位待确认",
                      "state": "complete" if active and not missing_results and not counts["individual_results_unconfirmed"] else "pending"})
    steps.append({"tab": "results", "label": "成绩与名次", "summary": f"{confirmed} 项名次已确认",
                  "detail": f"{len(pools)} 个小组排名待核对" if pools else f"{counts['placements_pending']} 项名次待确认",
                  "state": "attention" if pools or counts["placements_pending"] else "complete" if confirmed else "pending"})

    tasks = [{"code": "pool_confirmation", "message": f"{p['stage_name']} / {p['name']} 的比赛已结束",
              "detail": "核对并确认排名，系统据此解析后续晋级名单。",
              "action": {"tab": "results", "pool": p["id"], "label": "核对排名"}} for p in pools]
    tasks.extend({"code": "next_round", "message": f"{s['name']} 待生成第 {s['next_round']} 轮对阵",
                  "detail": f"本阶段共安排 {s['rounds']} 轮；下一轮依据当前已确认成绩配对。",
                  "action": {"tab": "schedule", "view": "planning", "stage": s["stage_id"], "label": "继续编排"}}
                 for s in next_rounds)
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
    return {
        "category": cat, "counts": counts,
        "plan": {k: plan[k] for k in ("id", "name", "status", "version")} if plan else None,
        "task": task, "primary_action": primary, "steps": steps, "tasks": tasks,
        "blockers": blockers, "reminders": reminders,
        "upcoming_matches": [serialize_match(conn, m, with_sets=False) for m in scoreable[:5]],
        "waiting_matches": [serialize_match(conn, m, with_sets=False) for m in pending[:3]],
        "allowed_actions": {"registration": role in ("admin", "organizer"),
                            "schedule": cat["kind"] == "team" and role in ("admin", "organizer"),
                            "record": role in ("admin", "organizer", "recorder"), "view_results": True},
    }
