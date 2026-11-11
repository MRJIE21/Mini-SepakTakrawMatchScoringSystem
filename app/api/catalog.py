"""赛事、大组别、项目、学校、运动员、队伍、参赛名单、场地。"""
from __future__ import annotations

import threading
import time
import uuid
import json

from .. import (config, db, idempotency, participation_deletion, registration,
                security, team_rules_store, event_settings)
from ..domain import team_rules
from ..errors import (ApiError, bad_request, conflict, invalid_fields, not_found,
                      stale_revision)
from ..http_server import route
from .common import (GENDER_NAMES, KIND_NAMES, category_context, get_or_404,
                     participation_display_map, participation_info)

ADMIN = ("admin",)
ORG = ("admin", "organizer")


# ------------------------------------------------------------------ 队伍成员
def normalize_members(conn, body: dict, school_id: int, cat: dict) -> tuple[list[dict], int | None]:
    """把请求里的成员描述统一成 ``[{"athlete_id", "jersey_no"}]`` 并解析队长。

    兼容两种写法：
      ``member_ids: [1, 2]``                     旧接口，只有运动员 ID
      ``members: [{"athlete_id":1,"jersey_no":"7"}]``  新接口，可带本队报名号码

    号码语义按 §6.2 区分：``jersey_no`` 是本队报名号码，留空时预填运动员常用号码，
    修改本队号码不回写运动员档案。
    """
    raw = body.get("members")
    if raw is None:
        raw = [{"athlete_id": mid} for mid in (body.get("member_ids") or [])]
    if not isinstance(raw, list):
        raise invalid_fields("队员名单格式不正确", {"members": "应为数组"})

    members: list[dict] = []
    seen: set[int] = set()
    errors: dict[str, str] = {}
    for index, item in enumerate(raw):
        if isinstance(item, dict):
            athlete_id = item.get("athlete_id") or item.get("id")
            jersey = str(item.get("jersey_no") or "").strip()
        else:
            athlete_id, jersey = item, ""
        if jersey:
            try:
                jersey_number = int(jersey)
                if str(jersey_number) != jersey or not 1 <= jersey_number <= 20:
                    raise ValueError
            except ValueError:
                errors["members"] = f"第 {index + 1} 位队员号码必须是 1—20 的整数"
                continue
        try:
            athlete_id = int(athlete_id)
        except (TypeError, ValueError):
            errors["members"] = f"第 {index + 1} 位队员缺少有效的运动员 ID"
            continue
        if athlete_id in seen:
            errors["members"] = f"第 {index + 1} 位队员重复"
            continue
        athlete = db.q1(conn, "SELECT * FROM athletes WHERE id = ?", (athlete_id,))
        if athlete is None:
            errors["members"] = f"第 {index + 1} 位队员不存在（id={athlete_id}）"
            continue
        if athlete["school_id"] != school_id:
            errors["members"] = f"队员「{athlete['name']}」不属于该学校"
            continue
        if cat["gender"] and athlete["gender"] and athlete["gender"] != cat["gender"]:
            errors["members"] = (f"队员「{athlete['name']}」性别与"
                                 f"{GENDER_NAMES[cat['gender']]}项目不符")
            continue
        seen.add(athlete_id)
        # 常用号码是自由档案字段；只有合法的 1—20 才能回填本项目号码，
        # 否则会在 validate_categories 里以另一条文案拒绝用户从未填写的值。
        fallback = str(athlete["jersey_no"] or "").strip()
        if fallback and not (fallback.isdecimal() and 1 <= int(fallback) <= 20
                             and str(int(fallback)) == fallback):
            fallback = ""
        members.append({"athlete_id": athlete_id,
                        "jersey_no": jersey or fallback})
    if errors:
        raise invalid_fields(errors["members"], errors)
    if len(members) > 6:
        raise invalid_fields("三人赛每队最多报名 6 人", {"members": "队员人数不能超过 6 人"})

    captain_id = body.get("captain_id")
    if captain_id in (None, "", 0, "0"):
        captain_id = None
    else:
        try:
            captain_id = int(captain_id)
        except (TypeError, ValueError):
            raise invalid_fields("队长标识不合法", {"captain_id": "应为运动员 ID"}) from None
        if captain_id not in seen:
            raise invalid_fields("队长必须是已选队员之一", {"captain_id": "队长不在队员名单中"})
    return members, captain_id


def write_members(conn, team_id: int, members: list[dict], captain_id: int | None) -> None:
    """整体重写成员，并按显式队长 ID 落标记（成员顺序不影响队长，§6.5）。"""
    db.run(conn, "DELETE FROM team_members WHERE team_id = ?", (team_id,))
    for m in members:
        db.insert(conn, "team_members", {
            "team_id": team_id,
            "athlete_id": m["athlete_id"],
            "jersey_no": m.get("jersey_no") or "",
            "is_captain": 1 if captain_id and m["athlete_id"] == captain_id else 0,
        })


def validate_no_event_double_entry(conn, cat: dict, athlete_ids: list[int],
                                   exclude_category: int | None = None) -> None:
    """同一赛事运动员不得跨项目兼项；逐条、组合及批量入口共用。"""
    for athlete_id in athlete_ids:
        hit = db.q1(conn,
                    """SELECT c.name AS category_name FROM participations p
                         JOIN categories c ON c.id = p.category_id
                         JOIN groups g ON g.id = c.group_id
                         LEFT JOIN team_members tm ON tm.team_id = p.team_id
                        WHERE g.event_id = ? AND p.status = 'active' AND p.deleted_at IS NULL
                          AND (p.athlete_id = ? OR tm.athlete_id = ?)
                          AND c.id <> ? LIMIT 1""",
                    (cat["event_id"], athlete_id, athlete_id, exclude_category or cat["id"]))
        if hit:
            raise conflict(f"该运动员已参加「{hit['category_name']}」，不可兼项",
                           code="athlete_already_entered")


def validate_individual_school_limit(conn, cat: dict, athlete_id: int) -> None:
    athlete = get_or_404(conn, "athletes", athlete_id, "运动员")
    hit = db.q1(conn,
                """SELECT p.id FROM participations p JOIN athletes a ON a.id = p.athlete_id
                    WHERE p.category_id = ? AND p.status = 'active'
                      AND p.deleted_at IS NULL AND a.school_id = ? LIMIT 1""",
                (cat["id"], athlete["school_id"]))
    if hit:
        raise conflict("同一学校在同一个人项目最多报名 1 人", code="school_individual_limit")


def team_captain_id(conn, team_id: int) -> int | None:
    row = db.q1(conn, "SELECT athlete_id FROM team_members WHERE team_id = ? AND is_captain = 1",
                (team_id,))
    return row["athlete_id"] if row else None


def team_members(conn, team_id: int) -> list[dict]:
    rows = db.q(conn,
                """SELECT a.id, a.name, a.gender, a.jersey_no AS athlete_jersey,
                          tm.jersey_no, tm.is_captain
                     FROM team_members tm JOIN athletes a ON a.id = tm.athlete_id
                    WHERE tm.team_id = ? ORDER BY tm.id""", (team_id,))
    return [dict(r) for r in rows]


def bump_rev(conn, table: str, row_id: int) -> int:
    """档案修订号 +1，返回新值（§15.4）。"""
    db.run(conn, f"UPDATE {table} SET rev = COALESCE(rev, 1) + 1 WHERE id = ?", (row_id,))
    row = db.q1(conn, f"SELECT rev FROM {table} WHERE id = ?", (row_id,))
    return int(row["rev"])


def expect_rev(conn, body: dict, table: str, row_id: int, label: str) -> None:
    """带上 base_rev 时校验修订号，避免覆盖别人的修改（§4.3）。"""
    if "base_rev" not in body:
        return
    row = db.q1(conn, f"SELECT rev FROM {table} WHERE id = ?", (row_id,))
    current = int(row["rev"] or 1)
    try:
        base = int(body["base_rev"])
    except (TypeError, ValueError):
        raise invalid_fields("修订号格式不正确", {"base_rev": "应为整数"}) from None
    if base != current:
        raise stale_revision(
            f"该{label}已被其他人修改，请核对后再保存（当前修订号 {current}，你基于 {base}）",
            current=current)


def team_profile_gaps(conn, team_id: int, captain_id: int | None) -> list[str]:
    """资料待补充项：实时计算，不落库（§6.6、§15.4）。"""
    members = team_members(conn, team_id)
    gaps = []
    if not members:
        gaps.append("尚未选择队员")
    elif len(members) < 3:
        gaps.append(f"队员不足 3 人（当前 {len(members)} 人）")
    unknown = [m["name"] for m in members if not m["gender"]]
    if unknown:
        gaps.append(f"性别待补充：{'、'.join(unknown)}")
    return gaps



# ------------------------------------------------------------------ 赛事列表计数缓存
# /api/events 的行数据始终实时查询 registry；每个赛事的三项计数按 event_id 缓存
# STSS_EVENT_STATS_TTL 秒，写操作通过 invalidate_event_stats() 显式失效。
# 缓存只保存未过滤的原始计数，access.filter_result 仍在返回前按角色过滤。
_EVENT_STATS_CACHE: dict[tuple[str, int], tuple[float, dict]] = {}
_EVENT_STATS_LOCK = threading.Lock()


def _stats_cache_key(event_id: int) -> tuple[str, int]:
    """缓存键带 registry 路径：测试/多数据目录同进程切换时不会读到别库的计数。"""
    try:
        registry = str(config.DB_PATH.resolve())
    except OSError:
        registry = str(config.DB_PATH)
    return registry, int(event_id)


def invalidate_event_stats(event_id: int | None = None) -> None:
    """失效 /api/events 计数缓存。

    event_id 为空时清空全部（创建/改名/删除赛事、账号赛事分配等跨赛事变化）；
    指定 event_id 时只失效该赛事（event-scope 写操作完成后可精确调用）。
    """
    with _EVENT_STATS_LOCK:
        if event_id is None:
            _EVENT_STATS_CACHE.clear()
        else:
            _EVENT_STATS_CACHE.pop(_stats_cache_key(event_id), None)


def _event_stats_ttl() -> float:
    try:
        return float(config.EVENT_STATS_TTL)
    except (TypeError, ValueError):
        return 3.0


def _event_stats(conn, event_id: int) -> dict:
    """读取单赛事计数；缓存命中时不打开赛事数据库连接。"""
    event_id = int(event_id)
    key = _stats_cache_key(event_id)
    ttl = _event_stats_ttl()
    if ttl > 0:
        with _EVENT_STATS_LOCK:
            cached = _EVENT_STATS_CACHE.get(key)
            if cached is not None and cached[0] > time.monotonic():
                return dict(cached[1])
    event_path = db.event_db_path(event_id)
    data_conn = db.connect(event_path) if event_path.exists() else conn
    try:
        counts = db.q1(data_conn,
                       """SELECT (SELECT COUNT(*) FROM categories c JOIN groups g ON g.id = c.group_id
                                   WHERE g.event_id = ?) AS categories,
                                 (SELECT COUNT(*) FROM schools WHERE event_id = ?) AS schools,
                                 (SELECT COUNT(*) FROM matches m
                                    JOIN categories c ON c.id = m.category_id
                                    JOIN groups g ON g.id = c.group_id
                                   WHERE g.event_id = ? AND m.status = 'finished') AS finished_matches
                       """, (event_id, event_id, event_id))
    finally:
        if data_conn is not conn:
            data_conn.close()
    stats = dict(counts)
    if ttl > 0:
        with _EVENT_STATS_LOCK:
            _EVENT_STATS_CACHE[key] = (time.monotonic() + ttl, stats)
    return dict(stats)


