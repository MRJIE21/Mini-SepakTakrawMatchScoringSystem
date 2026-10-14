"""小组排名：积分 → C 值 → Z 值 → 抽签（设计大纲 7.1）。

已确认口径：
  - 胜一场 2 分、负一场 1 分、弃权 0 分。
  - 同积分比较 C 值（胜局/负局），大者在前。
  - C 值仍相同比较 Z 值（得分/失分），大者在前。
  - Z 值仍相同通过抽签确定名次，录入并保存现场抽签结果。
  - 不额外插入相互胜负、净胜分或其他排序指标；比较使用精确比值。

计算边界（设计约定）：
  - 只统计同一小组内已确认且有效的比赛；未完成、取消、轮空场次不计入。
  - 弃权方 0 分，对手记 2 分；不自动补造局分和比分，因此不产生 C/Z 数据。
  - 正数除以零按无限大；0/0 标为不可计算，该组标记为待确认。
"""
from __future__ import annotations

from .slots import ratio, ratio_bucket, ratio_key, ratio_text, ratio_value
from .. import config

VALID_RESULT_STATUS = ("normal", "home_forfeit", "away_forfeit")


def _empty_stat(participation_id: int, label: str = "") -> dict:
    return {
        "participation_id": participation_id,
        "label": label,
        "played": 0,
        "wins": 0,
        "losses": 0,
        "forfeits": 0,
        "points": 0,
        "sets_won": 0,
        "sets_lost": 0,
        "points_won": 0,
        "points_lost": 0,
        "lot_value": None,
        "byes": 0,
        "bye_win": False,
    }


def match_winner_side(match: dict) -> str | None:
    """返回 'home' / 'away'。"""
    status = match.get("result_status")
    if status not in VALID_RESULT_STATUS or match.get("status", "finished") != "finished":
        return None
    if status == "home_forfeit":
        return "away"
    if status == "away_forfeit":
        return "home"
    sets = match.get("sets") or []
    home_sets = sum(1 for s in sets if s.get("winner_side") == "home")
    away_sets = sum(1 for s in sets if s.get("winner_side") == "away")
    if home_sets == away_sets or max(home_sets, away_sets) < config.TEAM_SETS_TO_WIN:
        return None
    return "home" if home_sets > away_sets else "away"


DEFAULT_POINTS = {"win": 2, "loss": 1, "forfeit": 0}


def compute_standings(members: list[dict], matches: list[dict],
                      lots: dict[int, int] | None = None,
                      bye_award: str = "none",
                      points: dict | None = None) -> dict:
    """计算小组排名。

    members: [{participation_id, label}]
    matches: [{home_participation, away_participation, status, result_status,
               sets: [{home_points, away_points, winner_side}]}]
    lots:    {participation_id: lot_value}
    bye_award: 轮空是否授予积分（"win" 记一场胜，其他值只记轮空次数）
    points:  排名积分方案 {win, loss, forfeit}，默认胜 2、负 1、弃权 0
    """
    scheme = {**DEFAULT_POINTS, **(points or {})}
    lots = lots or {}
    member_ids = {m["participation_id"] for m in members}
    stats: dict[int, dict] = {}
    for m in members:
        s = _empty_stat(m["participation_id"], m.get("label", ""))
        s["lot_value"] = lots.get(m["participation_id"])
        stats[m["participation_id"]] = s

    excluded: list[dict] = []
    for match in matches:
        if match.get("reset_state", "none") in ("inactive", "review"):
            continue
        home = match.get("home_participation")
        away = match.get("away_participation")
        if match.get("status") in ("pending", "ready"):
            continue
        if match.get("status") == "void":
            single = None
            if home in member_ids and away not in member_ids:
                single = home
            elif away in member_ids and home not in member_ids:
                single = away
            if single:
                stats[single]["byes"] += 1
                if bye_award == "win":
                    stats[single]["wins"] += 1
                    stats[single]["points"] += int(scheme["win"])
                    stats[single]["bye_win"] = True
                excluded.append({"match_id": match.get("id"),
                                 "reason": "轮空不计为实际比赛" if bye_award != "win"
                                           else "轮空按方案授予胜场积分"})
            else:
                excluded.append({"match_id": match.get("id"), "reason": "轮空或已取消，不计入排名"})
            continue
        if home not in member_ids or away not in member_ids:
            continue
        if match.get("result_status") not in VALID_RESULT_STATUS:
            excluded.append({"match_id": match.get("id"), "reason": "比赛未完成或结果未确认，不计入排名"})
            continue

        hs, as_ = stats[home], stats[away]
        winner = match_winner_side(match)
        if winner is None:
            excluded.append({"match_id": match.get("id"), "reason": "结果不明确，不计入排名"})
            continue

        hs["played"] += 1
        as_["played"] += 1
        if match.get("result_status") == "normal":
            for side, stat in (("home", hs), ("away", as_)):
                sets = match.get("sets") or []
                stat["sets_won"] += sum(
                    1 for s in sets if s.get("winner_side") == side)
                stat["sets_lost"] += sum(
                    1 for s in sets if s.get("winner_side") and s.get("winner_side") != side)
                stat["points_won"] += sum(int(s.get("home_points") or 0) if side == "home"
                                          else int(s.get("away_points") or 0) for s in sets)
                stat["points_lost"] += sum(int(s.get("away_points") or 0) if side == "home"
                                           else int(s.get("home_points") or 0) for s in sets)
            winner_stat = hs if winner == "home" else as_
            loser_stat = as_ if winner == "home" else hs
            winner_stat["wins"] += 1
            loser_stat["losses"] += 1
            winner_stat["points"] += int(scheme["win"])
            loser_stat["points"] += int(scheme["loss"])
        else:
            # 弃权：弃权方 0 分，对手记胜 2 分；不补造局分与比分
            forfeiting = hs if match.get("result_status") == "home_forfeit" else as_
            opponent = as_ if forfeiting is hs else hs
            forfeiting["forfeits"] += 1
            forfeiting["losses"] += 1
            opponent["wins"] += 1
            opponent["points"] += int(scheme["win"])

    for s in stats.values():
        s["c_value"] = ratio(s["sets_won"], s["sets_lost"])
        s["z_value"] = ratio(s["points_won"], s["points_lost"])

    ordered, unresolved = _order(list(stats.values()))

    position = 0
    for row in ordered:
        position += 1
        row["position"] = position
        if row["status"] != "tie_pending":
            row["rank"] = position
        else:
            row["rank"] = None
    for i, row in enumerate(ordered, start=1):
        row["c_text"] = ratio_text(row["c_value"])
        row["z_text"] = ratio_text(row["z_value"])
        row["c_number"] = ratio_value(row["c_value"])
        row["z_number"] = ratio_value(row["z_value"])
        row["ratio_note"] = _ratio_note(row)

    return {"rows": ordered, "unresolved": unresolved, "excluded": excluded}


