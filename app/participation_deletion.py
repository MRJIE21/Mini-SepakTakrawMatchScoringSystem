"""报名记录软删除结构迁移。

旧库的报名唯一索引覆盖全部历史行；软删除后唯一性只约束未删除记录，
从而既保留审计数据，也允许同一主体在删除后重新报名。
"""
from __future__ import annotations

import sqlite3
import uuid

from . import backup, db, registration, security
from .errors import ApiError


MARKER = "migration:participation-soft-delete-v1"
BACKUP_SUFFIX = ".before-participation-soft-delete-v1.db"
MAX_BATCH_SIZE = 100


REFERENCE_CHECKS = (
    ("POOL_MEMBER", "该报名已加入比赛小组", "pool_members", "participation_id"),
    ("DRAW_LOT", "该报名已有抽签结果", "draw_lots", "participation_id"),
    ("POOL_RANK", "该报名已有小组名次快照", "pool_rank_snapshots", "participation_id"),
    ("INDIVIDUAL_RESULT", "该报名已有个人成绩", "individual_results", "participation_id"),
    ("PLACEMENT", "该报名已有名次记录", "placements", "participation_id"),
    ("SCHOOL_POINTS", "该报名已计入学校积分", "school_points", "participation_id"),
)


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {row["name"] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def _columns(conn: sqlite3.Connection) -> set[str]:
    return {row["name"] for row in conn.execute("PRAGMA table_info(participations)")}


def _index_sql(conn: sqlite3.Connection, name: str) -> str:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (name,)
    ).fetchone()
    return (row["sql"] or "") if row else ""


def _is_current(conn: sqlite3.Connection) -> bool:
    required = {"deleted_at", "deleted_by", "delete_batch_id"}
    if not required.issubset(_columns(conn)):
        return False
    for name in ("idx_part_team", "idx_part_athl"):
        normalized = " ".join(_index_sql(conn, name).lower().split())
        if "deleted_at is null" not in normalized:
            return False
    return bool(_index_sql(conn, "idx_part_active_category"))


def backup_before_upgrade(conn: sqlite3.Connection):
    """结构确需变化时保留一次经校验的升级前快照。"""
    if "participations" not in _tables(conn) or _is_current(conn):
        return None
    return backup.online_backup(conn, BACKUP_SUFFIX)


def install(conn: sqlite3.Connection) -> None:
    """幂等安装软删除列、活动唯一索引与迁移标记。"""
    tables = _tables(conn)
    if "participations" not in tables:
        return
    if "settings" not in tables:
        raise RuntimeError("报名软删除迁移需要 settings 表")
    if _is_current(conn):
        with db.tx(conn):
            conn.execute(
                "INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)", (MARKER, "1")
            )
        return

    with db.tx(conn):
        existing = _columns(conn)
        definitions = (
            "deleted_at TEXT",
            "deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL",
            "delete_batch_id TEXT",
        )
        for definition in definitions:
            if definition.split()[0] not in existing:
                conn.execute(f"ALTER TABLE participations ADD COLUMN {definition}")

        # SQLite 不支持直接修改部分索引谓词；在同一写事务内切换。
        conn.execute("DROP INDEX IF EXISTS idx_part_team")
        conn.execute("DROP INDEX IF EXISTS idx_part_athl")
        conn.execute("""
            CREATE UNIQUE INDEX idx_part_team
            ON participations(category_id, team_id)
            WHERE team_id IS NOT NULL AND deleted_at IS NULL
        """)
        conn.execute("""
            CREATE UNIQUE INDEX idx_part_athl
            ON participations(category_id, athlete_id)
            WHERE athlete_id IS NOT NULL AND deleted_at IS NULL
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_part_active_category
            ON participations(category_id, deleted_at, id)
        """)
        conn.execute(
            "INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)", (MARKER, "1")
        )


def _positive_int(value, field: str) -> int:
    if type(value) is not int or value < 1:
        raise ApiError(400, "INVALID_DELETE_REQUEST", f"{field} 必须是正整数")
    return value