def _invalidate_event_of(conn, category_id=None, group_id=None, school_id=None, event_id=None) -> None:
    """按事件范围写操作精确失效计数缓存（只清该赛事，不清其它赛事）。"""
    resolved = event_id
    if resolved is None and category_id is not None:
        row = db.q1(conn, """SELECT g.event_id FROM categories c
                               JOIN groups g ON g.id = c.group_id WHERE c.id = ?""", (int(category_id),))
        resolved = row["event_id"] if row else None
    if resolved is None and group_id is not None:
        row = db.q1(conn, "SELECT event_id FROM groups WHERE id = ?", (int(group_id),))
        resolved = row["event_id"] if row else None
    if resolved is None and school_id is not None:
        row = db.q1(conn, "SELECT event_id FROM schools WHERE id = ?", (int(school_id),))
        resolved = row["event_id"] if row else None
    if resolved is not None:
        invalidate_event_stats(int(resolved))


# ------------------------------------------------------------------ 赛事
@route("GET", r"/api/events", scope="registry")
def list_events(ctx):
    rows = db.q(ctx.conn, "SELECT * FROM events ORDER BY id")
    out = []
    for r in rows:
        item = dict(r)
        item.update(_event_stats(ctx.conn, r["id"]))
        out.append(item)
    deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k = 'deployment_id'")
    return {"events": out, "deployment_id": deployment["v"] if deployment else ""}


@route("POST", r"/api/events", roles=ORG, scope="registry")
def create_event(ctx):
    name = (ctx.body.get("name") or "").strip()
    if not name:
        raise bad_request("请填写赛事名称")
    start_date = ctx.body.get("start_date") or ""
    end_date = ctx.body.get("end_date") or ""
    if start_date and end_date and start_date > end_date:
        raise invalid_fields("赛事日期不合法", {"end_date": "结束日期不能早于开始日期"})
    event_id = db.insert(ctx.conn, "events", {
        "uuid": str(uuid.uuid4()), "name": name,
        "start_date": start_date,
        "end_date": end_date,
        "location": ctx.body.get("location") or "",
    })
    event = dict(get_or_404(ctx.conn, "events", event_id, "赛事"))
    db.create_event_database(event_id, event, ctx.conn)
    security.audit(ctx.conn, ctx.user, "create_event", "event", event_id, {"name": name})
    invalidate_event_stats()          # 新赛事立即出现在列表中（计数为首个读取时计算）
    return {"event_id": event_id, "event_uuid": event["uuid"]}


@route("POST", r"/api/events/full", roles=ORG, scope="registry")
def create_full_event(ctx):
    """最终确认时一次建立赛事及其独立数据库，避免半成品赛事。"""
    event_data = ctx.body.get("event") or {}
    groups = ctx.body.get("groups") or []
    venues = ctx.body.get("venues") or []
    name = str(event_data.get("name") or "").strip()
    start_date = event_data.get("start_date") or ""
    end_date = event_data.get("end_date") or ""
    if not name:
        raise invalid_fields("请填写赛事名称", {"event.name": "赛事名称不能为空"})
    if start_date and end_date and start_date > end_date:
        raise invalid_fields("赛事日期不合法", {"event.end_date": "结束日期不能早于开始日期"})
    if not isinstance(groups, list) or not groups:
        raise invalid_fields("请至少添加一个大组别", {"groups": "至少需要一个大组别"})
    if not isinstance(venues, list):
        raise invalid_fields("比赛场地格式不正确", {"venues": "应为数组"})

    normalized_groups = []
    seen_codes, seen_names = set(), set()
    for index, group in enumerate(groups):
        group_name = str((group or {}).get("name") or "").strip()
        code = str((group or {}).get("code") or f"G{index + 1}").strip()
        categories = (group or {}).get("categories") or []
        if not group_name:
            raise invalid_fields("大组别名称不能为空", {f"groups.{index}.name": "请填写大组别名称"})
        if group_name in seen_names or code in seen_codes:
            raise conflict("大组别名称或标识不能重复")
        if not isinstance(categories, list) or not categories:
            raise invalid_fields(f"请为「{group_name}」添加比赛项目",
                                 {f"groups.{index}.categories": "至少需要一个比赛项目"})
        seen_names.add(group_name)
        seen_codes.add(code)
        normalized_categories, category_keys = [], set()
        for cat_index, category in enumerate(categories):
            cat_name = str((category or {}).get("name") or "").strip()
            gender = (category or {}).get("gender")
            kind = (category or {}).get("kind")
            if not cat_name:
                raise invalid_fields("比赛项目名称不能为空",
                                     {f"groups.{index}.categories.{cat_index}.name": "请填写比赛项目名称"})
            if gender not in GENDER_NAMES or kind not in KIND_NAMES:
                raise invalid_fields("比赛项目类型不正确",
                                     {f"groups.{index}.categories.{cat_index}": "请选择性别和项目类型"})
            if (gender, kind) in category_keys:
                raise conflict(f"「{group_name}」内同性别、同类型的项目不能重复")
            category_keys.add((gender, kind))
            normalized_categories.append({"name": cat_name, "gender": gender, "kind": kind})
        normalized_groups.append({"name": group_name, "code": code,
                                  "categories": normalized_categories})

    normalized_venues, venue_names = [], set()
    for index, venue in enumerate(venues):
        venue_name = str((venue or {}).get("name") or "").strip()
        if not venue_name:
            raise invalid_fields("比赛场地名称不能为空", {f"venues.{index}.name": "请填写比赛场地名称"})
        if venue_name in venue_names:
            raise conflict("比赛场地名称不能重复")
        venue_names.add(venue_name)
        normalized_venues.append(venue_name)

    event_id = db.insert(ctx.conn, "events", {
        "uuid": str(uuid.uuid4()), "name": name, "start_date": start_date, "end_date": end_date,
        "location": str(event_data.get("location") or "").strip(),
    })
    event = dict(get_or_404(ctx.conn, "events", event_id, "赛事"))
    event_conn = None
    try:
        path = db.create_event_database(event_id, event, ctx.conn)
        event_conn = db.connect(path)
        with db.tx(event_conn):
            first_group_id = first_category_id = None
            for group_seq, group in enumerate(normalized_groups, start=1):
                group_id = db.insert(event_conn, "groups", {
                    "event_id": event_id, "code": group["code"],
                    "name": group["name"], "seq": group_seq,
                })
                if first_group_id is None:
                    first_group_id = group_id
                for category_seq, category in enumerate(group["categories"], start=1):
                    category_id = db.insert(event_conn, "categories", {
                        "group_id": group_id, "gender": category["gender"],
                        "kind": category["kind"], "name": category["name"], "seq": category_seq,
                    })
                    if first_category_id is None:
                        first_category_id = category_id
            for venue_seq, venue_name in enumerate(normalized_venues, start=1):
                db.insert(event_conn, "venues", {
                    "event_id": event_id, "name": venue_name, "seq": venue_seq,
                })
        security.audit(ctx.conn, ctx.user, "create_event", "event", event_id,
                       {"name": name, "complete_setup": True})
    except BaseException:
        if event_conn is not None:
            event_conn.close()
            event_conn = None
        db.remove_event_database(event_id)
        raise
    finally:
        if event_conn is not None:
            event_conn.close()
    invalidate_event_stats(event_id)  # 完整建赛一次性写入组别/项目/场地，计数立即失效
    return {"event_id": event_id, "event_uuid": event["uuid"], "group_id": first_group_id,
            "category_id": first_category_id}


@route("PUT", r"/api/events/(?P<event_id>\d+)", roles=ORG, scope="registry")
def update_event(ctx):
    event_id = int(ctx.params["event_id"])
    event = get_or_404(ctx.conn, "events", event_id, "赛事")
    fields = {k: ctx.body[k] for k in ("name", "start_date", "end_date", "location", "status")
              if k in ctx.body}
    if not fields:
        raise bad_request("没有需要更新的字段")
    if "name" in fields:
        fields["name"] = (fields["name"] or "").strip()
        if not fields["name"]:
            raise invalid_fields("请填写赛事名称", {"name": "赛事名称不能为空"})
    start_date = fields.get("start_date", event["start_date"]) or ""
    end_date = fields.get("end_date", event["end_date"]) or ""
    if start_date and end_date and start_date > end_date:
        raise invalid_fields("赛事日期不合法", {"end_date": "结束日期不能早于开始日期"})
    db.update(ctx.conn, "events", event_id, fields)
    event_path = db.event_db_path(event_id)
    if event_path.exists():
        event_conn = db.connect(event_path)
        try:
            with db.tx(event_conn):
                db.update(event_conn, "events", event_id, fields)
        finally:
            event_conn.close()
    security.audit(ctx.conn, ctx.user, "update_event", "event", event_id, fields)
    invalidate_event_stats(event_id)  # 改名/状态变化后列表立即刷新
    return {"message": "已更新"}


@route("DELETE", r"/api/events/(?P<event_id>\d+)", roles=ADMIN, scope="registry", transaction=False)
def delete_event(ctx):
    event_id = int(ctx.params["event_id"])
    event_uuid = ctx.body.get("event_uuid")
    confirm_name = ctx.body.get("confirm_name")
    if not event_uuid or not isinstance(confirm_name, str):
        raise bad_request("请填写赛事名称以确认删除")
    attached = False
    retained = {}
    try:
        path = db.event_db_path(event_id)
        if path.exists():
            # ATTACH 与索引库共用提交/回滚，避免第二个连接先提交后留下半删除状态。
            ctx.conn.execute("ATTACH DATABASE ? AS deleting_event", (str(path.resolve()),))
            attached = True
        with db.tx(ctx.conn):
            event = get_or_404(ctx.conn, "events", event_id, "赛事")
            if event["uuid"] != event_uuid:
                raise conflict("赛事身份已变化，请刷新后重新核对", code="event_identity_mismatch")
            if confirm_name != event["name"]:
                raise bad_request("输入的赛事名称不一致，未执行删除")
            ctx.conn.execute("PRAGMA defer_foreign_keys = ON")
            if attached:
                target = ctx.conn.execute("SELECT id, uuid FROM deleting_event.events").fetchall()
                if len(target) != 1 or target[0]["id"] != event_id or target[0]["uuid"] != event_uuid:
                    raise conflict("赛事数据库身份不一致，未执行删除", code="event_identity_mismatch")
                from ..registration_history import retain
                retained = retain(ctx.conn, dict(event), ctx.user["id"])
                ctx.conn.execute("DELETE FROM deleting_event.events WHERE id=?", (event_id,))
                ctx.conn.execute("DELETE FROM deleting_event.display_config")
                ctx.conn.execute("DELETE FROM deleting_event.submissions")
                ctx.conn.execute("DELETE FROM deleting_event.request_log")
                ctx.conn.execute("DELETE FROM deleting_event.settings WHERE k LIKE 'recording:%'")
            ctx.conn.execute("DELETE FROM events WHERE id=?", (event_id,))
            ctx.conn.execute("DELETE FROM user_snapshot_outbox WHERE event_id=?", (event_id,))
            for access_row in db.q(ctx.conn, "SELECT k,v FROM settings WHERE k LIKE 'access:user:%'"):
                ids = json.loads(access_row["v"])
                if event_id in ids:
                    ctx.conn.execute("UPDATE settings SET v=? WHERE k=?",
                                     (json.dumps([eid for eid in ids if eid != event_id]), access_row["k"]))
            if retained:
                retained['after'] = {table: ctx.conn.execute(f'SELECT COUNT(*) FROM deleting_event."{table}"').fetchone()[0]
                                     for table in retained['before']}
                ctx.conn.execute('UPDATE event_deletion_history SET counts_json=? WHERE event_id=?',
                                 (json.dumps({'before': retained['before'], 'after': retained['after']}), event_id))
            security.audit(ctx.conn, ctx.user, "delete_event", "event", event_id,
                           {"name": event["name"], "event_uuid": event_uuid, **retained})
    finally:
        if attached:
            ctx.conn.execute("DETACH DATABASE deleting_event")
    invalidate_event_stats()
    return {"message": "赛事已删除，历史报名已保留", "event_id": event_id, **retained}


