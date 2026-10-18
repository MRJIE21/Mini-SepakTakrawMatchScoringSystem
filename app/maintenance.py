"""数据保留维护任务（REQ-008）。

默认 **dry-run 只统计不删除**；只有显式 ``--apply`` 才删除，且要求实例锁空闲
（服务已停）。清理范围严格限定：

* ``tokens``：已过期令牌（优先 ``expires_at_epoch``，缺失时兼容解析旧本地时间）；
* ``display_pair_codes``：已过期或已领取的配对码；
* ``display_live``：已过期的实时快照；
* ``request_log``：``created_at`` 早于保留期（默认 STSS_RETENTION_DAYS=30 天）的记录。

绝不删除成绩、报名、赛事结构、大屏设备与 ``audit_logs``。apply 结束后在
registry 的 ``audit_logs`` 写一条 ``maintenance_cleanup`` 审计（记录各项数量，
不含任何令牌/口令明文）。
"""
from __future__ import annotations

from pathlib import Path

from . import clock, config, db, instance_lock, security
from .backup_restore import canonical_event_files

CLEANUP_TABLES = ("tokens", "display_pair_codes", "display_live", "request_log")


class MaintenanceError(RuntimeError):
    """维护任务参数或数据状态错误（CLI 打印并非零退出）。"""