def _normalize_ids(values) -> list[int]:
    if not isinstance(values, list) or not values:
        raise ApiError(400, "INVALID_DELETE_IDS", "请选择至少一条报名记录")
    if len(values) > MAX_BATCH_SIZE:
        raise ApiError(400, "DELETE_BATCH_TOO_LARGE",
                       f"每次最多删除 {MAX_BATCH_SIZE} 条报名记录")
    ids = [_positive_int(value, "报名记录ID") for value in values]
    if len(set(ids)) != len(ids):
        raise ApiError(400, "DUPLICATE_DELETE_IDS", "报名记录ID不得重复")
    return ids


def _base_revisions(body: dict, ids: list[int], single: bool) -> dict[int, int]:
    raw = body.get("base_revs")
    if single and raw is None and "base_rev" in body:
        raw = {str(ids[0]): body.get("base_rev")}
    if not isinstance(raw, dict):
        raise ApiError(400, "MISSING_BASE_REVISIONS", "删除请求必须携带每条记录的修订号")
    revisions: dict[int, int] = {}
    for participation_id in ids:
        value = raw.get(str(participation_id), raw.get(participation_id))
        if type(value) is not int or value < 1:
            raise ApiError(400, "MISSING_BASE_REVISIONS",
                           f"报名记录 {participation_id} 缺少有效修订号")
        revisions[participation_id] = value
    return revisions


def _requested_ids(values) -> list[int]:
    """失败审计只记录有界、可识别的正整数ID。"""
    if not isinstance(values, list):
        return []
    result = []
    for value in values[:MAX_BATCH_SIZE]:
        if type(value) is int and value > 0 and value not in result:
            result.append(value)
    return result


def _failure(participation_id: int, code: str, message: str) -> dict:
    return {"id": participation_id, "ok": False, "code": code, "message": message}


def _envelope(batch_id: str, items: list[dict]) -> dict:
    succeeded = sum(1 for item in items if item.get("ok"))
    return {
        "batch_id": batch_id,
        "atomic": True,
        "success_count": succeeded,
        "failure_count": len(items) - succeeded,
        "items": items,
    }


def _rejection(batch_id: str, ids: list[int], failures: dict[int, tuple[str, str]],
               *, status: int = 409, code: str = "REGISTRATION_DELETE_REJECTED",
               message: str = "报名记录不满足删除条件，未删除任何记录") -> ApiError:
    items = []
    for participation_id in ids:
        failure = failures.get(participation_id)
        if failure:
            items.append(_failure(participation_id, failure[0], failure[1]))
        else:
            items.append(_failure(participation_id, "BATCH_ROLLED_BACK",
                                  "同批其他记录校验失败，本条未删除"))
    return ApiError(status, code, message, _envelope(batch_id, items))


def _load_rows(conn: sqlite3.Connection, ids: list[int]) -> dict[int, sqlite3.Row]:
    marks = ",".join("?" for _ in ids)
    rows = db.q(conn, f"""SELECT p.*,
            c.name AS category_name,c.kind AS category_kind,c.group_id,
            g.event_id,
            t.category_id AS team_category_id,t.school_id AS team_school_id,
            a.group_id AS athlete_group_id,a.school_id AS athlete_school_id,
            s.id AS school_id,s.name AS school_name,s.event_id AS school_event_id,
            CASE WHEN p.team_id IS NOT NULL THEN COALESCE(NULLIF(s.short_name,''),s.name)
                 ELSE a.name END AS subject
        FROM participations p
        LEFT JOIN categories c ON c.id=p.category_id
        LEFT JOIN groups g ON g.id=c.group_id
        LEFT JOIN teams t ON t.id=p.team_id
        LEFT JOIN athletes a ON a.id=p.athlete_id
        LEFT JOIN schools s ON s.id=COALESCE(t.school_id,a.school_id)
        WHERE p.id IN ({marks})""", ids)
    return {row["id"]: row for row in rows}