@route("POST", r"/api/events/(?P<event_id>\d+)/bootstrap", roles=ADMIN)
def bootstrap_event(ctx):
    """建立甲、乙、丙三个大组别及各自四个项目，并建立默认场地。"""
    event_id = int(ctx.params["event_id"])
    get_or_404(ctx.conn, "events", event_id, "赛事")
    created = []
    for code, name, seq in (("甲", "甲组：央属高校", 1), ("乙", "乙组：市属高校", 2),
                            ("丙", "丙组：高职高专", 3)):
        row = db.q1(ctx.conn, "SELECT * FROM groups WHERE event_id = ? AND code = ?",
                    (event_id, code))
        if row:
            group_id = row["id"]
        else:
            group_id = db.insert(ctx.conn, "groups", {"event_id": event_id, "code": code,
                                                      "name": name, "seq": seq})
        for gender in ("male", "female"):
            for kind in ("team", "individual"):
                exists = db.q1(ctx.conn,
                               "SELECT id FROM categories WHERE group_id = ? AND gender = ? AND kind = ?",
                               (group_id, gender, kind))
                if exists:
                    continue
                db.insert(ctx.conn, "categories", {
                    "group_id": group_id, "gender": gender, "kind": kind,
                    "name": f"{GENDER_NAMES[gender]}{KIND_NAMES[kind]}",
                    "seq": {"male": 0, "female": 1}[gender] + {"team": 0, "individual": 2}[kind],
                })
        created.append(name)
    for i, vname in enumerate(("1号场地", "2号场地"), start=1):
        if not db.q1(ctx.conn, "SELECT id FROM venues WHERE event_id = ? AND name = ?",
                     (event_id, vname)):
            db.insert(ctx.conn, "venues", {"event_id": event_id, "name": vname, "seq": i})
    security.audit(ctx.conn, ctx.user, "bootstrap_event", "event", event_id)
    _invalidate_event_of(ctx.conn, event_id=event_id)  # 组别/项目建立后计数立即刷新
    return {"message": "已建立大组别与项目", "groups": created}


@route("GET", r"/api/events/(?P<event_id>\d+)/structure")
def event_structure(ctx):
    event_id = int(ctx.params["event_id"])
    event = get_or_404(ctx.conn, "events", event_id, "赛事")
    groups = db.q(ctx.conn, "SELECT * FROM groups WHERE event_id = ? ORDER BY seq, id", (event_id,))
    out = []
    for g in groups:
        cats = db.q(ctx.conn, "SELECT * FROM categories WHERE group_id = ? ORDER BY seq, id", (g["id"],))
        cat_items = []
        for c in cats:
            counts = db.q1(ctx.conn,
                           """SELECT COUNT(*) AS participants FROM participations
                               WHERE category_id = ? AND deleted_at IS NULL""", (c["id"],))
            plan = db.q1(ctx.conn,
                         """SELECT id, status, version FROM plans WHERE category_id = ?
                             ORDER BY id DESC LIMIT 1""", (c["id"],))
            mstats = db.q1(ctx.conn,
                           """SELECT COUNT(*) AS total,
                                     SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished
                                FROM matches WHERE category_id = ?""", (c["id"],))
            cat_items.append({
                **dict(c), "participants": counts["participants"],
                **(team_rules_store.project(ctx.conn, c['id']) if c['kind'] == 'team' else {}),
                "plan": dict(plan) if plan else None,
                "matches_total": mstats["total"] or 0,
                "matches_finished": mstats["finished"] or 0,
            })
        school_count = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM school_entries WHERE group_id = ?",
                             (g["id"],))
        out.append({**dict(g), "categories": cat_items, "schools": school_count["n"]})
    venues = db.q(ctx.conn, "SELECT * FROM venues WHERE event_id = ? ORDER BY seq, id", (event_id,))
    return {"event": dict(event), "settings_lock": event_settings.read(event_id), "groups": out, "venues": [dict(v) for v in venues],
            "team_rules": team_rules_store.event_impact(ctx.conn, event_id)}


@route('PUT', r'/api/events/(?P<event_id>\d+)/settings-lock', roles=ADMIN, scope='registry')
def set_settings_lock(ctx):
    eid = int(ctx.params['event_id'])
    get_or_404(ctx.conn, 'events', eid, '赛事')
    if type(ctx.body.get('locked')) is not bool or type(ctx.body.get('base_version')) is not int:
        raise bad_request('请提供锁定状态和当前版本')
    old = event_settings.read(eid)
    if ctx.body['base_version'] != old['version']:
        raise conflict('锁定状态已变化，请刷新赛事设置', code='settings_lock_changed')
    if old['locked'] == ctx.body['locked']:
        return {'message': '锁定状态未变化', 'settings_lock': old}
    value = {'locked': ctx.body['locked'], 'version': old['version'] + 1,
             'updated_by': ctx.user['id'], 'updated_at': db.now(ctx.conn)}
    db.run(ctx.conn, 'INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)',
           (f'event-settings-lock:{eid}', json.dumps(value)))
    security.audit(ctx.conn, ctx.user, 'lock_event_settings' if value['locked'] else 'unlock_event_settings',
                   'event', eid, {'before': old, 'after': value})
    return {'message': '赛事设置已锁定' if value['locked'] else '赛事设置已解锁', 'settings_lock': value}


@route("GET", r"/api/categories/(?P<category_id>\d+)/workspace")
def category_workspace(ctx):
    from ..workspace import category_snapshot
    return category_snapshot(ctx.conn, int(ctx.params["category_id"]), ctx.user["role"])


# ------------------------------------------------------------------ 大组别 / 项目
@route("GET", r"/api/categories/(?P<category_id>\d+)/team-rules")
def get_team_rules(ctx):
    with db.read_tx(ctx.conn):
        return team_rules_store.impact(ctx.conn, int(ctx.params['category_id']))


@route("PUT", r"/api/categories/(?P<category_id>\d+)/team-rules", roles=ADMIN)
def reject_project_team_rules(ctx):
    team_rules_store.project(ctx.conn, int(ctx.params['category_id']))
    raise conflict('三人赛规则现由本赛事统一设置，请刷新后进入侧边栏“三人赛规则设置”', code='event_rules_required')


@route("GET", r"/api/events/(?P<event_id>\d+)/team-rules")
def get_event_team_rules(ctx):
    with db.read_tx(ctx.conn):
        return team_rules_store.event_impact(ctx.conn, int(ctx.params['event_id']))


@route("PUT", r"/api/events/(?P<event_id>\d+)/team-rules", roles=ADMIN)
def save_team_rules(ctx):
    body = ctx.body or {}
    if body.get('rules') is None:
        raise bad_request('请填写比赛规则')
    try:
        value = team_rules.normalize(body['rules'])
    except ValueError as exc:
        raise bad_request(str(exc), code='invalid_rules') from exc
    event_id = int(ctx.params['event_id'])
    with db.tx(ctx.conn):
        before, changed = team_rules_store.save_event(ctx.conn, event_id, value, body)
        if not changed:
            return {'message': '规则未变化', **before}
        security.audit(ctx.conn, ctx.user, 'update_team_rules', 'event', event_id,
                       {'before': before['rules'], 'before_state': before['rules_state'],
                        'legacy_rules': before['legacy_rules'], 'after': value, 'revision': before['rules_revision'] + 1,
                        'future_matches': before['future_matches'], 'frozen_matches': before['frozen_matches']})
        return {'message': '赛事三人赛规则已保存，已开始场次保持原规则', **team_rules_store.event_impact(ctx.conn, event_id)}


@route("POST", r"/api/events/(?P<event_id>\d+)/groups", roles=ORG)
def create_group(ctx):
    event_id = int(ctx.params["event_id"])
    get_or_404(ctx.conn, "events", event_id, "赛事")
    code = (ctx.body.get("code") or "").strip()
    if not code:
        raise bad_request("请填写大组别标识（甲/乙/丙）")
    if db.q1(ctx.conn, "SELECT id FROM groups WHERE event_id = ? AND code = ?", (event_id, code)):
        raise conflict(f"大组别 {code} 已存在", code="duplicate")
    group_id = db.insert(ctx.conn, "groups", {
        "event_id": event_id, "code": code,
        "name": ctx.body.get("name") or f"{code}组",
        "seq": int(ctx.body.get("seq") or 0)})
    return {"group_id": group_id}


@route("PUT", r"/api/groups/(?P<group_id>\d+)", roles=ORG)
def update_group(ctx):
    """组别可自定义命名与排序。"""
    group_id = int(ctx.params["group_id"])
    get_or_404(ctx.conn, "groups", group_id, "大组别")
    fields = {}
    if "name" in ctx.body:
        name = (ctx.body["name"] or "").strip()
        if not name:
            raise bad_request("组别名称不能为空")
        fields["name"] = name
    if "code" in ctx.body:
        fields["code"] = (ctx.body["code"] or "").strip() or None
    if "seq" in ctx.body:
        fields["seq"] = int(ctx.body["seq"])
    if fields:
        db.update(ctx.conn, "groups", group_id, fields)
    return {"message": "组别已更新"}


@route("DELETE", r"/api/groups/(?P<group_id>\d+)", roles=ADMIN)
def delete_group(ctx):
    group_id = int(ctx.params["group_id"])
    get_or_404(ctx.conn, "groups", group_id, "大组别")
    cats = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM categories WHERE group_id = ?", (group_id,))
    entries = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM school_entries WHERE group_id = ?", (group_id,))
    if cats["n"] or entries["n"]:
        raise conflict("该组别下已有项目或学校，不能删除；请先移除项目与学校", code="in_use")
    db.run(ctx.conn, "DELETE FROM groups WHERE id = ?", (group_id,))
    return {"message": "组别已删除"}


@route("POST", r"/api/groups/(?P<group_id>\d+)/categories", roles=ORG)
def create_category(ctx):
    group_id = int(ctx.params["group_id"])
    get_or_404(ctx.conn, "groups", group_id, "大组别")
    gender = ctx.body.get("gender")
    kind = ctx.body.get("kind")
    if gender not in ("male", "female") or kind not in ("team", "individual"):
        raise bad_request("性别或项目类型不合法")
    if db.q1(ctx.conn, "SELECT id FROM categories WHERE group_id = ? AND gender = ? AND kind = ?",
             (group_id, gender, kind)):
        raise conflict("该项目已存在", code="duplicate")
    cat_id = db.insert(ctx.conn, "categories", {
        "group_id": group_id, "gender": gender, "kind": kind,
        "name": ctx.body.get("name") or f"{GENDER_NAMES[gender]}{KIND_NAMES[kind]}",
        "seq": int(ctx.body.get("seq") or 0)})
    _invalidate_event_of(ctx.conn, group_id=group_id)
    return {"category_id": cat_id}


