"""签位推进：把已确认的成绩转成后续对阵的参赛位置（设计大纲 5.1、4.2、4.3）。

规则：
  - “轮空”与“对手待定”严格区分：待定表示等待前序结果，轮空表示确定没有对手。
  - 小组第 N 名只在小组名次被确认（并写入快照）后才解析。
  - 已经有结果的场次不会被自动改写参赛双方；发现不一致时只报告受影响场次。
"""
from __future__ import annotations

import re

from . import ranking
from .slots import SlotSpec
from .. import db, team_rules_store
from ..read_projection import text_integer_rows

FINISHED_RESULTS = ("normal", "home_forfeit", "away_forfeit")


def is_dependency_note(note):
    """识别旧版本写入人工备注栏的系统依赖说明。"""
    return note in ("小组名次需要重新确认", "等待前序场次结果确认", "签位来源缺失",
                    "前序场次不存在", "前序场次为轮空，无负者", "前序场次参赛双方未确定",
                    "前序场次结果不明确", "两侧轮空，不生成比赛", "轮空，无实际比赛，不计分") \
        or bool(re.fullmatch(r"等待小组第\d+名确认", note or ""))


def dependency_note(conn, row):
    if dict(row).get("reset_state") in ("inactive", "review"):
        return "重置赛已停用" if row["reset_state"] == "inactive" else "重置赛需要显式复核"
    if row["status"] == "void":
        return "轮空，无实际比赛，不计分"
    if row["status"] != "pending":
        return ""
    return resolve_slot(conn, row, "home")[2] or resolve_slot(conn, row, "away")[2]


def display_note(conn, row):
    manual = "" if is_dependency_note(row["note"]) else (row["note"] or "")
    return "；".join(filter(None, (manual, dependency_note(conn, row))))


# ------------------------------------------------------------------ 单槽解析
def resolve_slot(conn, row, prefix: str, _seen=frozenset()) -> tuple[int | None, bool, str]:
    """返回 (参赛主体 id, 是否轮空, 未解析原因)。"""
    stype = row[f"{prefix}_source_type"]
    if stype == "participation":
        return row[f"{prefix}_participation"], False, ""
    if stype == "bye":
        return None, True, ""
    if stype == "pool_rank":
        snap = conn.execute(
            """SELECT s.participation_id FROM pool_rank_snapshots s
                JOIN pools p ON p.id = s.pool_id
                WHERE s.pool_id = ? AND s.rank_no = ? AND s.status = 'confirmed'
                  AND p.status = 'confirmed'""",
            (row[f"{prefix}_source_pool"], row[f"{prefix}_source_rank"]),
        ).fetchone()
        if snap:
            return snap["participation_id"], False, ""
        pool = conn.execute("SELECT status FROM pools WHERE id = ?",
                            (row[f"{prefix}_source_pool"],)).fetchone()
        reason = ("小组名次需要重新确认" if pool and pool["status"] != "confirmed"
                  else f"等待小组第{row[f'{prefix}_source_rank']}名确认")
        return None, False, reason
    ref = row[f"{prefix}_source_match"]
    if not ref:
        return None, False, "签位来源缺失"
    m = conn.execute("SELECT * FROM matches WHERE id = ?", (ref,)).fetchone()
    if m is None:
        return None, False, "前序场次不存在"
    want_winner = stype == "match_winner"
    if dict(m).get("reset_state") in ("inactive", "review"):
        return None, False, "前序重置赛已停用或需要复核"
    if m["status"] == "void":
        # Structural byes are independent of a played match result. A stopped
        # reset never becomes a bye, and a void row with two teams is not one.
        if bool(m["home_actual"]) == bool(m["away_actual"]):
            return None, False, "前序场次不是有效轮空"
        real = m["home_actual"] or m["away_actual"]
        if want_winner and real:
            return real, False, ""
        return None, False, "前序场次为轮空，无负者"
    if m["status"] != "finished" or m["result_status"] not in FINISHED_RESULTS:
        return None, False, "等待前序场次结果确认"
    if m["home_actual"] is None or m["away_actual"] is None:
        return None, False, "前序场次参赛双方未确定"
    if m["id"] in _seen:
        return None, False, "签位来源存在循环"
    seen = _seen | {m["id"]}
    source_home = resolve_slot(conn, m, "home", seen)
    source_away = resolve_slot(conn, m, "away", seen)
    if (source_home[1] or source_away[1] or not source_home[0] or not source_away[0]
            or (source_home[0], source_away[0]) != (m["home_actual"], m["away_actual"])):
        return None, False, "前序场次对阵依据需复核"
    sets = conn.execute(
        "SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no", (ref,)).fetchall()
    winner = ranking.match_winner_side({"result_status": m["result_status"],
                                        "rules": team_rules_store.match_rules(conn, m)['rules'],
                                        "sets": [dict(s) for s in sets]})
    if winner is None:
        return None, False, "前序场次结果不明确"
    if want_winner:
        return (m["home_actual"] if winner == "home" else m["away_actual"]), False, ""
    return (m["away_actual"] if winner == "home" else m["home_actual"]), False, ""


