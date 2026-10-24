"""备份归档测试设施：构造隔离数据集、读取/篡改清单、统计关键表。

只用于 P2-B 备份/恢复/维护/启动测试；所有路径由调用方传入临时目录，绝不写
真实 ``NEW-PROJIECT/data``。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

KEY_TABLES = (
    "users", "tokens", "events", "groups", "categories", "schools", "athletes",
    "teams", "participations", "matches", "placements", "school_points",
    "individual_results", "submissions", "audit_logs", "request_log",
    "display_screens", "display_pair_codes", "display_live",
    "result_candidates", "candidate_heads", "review_decisions", "review_receipts",
    "official_versions", "review_grants", "recording_epochs", "result_disputes", "review_recusals",
)


def init_dataset(root: Path | str) -> dict:
    """在 ``root`` 下创建 registry + 2 个赛事库的隔离数据集。

    返回路径、deployment_id 与一条明文令牌（仅用于“备份不得含明文令牌”断言）。
    """
    from app import db, security

    root = Path(root)
    events_dir = root / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    db_path = root / "registry.db"
    db.init_db(db_path)
    registry = db.connect(db_path)
    try:
        security.create_user(registry, "admin", "admin123", "admin", "管理员")
        security.create_user(registry, "viewer", "viewer123", "viewer", "查看者")
        deployment = registry.execute(
            "SELECT v FROM settings WHERE k='deployment_id'").fetchone()["v"]
        event_paths: dict[int, Path] = {}
        for event_id in (1, 2):
            path = events_dir / f"event_{event_id}.db"
            db.init_db(path)
            event_conn = db.connect(path)
            try:
                event_conn.execute(
                    "INSERT INTO events(id,uuid,name) VALUES(?,?,?)",
                    (event_id, f"event-uuid-{event_id}", f"赛事{event_id}"))
                event_conn.execute(
                    "INSERT OR REPLACE INTO settings(k,v) VALUES('deployment_id',?)",
                    (deployment,))
                event_conn.execute(
                    "INSERT INTO groups(id,event_id,code,name,seq) VALUES(?,?,?,?,1)",
                    (event_id * 10, event_id, "A", "甲组"))
                event_conn.execute(
                    "INSERT INTO categories(id,group_id,gender,kind,name,seq) "
                    "VALUES(?,?,?,?,?,1)",
                    (event_id * 100, event_id * 10, "male", "team", "男子三人赛"))
                event_conn.execute(
                    "INSERT INTO schools(id,event_id,name) VALUES(?,?,?)",
                    (event_id * 1000, event_id, f"学校{event_id}"))
                event_conn.execute(
                    "INSERT INTO audit_logs(action,entity_type,entity_id) VALUES('seed','school',?)",
                    (event_id * 1000,))
            finally:
                event_conn.close()
            registry.execute(
                "INSERT INTO events(id,uuid,name) VALUES(?,?,?)",
                (event_id, f"event-uuid-{event_id}", f"赛事{event_id}"))
            event_paths[event_id] = path
        registry.execute(
            "INSERT INTO request_log(uid,scope,status,created_at) "
            "VALUES('seed-registry','auth','succeeded',datetime('now','localtime'))")
        registry.commit()
        token = security.login(registry, "admin", "admin123")
        assert token
    finally:
        registry.close()
    return {"root": root, "db_path": db_path, "events_dir": events_dir,
            "deployment_id": deployment, "event_paths": event_paths,
            "token": token}


# ------------------------------------------------------------------ 清单/文件
def read_manifest(archive_dir: Path | str) -> dict:
    path = Path(archive_dir) / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


def write_manifest(archive_dir: Path | str, manifest: dict) -> None:
    path = Path(archive_dir) / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


def mutate_manifest(archive_dir: Path | str, mutate) -> dict:
    """读取清单→mutate(manifest) 原地修改→写回，返回修改后的清单。"""
    manifest = read_manifest(archive_dir)
    mutate(manifest)
    write_manifest(archive_dir, manifest)
    return manifest


def archive_relative_files(archive_dir: Path | str) -> list[str]:
    root = Path(archive_dir)
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*")
                  if path.is_file())


def sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tamper_file(path: Path | str, extra: bytes = b"tampered") -> None:
    with open(path, "ab") as handle:
        handle.write(extra)


def database_counts(db_path: Path | str) -> dict:
    """只读统计关键表行数（与备份清单 counts 口径一致）。"""
    conn = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        return {table: int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
                for table in KEY_TABLES if table in tables}
    finally:
        conn.close()


def database_rows(db_path: Path | str, sql: str, args: tuple = ()) -> list[tuple]:
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def count_rows(db_path: Path | str, sql: str, args: tuple = ()) -> int:
    return int(database_rows(db_path, sql, args)[0][0])