@route("PUT", r"/api/categories/(?P<category_id>\d+)", roles=ORG)
def update_category(ctx):
    """项目可自定义命名；类型与性别在已有数据后不允许更改。"""
    category_id = int(ctx.params["category_id"])
    cat = get_or_404(ctx.conn, "categories", category_id, "项目")
    fields = {}
    if "name" in ctx.body:
        name = (ctx.body["name"] or "").strip()
        if not name:
            raise bad_request("项目名称不能为空")
        fields["name"] = name
    if "seq" in ctx.body:
        fields["seq"] = int(ctx.body["seq"])
    for key in ("gender", "kind"):
        if key in ctx.body and ctx.body[key] != cat[key]:
            used = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM participations WHERE category_id = ?",
                         (category_id,))
            if used["n"]:
                raise conflict("该项目已有参赛名单，不能更改类型或性别", code="in_use")
            fields[key] = ctx.body[key]
    if fields:
        db.update(ctx.conn, "categories", category_id, fields)
    return {"message": "项目已更新"}


@route("DELETE", r"/api/categories/(?P<category_id>\d+)", roles=ADMIN)
def delete_category(ctx):
    category_id = int(ctx.params["category_id"])
    get_or_404(ctx.conn, "categories", category_id, "项目")
    used = db.q1(ctx.conn,
                 """SELECT (SELECT COUNT(*) FROM participations WHERE category_id = ?) AS p,
                           (SELECT COUNT(*) FROM matches WHERE category_id = ?) AS m""",
                 (category_id, category_id))
    if used["p"] or used["m"]:
        raise conflict("该项目已有参赛名单或比赛，不能删除", code="in_use")
    event_id = _event_id_of_category(ctx.conn, category_id)
    db.run(ctx.conn, "DELETE FROM plans WHERE category_id = ?", (category_id,))
    db.run(ctx.conn, "DELETE FROM categories WHERE id = ?", (category_id,))
    if event_id is not None:
        invalidate_event_stats(event_id)
    return {"message": "项目已删除"}


def _event_id_of_category(conn, category_id: int):
    row = db.q1(conn, """SELECT g.event_id FROM categories c
                           JOIN groups g ON g.id = c.group_id WHERE c.id = ?""",
                (int(category_id),))
    return int(row["event_id"]) if row else None


# ------------------------------------------------------------------ 学校
@route("GET", r"/api/events/(?P<event_id>\d+)/schools")
def list_schools(ctx):
    event_id = int(ctx.params["event_id"])
    group_id = ctx.arg("group_id")
    sql = """SELECT s.*, se.group_id, g.name AS group_name, g.code AS group_code,
                    (SELECT COUNT(*) FROM athletes a WHERE a.school_id = s.id) AS athlete_count,
                    (SELECT COUNT(*) FROM teams t WHERE t.school_id = s.id) AS team_count
               FROM schools s
               LEFT JOIN school_entries se ON se.school_id = s.id
               LEFT JOIN groups g ON g.id = se.group_id
              WHERE s.event_id = ?"""
    args: list = [event_id]
    if group_id:
        sql += " AND se.group_id = ?"
        args.append(int(group_id))
    sql += " ORDER BY g.seq, s.name"
    return {"schools": db.rows_to_dicts(db.q(ctx.conn, sql, args))}


@route("POST", r"/api/events/(?P<event_id>\d+)/schools", roles=ORG)
def create_school(ctx):
    event_id = int(ctx.params["event_id"])
    get_or_404(ctx.conn, "events", event_id, "赛事")
    name = (ctx.body.get("name") or "").strip()
    if not name:
        raise invalid_fields("请填写学校名称", {"name": "请填写学校名称"})
    if db.q1(ctx.conn, "SELECT id FROM schools WHERE event_id = ? AND name = ?", (event_id, name)):
        raise conflict("该学校已存在", code="duplicate",
                       detail={"fields": {"name": "该学校已存在"}})
    group_id = ctx.body.get("group_id")
    if not group_id:
        raise invalid_fields("请选择所属大组别（甲/乙/丙）", {"group_id": "请选择所属大组别"})
    get_or_404(ctx.conn, "groups", int(group_id), "大组别")
    school_id = db.insert(ctx.conn, "schools", {
        "event_id": event_id, "name": name,
        "short_name": ctx.body.get("short_name") or name,
        "note": ctx.body.get("note") or ""})
    db.insert(ctx.conn, "school_entries", {"event_id": event_id, "group_id": int(group_id),
                                           "school_id": school_id})
    security.audit(ctx.conn, ctx.user, "create_school", "school", school_id, {"name": name})
    invalidate_event_stats(event_id)  # 学校计数立即刷新
    return {"school_id": school_id, "rev": 1}


@route("PUT", r"/api/schools/(?P<school_id>\d+)", roles=ORG)
def update_school(ctx):
    school_id = int(ctx.params["school_id"])
    school = get_or_404(ctx.conn, "schools", school_id, "学校")
    expect_rev(ctx.conn, ctx.body, "schools", school_id, "学校")
    fields = {k: ctx.body[k] for k in ("name", "short_name", "note") if k in ctx.body}
    for key in ('name', 'short_name'):
        if key in fields:
            if not isinstance(fields[key], str):
                raise invalid_fields('学校名称和简称须为文字', {key: '请填写文字'})
            fields[key] = fields[key].strip()
    if "name" in fields and not (fields["name"] or "").strip():
        raise invalid_fields("学校名称不能为空", {"name": "学校名称不能为空"})
    if 'name' in fields and db.q1(ctx.conn, 'SELECT id FROM schools WHERE event_id=? AND name=? AND id<>?',
                                 (school['event_id'], fields['name'], school_id)):
        raise conflict('该学校名称已存在', code='duplicate', detail={'fields': {'name': '该学校名称已存在'}})
    if "group_id" in ctx.body:
        # 已有参赛引用时不允许用改组别的方式整校迁移（§8.1）
        used = db.q1(ctx.conn,
                     """SELECT COUNT(*) AS n FROM participations p
                         WHERE p.team_id IN (SELECT id FROM teams WHERE school_id = ?)
                            OR p.athlete_id IN (SELECT id FROM athletes WHERE school_id = ?)""",
                     (school_id, school_id))
        if used["n"]:
            raise conflict("该学校已有参赛记录，不能直接更改所属组别；请按受控迁移处理",
                           code="in_use", detail={"fields": {"group_id": "该学校已有参赛记录"}})
        db.run(ctx.conn, "UPDATE school_entries SET group_id = ? WHERE school_id = ?",
               (int(ctx.body["group_id"]), school_id))
    if fields:
        db.update(ctx.conn, "schools", school_id, fields)
        # 三人赛以学校为唯一参赛单位；内部 team 仅承载项目阵容，名称始终跟随学校。
        current = get_or_404(ctx.conn, "schools", school_id, "学校")
        display_name = current["short_name"] or current["name"]
        db.run(ctx.conn, "UPDATE teams SET name = ?, rev = rev + 1 WHERE school_id = ? AND name <> ?",
               (display_name, school_id, display_name))
    rev = bump_rev(ctx.conn, "schools", school_id)
    security.audit(ctx.conn, ctx.user, 'update_school', 'school', school_id,
                   {'before': dict(school), 'changes': fields, 'rev': rev})
    return {"message": "已更新", "rev": rev}


@route("DELETE", r"/api/schools/(?P<school_id>\d+)", roles=ADMIN)
def delete_school(ctx):
    from .. import school_deletion
    event_id = school_deletion.delete_school(ctx.conn, ctx.user, int(ctx.params["school_id"]))
    # HTTP 层在事务提交后再次失效，避免并发读取在提交前回填旧统计。
    invalidate_event_stats(event_id)
    return {"message": "已删除"}


# ------------------------------------------------------------------ 运动员
@route("GET", r"/api/schools/(?P<school_id>\d+)/detail")
def school_detail(ctx):
    """学校详情：基本信息、运动员与各项目报名名单（§8.1、Q10）。"""
    school_id = int(ctx.params["school_id"])
    school = get_or_404(ctx.conn, "schools", school_id, "学校")
    entry = db.q1(ctx.conn,
                  """SELECT se.group_id, g.name AS group_name, g.code AS group_code
                       FROM school_entries se JOIN groups g ON g.id = se.group_id
                      WHERE se.school_id = ?""", (school_id,))
    athletes = db.rows_to_dicts(db.q(
        ctx.conn, "SELECT * FROM athletes WHERE school_id = ? ORDER BY id", (school_id,)))
    teams = []
    for t in db.q(ctx.conn,
                  """SELECT t.*, c.name AS category_name, c.kind, c.gender, g.name AS group_name
                       FROM teams t JOIN categories c ON c.id = t.category_id
                       JOIN groups g ON g.id = c.group_id
                      WHERE t.school_id = ? ORDER BY g.seq, c.seq, t.id""", (school_id,)):
        item = dict(t)
        members = team_members(ctx.conn, t["id"])
        captain = team_captain_id(ctx.conn, t["id"])
        item["members"] = members
        item["captain_id"] = captain
        item["captain_name"] = next((m["name"] for m in members if m["id"] == captain), "")
        item["profile_gaps"] = team_profile_gaps(ctx.conn, t["id"], captain)
        part = db.q1(ctx.conn,
                     """SELECT id, seed_no, status FROM participations
                         WHERE team_id = ? AND deleted_at IS NULL""", (t["id"],))
        item["participation"] = dict(part) if part else None
        teams.append(item)
    # 个人赛报名：按运动员归属本校列出
    individual = db.rows_to_dicts(db.q(
        ctx.conn,
        """SELECT p.id AS participation_id, p.seed_no, p.status, p.category_id,
                  c.name AS category_name, c.gender AS category_gender, g.name AS group_name,
                  a.id AS athlete_id, a.name AS athlete_name
             FROM participations p
             JOIN athletes a ON a.id = p.athlete_id
             JOIN categories c ON c.id = p.category_id
             JOIN groups g ON g.id = c.group_id
            WHERE a.school_id = ? AND p.deleted_at IS NULL
            ORDER BY g.seq, c.seq, a.name""", (school_id,)))
    return {"school": dict(school),
            "group": dict(entry) if entry else None,
            "athletes": athletes, "teams": teams, "individual_entries": individual}


@route("GET", r"/api/schools/(?P<school_id>\d+)/athletes")
def list_athletes(ctx):
    school_id = int(ctx.params["school_id"])
    rows = db.q(ctx.conn, "SELECT * FROM athletes WHERE school_id = ? ORDER BY id", (school_id,))
    return {"athletes": db.rows_to_dicts(rows)}


def normalized_athlete_name(value):
    if not isinstance(value, str):
        raise invalid_fields('姓名必须为文本', {'name': '姓名必须为文本，长度为 1–50 个字符'})
    name = value.strip()
    if not name:
        raise invalid_fields('姓名不能为空', {'name': '姓名不能为空，请输入 1–50 个字符'})
    if len(name) > 50:
        raise invalid_fields('姓名不能超过 50 个字符', {'name': '姓名长度须为 1–50 个字符'})
    return name


@route("GET", r"/api/athletes/(?P<athlete_id>\d+)", roles=ORG)
def athlete_detail(ctx):
    return {'athlete': dict(get_or_404(ctx.conn, 'athletes', int(ctx.params['athlete_id']), '人员'))}


