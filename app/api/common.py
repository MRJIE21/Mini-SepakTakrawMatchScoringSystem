"""接口层公用查询与序列化。"""
from __future__ import annotations

from .. import db
from ..domain import slots as slotmod
from ..domain import validation, advancement
from ..errors import not_found

GENDER_NAMES = {"male": "男子", "female": "女子"}
KIND_NAMES = {"team": "三人赛", "individual": "个人赛"}
MATCH_STATUS_NAMES = {
    "pending": "等待前序结果",
    "ready": "待记录",
    "finished": "已确认",
    "void": "轮空/不进行",
}
RESULT_STATUS_NAMES = {
    "normal": "正常完成",
    "home_forfeit": "主队弃权",
    "away_forfeit": "客队弃权",
    "unfinished": "未完成",
    "cancelled": "已取消",
}


def get_or_404(conn, table: str, row_id: int, label: str = "对象"):
    row = db.q1(conn, f"SELECT * FROM {table} WHERE id = ?", (row_id,))
    if row is None:
        raise not_found(f"{label}不存在（id={row_id}）")
    return row


def participation_info(conn, pid: int) -> dict:
    row = db.q1(
        conn,
        """SELECT p.id, p.category_id, p.team_id, p.athlete_id, p.seed_no, p.status,
                  t.name AS team_name, t.school_id AS team_school,
                  a.name AS athlete_name, a.school_id AS athlete_school, a.gender AS athlete_gender,
                  s.id AS school_id, s.name AS school_name, s.short_name AS school_short,
                  c.kind AS category_kind, c.gender AS category_gender,
                  g.name AS group_name, g.id AS group_id
             FROM participations p
             JOIN categories c ON c.id = p.category_id
             JOIN groups g ON g.id = c.group_id
             LEFT JOIN teams t ON t.id = p.team_id
             LEFT JOIN athletes a ON a.id = p.athlete_id
             LEFT JOIN schools s ON s.id = COALESCE(t.school_id, a.school_id)
            WHERE p.id = ?""",
        (pid,))
    if row is None:
        raise not_found(f"参赛记录不存在（id={pid}）")
    info = dict(row)
    school_label = info["school_short"] or info["school_name"]
    if info["team_id"]:
        info["label"] = school_label
        info["subject"] = info["school_name"]
        info["display"] = school_label
    else:
        info["label"] = info["athlete_name"]
        info["subject"] = info["athlete_name"]
        info["display"] = f"{school_label}·{info['label']}"
    return info


def participation_display_map(conn, ids: list[int]) -> dict[int, str]:
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    rows = db.q(conn,
                f"""SELECT p.id, p.team_id,
                           COALESCE(t.name, a.name) AS subject,
                           COALESCE(NULLIF(s.short_name, ''), s.name) AS school
                      FROM participations p
                      LEFT JOIN teams t ON t.id = p.team_id
                      LEFT JOIN athletes a ON a.id = p.athlete_id
                      LEFT JOIN schools s ON s.id = COALESCE(t.school_id, a.school_id)
                     WHERE p.id IN ({marks})""", ids)
    return {r["id"]: r["school"] if r["team_id"]
            else f"{r['school']}·{r['subject']}" for r in rows}


def category_context(conn, category_id: int) -> dict:
    row = db.q1(
        conn,
        """SELECT c.*, g.name AS group_name, g.code AS group_code, g.event_id, e.name AS event_name
             FROM categories c JOIN groups g ON g.id = c.group_id
             JOIN events e ON e.id = g.event_id WHERE c.id = ?""",
        (category_id,))
    if row is None:
        raise not_found(f"项目不存在（id={category_id}）")
    return dict(row)


def active_plan(conn, category_id: int):
    return db.q1(conn,
                 """SELECT * FROM plans WHERE category_id = ?
                     ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'locked' THEN 1
                              WHEN 'previewed' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END, id DESC
                     LIMIT 1""", (category_id,))


