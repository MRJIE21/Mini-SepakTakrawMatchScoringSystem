"""赛程保存校验：同场地/参赛主体同时开赛，以及晋级依赖的先后顺序。"""
from datetime import datetime
from collections import defaultdict

from ..errors import ApiError, bad_request, conflict


def normalize_time(value):
    if not value or not str(value).strip():
        return ""
    try:
        stamp = datetime.fromisoformat(str(value).strip())
        if stamp.tzinfo is not None or stamp.microsecond:
            raise ValueError
    except ValueError:
        raise bad_request("计划时间格式应为 2026-10-07 09:00（本地时间）") from None
    return stamp.isoformat(sep=" ", timespec="seconds" if stamp.second else "minutes")


def validate_schedule(conn, changes):
    """按整批变更后的状态校验，失败时由调用者的事务回滚。"""
    if not changes:
        return
    from ..auto_schedule_store import validate_manual
    validate_manual(conn, changes)
    event_ids = {conn.execute(
        "SELECT g.event_id FROM categories c JOIN groups g ON g.id=c.group_id WHERE c.id=?",
        (row["category_id"],)).fetchone()[0] for row in changes.values()}
    marks = ",".join("?" for _ in event_ids)
    stored = conn.execute(f"""SELECT m.*, g.event_id FROM matches m
        JOIN categories c ON c.id=m.category_id JOIN groups g ON g.id=c.group_id
        LEFT JOIN plans p ON p.id=m.plan_id
        WHERE g.event_id IN ({marks}) AND (p.status IS NULL OR p.status <> 'archived')
          AND m.reset_state IN ('none', 'active')""",
        tuple(event_ids)).fetchall()
    rows = {row["id"]: {**dict(row), **changes.get(row["id"], {})} for row in stored}
    times = {}
    for mid, row in rows.items():
        try:
            value = normalize_time(row["scheduled_at"])
        except ApiError:
            if mid in changes:
                raise
            continue  # 旧库的无效时间不阻止无关场次编辑。
        if value and row["status"] != "void" and row["result_status"] != "cancelled":
            times[mid] = datetime.fromisoformat(value)

    def label(mid):
        return f"{rows[mid]['round_label']}（场次 #{mid}）"

    def participants(row):
        return {row.get(f"{side}_actual") or row.get(f"{side}_participation")
                for side in ("home", "away")} - {None}

    buckets = defaultdict(list)
    for mid, at in times.items():
        buckets[(rows[mid]['event_id'], at)].append(mid)
    checked = set()
    for mid in changes.keys() & times.keys():
        a = rows[mid]
        for other in buckets[(a['event_id'], times[mid])]:
            pair = tuple(sorted((mid, other)))
            if mid == other or pair in checked:
                continue
            checked.add(pair)
            b = rows[other]
            reason = ("同一场地同时安排了两场比赛" if a["venue_id"] and a["venue_id"] == b["venue_id"]
                      else "同一参赛队伍同时参加两场比赛" if participants(a) & participants(b) else "")
            if reason:
                raise conflict(f"赛程冲突：{reason}：{label(mid)}、{label(other)}",
                               code="schedule_conflict", detail={"matches": [mid, other]})

    # 同时检查改变前序场次的情况，不能只校验被编辑场次自己的来源。
    pools = defaultdict(list)
    descendants = defaultdict(set)
    direct_sources = {}
    for mid, row in rows.items():
        pools[row['pool_id']].append(mid)
    for mid, row in rows.items():
        direct = []
        for side in ('home', 'away'):
            source = row[f'{side}_source_type']
            if source in ('match_winner', 'match_loser'):
                direct.append(row[f'{side}_source_match'])
            elif source == 'pool_rank':
                direct.extend(pools.get(row[f'{side}_source_pool'], []))
        direct_sources[mid] = [pid for pid in direct if pid in rows and pid != mid]
        for pid in direct_sources[mid]:
            descendants[pid].add(mid)

    def predecessors(mid, seen=None):
        seen = set() if seen is None else seen
        for pid in direct_sources[mid]:
            if pid in seen:
                continue
            seen.add(pid)
            predecessors(pid, seen)
        return seen

    affected = set(changes) & rows.keys()
    pending = list(affected)
    while pending:
        mid = pending.pop()
        for child in descendants[mid] - affected:
            affected.add(child)
            pending.append(child)
    for mid in affected & times.keys():
        for before in predecessors(mid):
            if before in times and (mid in changes or before in changes) and times[before] >= times[mid]:
                raise conflict(f"赛程顺序冲突：{label(mid)}必须安排在前序{label(before)}之后",
                               code="schedule_dependency_conflict", detail={"matches": [before, mid]})