@route("POST", r"/api/schools/(?P<school_id>\d+)/athletes", roles=ORG)
def create_athlete(ctx):
    school_id = int(ctx.params["school_id"])
    get_or_404(ctx.conn, "schools", school_id, "学校")
    name = normalized_athlete_name(ctx.body.get("name"))
    gender = ctx.body.get("gender") or ""
    if gender not in ("male", "female", ""):
        raise invalid_fields("性别不合法", {"gender": "性别只能是男子、女子或留空"})
    entry = db.q1(ctx.conn, "SELECT group_id FROM school_entries WHERE school_id = ?", (school_id,))
    group_id = int(ctx.body.get("group_id") or (entry["group_id"] if entry else 0))
    if not group_id:
        raise invalid_fields("该学校尚未归属大组别，请先在赛事结构中建立学校",
                             {"school_id": "该学校尚未归属大组别"})
    athlete_id = db.insert(ctx.conn, "athletes", {
        "group_id": group_id, "school_id": school_id, "name": name,
        "gender": gender,
        "jersey_no": str(ctx.body.get("jersey_no") or "").strip(),
        "note": ctx.body.get("note") or ""})
    # 同名只作候选提示，不自动合并（§6.3、§8.2）
    duplicates = db.q(ctx.conn,
                      """SELECT id, name, jersey_no FROM athletes
                          WHERE school_id = ? AND name = ? AND id <> ?""",
                      (school_id, name, athlete_id))
    return {"athlete_id": athlete_id, "rev": 1,
            "same_name_candidates": [dict(d) for d in duplicates]}


@route("PUT", r"/api/athletes/(?P<athlete_id>\d+)", roles=ORG)
def update_athlete(ctx):
    athlete_id = int(ctx.params["athlete_id"])
    old = get_or_404(ctx.conn, "athletes", athlete_id, "运动员")
    expect_rev(ctx.conn, ctx.body, "athletes", athlete_id, "运动员")
    fields = {}
    if "name" in ctx.body:
        fields["name"] = normalized_athlete_name(ctx.body["name"])
    if "gender" in ctx.body:
        gender = ctx.body["gender"] or ""
        if gender not in ("male", "female", ""):
            raise invalid_fields("性别不合法", {"gender": "性别只能是男子、女子或留空"})
        # 不能从项目默认值悄悄改写已有运动员性别（§7.1）
        fields["gender"] = gender
    if "jersey_no" in ctx.body:
        fields["jersey_no"] = str(ctx.body["jersey_no"] or "").strip()
    if "note" in ctx.body:
        fields["note"] = ctx.body["note"]
    if fields:
        db.update(ctx.conn, "athletes", athlete_id, fields)
        categories = registration.athlete_categories(ctx.conn, athlete_id)
        if any(key in fields and fields[key] != old[key] for key in ('name', 'gender')):
            registration.guard_athlete_identity(ctx.conn, athlete_id)
        registration.validate_categories(ctx.conn, categories)
    rev = bump_rev(ctx.conn, "athletes", athlete_id)
    security.audit(ctx.conn, ctx.user, 'update_athlete', 'athlete', athlete_id,
                   {'fields': list(fields), 'rev': rev})
    return {"message": "保存成功", "rev": rev,
            "athlete": dict(get_or_404(ctx.conn, 'athletes', athlete_id, '人员'))}


@route("DELETE", r"/api/athletes/(?P<athlete_id>\d+)", roles=ORG)
def delete_athlete(ctx):
    athlete_id = int(ctx.params["athlete_id"])
    athlete = get_or_404(ctx.conn, "athletes", athlete_id, "运动员")
    if db.q1(ctx.conn, "SELECT id FROM participations WHERE athlete_id = ?", (athlete_id,)):
        raise conflict("该运动员已进入参赛名单，不能删除", code="in_use")
    if db.q1(ctx.conn, "SELECT id FROM team_members WHERE athlete_id = ?", (athlete_id,)):
        raise conflict("该运动员已在某个三人赛项目名单中，请先从项目名单中移除", code="in_use")
    db.run(ctx.conn, "DELETE FROM athletes WHERE id = ?", (athlete_id,))
    # REQ-006：删除类操作写审计，便于现场追责；只记对象标识，不记口令/令牌。
    security.audit(ctx.conn, ctx.user, "delete_athlete", "athlete", athlete_id,
                   {"school_id": athlete["school_id"], "name": athlete["name"]})
    return {"message": "已删除"}


# ------------------------------------------------------------------ 队伍
@route("GET", r"/api/categories/(?P<category_id>\d+)/teams")
def list_teams(ctx):
    category_id = int(ctx.params["category_id"])
    rows = db.q(ctx.conn,
                """SELECT t.*, s.name AS school_name, s.short_name AS school_short
                     FROM teams t JOIN schools s ON s.id = t.school_id
                    WHERE t.category_id = ? ORDER BY s.name""", (category_id,))
    out = []
    for r in rows:
        item = dict(r)
        item["members"] = team_members(ctx.conn, r["id"])
        item["captain_id"] = team_captain_id(ctx.conn, r["id"])
        out.append(item)
    return {"teams": out}


@route("POST", r"/api/categories/(?P<category_id>\d+)/teams", roles=ORG)
def create_team(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "team":
        raise bad_request("该项目不是三人赛，不能设置学校项目名单")
    return idempotency.replay_or_run(
        ctx.conn, ctx.user, idempotency.extract_uid(ctx.body),
        idempotency.payload_without_uid(ctx.body),
        lambda: _create_team(ctx.conn, ctx.user, cat, ctx.body),
        scope=f"team:{category_id}")


def _create_team(conn, user, cat: dict, body: dict) -> dict:
    category_id = cat["id"]
    try:
        school_id = int(body.get("school_id") or 0)
    except (TypeError, ValueError):
        raise invalid_fields("请选择学校", {"school_id": "请选择学校"}) from None
    if not school_id:
        raise invalid_fields("请选择学校", {"school_id": "请选择学校"})
    school = get_or_404(conn, "schools", school_id, "学校")
    entry = db.q1(conn, "SELECT group_id FROM school_entries WHERE school_id = ?", (school_id,))
    if not entry or entry["group_id"] != cat["group_id"]:
        raise invalid_fields("该学校不属于本项目所在大组别",
                             {"school_id": "该学校不属于本项目所在大组别"})
    if db.q1(conn, "SELECT id FROM teams WHERE category_id = ? AND school_id = ?",
             (category_id, school_id)):
        raise conflict("该学校在本项目已有名单", code="duplicate",
                       detail={"fields": {"school_id": "该学校在本项目已有名单"}})
    name = school["short_name"] or school["name"]
    members, captain_id = normalize_members(conn, body, school_id, cat)
    team_id = db.insert(conn, "teams", {"category_id": category_id, "school_id": school_id,
                                        "name": name, "note": body.get("note") or ""})
    write_members(conn, team_id, members, captain_id)
    security.audit(conn, user, "create_team", "team", team_id,
                   {"school_id": school_id, "members": len(members)})
    return {"team_id": team_id, "rev": 1, "captain_id": captain_id,
            "profile_gaps": team_profile_gaps(conn, team_id, captain_id)}


@route("PUT", r"/api/teams/(?P<team_id>\d+)", roles=ORG)
def update_team(ctx):
    team_id = int(ctx.params["team_id"])
    team = get_or_404(ctx.conn, "teams", team_id, "学校项目名单")
    cat = category_context(ctx.conn, team["category_id"])
    expect_rev(ctx.conn, ctx.body, "teams", team_id, "学校项目名单")

    # name 是兼容旧数据的内部字段，用户侧不再单独维护队名。
    school = get_or_404(ctx.conn, "schools", team["school_id"], "学校")
    fields = {"name": school["short_name"] or school["name"]}
    if "note" in ctx.body:
        fields["note"] = ctx.body["note"]
    if fields:
        db.update(ctx.conn, "teams", team_id, fields)

    rewriting = "members" in ctx.body or "member_ids" in ctx.body
    captain_changed = "captain_id" in ctx.body
    previous_captain = team_captain_id(ctx.conn, team_id)
    if rewriting:
        members, captain_id = normalize_members(ctx.conn, ctx.body, team["school_id"], cat)
        if not captain_changed:
            # 成员重排或勾选顺序变化不改变队长；队长已不在名单中才清空（§6.5）
            captain_id = previous_captain if previous_captain in {m["athlete_id"] for m in members} else None
        old_members = sorted((m['id'], m['jersey_no']) for m in team_members(ctx.conn, team_id))
        new_members = sorted((m['athlete_id'], m['jersey_no']) for m in members)
        if old_members != new_members or captain_id != previous_captain:
            registration.guard_team_roster(ctx.conn, team_id)
        write_members(ctx.conn, team_id, members, captain_id)
    elif captain_changed:
        captain_id = ctx.body.get("captain_id")
        captain_id = int(captain_id) if captain_id else None
        existing = {m["athlete_id"] for m in team_members(ctx.conn, team_id)}
        if captain_id and captain_id not in existing:
            raise invalid_fields("队长必须是已选队员之一", {"captain_id": "队长不在队员名单中"})
        if captain_id != previous_captain:
            registration.guard_team_roster(ctx.conn, team_id)
        for athlete_id in existing:
            db.run(ctx.conn, "UPDATE team_members SET is_captain = ? WHERE team_id = ? AND athlete_id = ?",
                   (1 if athlete_id == captain_id else 0, team_id, athlete_id))

    registration.validate_categories(ctx.conn, [cat['id']])
    rev = bump_rev(ctx.conn, "teams", team_id)
    final_captain = team_captain_id(ctx.conn, team_id)
    return {"message": "已更新", "rev": rev, "captain_id": final_captain,
            "profile_gaps": team_profile_gaps(ctx.conn, team_id, final_captain),
            "captain_cleared": previous_captain is not None and final_captain is None}


@route("DELETE", r"/api/teams/(?P<team_id>\d+)", roles=ADMIN)
def delete_team(ctx):
    team_id = int(ctx.params["team_id"])
    team = get_or_404(ctx.conn, "teams", team_id, "学校项目名单")
    if db.q1(ctx.conn, "SELECT id FROM participations WHERE team_id = ?", (team_id,)):
        raise conflict("该学校已进入本项目参赛名单，不能删除项目名单", code="in_use")
    db.run(ctx.conn, "DELETE FROM teams WHERE id = ?", (team_id,))
    security.audit(ctx.conn, ctx.user, "delete_team", "team", team_id,
                   {"category_id": team["category_id"], "school_id": team["school_id"],
                    "name": team["name"]})
    return {"message": "已删除"}


@route("GET", r"/api/teams/(?P<team_id>\d+)/impact")
def team_impact(ctx):
    """修改影响预检查（§15.2）：只读，提交时仍会重复校验。"""
    team_id = int(ctx.params["team_id"])
    get_or_404(ctx.conn, "teams", team_id, "学校项目名单")
    part = db.q1(ctx.conn, """SELECT id FROM participations
        WHERE team_id = ? AND deleted_at IS NULL""", (team_id,))
    if not part:
        return {"participation_id": None, "matches": 0, "finished_matches": 0,
                "placements": 0, "locked_plan": False, "members": 0}
    pid = part["id"]
    stats = db.q1(ctx.conn,
                  """SELECT (SELECT COUNT(*) FROM matches
                              WHERE home_actual = ? OR away_actual = ?
                                 OR home_participation = ? OR away_participation = ?) AS matches,
                            (SELECT COUNT(*) FROM matches
                              WHERE (home_actual = ? OR away_actual = ?)
                                AND status = 'finished') AS finished,
                            (SELECT COUNT(*) FROM placements WHERE participation_id = ?) AS placements""",
                  (pid, pid, pid, pid, pid, pid, pid))
    member_count = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?",
                         (team_id,))
    plan_locked = bool(db.q1(ctx.conn,
                             """SELECT p.id FROM plans p JOIN categories c ON c.id = p.category_id
                                 JOIN teams t ON t.category_id = c.id
                                WHERE t.id = ? AND p.status IN ('locked','running') LIMIT 1""",
                             (team_id,)))
    return {"participation_id": pid, "matches": stats["matches"] or 0,
            "finished_matches": stats["finished"] or 0, "placements": stats["placements"] or 0,
            "locked_plan": plan_locked, "members": member_count["n"]}