def result_winner_side(conn, row):
    """A recorded result only counts while its original lineup is still valid."""
    if (row["status"] != "finished" or row["result_status"] not in FINISHED_RESULTS
            or dict(row).get("reset_state") in ("inactive", "review")):
        return None
    home = resolve_slot(conn, row, "home")
    away = resolve_slot(conn, row, "away")
    if (home[1] or away[1] or not home[0] or not away[0]
            or (home[0], away[0]) != (row["home_actual"], row["away_actual"])):
        return None
    sets = conn.execute("SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no",
                        (row["id"],)).fetchall()
    return ranking.match_winner_side({"status": row["status"], "result_status": row["result_status"],
                                      "rules": team_rules_store.match_rules(conn, row)['rules'],
                                      "sets": [dict(s) for s in sets]})


def resolve_spec(conn, spec: SlotSpec) -> tuple[int | None, bool, str]:
    row = dict(spec.to_columns("home"))
    return resolve_slot(conn, row, "home")


# ------------------------------------------------------------------ 方案刷新
def refresh_plan(conn, plan_id: int) -> dict:
    """重算方案内所有签位的解析结果与场次状态。返回受影响场次清单。"""
    matches = text_integer_rows(conn,
        """SELECT id,reset_state,note,status,home_actual,away_actual,pool_id,
            home_source_type,home_participation,home_source_pool,home_source_rank,home_source_match,
            away_source_type,away_participation,away_source_pool,away_source_rank,away_source_match
            FROM matches WHERE plan_id = ? ORDER BY seq, id""",
        ('id','reset_state','note','status','home_actual','away_actual','pool_id',
         'home_source_type','home_participation','home_source_pool','home_source_rank','home_source_match',
         'away_source_type','away_participation','away_source_pool','away_source_rank','away_source_match'), (plan_id,))
    has_candidates = bool(db.q1(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name='result_candidates'"))
    affected: list[dict] = []
    for row in matches:
        if dict(row).get("reset_state") in ("inactive", "review"):
            continue
        home_pid, home_bye, home_reason = resolve_slot(conn, row, "home")
        away_pid, away_bye, away_reason = resolve_slot(conn, row, "away")
        updates: dict = {}
        if is_dependency_note(row["note"]):
            updates["note"] = ""
        if row["status"] == "finished":
            recorded = (row["home_actual"], row["away_actual"])
            resolved = (None if home_bye else home_pid, None if away_bye else away_pid)
            if resolved != recorded or home_bye or away_bye:
                affected.append({
                    "match_id": row["id"],
                    "reason": "前序成绩变化导致对阵双方与已记录结果不一致，需人工处理",
                    "recorded": recorded,
                    "resolved": resolved,
                })
        else:
            # A claimed ready fixture can have offline records not visible on the server.
            # Preserve its identity until an independently reviewed impact plan resolves it.
            recorded = (row['home_actual'], row['away_actual'])
            resolved = (None if home_bye else home_pid, None if away_bye else away_pid)
            if resolved != recorded or home_bye or away_bye:
                from .. import access
                claim = access.assignment(conn, 'match', row['id'])
                pending = db.q1(conn,"SELECT id FROM result_candidates WHERE subject_kind='match' AND subject_id=? LIMIT 1",(row['id'],)) if has_candidates else None
                if claim or pending:
                    affected.append({'match_id':row['id'], 'reason':'场次已领取，可能存在本机过程，需显式处置',
                                     'recorded':recorded, 'resolved':resolved})
                    continue
            if home_bye and away_bye:
                updates["status"] = "void"
            elif home_bye or away_bye:
                updates["status"] = "void"
                updates["home_actual"] = None if home_bye else home_pid
                updates["away_actual"] = None if away_bye else away_pid
            elif home_pid and away_pid:
                updates["status"] = "ready"
                updates["home_actual"] = home_pid
                updates["away_actual"] = away_pid
            else:
                updates["status"] = "pending"
                updates["home_actual"] = None
                updates["away_actual"] = None
        # A refresh must not rewrite every unchanged ready row. Apart from
        # needless locks, those no-op writes also fire roster revision triggers.
        updates = {key: value for key, value in updates.items() if row[key] != value}
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE matches SET {sets} WHERE id = ?",
                         (*updates.values(), row["id"]))
        home_final = updates.get("home_actual", row["home_actual"])
        away_final = updates.get("away_actual", row["away_actual"])
        if row["pool_id"]:
            for pid in (home_final, away_final):
                if pid:
                    conn.execute(
                        "INSERT OR IGNORE INTO pool_members (pool_id, participation_id, seed_no)"
                        " VALUES (?, ?, NULL)", (row["pool_id"], pid))
    _refresh_pool_status(conn, plan_id)
    return {"affected": affected}


def _refresh_pool_status(conn, plan_id: int) -> None:
    pools = conn.execute(
        "SELECT * FROM pools WHERE stage_id IN (SELECT id FROM stages WHERE plan_id = ?)",
        (plan_id,)).fetchall()
    for pool in pools:
        rows = conn.execute("SELECT status FROM matches WHERE pool_id = ?"
                            " AND reset_state IN ('none','active')", (pool["id"],)).fetchall()
        if not rows:
            continue
        statuses = [r["status"] for r in rows]
        if pool["status"] == "confirmed":
            continue
        if all(s in ("finished", "void") for s in statuses):
            new_status = "finished"
        elif any(s in ("finished", "void") for s in statuses):
            new_status = "running"
        else:
            new_status = "pending"
        if new_status != pool["status"]:
            conn.execute("UPDATE pools SET status = ? WHERE id = ?", (new_status, pool["id"]))


# ------------------------------------------------------------------ 依赖查询
def downstream_matches(conn, match_id: int, plan_id: int | None = None) -> list[dict]:
    """递归列出依赖某场次结果的后续场次。"""
    seen: set[int] = set()
    out: list[dict] = []
    frontier = [match_id]
    while frontier:
        current = frontier.pop()
        rows = conn.execute(
            """SELECT id, seq, round_label, status, home_source_match, away_source_match
                FROM matches WHERE home_source_match = ? OR away_source_match = ?""",
            (current, current)).fetchall()
        for r in rows:
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            out.append({"match_id": r["id"], "round_label": r["round_label"],
                        "status": r["status"]})
            frontier.append(r["id"])
    return out


def matches_depending_on_pool(conn, pool_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT id, round_label, status FROM matches
            WHERE (home_source_type = 'pool_rank' AND home_source_pool = ?)
               OR (away_source_type = 'pool_rank' AND away_source_pool = ?)""",
        (pool_id, pool_id)).fetchall()
    out = []
    for r in rows:
        out.append({"match_id": r["id"], "round_label": r["round_label"], "status": r["status"]})
        out.extend(downstream_matches(conn, r["id"]))
    return out
