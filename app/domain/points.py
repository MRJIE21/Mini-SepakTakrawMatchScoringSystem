"""学校团体总分（设计大纲 7.2、15.2）。

口径：
  - 单项前八名积分 9、7、6、5、4、3、2、1；集体项目（三人赛）按双倍计入。
  - 每个大组别独立汇总本组学校所有项目积分。
  - 集体项目名次积分按代表队计一次，不按队员人数重复累计。
  - 个人项目名次积分归属该选手所在学校。
  - 未确认名次不计入正式积分，单独显示待确认。
  - 总分相同按第一名数量、第二名数量……依次比较，仍相同则录入现场确认结果。
"""
from __future__ import annotations

from .. import config


def base_points_for_rank(rank: int | None) -> int:
    if rank is None or rank < 1 or rank > len(config.PLACEMENT_POINTS):
        return 0
    return config.PLACEMENT_POINTS[rank - 1]


def placement_points(rank: int | None, category_kind: str) -> tuple[int, int, int]:
    """返回 (基础分, 倍数, 实得积分)。"""
    base = base_points_for_rank(rank)
    multiplier = config.TEAM_CATEGORY_MULTIPLIER if category_kind == "team" else 1
    return base, multiplier, base * multiplier


def compute_school_totals(schools: list[dict], points_rows: list[dict],
                          pending_rows: list[dict] | None = None,
                          tiebreaks: dict[int, int] | None = None,
                          started: bool = True) -> dict:
    """汇总学校总分。

    schools:     [{school_id, name, short_name}]
    points_rows: [{school_id, points, rank_no, category_id, category_name,
                   participation_label, base_points, multiplier, kind}]
    pending_rows:[{school_id, category_name, participation_label}]  未确认名次
    tiebreaks:   {school_id: manual_order}
    started:     False 表示该大组别尚无任何已开赛场次：不产生名次（rank=None、
                 status='not_started'、不显示待确认项），总分仍按现有规则求和。
    """
    pending_rows = pending_rows or []
    tiebreaks = tiebreaks or {}
    table: dict[int, dict] = {}
    for s in schools:
        table[s["school_id"]] = {
            "school_id": s["school_id"],
            "name": s.get("name", ""),
            "short_name": s.get("short_name", ""),
            "total": 0,
            "details": [],
            "rank_counts": {},
            "pending": [],
            "manual_order": tiebreaks.get(s["school_id"]),
        }
    max_rank = len(config.PLACEMENT_POINTS)
    for row in points_rows:
        entry = table.get(row["school_id"])
        if entry is None:
            continue
        entry["total"] += int(row.get("points") or 0)
        entry["details"].append({
            "category_id": row.get("category_id"),
            "category_name": row.get("category_name", ""),
            "category_gender": row.get("category_gender", ""),
            "participation_label": row.get("participation_label", ""),
            "rank_no": row.get("rank_no"),
            "base_points": row.get("base_points"),
            "multiplier": row.get("multiplier"),
            "points": row.get("points"),
            "kind": row.get("kind", ""),
        })
        rank_no = row.get("rank_no")
        if rank_no and 1 <= rank_no <= max_rank:
            entry["rank_counts"][rank_no] = entry["rank_counts"].get(rank_no, 0) + 1
    for row in pending_rows:
        entry = table.get(row["school_id"])
        if entry is not None:
            entry["pending"].append(row)

    entries = list(table.values())
    for e in entries:
        e["details"].sort(key=lambda d: (d["category_name"], d["rank_no"] or 999))
        e["rank_vector"] = [e["rank_counts"].get(i, 0) for i in range(1, max_rank + 1)]

    unresolved: list[dict] = []

    def sort_key(e: dict):
        manual = e["manual_order"] if e["manual_order"] is not None else 10 ** 6
        return (-e["total"],) + tuple(-c for c in e["rank_vector"]) + (manual,)

    # 先按总分与名次数量排序，再把“完全并列且没有现场确认结果”的学校标为待确认
    ordered = sorted(entries, key=sort_key)
    groups: dict[tuple, list[dict]] = {}
    for e in ordered:
        key = (e["total"],) + tuple(e["rank_vector"])
        groups.setdefault(key, []).append(e)

    def is_unresolved(key: tuple, group: list[dict]) -> bool:
        if len(group) < 2:
            return False
        if key[0] == 0 and not any(key[1:]):
            return False        # 尚无任何积分的学校不视为并列
        orders = [g["manual_order"] for g in group]
        # 现场顺序必须覆盖整个并列集合，且为完整、不重复的 1..N。
        return any(order is None for order in orders) or set(orders) != set(range(1, len(group) + 1))

    unresolved_keys = set() if not started else {
        key for key, group in groups.items() if is_unresolved(key, group)}
    for key in unresolved_keys:
        group = groups[key]
        unresolved.append({
            "total": key[0],
            "schools": [{"school_id": g["school_id"], "name": g["name"]} for g in group],
            "hint": "总分与各名次数量均相同，需录入现场确认结果",
        })
    position = 0
    for e in ordered:
        position += 1
        e["position"] = position
        group_key = (e["total"],) + tuple(e["rank_vector"])
        if not started:
            # 未开赛组别不产生伪名次：名次留空，也不把“尚未开赛”标成“待确认”。
            e["status"] = "not_started"
            e["rank"] = None
        elif group_key in unresolved_keys:
            e["status"] = "tie_pending"
            e["rank"] = None
        else:
            e["status"] = "ok"
            e["rank"] = position
    if not started:
        for e in ordered:
            e["pending"] = []
    for e in ordered:
        if e["manual_order"] is None:
            e.pop("manual_order", None)
    return {"rows": ordered, "unresolved": unresolved, "started": bool(started)}