def _context_failure(conn: sqlite3.Connection, row: sqlite3.Row,
                     category_id: int, school_id: int | None) -> tuple[str, str] | None:
    if row["deleted_at"] is not None:
        return "ALREADY_DELETED", "该报名记录已删除，请刷新列表"
    if row["category_id"] != category_id:
        return "CATEGORY_MISMATCH", "该报名记录不属于当前报名批次"
    if row["group_id"] is None or row["event_id"] is None or row["school_id"] is None:
        return "INVALID_REGISTRATION_CONTEXT", "该报名记录的项目或学校信息不完整"
    if school_id is not None and row["school_id"] != school_id:
        return "SCHOOL_MISMATCH", "该报名记录不属于当前学校"
    if row["school_event_id"] != row["event_id"]:
        return "INVALID_REGISTRATION_CONTEXT", "报名学校与赛事不一致"
    entry = db.q1(conn, """SELECT id FROM school_entries
        WHERE event_id=? AND group_id=? AND school_id=?""",
                  (row["event_id"], row["group_id"], row["school_id"]))
    if entry is None:
        return "INVALID_REGISTRATION_CONTEXT", "报名学校不属于当前组别"
    if row["team_id"] is not None:
        if (row["athlete_id"] is not None or row["category_kind"] != "team" or
                row["team_category_id"] != row["category_id"] or
                row["team_school_id"] != row["school_id"]):
            return "INVALID_REGISTRATION_CONTEXT", "学校项目名单与报名项目不一致"
    elif (row["athlete_id"] is None or row["category_kind"] != "individual" or
          row["athlete_group_id"] != row["group_id"] or
          row["athlete_school_id"] != row["school_id"]):
        return "INVALID_REGISTRATION_CONTEXT", "运动员与报名项目或学校不一致"
    return None


def _reference_failure(conn: sqlite3.Connection, participation_id: int) -> tuple[str, str] | None:
    for code, message, table, column in REFERENCE_CHECKS:
        if db.q1(conn, f"SELECT 1 FROM {table} WHERE {column}=? LIMIT 1",
                 (participation_id,)):
            return code, message
    match_columns = (
        ("MATCH_HOME_SOURCE", "该报名已被主队签位引用", "home_participation"),
        ("MATCH_AWAY_SOURCE", "该报名已被客队签位引用", "away_participation"),
        ("MATCH_HOME_ACTUAL", "该报名已进入主队对阵", "home_actual"),
        ("MATCH_AWAY_ACTUAL", "该报名已进入客队对阵", "away_actual"),
    )
    for code, message, column in match_columns:
        if db.q1(conn, f"SELECT 1 FROM matches WHERE {column}=? LIMIT 1",
                 (participation_id,)):
            return code, message
    if db.q1(conn, """SELECT 1 FROM submissions
        WHERE home_participation=? OR away_participation=? LIMIT 1""",
             (participation_id, participation_id)):
        return "SUBMISSION_REFERENCE", "该报名已被成绩提交记录引用"
    return None


def _audit_items(conn: sqlite3.Connection, user: dict, batch_id: str,
                 category_id: int | None, items: list[dict], result: str) -> None:
    for item in items:
        security.audit(conn, user, "delete_participation", "participation", item["id"], {
            "batch_id": batch_id,
            "category_id": category_id,
            "result": result,
            "code": item["code"],
            "reason": item["message"],
        })
    security.audit(conn, user, "delete_participations_batch", "category", category_id, {
        **_envelope(batch_id, items),
        "result": result,
        "participation_ids": [item["id"] for item in items],
    })


def _audit_failure(conn: sqlite3.Connection, user: dict, batch_id: str,
                   category_id: int | None, ids: list[int], error: ApiError) -> None:
    detail = error.detail if isinstance(error.detail, dict) else {}
    items = detail.get("items") if isinstance(detail.get("items"), list) else None
    if not items:
        items = [_failure(participation_id, error.code, error.message)
                 for participation_id in ids]
    with db.tx(conn):
        db.ensure_user_snapshot(conn, user)
        _audit_items(conn, user, batch_id, category_id, items, "failed")