def plan_effective(conn, plan) -> bool:
    """方案是否已生效：已锁定/执行中，或包含管理员手工建立的自定义阶段。

    手动添加的比赛由编排人员逐场指定双方，不需要再走“生成预览 → 锁定”流程。
    """
    if plan is None:
        return False
    if plan["status"] in ("locked", "running"):
        return True
    return bool(db.q1(conn,
                      "SELECT id FROM stages WHERE plan_id = ? AND kind = 'custom' LIMIT 1",
                      (plan["id"],)))


def match_plan_effective(conn, row, plan=None):
    plan = plan or db.q1(conn, "SELECT * FROM plans WHERE id=?", (row["plan_id"],))
    if not plan or plan["status"] == "archived":
        return False
    if plan["status"] in ("locked", "running"):
        return True
    stage = db.q1(conn, "SELECT kind FROM stages WHERE id=? AND plan_id=?", (row["stage_id"], plan["id"]))
    return bool(stage and stage["kind"] == "custom")


def recording_blocker(conn, row):
    if dict(row).get('reset_state', 'none') in ('inactive', 'review'):
        return '该重置场次已停用或待复核，不能记录'
    if row["status"] == "pending":
        return "等待前序结果，暂不能计分"
    if row["status"] == "void":
        return "该场次为轮空，没有实际比赛"
    if row["status"] == "finished":
        return "该场次已确认，更正需要编排与成绩人员操作"
    if not match_plan_effective(conn, row):
        return "编排方案尚未生效，请管理员先锁定方案，再领取任务和开始记录"
    return ""


def slot_view(conn, row: dict, prefix: str) -> dict:
    """把一个签位来源转成前端可展示的描述。"""
    stype = row[f"{prefix}_source_type"]
    view = {"type": stype, "type_name": {"participation": "指定队伍", "pool_rank": "小组名次",
                                         "match_winner": "前一场胜者", "match_loser": "前一场负者",
                                         "bye": "轮空"}[stype],
            "participation_id": None, "label": "", "source_match_id": row.get(f"{prefix}_source_match"),
            "source_pool_id": row.get(f"{prefix}_source_pool"),
            "source_rank": row.get(f"{prefix}_source_rank"), "resolved": False, "reason": ""}
    if stype == "bye":
        view["resolved"] = True
        view["label"] = "轮空"
        return view
    actual = row.get(f"{prefix}_actual")
    status = row.get("status")
    if actual:
        view["participation_id"] = actual
        view["resolved"] = True
        view["label"] = participation_display_map(conn, [actual]).get(actual, "")
    elif stype == "participation" and row.get(f"{prefix}_participation"):
        view["participation_id"] = row[f"{prefix}_participation"]
        view["resolved"] = True
        view["label"] = participation_display_map(
            conn, [row[f"{prefix}_participation"]]).get(row[f"{prefix}_participation"], "")
    else:
        if status == "pending":
            view["reason"] = advancement.resolve_slot(conn, row, prefix)[2] or "等待前序结果"
        else:
            view["reason"] = row.get("note") or "待确定"
    return view


