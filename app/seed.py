"""演示数据：建立赛事、三个大组别、学校名单与一个已锁定的编排方案。

用法：python run.py --seed
演示数据只用于熟悉界面，正式比赛前请用 --reset-db 清空后重新录入。
"""
from __future__ import annotations

import json

from . import db, security
from .domain import advancement, formats
from .domain.slots import SlotSpec

SCHOOLS = {
    "甲": ["A大学", "B大学", "C大学", "D大学", "E大学", "F大学"],
    "乙": ["G学院", "H学院", "I学院", "J学院"],
    "丙": ["K职业学院", "L职业学院", "M职业学院"],
}
ATHLETE_NAMES = ["张一", "王二", "李三", "赵四", "陈五", "刘六"]


def seed_demo(conn) -> dict:
    initial_password = security.ensure_default_users(conn)
    if initial_password:
        print(f"已创建管理员账号 admin，初始密码：{initial_password}（只显示这一次，请登录后立即修改）")
    if db.q1(conn, "SELECT id FROM events LIMIT 1"):
        print("已有赛事数据，跳过演示数据写入（如需重建请使用 --reset-db --seed）")
        return {}

    event_id = db.insert(conn, "events", {
        "name": "首都高等学校藤球比赛（演示数据）",
        "start_date": "2026-09-20", "end_date": "2026-09-21",
        "location": "综合体育馆", "status": "running"})
    groups = {}
    for code, name, seq in (("甲", "甲组：央属高校", 1), ("乙", "乙组：市属高校", 2),
                            ("丙", "丙组：高职高专", 3)):
        group_id = db.insert(conn, "groups", {"event_id": event_id, "code": code,
                                              "name": name, "seq": seq})
        groups[code] = group_id
        for gender in ("male", "female"):
            for kind, offset in (("team", 0), ("individual", 2)):
                db.insert(conn, "categories", {
                    "group_id": group_id, "gender": gender, "kind": kind,
                    "name": f"{'男子' if gender == 'male' else '女子'}{'三人赛' if kind == 'team' else '个人赛'}",
                    "seq": (0 if gender == "male" else 1) + offset})
    venues = []
    for i, vname in enumerate(("1号场地", "2号场地", "3号场地"), start=1):
        venues.append(db.insert(conn, "venues", {"event_id": event_id, "name": vname, "seq": i}))

    for code, names in SCHOOLS.items():
        group_id = groups[code]
        cats = {(c["gender"], c["kind"]): c["id"] for c in db.q(
            conn, "SELECT * FROM categories WHERE group_id = ?", (group_id,))}
        for i, school_name in enumerate(names):
            school_id = db.insert(conn, "schools", {
                "event_id": event_id, "name": school_name,
                "short_name": school_name.replace("大学", "").replace("学院", "").replace("职业学院", "")})
            db.insert(conn, "school_entries", {"event_id": event_id, "group_id": group_id,
                                               "school_id": school_id})
            for gender, cat_kind in (("male", "team"), ("female", "team")):
                athletes = []
                for j in range(3):
                    athletes.append(db.insert(conn, "athletes", {
                        "group_id": group_id, "school_id": school_id,
                        "name": f"{ATHLETE_NAMES[(i + j) % len(ATHLETE_NAMES)]}",
                        "gender": gender, "jersey_no": str(j + 1)}))
                team_id = db.insert(conn, "teams", {
                    "category_id": cats[(gender, "team")], "school_id": school_id,
                    "name": f"{school_name.replace('大学', '').replace('学院', '')}"
                            f"{'男' if gender == 'male' else '女'}队"})
                for j, athlete_id in enumerate(athletes):
                    db.insert(conn, "team_members", {"team_id": team_id, "athlete_id": athlete_id,
                                                     "jersey_no": str(j + 1),
                                                     "is_captain": 1 if j == 0 else 0})
                db.insert(conn, "participations", {
                    "category_id": cats[(gender, "team")], "team_id": team_id, "seed_no": i + 1})
            for gender in ("male", "female"):
                for j in range(2):
                    athlete_id = db.insert(conn, "athletes", {
                        "group_id": group_id, "school_id": school_id,
                        "name": f"{ATHLETE_NAMES[(i + j + 2) % len(ATHLETE_NAMES)]}",
                        "gender": gender, "jersey_no": ""})
                    db.insert(conn, "participations", {
                        "category_id": cats[(gender, "individual")], "athlete_id": athlete_id})

    # 甲组男子三人赛：两组循环 + 交叉淘汰（含三四名）+ 五、六名评次，直接锁定
    cat_id = db.q1(conn, """SELECT c.id FROM categories c JOIN groups g ON g.id = c.group_id
                             WHERE g.event_id = ? AND g.code = '甲' AND c.gender = 'male'
                               AND c.kind = 'team'""", (event_id,))["id"]
    stages_cfg = [
        {"kind": "round_robin", "name": "小组赛",
         "params": {"legs": 1, "pool_count": 2, "assign": "snake"}},
        {"kind": "single_elim", "name": "淘汰赛",
         "params": {"third_place": True, "sources": [
             {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 1},
             {"type": "pool_rank", "stage": 1, "pool": 1, "rank": 1},
             {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 2},
             {"type": "pool_rank", "stage": 1, "pool": 1, "rank": 2}]}},
        {"kind": "placement", "name": "五、六名比赛",
         "params": {"format": "round_robin", "rank_from": 5, "rank_to": 6, "sources": [
             {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 3},
             {"type": "pool_rank", "stage": 1, "pool": 1, "rank": 3}]}},
    ]
    plan_id = db.insert(conn, "plans", {
        "category_id": cat_id, "name": "演示方案：两组循环 + 交叉淘汰",
        "status": "draft", "version": 1,
        "params_json": json.dumps({"stages": stages_cfg}, ensure_ascii=False)})
    plan = db.q1(conn, "SELECT * FROM plans WHERE id = ?", (plan_id,))
    _generate(conn, plan, stages_cfg)

    # 乙组男子三人赛：单循环，生成预览但保持未锁定，便于演示“预览核对”状态
    cat_b = db.q1(conn, """SELECT c.id FROM categories c JOIN groups g ON g.id = c.group_id
                            WHERE g.event_id = ? AND g.code = '乙' AND c.gender = 'male'
                              AND c.kind = 'team'""", (event_id,))["id"]
    stages_b = [{"kind": "round_robin", "name": "单循环", "params": {"legs": 1}}]
    plan_b = db.insert(conn, "plans", {
        "category_id": cat_b, "name": "演示方案：单循环", "status": "draft", "version": 1,
        "params_json": json.dumps({"stages": stages_b}, ensure_ascii=False)})
    _generate(conn, db.q1(conn, "SELECT * FROM plans WHERE id = ?", (plan_b,)), stages_b)

    admin = db.q1(conn, "SELECT * FROM users WHERE username = 'admin'")
    security.audit(conn, admin, "seed_demo", "event", event_id)
    print(f"演示数据：赛事 #{event_id}，学校 {sum(len(v) for v in SCHOOLS.values())} 所，"
          f"甲组男子三人赛已生成并锁定方案（{len(SCHOOLS['甲'])} 队）")
    return {"event_id": event_id, "plan_id": plan_id}