# ------------------------------------------------------------------ 参赛名单
@route("GET", r"/api/categories/(?P<category_id>\d+)/participations")
def list_participations(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    # 编辑提示与实际写入使用同一保护规则，避免界面允许修改已冻结的种子。
    try:
        registration.guard_change(ctx.conn, category_id)
        cat["registration_locked_reason"] = ""
    except ApiError as exc:
        cat["registration_locked_reason"] = exc.message
    rows = db.q(ctx.conn,
                """SELECT p.*, CASE WHEN p.team_id IS NOT NULL
                                           THEN COALESCE(NULLIF(s.short_name, ''), s.name)
                                           ELSE a.name END AS subject,
                          COALESCE(t.school_id, a.school_id) AS school_id,
                          COALESCE(t.id, a.id) AS subject_id,
                          s.name AS school_name, s.short_name AS school_short
                     FROM participations p
                     LEFT JOIN teams t ON t.id = p.team_id
                     LEFT JOIN athletes a ON a.id = p.athlete_id
                     LEFT JOIN schools s ON s.id = COALESCE(t.school_id, a.school_id)
                    WHERE p.category_id = ? AND p.deleted_at IS NULL
                    ORDER BY p.seed_no IS NULL, p.seed_no, s.name""",
                (category_id,))
    plan = db.q1(ctx.conn,
                 "SELECT status FROM plans WHERE category_id = ? ORDER BY id DESC LIMIT 1",
                 (category_id,))
    out = []
    for r in rows:
        item = dict(r)
        item["display"] = ((r["school_short"] or r["school_name"])
                           if cat["kind"] == "team"
                           else f"{r['school_short'] or r['school_name']}·{r['subject']}")
        item["kind"] = cat["kind"]
        if cat["kind"] == "team" and r["team_id"]:
            members = team_members(ctx.conn, r["team_id"])
            captain = team_captain_id(ctx.conn, r["team_id"])
            item["members"] = members
            item["captain_id"] = captain
            item["captain_name"] = next((m["name"] for m in members if m["id"] == captain), "")
            item["member_summary"] = "、".join(m["name"] for m in members)
            item["profile_gaps"] = team_profile_gaps(ctx.conn, r["team_id"], captain)
        else:
            athlete = db.q1(ctx.conn, "SELECT name, gender, jersey_no FROM athletes WHERE id = ?",
                            (r["athlete_id"],)) if r["athlete_id"] else None
            item["members"] = []
            item["captain_id"] = None
            item["captain_name"] = ""
            item["member_summary"] = ""
            item["profile_gaps"] = (["性别待补充"] if athlete and not athlete["gender"] else [])
        item["profile_status"] = "complete" if not item["profile_gaps"] else "incomplete"
        # 第三个维度：任务可用性。它与报名状态、资料状态分开表达；名单缺项按已确认
        # 口径不阻断编排，但会在具体场次开始记录前核验。
        if item["status"] != "active":
            item["task_status"] = "已退出，不参与后续任务"
            item["task_status_kind"] = ""
        elif cat["kind"] == "individual":
            item["task_status"] = "可录入成绩"
            item["task_status_kind"] = "info"
        elif plan is None or plan["status"] == "draft":
            item["task_status"] = "可参与编排"
            item["task_status_kind"] = "ok"
        elif plan["status"] == "previewed":
            item["task_status"] = "等待方案锁定"
            item["task_status_kind"] = "warn"
        else:
            ready = db.q1(ctx.conn,
                          """SELECT COUNT(*) AS n FROM matches
                              WHERE category_id = ? AND status = 'ready'
                                AND (home_actual = ? OR away_actual = ?)""",
                          (category_id, item["id"], item["id"]))
            item["task_status"] = "有待记录场次" if ready["n"] else "等待后续场次"
            item["task_status_kind"] = "info" if ready["n"] else ""
        out.append(item)
    result = {"category": cat, "participations": out}
    if cat['kind'] == 'individual':
        from ..individual_draw_store import attach
        result['individual_draw'] = attach(ctx.conn, category_id, out)
    return result


@route("POST", r"/api/categories/(?P<category_id>\d+)/participations", roles=ORG)
def create_participation(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    registration.guard_change(ctx.conn, category_id)
    team_id = ctx.body.get("team_id")
    athlete_id = ctx.body.get("athlete_id")
    if bool(team_id) == bool(athlete_id):
        raise bad_request("请且仅请指定参赛学校项目名单或运动员其中之一")
    if team_id:
        if cat["kind"] != "team":
            raise bad_request("该项目不是三人赛")
        team = get_or_404(ctx.conn, "teams", int(team_id), "学校项目名单")
        if team["category_id"] != category_id:
            raise invalid_fields("该学校项目名单不属于本项目", {"team_id": "该学校项目名单不属于本项目"})
        if db.q1(ctx.conn, """SELECT id FROM participations
                 WHERE category_id = ? AND team_id = ? AND deleted_at IS NULL""",
                 (category_id, int(team_id))):
            raise conflict("该学校已在本项目参赛名单中", code="duplicate",
                           detail={"fields": {"team_id": "该学校已在本项目参赛名单中"}})
        member_ids = [r["athlete_id"] for r in db.q(
            ctx.conn, "SELECT athlete_id FROM team_members WHERE team_id = ?", (int(team_id),))]
        validate_no_event_double_entry(ctx.conn, cat, member_ids)
    else:
        if cat["kind"] != "individual":
            raise bad_request("该项目不是个人赛")
        ath = get_or_404(ctx.conn, "athletes", int(athlete_id), "运动员")
        if ath["group_id"] != cat["group_id"]:
            raise invalid_fields("该运动员不属于本项目所在大组别",
                                 {"athlete_id": "该运动员不属于本项目所在大组别"})
        if ath["gender"] and ath["gender"] != cat["gender"]:
            raise invalid_fields("运动员性别与项目不符", {"athlete_id": "运动员性别与项目不符"})
        if db.q1(ctx.conn, """SELECT id FROM participations
                 WHERE category_id = ? AND athlete_id = ? AND deleted_at IS NULL""",
                 (category_id, int(athlete_id))):
            raise conflict("该运动员已在参赛名单中", code="duplicate",
                           detail={"fields": {"athlete_id": "该运动员已在参赛名单中"}})
        validate_individual_school_limit(ctx.conn, cat, int(athlete_id))
        validate_no_event_double_entry(ctx.conn, cat, [int(athlete_id)])
    pid = db.insert(ctx.conn, "participations", {
        "event_id": cat["event_id"], "category_id": category_id,
        "team_id": int(team_id) if team_id else None,
        "athlete_id": int(athlete_id) if athlete_id else None,
        "seed_no": parse_seed(ctx.body.get("seed_no")),
        "status": "active", "note": ctx.body.get("note") or ""})
    registration.validate_categories(ctx.conn, [category_id])
    registration.sync_choice(ctx.conn, category_id, team['school_id'] if team_id else ath['school_id'])
    return {"participation_id": pid, "rev": 1}


def parse_seed(value):
    """种子序号：正整数，空值表示未指定（§6.2、§9.1）。"""
    if value in (None, ""):
        return None
    try:
        seed = int(value)
    except (TypeError, ValueError):
        raise invalid_fields("种子序号必须是正整数", {"seed_no": "种子序号必须是正整数"}) from None
    if seed <= 0:
        raise invalid_fields("种子序号必须是正整数", {"seed_no": "种子序号必须是正整数"})
    return seed


# ------------------------------------------------------------------ 组合报名
def _guard_plan_state(conn, category_id: int) -> None:
    """方案锁定后不再静默接受新报名（§15.3“方案状态”校验）。

    锁定的对阵里不可能出现新队伍，直接写入只会造出一支永远打不上比赛的队。
    """
    registration.guard_change(conn, category_id)
    plan = db.q1(conn,
                 """SELECT id, status FROM plans WHERE category_id = ?
                     ORDER BY id DESC LIMIT 1""", (category_id,))
    if not plan or plan["status"] not in ("locked", "running"):
        return
    has_matches = db.q1(conn, "SELECT COUNT(*) AS n FROM matches WHERE category_id = ?",
                        (category_id,))
    if has_matches["n"]:
        raise conflict("该项目方案已锁定并已生成赛程，不能直接新增报名；请先解锁方案或走受控变更流程",
                       code="plan_locked")


def _resolve_school(conn, cat: dict, body: dict, created: dict) -> dict:
    """按引用取学校，或在本事务内新建（§6.4：新建对象随本次提交一起落库）。"""
    event_id = cat["event_id"]
    school_id = body.get("school_id")
    if school_id:
        school = get_or_404(conn, "schools", int(school_id), "学校")
        entry = db.q1(conn, "SELECT group_id FROM school_entries WHERE school_id = ?", (school["id"],))
        if not entry or entry["group_id"] != cat["group_id"]:
            raise invalid_fields("该学校不属于本项目所在大组别",
                                 {"school_id": "该学校不属于本项目所在大组别"})
        return school
    new = body.get("school") or {}
    name = (new.get("name") or "").strip()
    if not name:
        raise invalid_fields("请选择学校，或填写新学校名称", {"school_id": "请选择学校"})
    existing = db.q1(conn, "SELECT * FROM schools WHERE event_id = ? AND name = ?", (event_id, name))
    if existing:
        # 同名匹配只作复用，不重复建档（§6.3）
        entry = db.q1(conn, "SELECT group_id FROM school_entries WHERE school_id = ?", (existing["id"],))
        if entry and entry["group_id"] != cat["group_id"]:
            raise invalid_fields(f"学校「{name}」已归属其他组别，不能跨组别报名",
                                 {"school_id": f"学校「{name}」已归属其他组别"})
        if not entry:
            db.insert(conn, "school_entries", {"event_id": event_id, "group_id": cat["group_id"],
                                               "school_id": existing["id"]})
        return existing
    school_id = db.insert(conn, "schools", {
        "event_id": event_id, "name": name,
        "short_name": (new.get("short_name") or "").strip() or name,
        "note": new.get("note") or ""})
    db.insert(conn, "school_entries", {"event_id": event_id, "group_id": cat["group_id"],
                                       "school_id": school_id})
    created["schools"].append(school_id)
    invalidate_event_stats(event_id)  # 报名时随事务新建的学校也要让列表计数立即刷新
    return db.q1(conn, "SELECT * FROM schools WHERE id = ?", (school_id,))


def _resolve_athlete(conn, cat: dict, item: dict, school, created: dict, where: str,
                     field_name: str = "members") -> dict:
    """按引用取运动员，或在本事务内新建；复用已有档案时不改写其姓名、性别、号码。

    field_name 决定校验错误挂在哪个字段上：三人赛是 members，个人赛是 athlete。
    """
    athlete_id = item.get("athlete_id")
    if athlete_id:
        athlete = get_or_404(conn, "athletes", int(athlete_id), "运动员")
        if athlete["school_id"] != school["id"]:
            raise invalid_fields(f"{where}：该运动员不属于所选学校", {field_name: f"{where}：运动员不属于所选学校"})
        if athlete["group_id"] != cat["group_id"]:
            raise invalid_fields(f"{where}：该运动员不属于本项目所在大组别", {field_name: where})
        if athlete["gender"] and athlete["gender"] != cat["gender"]:
            raise invalid_fields(f"{where}：运动员性别与{GENDER_NAMES[cat['gender']]}项目不符",
                                 {field_name: where})
        return athlete
    name = (item.get("name") or "").strip()
    if not name:
        raise invalid_fields(f"{where}：缺少运动员姓名或 ID", {field_name: where})
    gender = item.get("gender") or ""
    if gender not in ("male", "female", ""):
        raise invalid_fields(f"{where}：性别不合法", {field_name: where})
    if gender and gender != cat["gender"]:
        raise invalid_fields(f"{where}：性别与{GENDER_NAMES[cat['gender']]}项目不符", {field_name: where})
    new_id = db.insert(conn, "athletes", {
        "group_id": cat["group_id"], "school_id": school["id"], "name": name,
        "gender": gender,
        "jersey_no": str(item.get("athlete_jersey_no") or "").strip(),
        "note": item.get("note") or ""})
    created["athletes"].append(new_id)
    return db.q1(conn, "SELECT * FROM athletes WHERE id = ?", (new_id,))


@route("POST", r"/api/categories/(?P<category_id>\d+)/enrollments", roles=ORG)
def create_enrollment(ctx):
    """学校参加三人赛：一个事务内完成运动员、项目名单与报名（§6.3、§15.2）。

    整个业务项要么全部成功、要么全部回滚；带 request_uid 时重放返回原结果，
    不会重复建队或重复报名（§15.3、T05）。
    """
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "team":
        raise bad_request("该项目不是三人赛，请使用个人赛报名入口")
    return idempotency.replay_or_run(
        ctx.conn, ctx.user, idempotency.extract_uid(ctx.body),
        idempotency.payload_without_uid(ctx.body),
        lambda: _enroll_team(ctx.conn, ctx.user, cat, ctx.body),
        scope=f"enroll:{category_id}")


def _enroll_team(conn, user, cat: dict, body: dict) -> dict:
    category_id = cat["id"]
    _guard_plan_state(conn, category_id)
    created: dict = {"schools": [], "athletes": [], "teams": []}
    school = _resolve_school(conn, cat, body, created)

    team_id = body.get("team_id")
    if team_id:
        team = get_or_404(conn, "teams", int(team_id), "学校项目名单")
        if team["category_id"] != category_id or team["school_id"] != school["id"]:
            raise invalid_fields("该项目名单不属于本项目或该学校", {"team_id": "该项目名单不属于本项目或该学校"})
        team_id = team["id"]
        captain_id = team_captain_id(conn, team_id)
        members = [{"athlete_id": m["id"], "jersey_no": m["jersey_no"]}
                   for m in team_members(conn, team_id)]
        members, captain_id = normalize_members(conn, {"members": members, "captain_id": captain_id},
                                                 school["id"], cat)
    else:
        team_name = school["short_name"] or school["name"]
        if db.q1(conn, "SELECT id FROM teams WHERE category_id = ? AND school_id = ?",
                 (category_id, school["id"])):
            raise conflict("该学校在本项目已有名单，请直接复用或编辑", code="duplicate",
                           detail={"fields": {"school_id": "该学校在本项目已有名单"}})
        raw_members = body.get("members") or []
        if not isinstance(raw_members, list):
            raise invalid_fields("队员名单格式不正确", {"members": "应为数组"})
        pending_names = {}
        for item in raw_members:
            if not isinstance(item, dict):
                raise invalid_fields('队员资料格式不正确', {'members': '队员应为对象'})
            if not item.get('athlete_id'):
                _confirm_same_name_creation(conn, school['id'], item)
                name_key = str(item.get('name') or '').strip().lower()
                prior = pending_names.get(name_key, [])
                note = str(item.get('note') or '').strip().lower()
                if prior and (item.get('confirm_distinct_person') is not True or not note or note in prior):
                    raise invalid_fields('新增名单中有同名人员，请确认不同人并填写不同区分信息', {'members': '同名人员未核对'})
                pending_names.setdefault(name_key, []).append(note)
        members: list[dict] = []
        seen: set[int] = set()
        for index, item in enumerate(raw_members):
            if not isinstance(item, dict):
                raise invalid_fields(f"第 {index + 1} 位队员格式不正确", {"members": "队员应为对象"})
            where = f"第 {index + 1} 位队员"
            athlete = _resolve_athlete(conn, cat, item, school, created, where)
            if athlete["id"] in seen:
                raise invalid_fields(f"{where}重复", {"members": f"{where}重复"})
            seen.add(athlete["id"])
            # jersey_no 是本队报名号码；留空时预填运动员常用号码（§6.2）
            jersey = str(item.get("jersey_no") or "").strip() or (athlete["jersey_no"] or "")
            members.append({"athlete_id": athlete["id"], "jersey_no": jersey})
        captain_index = body.get("captain_index")
        captain_id = None
        if captain_index not in (None, ""):
            try:
                captain_index = int(captain_index)
            except (TypeError, ValueError):
                raise invalid_fields("队长序号不合法", {"captain_index": "应为队员序号"}) from None
            if not 0 <= captain_index < len(members):
                raise invalid_fields("队长必须是已选队员之一", {"captain_index": "队长不在队员名单中"})
            captain_id = members[captain_index]["athlete_id"]
        members, captain_id = normalize_members(conn, {"members": members, "captain_id": captain_id},
                                                 school["id"], cat)
        team_id = db.insert(conn, "teams", {"category_id": category_id, "school_id": school["id"],
                                            "name": team_name, "note": body.get("team_note") or ""})
        created["teams"].append(team_id)
        write_members(conn, team_id, members, captain_id)

    existing = db.q1(conn, """SELECT * FROM participations
        WHERE category_id = ? AND team_id = ? AND deleted_at IS NULL""",
                     (category_id, team_id))
    if existing:
        raise conflict("该学校已在本项目参赛名单中", code="duplicate",
                       detail={"fields": {"team_id": "该学校已在本项目参赛名单中"},
                               "participation_id": existing["id"]})
    validate_no_event_double_entry(conn, cat, [m["athlete_id"] for m in members])
    pid = db.insert(conn, "participations", {
        "event_id": cat["event_id"], "category_id": category_id, "team_id": team_id,
        "seed_no": parse_seed(body.get("seed_no")),
        "status": "active", "note": body.get("note") or ""})
    security.audit(conn, user, "enroll_team", "participation", pid,
                   {"team_id": team_id, "created": created})
    registration.validate_categories(conn, [category_id])
    registration.sync_choice(conn, category_id, school['id'])
    captain = team_captain_id(conn, team_id)
    return {"participation_id": pid, "team_id": team_id, "rev": 1,
            "created": created, "captain_id": captain,
            "profile_gaps": team_profile_gaps(conn, team_id, captain)}


@route("POST", r"/api/categories/(?P<category_id>\d+)/enrollments/individual", roles=ORG)
def create_individual_enrollment(ctx):
    """组合个人报名：选人或就地建人，并写入报名（§7.1、Q04）。"""
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "individual":
        raise bad_request("该项目不是个人赛，请使用三人赛报名入口")
    return idempotency.replay_or_run(
        ctx.conn, ctx.user, idempotency.extract_uid(ctx.body),
        idempotency.payload_without_uid(ctx.body),
        lambda: _enroll_individual(ctx.conn, ctx.user, cat, ctx.body),
        scope=f"enroll-ind:{category_id}")


def _confirm_same_name_creation(conn, school_id: int, source: dict) -> list[dict]:
    """同名只提示核对；明确确认不同人后允许就地建档，提交时复核候选版本。"""
    if source.get('athlete_id'):
        return []
    name = str(source.get('name') or '').strip().lower()
    if not name:
        return []
    matches = [dict(row) for row in db.q(
        conn, 'SELECT id, name, gender, jersey_no, note, rev FROM athletes WHERE school_id=? ORDER BY id',
        (school_id,)) if row['name'].strip().lower() == name]
    snapshot = [{'id': row['id'], 'rev': row['rev']} for row in matches]
    reviewed = source.get('same_name_candidates')
    if reviewed is not None and reviewed != snapshot:
        raise conflict('同名人员档案已变化，请在当前窗口重新核对', code='same_name_changed',
                       detail={'fields': {'athlete': '请重新核对同名人员'}, 'same_name_candidates': matches})
    if not matches:
        return []
    if source.get('confirm_distinct_person') is not True or reviewed is None:
        raise invalid_fields('该校已有同名人员，请选择已有人员，或核对后确认新增另一位同名人员',
                             {'athlete': '请核对已有人员并明确确认是不同人'})
    note = str(source.get('note') or '').strip()
    if not note or any(note.lower() == str(row['note'] or '').strip().lower() for row in matches):
        raise invalid_fields('请填写能够区分同名人员的信息，例如班级或学号',
                             {'athlete_note': '区分信息不能为空，也不能与已有同名人员相同'})
    source['note'] = note
    return snapshot


def _enroll_individual(conn, user, cat: dict, body: dict) -> dict:
    category_id = cat["id"]
    _guard_plan_state(conn, category_id)
    created: dict = {"schools": [], "athletes": []}
    school = _resolve_school(conn, cat, body, created)
    source = body.get("athlete") if body.get("athlete") else {"athlete_id": body.get("athlete_id")}
    if not isinstance(source, dict):
        raise invalid_fields('运动员资料格式不正确', {'athlete': '运动员应为对象'})
    reviewed = _confirm_same_name_creation(conn, school['id'], source)
    athlete = _resolve_athlete(conn, cat, source or {}, school, created, "运动员",
                               field_name="athlete")
    existing = db.q1(conn, """SELECT * FROM participations
        WHERE category_id = ? AND athlete_id = ? AND deleted_at IS NULL""",
                     (category_id, athlete["id"]))
    if existing:
        raise conflict("该运动员已在参赛名单中", code="duplicate",
                       detail={"fields": {"athlete_id": "该运动员已在参赛名单中"},
                               "participation_id": existing["id"]})
    validate_individual_school_limit(conn, cat, athlete["id"])
    validate_no_event_double_entry(conn, cat, [athlete["id"]])
    pid = db.insert(conn, "participations", {
        "event_id": cat["event_id"], "category_id": category_id, "athlete_id": athlete["id"],
        "seed_no": parse_seed(body.get("seed_no")),
        "status": "active", "note": body.get("note") or ""})
    security.audit(conn, user, "enroll_individual", "participation", pid,
                   {"athlete_id": athlete["id"], "created": created, "same_name_reviewed": reviewed})
    registration.validate_categories(conn, [category_id])
    registration.sync_choice(conn, category_id, school['id'])
    return {"participation_id": pid, "athlete_id": athlete["id"], "rev": 1, "created": created,
            "profile_gaps": [] if athlete["gender"] else ["性别待补充"]}


@route("GET", r"/api/categories/(?P<category_id>\d+)/enrollment-candidates")
def enrollment_candidates(ctx):
    """从档案批量加入的候选核对（§8.3）：只读，不写任何报名数据。

    返回每个候选的动作分类，供界面先展示“预计新增 / 已报名 / 已退出 / 不符合条件”
    再让用户勾选提交，取代原来一键直接写入的行为。
    """
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    candidates = []
    if cat["kind"] == "team":
        rows = db.q(ctx.conn,
                    """SELECT t.id AS subject_id, t.name AS subject, t.school_id,
                              s.name AS school_name, s.short_name AS school_short,
                              (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
                         FROM teams t JOIN schools s ON s.id = t.school_id
                        WHERE t.category_id = ? ORDER BY s.name, t.name""", (category_id,))
    else:
        rows = db.q(ctx.conn,
                    """SELECT a.id AS subject_id, a.name AS subject, a.school_id,
                              s.name AS school_name, s.short_name AS school_short, a.gender,
                              a.jersey_no, a.note, a.rev
                         FROM athletes a
                         JOIN school_entries se ON se.school_id = a.school_id
                         JOIN schools s ON s.id = a.school_id
                        WHERE se.group_id = ? ORDER BY s.name, a.name""", (cat["group_id"],))
    key = "team_id" if cat["kind"] == "team" else "athlete_id"
    for r in rows:
        item = dict(r)
        item["key"] = key
        item["display"] = ((r["school_short"] or r["school_name"])
                           if cat["kind"] == "team"
                           else f"{r['school_short'] or r['school_name']}·{r['subject']}")
        existing = db.q1(ctx.conn,
                         f"""SELECT id, status FROM participations
                              WHERE category_id = ? AND {key} = ? AND deleted_at IS NULL""",
                         (category_id, r["subject_id"]))
        if existing and existing["status"] == "active":
            item["action"] = "enrolled"
            item["reason"] = "已在报名名单中"
            item["participation_id"] = existing["id"]
        elif existing:
            # 已退出者默认不自动恢复（§8.3）
            item["action"] = "withdrawn"
            item["reason"] = "已退出，不会随批量加入自动恢复"
            item["participation_id"] = existing["id"]
        elif cat["kind"] == "individual" and r["gender"] and r["gender"] != cat["gender"]:
            item["action"] = "ineligible"
            item["reason"] = f"性别与{GENDER_NAMES[cat['gender']]}项目不符"
        elif cat["kind"] == "individual" and not r["gender"]:
            item["action"] = "needs_review"
            item["reason"] = "性别未填，请确认后再加入"
        else:
            item["action"] = "addable"
            item["reason"] = ""
        if cat['kind'] == 'individual' and item['action'] in ('addable', 'needs_review'):
            try:
                validate_no_event_double_entry(ctx.conn, cat, [r['subject_id']])
                validate_individual_school_limit(ctx.conn, cat, r['subject_id'])
            except ApiError as exc:
                item['action'] = 'ineligible'
                item['reason'] = exc.message
        candidates.append(item)
    counts: dict[str, int] = {}
    for c in candidates:
        counts[c["action"]] = counts.get(c["action"], 0) + 1
    return {"category": cat, "candidates": candidates, "counts": counts}


@route("POST", r"/api/categories/(?P<category_id>\d+)/participations/batch", roles=ORG)
def batch_participations(ctx):
    """按业务项原子保存、批次允许部分成功（§8.4）。

    每项独立返回 created / duplicate / error，不因一项失败回滚整批；
    单项内部仍是原子的。
    """
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    items = ctx.body.get("items")
    if not isinstance(items, list) or not items:
        raise invalid_fields("请先勾选要加入的报名项", {"items": "至少选择一项"})
    key = "team_id" if cat["kind"] == "team" else "athlete_id"
    results = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            results.append({"index": index, "status": "error", "message": "格式不正确"})
            continue
        try:
            subject_id = int(item.get(key) or item.get("subject_id") or 0)
        except (TypeError, ValueError):
            subject_id = 0
        if not subject_id:
            results.append({"index": index, "status": "error", "message": f"缺少 {key}"})
            continue
        label = item.get("display") or f"#{subject_id}"
        try:
            with db.savepoint(ctx.conn, f"sp{index}"):
                seed = parse_seed(item.get("seed_no"))
                pid = _enroll_subject(ctx.conn, cat, key, subject_id, seed,
                                      item.get("note") or "")
            results.append({"index": index, "subject_id": subject_id, "display": label,
                            "status": "created", "participation_id": pid})
        except ApiError as exc:
            results.append({"index": index, "subject_id": subject_id, "display": label,
                            "status": "duplicate" if exc.code == "duplicate" else "error",
                            "message": exc.message})
    created = sum(1 for r in results if r["status"] == "created")
    security.audit(ctx.conn, ctx.user, "batch_enroll", "category", category_id,
                   {"created": created, "total": len(items)})
    return {"created": created, "results": results,
            "message": f"已加入 {created} 项，其余 {len(items) - created} 项见明细"}


def _enroll_subject(conn, cat: dict, key: str, subject_id: int, seed, note: str) -> int:
    """写入单条报名。复用 create_participation 的校验口径，避免快捷入口绕过保护（§15.3）。"""
    category_id = cat["id"]
    registration.guard_change(conn, category_id)
    if key == "team_id":
        if cat["kind"] != "team":
            raise bad_request("该项目不是三人赛")
        team = get_or_404(conn, "teams", subject_id, "学校项目名单")
        if team["category_id"] != category_id:
            raise bad_request("该学校项目名单不属于本项目")
        if db.q1(conn, """SELECT id FROM participations
                 WHERE category_id = ? AND team_id = ? AND deleted_at IS NULL""",
                 (category_id, subject_id)):
            raise conflict("该学校已在本项目参赛名单中", code="duplicate")
        validate_no_event_double_entry(conn, cat, [r["athlete_id"] for r in db.q(
            conn, "SELECT athlete_id FROM team_members WHERE team_id = ?", (subject_id,))])
    else:
        if cat["kind"] != "individual":
            raise bad_request("该项目不是个人赛")
        ath = get_or_404(conn, "athletes", subject_id, "运动员")
        if ath["group_id"] != cat["group_id"]:
            raise bad_request("该运动员不属于本项目所在大组别")
        if ath["gender"] and ath["gender"] != cat["gender"]:
            raise bad_request("运动员性别与项目不符")
        if db.q1(conn, """SELECT id FROM participations
                 WHERE category_id = ? AND athlete_id = ? AND deleted_at IS NULL""",
                 (category_id, subject_id)):
            raise conflict("该运动员已在参赛名单中", code="duplicate")
        validate_individual_school_limit(conn, cat, subject_id)
        validate_no_event_double_entry(conn, cat, [subject_id])
    pid = db.insert(conn, "participations", {
        "event_id": cat["event_id"], "category_id": category_id,
        "team_id": subject_id if key == "team_id" else None,
        "athlete_id": subject_id if key == "athlete_id" else None,
        "seed_no": seed, "status": "active", "note": note})
    registration.validate_categories(conn, [category_id])
    registration.sync_choice(conn, category_id, team['school_id'] if key == 'team_id' else ath['school_id'])
    return pid


@route("PUT", r"/api/participations/(?P<participation_id>\d+)", roles=ORG)
def update_participation(ctx):
    pid = int(ctx.params["participation_id"])
    part = db.q1(ctx.conn, """SELECT * FROM participations
        WHERE id=? AND deleted_at IS NULL""", (pid,))
    if part is None:
        raise not_found(f"参赛记录不存在（id={pid}）")
    expect_rev(ctx.conn, ctx.body, "participations", pid, "报名记录")
    fields = {}
    if "seed_no" in ctx.body:
        fields["seed_no"] = parse_seed(ctx.body["seed_no"])
    if "status" in ctx.body:
        if ctx.body["status"] not in ("active", "withdrawn"):
            raise invalid_fields("状态不合法", {"status": "状态只能是 active 或 withdrawn"})
        fields["status"] = ctx.body["status"]
    if "note" in ctx.body:
        fields["note"] = ctx.body["note"]
    if fields:
        if any(key in fields and fields[key] != part[key] for key in ('status', 'seed_no')):
            registration.guard_change(ctx.conn, part['category_id'])
        db.update(ctx.conn, "participations", pid, fields)
        registration.validate_categories(ctx.conn, [part['category_id']])
        if 'status' in fields and fields['status'] != part['status']:
            subject = get_or_404(ctx.conn, 'teams' if part['team_id'] else 'athletes', part['team_id'] or part['athlete_id'], '参赛主体')
            registration.sync_choice(ctx.conn, part['category_id'], subject['school_id'])
    return {"message": "已更新", "rev": bump_rev(ctx.conn, "participations", pid)}


@route("DELETE", r"/api/participations/(?P<participation_id>\d+)",
       roles=None, transaction=False)
def delete_participation(ctx):
    pid = int(ctx.params["participation_id"])
    return participation_deletion.delete_records(
        ctx.conn, ctx.user, [pid], ctx.body, single=True)


@route("POST", r"/api/participations/batch-delete", roles=None, transaction=False)
def batch_delete_participations(ctx):
    body = ctx.body if isinstance(ctx.body, dict) else {}
    return participation_deletion.delete_records(
        ctx.conn, ctx.user, body.get("ids"), body, single=False)


# ------------------------------------------------------------------ 场地
@route("GET", r"/api/events/(?P<event_id>\d+)/venues")
def list_venues(ctx):
    event_id = int(ctx.params["event_id"])
    return {"venues": db.rows_to_dicts(
        db.q(ctx.conn, "SELECT * FROM venues WHERE event_id = ? ORDER BY seq, id", (event_id,)))}


@route("POST", r"/api/events/(?P<event_id>\d+)/venues", roles=ORG)
def create_venue(ctx):
    event_id = int(ctx.params["event_id"])
    get_or_404(ctx.conn, "events", event_id, "赛事")
    name = (ctx.body.get("name") or "").strip()
    if not name:
        raise bad_request("请填写场地名称")
    if db.q1(ctx.conn, "SELECT id FROM venues WHERE event_id = ? AND name = ?", (event_id, name)):
        raise conflict("该场地已存在", code="duplicate")
    venue_id = db.insert(ctx.conn, "venues", {"event_id": event_id, "name": name,
                                              "seq": int(ctx.body.get("seq") or 0)})
    return {"venue_id": venue_id}


@route("DELETE", r"/api/venues/(?P<venue_id>\d+)", roles=ORG)
def delete_venue(ctx):
    """删除场地：同一事务统计影响场次、递增安排版本、写审计。"""
    venue_id = int(ctx.params["venue_id"])
    venue = get_or_404(ctx.conn, "venues", venue_id, "场地")
    with db.tx(ctx.conn):
        affected = db.q1(ctx.conn,
                         "SELECT COUNT(*) AS n FROM matches WHERE venue_id = ?", (venue_id,))["n"]
        # 递增 schedule_revision/updated_at，让已打开的记录页/编辑弹窗的乐观锁能感知变化。
        db.run(ctx.conn,
               """UPDATE matches SET venue_id = NULL,
                          schedule_revision = schedule_revision + 1, updated_at = ?
                   WHERE venue_id = ?""", (db.now(ctx.conn), venue_id))
        db.run(ctx.conn, "DELETE FROM venues WHERE id = ?", (venue_id,))
        security.audit(ctx.conn, ctx.user, "delete_venue", "venue", venue_id,
                       {"event_id": venue["event_id"], "affected_matches": affected})
    return {"message": "已删除", "affected_matches": affected}


@route("GET", r"/api/participations/labels")
def participation_labels(ctx):
    ids = [int(x) for x in (ctx.arg("ids") or "").split(",") if x.strip().isdigit()]
    return {"labels": participation_display_map(ctx.conn, ids)}