def _ratio_note(row: dict) -> str:
    if row["c_value"][0] == "undef" or row["z_value"][0] == "undef":
        return "缺少可用局分/比分数据，C 值或 Z 值不可计算，需现场确认"
    return ""


def _order(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """按 积分 → C → Z → 抽签 分桶排序。返回 (排序结果, 未确定集合)。"""
    unresolved: list[dict] = []

    def bucket(rows_: list[dict], keyfunc, orderfunc):
        groups: dict = {}
        for r in rows_:
            groups.setdefault(keyfunc(r), []).append(r)
        return sorted(groups.items(), key=lambda kv: orderfunc(kv[0]))

    def finish(items: list[dict], rank_from: int, rank_to: int, tie_set: str):
        for r in items:
            r["status"] = "tie_pending"
            r["tie_set"] = tie_set
            r["rank_from"] = rank_from
            r["rank_to"] = rank_to
        unresolved.append({
            "tie_set": tie_set,
            "rank_from": rank_from,
            "rank_to": rank_to,
            "members": [{"participation_id": r["participation_id"], "label": r["label"]} for r in items],
            "hint": "积分、C 值、Z 值均相同，需录入抽签结果",
        })

    out: list[dict] = []
    pos = 1
    for points, group in bucket(rows, lambda r: r["points"], lambda k: -k):
        if len(group) == 1:
            _mark_ok(group)
            out.extend(group)
            pos += 1
            continue
        for _ckey, cgroup in bucket(group, lambda r: ratio_bucket(r["c_value"]), ratio_key):
            if len(cgroup) == 1:
                _mark_ok(cgroup)
                out.extend(cgroup)
                pos += 1
                continue
            for _zkey, zgroup in bucket(cgroup, lambda r: ratio_bucket(r["z_value"]), ratio_key):
                if len(zgroup) == 1:
                    _mark_ok(zgroup)
                    out.extend(zgroup)
                    pos += 1
                    continue
                if all(r.get("lot_value") is not None for r in zgroup):
                    zgroup_sorted = sorted(zgroup, key=lambda r: r["lot_value"])
                    for r in zgroup_sorted:
                        _mark_ok([r])
                        r["by_lot"] = True
                    out.extend(zgroup_sorted)
                    pos += len(zgroup_sorted)
                else:
                    finish(zgroup, pos, pos + len(zgroup) - 1, f"抽签组{pos}")
                    out.extend(zgroup)
                    pos += len(zgroup)
    return out, unresolved


def _mark_ok(rows: list[dict]) -> None:
    for r in rows:
        r["status"] = "ok"
        r["tie_set"] = ""
        r["rank_from"] = r.get("rank_from")
        r["rank_to"] = r.get("rank_to")
        r["by_lot"] = r.get("by_lot", False)