def delete_records(conn: sqlite3.Connection, user: dict, values, body: dict | None,
                   *, single: bool = False) -> dict:
    """原子软删除报名记录；所有检查和成功审计均在同一写事务内。"""
    body = body if isinstance(body, dict) else {}
    batch_id = str(uuid.uuid4())
    requested = _requested_ids(values)
    raw_category_id = body.get("category_id")
    audit_category = raw_category_id if type(raw_category_id) is int and raw_category_id > 0 else None
    try:
        with db.tx(conn):
            db.ensure_user_snapshot(conn, user)
            if not security.has_capability(user, security.REGISTRATION_DELETE):
                raise ApiError(403, "REGISTRATION_DELETE_FORBIDDEN",
                               "当前角色没有报名记录删除权限")

            ids = _normalize_ids(values)
            requested = ids
            category_id = _positive_int(raw_category_id, "category_id")
            audit_category = category_id
            school_value = body.get("school_id")
            school_id = None if school_value in (None, "") else _positive_int(
                school_value, "school_id")
            revisions = _base_revisions(body, ids, single)
            category = db.q1(conn, """SELECT c.id,c.group_id,g.event_id
                FROM categories c JOIN groups g ON g.id=c.group_id WHERE c.id=?""",
                              (category_id,))
            if category is None:
                failures = {participation_id: ("CATEGORY_NOT_FOUND", "当前报名批次不存在")
                            for participation_id in ids}
                raise _rejection(batch_id, ids, failures, status=404)

            rows = _load_rows(conn, ids)
            failures: dict[int, tuple[str, str]] = {}
            for participation_id in ids:
                row = rows.get(participation_id)
                if row is None:
                    failures[participation_id] = ("REGISTRATION_NOT_FOUND", "报名记录不存在")
                    continue
                invalid = _context_failure(conn, row, category_id, school_id)
                if invalid:
                    failures[participation_id] = invalid
                elif int(row["rev"] or 1) != revisions[participation_id]:
                    failures[participation_id] = (
                        "STALE_REVISION",
                        f"报名记录已被修改（当前修订号 {int(row['rev'] or 1)}），请刷新后重试",
                    )
            if failures:
                raise _rejection(batch_id, ids, failures)

            for participation_id in ids:
                referenced = _reference_failure(conn, participation_id)
                if referenced:
                    failures[participation_id] = referenced
            if failures:
                raise _rejection(batch_id, ids, failures)

            try:
                registration.guard_change(conn, category_id)
            except ApiError as exc:
                code = "PLAN_LOCKED" if exc.code == "plan_locked" else "REGISTRATION_LOCKED"
                failures = {participation_id: (code, exc.message) for participation_id in ids}
                raise _rejection(batch_id, ids, failures) from exc

            items = []
            affected_schools: set[int] = set()
            for participation_id in ids:
                row = rows[participation_id]
                changed = conn.execute("""UPDATE participations
                    SET deleted_at=datetime('now','localtime'),deleted_by=?,delete_batch_id=?,rev=rev+1
                    WHERE id=? AND category_id=? AND rev=? AND deleted_at IS NULL""",
                    (user["id"], batch_id, participation_id, category_id,
                     revisions[participation_id]))
                if changed.rowcount != 1:
                    raise ApiError(409, "DELETE_CONCURRENT_CHANGE",
                                   "报名记录在删除时发生变化，已回滚全部删除")
                affected_schools.add(int(row["school_id"]))
                items.append({"id": participation_id, "ok": True, "code": "DELETED",
                              "message": "删除成功"})
            for school_id in affected_schools:
                registration.sync_choice(conn, category_id, school_id)
            _audit_items(conn, user, batch_id, category_id, items, "success")

        return {**_envelope(batch_id, items), "message": "删除成功"}
    except ApiError as exc:
        try:
            _audit_failure(conn, user, batch_id, audit_category, requested, exc)
        except Exception as audit_exc:
            raise ApiError(500, "REGISTRATION_DELETE_AUDIT_FAILED",
                           "删除未提交，且操作日志写入失败，请联系管理员核对") from audit_exc
        raise
    except Exception as exc:
        failure = ApiError(500, "REGISTRATION_DELETE_FAILED",
                           "删除失败，服务器未提交任何更改，请刷新后核对")
        try:
            _audit_failure(conn, user, batch_id, audit_category, requested, failure)
        except Exception as audit_exc:
            raise ApiError(500, "REGISTRATION_DELETE_AUDIT_FAILED",
                           "删除未提交，且操作日志写入失败，请联系管理员核对") from audit_exc
        raise failure from exc