def serialize_match(conn, row, with_sets: bool = True) -> dict:
    from ..access import owner_info
    row = dict(row)
    home = slot_view(conn, row, "home")
    away = slot_view(conn, row, "away")
    info = {
        "id": row["id"],
        "category_id": row["category_id"],
        "stage_id": row["stage_id"],
        "pool_id": row["pool_id"],
        "round_no": row["round_no"],
        "round_label": row["round_label"],
        "seq": row["seq"],
        "venue_id": row["venue_id"],
        "scheduled_at": row["scheduled_at"],
        "status": row["status"],
        "status_name": MATCH_STATUS_NAMES.get(row["status"], row["status"]),
        "result_status": row["result_status"],
        "result_status_name": RESULT_STATUS_NAMES.get(row["result_status"] or "", ""),
        "result_version": row["result_version"],
        "plan_id": row["plan_id"],
        "plan_version": row["plan_version"],
        "note": advancement.display_note(conn, row),
        "manual_note": "" if advancement.is_dependency_note(row["note"]) else (row["note"] or ""),
        "dependency_note": advancement.dependency_note(conn, row),
        "home": home,
        "away": away,
        "updated_at": row["updated_at"],
        "reset_state": row.get("reset_state", "none"),
        "reset_parent_id": row.get("reset_parent_id"),
    }
    info["blocked_reason"] = recording_blocker(conn, row)
    info["can_score"] = not bool(info["blocked_reason"])
    info.update(owner_info(conn, 'match', row['id']))
    authors = db.q(conn, 'SELECT s.user_id,u.display_name FROM submissions s LEFT JOIN users u ON u.id=s.user_id WHERE s.match_id=? ORDER BY s.id', (row['id'],))
    if authors:
        info['recorder_name'] = authors[0]['display_name'] or ''
        info['corrector_name'] = authors[-1]['display_name'] if len(authors) > 1 else ''
    correction = db.q1(conn, '''SELECT u.display_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
        WHERE a.entity_type='match' AND a.entity_id=? AND a.action IN ('correct_match','cancel_match')
        ORDER BY a.id DESC LIMIT 1''', (row['id'],))
    if correction:
        info['corrector_name'] = correction['display_name'] or ''
    if row["venue_id"]:
        venue = db.q1(conn, "SELECT name FROM venues WHERE id = ?", (row["venue_id"],))
        info["venue_name"] = venue["name"] if venue else ""
    else:
        info["venue_name"] = ""
    if row["stage_id"]:
        stage = db.q1(conn, "SELECT name FROM stages WHERE id = ?", (row["stage_id"],))
        info["stage_name"] = stage["name"] if stage else ""
    else:
        info["stage_name"] = ""
    if with_sets:
        sets = db.q(conn, "SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no", (row["id"],))
        info["sets"] = [dict(s) for s in sets]
        info["winner_side"] = validation.match_winner_from_sets(info["sets"]) \
            if row["result_status"] in ("normal", "home_forfeit", "away_forfeit") else None
        if row["result_status"] == "home_forfeit":
            info["winner_side"] = "away"
        elif row["result_status"] == "away_forfeit":
            info["winner_side"] = "home"
    return info


def serialize_matches(conn, rows, with_sets: bool = True) -> list[dict]:
    """Serialize a page with one request-local set of relation queries."""
    rows = list(rows)
    if not rows:
        return []
    from .batch_matches import BatchReadConnection
    cached = BatchReadConnection(conn, rows, with_sets)
    return [serialize_match(cached, row, with_sets) for row in rows]


def match_full_context(conn, match_id: int) -> dict:
    row = get_or_404(conn, "matches", match_id, "场次")
    info = serialize_match(conn, row)
    ctx = category_context(conn, row["category_id"])
    info["category_name"] = ctx["name"]
    info["category_gender"] = ctx["gender"]
    info["group_name"] = ctx["group_name"]
    info["event_id"] = ctx["event_id"]
    if row["stage_id"]:
        stage = db.q1(conn, "SELECT name, kind, params_json FROM stages WHERE id = ?", (row["stage_id"],))
        info["stage_name"] = stage["name"] if stage else ""
        info["stage_kind"] = stage["kind"] if stage else ""
    if row["pool_id"]:
        pool = db.q1(conn, "SELECT name, status FROM pools WHERE id = ?", (row["pool_id"],))
        info["pool_name"] = pool["name"] if pool else ""
        info["pool_status"] = pool["status"] if pool else ""
    plan = db.q1(conn, "SELECT * FROM plans WHERE id = ?", (row["plan_id"],))
    info["plan_status"] = plan["status"] if plan else ""
    info["plan_locked"] = bool(plan and plan["status"] in ("locked", "running"))
    return info


def side_players(conn, participation_id: int) -> list[dict]:
    info = participation_info(conn, participation_id)
    if not info["team_id"]:
        return []
    rows = db.q(conn,
                """SELECT a.id, a.name, a.jersey_no, tm.jersey_no AS member_jersey, tm.is_captain
                     FROM team_members tm JOIN athletes a ON a.id = tm.athlete_id
                    WHERE tm.team_id = ? ORDER BY tm.id""", (info["team_id"],))
    return [{"player_id": r["id"], "name": r["name"],
             "jersey_no": r["member_jersey"] or r["jersey_no"],
             "is_captain": bool(r["is_captain"])} for r in rows]


def describe_spec(spec: slotmod.SlotSpec, conn=None) -> str:
    return spec.describe()