# ------------------------------------------------------------------ 只读辅助
def _table_names(conn) -> set[str]:
    return {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def _columns(conn, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _row_value(row, column: str):
    try:
        return row[column]
    except (KeyError, IndexError):
        return None


def _epoch_expired(row, epoch_column: str, text_column: str, now: float) -> bool:
    """优先 epoch 判定；旧行没有 epoch 时兼容解析本地时间文本。"""
    try:
        epoch = int(_row_value(row, epoch_column) or 0)
    except (TypeError, ValueError):
        epoch = 0
    if epoch:
        return epoch < now
    parsed = clock.parse_local_text(_row_value(row, text_column))
    return parsed is not None and parsed < now


def _plan_database(conn, now: float, cutoff: float) -> dict:
    """返回 ``{表: [主键值列表]}``；不写库。"""
    tables = _table_names(conn)
    plan: dict[str, list] = {}
    if "tokens" in tables:
        columns = _columns(conn, "tokens")
        epoch_column = "expires_at_epoch" if "expires_at_epoch" in columns else ""
        expired = []
        for row in conn.execute(
                f"SELECT token, {epoch_column or 'NULL'} AS expires_at_epoch, expires_at FROM tokens"):
            if _epoch_expired(row, "expires_at_epoch", "expires_at", now):
                expired.append(row["token"])
        plan["tokens"] = expired
    if "display_pair_codes" in tables:
        columns = _columns(conn, "display_pair_codes")
        epoch_column = "expires_at_epoch" if "expires_at_epoch" in columns else ""
        removable = []
        for row in conn.execute(
                f"SELECT id, claimed_at, {epoch_column or 'NULL'} AS expires_at_epoch, expires_at "
                f"FROM display_pair_codes"):
            claimed = str(row["claimed_at"] or "").strip()
            if claimed or _epoch_expired(row, "expires_at_epoch", "expires_at", now):
                removable.append(row["id"])
        plan["display_pair_codes"] = removable
    if "display_live" in tables:
        columns = _columns(conn, "display_live")
        epoch_column = "expires_at_epoch" if "expires_at_epoch" in columns else ""
        expired = []
        for row in conn.execute(
                f"SELECT match_id, {epoch_column or 'NULL'} AS expires_at_epoch, expires_at FROM display_live"):
            if _epoch_expired(row, "expires_at_epoch", "expires_at", now):
                expired.append(row["match_id"])
        plan["display_live"] = expired
    if "request_log" in tables:
        stale = []
        for row in conn.execute("SELECT uid, created_at FROM request_log"):
            parsed = clock.parse_local_text(row["created_at"])
            if parsed is not None and parsed < cutoff:
                stale.append(row["uid"])
        plan["request_log"] = stale
    return plan


def _apply_plan(conn, plan: dict) -> None:
    """在一个事务里删除本库计划项；表名/列名均来自固定白名单。"""
    with db.tx(conn):
        if plan.get("tokens"):
            conn.executemany("DELETE FROM tokens WHERE token = ?", [(key,) for key in plan["tokens"]])
        if plan.get("display_pair_codes"):
            conn.executemany("DELETE FROM display_pair_codes WHERE id = ?",
                             [(key,) for key in plan["display_pair_codes"]])
        if plan.get("display_live"):
            conn.executemany("DELETE FROM display_live WHERE match_id = ?",
                             [(key,) for key in plan["display_live"]])
        if plan.get("request_log"):
            conn.executemany("DELETE FROM request_log WHERE uid = ?",
                             [(key,) for key in plan["request_log"]])


# ------------------------------------------------------------------ 入口
def _target_databases(db_path: Path, events_dir: Path) -> list[tuple[str, Path]]:
    targets: list[tuple[str, Path]] = [("registry", db_path)]
    for path in canonical_event_files(events_dir):
        targets.append((path.stem, path))
    return targets


def run_maintenance(dry_run: bool = True, retention_days: int | None = None,
                    *, lock: instance_lock.InstanceLock | None = None,
                    db_path: Path | str | None = None,
                    events_dir: Path | str | None = None,
                    data_dir: Path | str | None = None) -> dict:
    """执行数据保留维护；默认只看不删。

    ``--apply``（``dry_run=False``）要求实例锁空闲，apply 后在 registry 写审计。
    ``lock`` 可由 run.py 传入已持有的实例锁，避免同进程重复加锁。
    """
    db_path = Path(db_path if db_path is not None else config.DB_PATH)
    events_dir = Path(events_dir if events_dir is not None else config.EVENTS_DIR)
    data_dir = Path(data_dir if data_dir is not None else config.DATA_DIR)
    try:
        retention = int(config.RETENTION_DAYS if retention_days is None else retention_days)
    except (TypeError, ValueError) as exc:
        raise MaintenanceError(f"保留期必须是整数天：{retention_days}") from exc
    if retention < 0:
        raise MaintenanceError(f"保留期不能为负数：{retention}")
    if not db_path.is_file():
        raise MaintenanceError(f"全局索引库不存在，无法维护：{db_path}（可先运行 python run.py --init-db）")

    holder = lock
    owned = False
    if not dry_run:
        if holder is None:
            holder = instance_lock.acquire(data_dir)
            owned = True
    try:
        databases = []
        totals = {table: 0 for table in CLEANUP_TABLES}
        for label, path in _target_databases(db_path, events_dir):
            conn = db.connect(path, existing=True)
            try:
                now = max(float(clock.utc_epoch()), float(clock.read_high_water(conn)))
                cutoff = now - retention * 86400
                plan = _plan_database(conn, now, cutoff)
                counts = {table: len(plan.get(table) or []) for table in CLEANUP_TABLES}
                if not dry_run:
                    _apply_plan(conn, plan)
                databases.append({"database": label, "path": str(path), "counts": counts})
                for table, count in counts.items():
                    totals[table] += count
            finally:
                conn.close()
        total = sum(totals.values())
        report = {
            "dry_run": bool(dry_run),
            "retention_days": retention,
            "cutoff_utc": clock.utc_iso(clock.utc_epoch() - retention * 86400),
            "databases": databases,
            "totals": totals,
            "total": total,
            "audit_written": False,
        }
        if not dry_run:
            audit_conn = db.connect(db_path, existing=True)
            try:
                with db.tx(audit_conn):
                    security.audit(
                        audit_conn, None, "maintenance_cleanup", "maintenance", None,
                        {"dry_run": False, "retention_days": retention, "total": total,
                         "totals": totals,
                         "databases": {item["database"]: item["counts"] for item in databases},
                         "cutoff_utc": report["cutoff_utc"]})
            finally:
                audit_conn.close()
            report["audit_written"] = True
        return report
    finally:
        if owned:
            holder.release()


def format_report(report: dict) -> str:
    """把维护结果格式化为 CLI 可读文本（中文）。"""
    action = "将清理" if report.get("dry_run") else "已清理"
    lines = [
        f"维护任务（{'dry-run，不写库' if report.get('dry_run') else 'apply，已写审计'}）"
        f" 保留期 {report.get('retention_days')} 天，截止 {report.get('cutoff_utc')}",
    ]
    for item in report.get("databases", []):
        counts = item.get("counts") or {}
        detail = "，".join(f"{table} {counts.get(table, 0)}" for table in CLEANUP_TABLES)
        lines.append(f"  {item['database']}：{detail}")
    totals = report.get("totals") or {}
    lines.append(f"合计{action} {report.get('total', 0)} 行：" +
                 "，".join(f"{table} {totals.get(table, 0)}" for table in CLEANUP_TABLES))
    if report.get("dry_run"):
        lines.append("dry-run 未修改任何数据；确认后以 --apply 执行（需先停止服务）。")
    else:
        lines.append("已在 registry 写入 maintenance_cleanup 审计；审计日志本身不会被清理。")
    return "\n".join(lines)