def _generate(conn, plan, stages_cfg) -> None:
    """按种子顺序生成阶段结构（与接口层的生成流程一致）。"""
    participation_ids = [r["id"] for r in db.q(
        conn, """SELECT id FROM participations WHERE category_id = ? AND status = 'active'
                  ORDER BY seed_no IS NULL, seed_no, id""", (plan["category_id"],))]
    for seq, cfg in enumerate(stages_cfg, start=1):
        params = cfg.get("params") or {}
        sources: list[SlotSpec] = []
        for d in params.get("sources") or []:
            if d["type"] == "pool_rank":
                stage_row = db.q1(conn, "SELECT id FROM stages WHERE plan_id = ? AND seq = ?",
                                  (plan["id"], int(d["stage"])))
                pool_rows = db.q(conn, "SELECT id FROM pools WHERE stage_id = ? ORDER BY seq, id",
                                 (stage_row["id"],))
                sources.append(SlotSpec("pool_rank", pool_ref=pool_rows[int(d["pool"])]["id"],
                                        rank=int(d["rank"])))
            else:
                raise ValueError(f"演示数据不支持来源类型 {d['type']}")
        if not sources:
            sources = [SlotSpec("participation", participation_id=pid) for pid in participation_ids]
        gen = formats.generate_stage(cfg["kind"], sources, params, seq, cfg.get("name") or cfg["kind"])
        stage_id = db.insert(conn, "stages", {
            "plan_id": plan["id"], "seq": gen.seq, "kind": gen.kind, "name": gen.name,
            "params_json": json.dumps(gen.params, ensure_ascii=False), "note": gen.note})
        pool_key_map = {}
        for pool in gen.pools:
            pool_id = db.insert(conn, "pools", {
                "stage_id": stage_id, "name": pool.name, "kind": pool.kind, "seq": pool.seq,
                "status": "pending", "rank_from": pool.rank_from, "rank_to": pool.rank_to})
            pool_key_map[pool.key] = pool_id
            for i, pid in enumerate(pool.members, start=1):
                if pid:
                    conn.execute("INSERT OR IGNORE INTO pool_members (pool_id, participation_id, seed_no)"
                                 " VALUES (?, ?, ?)", (pool_id, pid, i))
        match_key_map = {}
        for m in gen.matches:
            cols = {"category_id": plan["category_id"], "plan_id": plan["id"],
                    "plan_version": plan["version"], "stage_id": stage_id,
                    "pool_id": pool_key_map.get(m.pool_key), "seq": m.seq, "round_no": m.round_no,
                    "round_label": m.round_label, "status": "pending", "note": m.note}
            cols.update(m.home.to_columns("home", match_key_map={}, pool_key_map=pool_key_map))
            cols.update(m.away.to_columns("away", match_key_map={}, pool_key_map=pool_key_map))
            match_key_map[m.key] = db.insert(conn, "matches", cols)
        for m in gen.matches:
            updates = {}
            if m.home.type in ("match_winner", "match_loser") and m.home.match_ref in match_key_map:
                updates["home_source_match"] = match_key_map[m.home.match_ref]
            if m.away.type in ("match_winner", "match_loser") and m.away.match_ref in match_key_map:
                updates["away_source_match"] = match_key_map[m.away.match_ref]
            if updates:
                sets = ", ".join(f"{k} = ?" for k in updates)
                conn.execute(f"UPDATE matches SET {sets} WHERE id = ?",
                             (*updates.values(), match_key_map[m.key]))
    advancement.refresh_plan(conn, plan["id"])
    locked = plan["status"] == "draft" and plan["name"].startswith("演示方案：两组")
    db.update(conn, "plans", plan["id"], {
        "status": "locked" if locked else "previewed",
        "locked_at": db.now(conn) if locked else None,
        "locked_by": db.q1(conn, "SELECT id FROM users WHERE username = 'admin'")["id"] if locked else None})
