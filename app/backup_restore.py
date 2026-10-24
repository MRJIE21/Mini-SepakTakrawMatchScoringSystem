"""成套备份 / 校验 / 恢复（REQ-007）。

一次备份 = 全局索引库 ``registry.db`` + 全部赛事库 ``events/event_<数字>.db``
的一致快照，以及描述每个文件的 ``manifest.json``：

* 每个数据库用 SQLite 在线 backup API 复制，服务运行中执行也能得到一致快照；
* 复制后逐库执行 ``PRAGMA integrity_check`` / ``PRAGMA foreign_key_check``，
  统计关键表行数、表集合与 ``PRAGMA user_version``；
* 清单记录 sha256/字节数/deployment_id 等，verify 严格对照清单，restore 只
  接受通过校验的归档。

安全边界：

* 备份只枚举 registry 与 canonical 赛事库，天然排除 backups/logs/锁文件/旧嵌套
  备份；备份目录不允许放进赛事库目录（避免被启动扫描误判）。
* restore 必须先拿到实例锁（服务已停），先 verify 清单，再对当前库做
  pre-restore 成套快照，逐文件“临时名 + os.replace”，并清理 -wal/-shm；
  恢复后自动对照清单再校验一遍。清单外旧文件只告警、不删除。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from pathlib import Path, PurePosixPath

from . import clock, config, instance_lock

ARCHIVE_FORMAT_VERSION = 1
MANIFEST_NAME = "manifest.json"
REGISTRY_NAME = "registry.db"
EVENTS_DIRNAME = "events"
EVENT_DB_NAME = re.compile(r"event_(\d+)\.db")

#: 清单与校验必须一致的关键表；实际数据库里缺哪张就只记录存在的那部分。
KEY_TABLES = (
    "users", "tokens", "events", "groups", "categories", "schools", "athletes",
    "teams", "participations", "matches", "placements", "school_points",
    "individual_results", "submissions", "audit_logs", "request_log",
    "display_screens", "display_pair_codes", "display_live",
    "result_candidates", "candidate_heads", "review_decisions", "review_receipts",
    "official_versions", "review_grants", "recording_epochs", "result_disputes", "review_recusals",
)

_CHUNK = 1024 * 1024


class BackupError(RuntimeError):
    """备份/校验/恢复失败（CLI 会打印消息并非零退出）。"""


class VerifyError(BackupError):
    """归档清单或文件校验不通过。"""


class RestoreError(BackupError):
    """恢复过程失败（消息会包含 pre-restore 快照位置）。"""


# ------------------------------------------------------------------ 基础工具
def canonical_event_files(events_dir: Path | str | None = None) -> list[Path]:
    """严格匹配 ``event_<数字>.db``；备份/临时文件不会被当成赛事库。"""
    directory = Path(events_dir if events_dir is not None else config.EVENTS_DIR)
    if not directory.is_dir():
        return []
    return sorted(path for path in directory.iterdir()
                  if path.is_file() and EVENT_DB_NAME.fullmatch(path.name))


def _backups_root(db_path: Path) -> Path:
    """与 app.backup.backups_root 一致的默认备份位置。"""
    resolved = Path(db_path).resolve()
    try:
        if resolved == Path(config.DB_PATH).resolve() or resolved.parent == Path(config.EVENTS_DIR).resolve():
            return Path(config.backups_dir())
    except OSError:
        pass
    return resolved.parent / "backups"


def _unique_directory(path: Path) -> Path:
    candidate = path
    index = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.name}-{index}")
        index += 1
    return candidate


def _sha256(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _file_fingerprint(path: Path) -> tuple[str, int]:
    return _sha256(path), path.stat().st_size


def _connect_readonly(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


#: 判断“当前库损坏/不可读”的错误特征；restore 遇到此类错误时允许继续恢复。
_CORRUPTION_HINTS = (
    "file is not a database",
    "database disk image is malformed",
    "not a database",
    "unable to open database file",
    "database is locked",
)


def _looks_corrupt(message: str) -> bool:
    text = str(message or "").lower()
    return any(hint in text for hint in _CORRUPTION_HINTS)


#: 账号/权限真源列：只比较这些列，记账列 snapshot_revision 与 created_at 不参与。
_USER_AUTHORITY_COLUMNS = ("id", "username", "password_hash", "salt",
                           "display_name", "role", "active")


def _user_authority_rows(conn: sqlite3.Connection) -> list[tuple]:
    columns = [row[1] for row in conn.execute("PRAGMA table_info(users)")]
    chosen = [name for name in _USER_AUTHORITY_COLUMNS if name in columns]
    if not chosen:
        raise RestoreError("用户表结构无法识别，不能校验账号/权限真源")
    return [tuple(row) for row in conn.execute(
        f"SELECT {','.join(chosen)} FROM users ORDER BY id")]


def inspect_database(path: Path | str) -> dict:
    """检查单个数据库文件：完整性、外键、表集合、关键计数与部署标识。"""
    target = Path(path)
    result = {"integrity": "error", "foreign_keys": 0, "tables": [],
              "user_version": 0, "counts": {}, "deployment_id": None,
              "error": None, "page_size": 0, "page_count": 0, "page_bytes": 0,
              "file_bytes": target.stat().st_size if target.is_file() else 0,
              "trailing_garbage_bytes": 0}
    if not target.is_file():
        result["error"] = "文件不存在"
        return result
    try:
        conn = _connect_readonly(target)
    except sqlite3.Error as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result
    try:
        rows = conn.execute("PRAGMA integrity_check").fetchall()
        messages = [str(row[0]) for row in rows]
        result["integrity"] = "ok" if messages == ["ok"] else "; ".join(messages[:5]) or "failed"
        result["foreign_keys"] = len(conn.execute("PRAGMA foreign_key_check").fetchall())
        tables = sorted(row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
        result["tables"] = tables
        result["user_version"] = int(conn.execute("PRAGMA user_version").fetchone()[0])
        counts = {}
        for table in KEY_TABLES:
            if table in tables:
                counts[table] = int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
        result["counts"] = counts
        if "settings" in tables:
            row = conn.execute("SELECT v FROM settings WHERE k = 'deployment_id'").fetchone()
            if row is not None:
                result["deployment_id"] = row[0]
        # 尾部多余字节检查：SQLite 有效数据 = page_count * page_size。
        # 文件比有效页更大说明被追加/拼接（WAL 模式下文件可能更小，不算异常）。
        try:
            page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
            page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
            result["page_size"] = page_size
            result["page_count"] = page_count
            result["page_bytes"] = page_size * page_count
            trailing = result["file_bytes"] - result["page_bytes"]
            result["trailing_garbage_bytes"] = trailing if trailing > page_size else 0
        except sqlite3.Error:
            pass
    except sqlite3.Error as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        conn.close()
    return result


def _remove_sidecars(path: Path) -> None:
    """删除数据库文件的 -wal/-shm 边车（只用于我们自己创建的副本）。"""
    for suffix in ("-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)


def _snapshot_database(source: Path, destination: Path) -> None:
    """用 SQLite 在线 backup API 生成一致快照（服务运行中也可用）。

    备份副本会继承源库的 WAL 文件头；这里把它转回单文件（DELETE）模式，
    避免归档目录出现 -wal/-shm 边车，恢复时也只需替换主文件。
    """
    if not Path(source).is_file():
        raise BackupError(f"数据库不存在，无法备份：{source}")
    try:
        source_conn = sqlite3.connect(str(source), timeout=30)
    except sqlite3.Error as exc:
        raise BackupError(f"无法打开数据库：{source}（{exc}）") from exc
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination_conn = sqlite3.connect(str(destination))
        try:
            source_conn.backup(destination_conn)
            try:
                destination_conn.execute("PRAGMA journal_mode=DELETE")
            except sqlite3.Error:
                pass  # 转换失败不影响快照本身；后面显式清理边车。
        finally:
            destination_conn.close()
    except sqlite3.Error as exc:
        raise BackupError(f"数据库快照失败：{source}（{exc}）") from exc
    finally:
        source_conn.close()
        _remove_sidecars(destination)


def _source_entries(db_path: Path, events_dir: Path) -> list[tuple[str, str, int | None, Path]]:
    entries: list[tuple[str, str, int | None, Path]] = [
        (REGISTRY_NAME, "registry", None, Path(db_path))]
    for path in canonical_event_files(events_dir):
        match = EVENT_DB_NAME.fullmatch(path.name)
        entries.append((f"{EVENTS_DIRNAME}/{path.name}", "event", int(match.group(1)), path))
    return entries


def _write_json_atomic(path: Path, payload: dict) -> None:
    temp = path.with_name(path.name + ".tmp")
    with open(temp, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        try:
            os.fsync(handle.fileno())
        except OSError:
            pass
    os.replace(temp, path)


def _safe_relative(path_value) -> str:
    if not isinstance(path_value, str) or not path_value:
        raise VerifyError("备份清单包含空的文件路径")
    if "\\" in path_value:
        raise VerifyError(f"备份清单文件路径必须使用正斜杠：{path_value}")
    parts = PurePosixPath(path_value)
    if parts.is_absolute() or any(part in ("", "..", ".") for part in parts.parts):
        raise VerifyError(f"备份清单文件路径不合法：{path_value}")
    if path_value == REGISTRY_NAME:
        return path_value
    if (len(parts.parts) == 2 and parts.parts[0] == EVENTS_DIRNAME
            and EVENT_DB_NAME.fullmatch(parts.parts[1])):
        return path_value
    raise VerifyError(f"备份清单包含不允许的文件路径：{path_value}")


def _archive_member(archive_dir: Path, relative: str) -> Path:
    root = Path(archive_dir).resolve()
    member = (root / relative).resolve()
    if member != root and root not in member.parents:
        raise VerifyError(f"备份清单文件越出备份目录：{relative}")
    return member


def _live_path(relative: str, db_path: Path, events_dir: Path) -> Path:
    if relative == REGISTRY_NAME:
        return Path(db_path)
    depth_one = _safe_relative(relative)
    return Path(events_dir) / Path(depth_one).name


def _load_manifest(archive_dir: Path) -> dict:
    manifest_path = Path(archive_dir) / MANIFEST_NAME
    if not manifest_path.is_file():
        raise VerifyError(f"备份清单不存在：{manifest_path}")
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerifyError(f"备份清单无法解析：{manifest_path}（{exc}）") from exc
    if not isinstance(value, dict):
        raise VerifyError(f"备份清单格式错误：{manifest_path}")
    return value


# ------------------------------------------------------------------ 备份
def build_archive(output_dir: Path | str | None = None,
                  data_dir: Path | str | None = None,
                  db_path: Path | str | None = None,
                  events_dir: Path | str | None = None, *,
                  dest: Path | str | None = None) -> dict:
    """把 registry + 全部赛事库备份到 ``output_dir`` 并写 manifest.json。

    ``output_dir`` 缺省为 ``<db_path 父目录>/backups/backup-<UTC 时间戳>``；
    目标目录必须不存在或为空，避免把两次备份混在一起。返回
    ``{"manifest": ..., "archive_dir": ..., "files": N}``。
    """
    if dest is not None:
        output_dir = dest
    data_dir = Path(data_dir if data_dir is not None else config.DATA_DIR)
    db_path = Path(db_path if db_path is not None else config.DB_PATH)
    events_dir = Path(events_dir if events_dir is not None else config.EVENTS_DIR)
    if not db_path.is_file():
        raise BackupError(f"全局索引库不存在，无法备份：{db_path}（可先运行 python run.py --init-db）")

    if output_dir is None:
        stamp = clock.utc_now().strftime("%Y%m%d-%H%M%S")
        destination = _unique_directory(_backups_root(db_path) / f"backup-{stamp}")
    else:
        destination = Path(output_dir)
    resolved_destination = destination.resolve()
    resolved_events = events_dir.resolve()
    if resolved_destination == resolved_events or resolved_events in resolved_destination.parents:
        raise BackupError(f"备份目录不能位于赛事数据库目录内（会被启动扫描误判）：{destination}")
    created = not destination.exists()
    if destination.exists():
        if not destination.is_dir():
            raise BackupError(f"备份输出路径不是目录：{destination}")
        if any(destination.iterdir()):
            raise BackupError(f"备份目录已存在且非空，请指定新的空目录：{destination}")
    destination.mkdir(parents=True, exist_ok=True)

    entries = _source_entries(db_path, events_dir)
    files: list[dict] = []
    warnings: list[str] = []
    try:
        for relative, role, event_id, source in entries:
            target = destination / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + ".tmp")
            try:
                # 源文件尾部多余字节不进入 SQLite 有效页，但说明文件被追加/拼接；
                # 备份前明确告警，避免“备份/校验通过”掩盖源文件异常。
                try:
                    source_info = inspect_database(source)
                except Exception:  # noqa: BLE001 - 源库不可读时由快照步骤给出明确错误
                    source_info = {}
                if (source_info.get("trailing_garbage_bytes") or 0) > 0:
                    warnings.append(
                        f"源数据库 {relative} 文件尾部存在多余字节"
                        f"（有效页 {source_info.get('page_bytes')} 字节 / 文件 "
                        f"{source_info.get('file_bytes')} 字节），可能被追加或损坏；"
                        f"已按 SQLite 有效页生成备份，建议核对源文件")
                _snapshot_database(source, temporary)
                info = inspect_database(temporary)
                if info["error"]:
                    raise BackupError(f"备份副本无法读取：{relative}（{info['error']}）")
                if info["integrity"] != "ok":
                    raise BackupError(f"备份副本完整性检查失败：{relative}（{info['integrity']}）")
                if info["foreign_keys"]:
                    raise BackupError(f"备份副本外键检查失败：{relative}（{info['foreign_keys']} 条）")
                digest, size = _file_fingerprint(temporary)
                os.replace(temporary, target)
            finally:
                _remove_sidecars(temporary)
                temporary.unlink(missing_ok=True)
            files.append({
                "path": relative,
                "role": role,
                "event_id": event_id,
                "sha256": digest,
                "bytes": size,
                "integrity": info["integrity"],
                "foreign_keys": info["foreign_keys"],
                "counts": info["counts"],
                "tables": info["tables"],
                "user_version": info["user_version"],
                "deployment_id": info["deployment_id"],
            })
        manifest = {
            "version": ARCHIVE_FORMAT_VERSION,
            "format": "stss-suite-backup",
            "created_at_utc": clock.utc_iso(),
            "source": {
                "data_dir": str(Path(data_dir).resolve()),
                "db_path": str(db_path.resolve()),
                "events_dir": str(events_dir.resolve()),
            },
            "deployment_id": files[0].get("deployment_id"),
            "schema": {
                "format": ARCHIVE_FORMAT_VERSION,
                "user_versions": {item["path"]: item["user_version"] for item in files},
            },
            "files": files,
        }
        _write_json_atomic(destination / MANIFEST_NAME, manifest)
        registry_deployment = files[0].get("deployment_id") if files else None
        for item in files[1:]:
            if item.get("deployment_id") and registry_deployment and item["deployment_id"] != registry_deployment:
                warnings.append(
                    f"赛事库 {item['path']} 的 deployment_id 与 registry 不同（历史库可能由旧版本独立初始化，"
                    "不影响备份有效性）")
        return {"manifest": manifest, "archive_dir": str(destination),
                "files": len(files), "warnings": warnings}
    except BaseException:
        if destination.exists():
            for leftover in destination.rglob("*"):
                if leftover.is_file() and (leftover.name.endswith(".tmp") or ".tmp-" in leftover.name):
                    leftover.unlink(missing_ok=True)
        if created:
            shutil.rmtree(destination, ignore_errors=True)
        raise


# ------------------------------------------------------------------ 校验
def _entry_counts_mismatch(relative: str, expected: dict, actual: dict) -> None:
    if not isinstance(expected, dict):
        raise VerifyError(f"备份清单计数格式错误：{relative}")
    if set(expected) != set(actual):
        raise VerifyError(f"备份关键表集合不一致：{relative}（清单 {sorted(expected)} / 实际 {sorted(actual)}）")
    for table, count in expected.items():
        if actual.get(table) != count:
            raise VerifyError(
                f"备份关键表计数不一致：{relative} / {table}（清单 {count} / 实际 {actual.get(table)}）")


def verify_archive(archive_dir: Path | str) -> dict:
    """严格校验归档：文件存在、sha256、integrity、外键、表集合、计数与标识。

    校验失败抛 :class:`VerifyError`；成功返回
    ``{"manifest":..., "infos": {...}, "files": N, "warnings": [...]}``。
    """
    archive = Path(archive_dir)
    if not archive.is_dir():
        raise VerifyError(f"备份目录不存在：{archive}")
    manifest = _load_manifest(archive)
    version = manifest.get("version")
    if version != ARCHIVE_FORMAT_VERSION:
        raise VerifyError(f"不支持的备份清单版本：{version}（当前支持 {ARCHIVE_FORMAT_VERSION}）")
    file_entries = manifest.get("files")
    if not isinstance(file_entries, list) or not file_entries:
        raise VerifyError("备份清单未包含任何数据库文件")

    seen: set[str] = set()
    infos: dict[str, dict] = {}
    entries_by_path: dict[str, dict] = {}
    registry_entries = 0
    for entry in file_entries:
        if not isinstance(entry, dict):
            raise VerifyError("备份清单 files 条目格式错误")
        relative = _safe_relative(entry.get("path"))
        if relative in seen:
            raise VerifyError(f"备份清单重复包含文件：{relative}")
        seen.add(relative)
        target = _archive_member(archive, relative)
        if not target.is_file():
            raise VerifyError(f"备份文件缺失：{relative}")
        expected_bytes = entry.get("bytes")
        if not isinstance(expected_bytes, int) or target.stat().st_size != expected_bytes:
            raise VerifyError(
                f"备份文件大小不一致：{relative}（清单 {expected_bytes} / 实际 {target.stat().st_size}）")
        digest, _size = _file_fingerprint(target)
        if digest != entry.get("sha256"):
            raise VerifyError(f"备份文件哈希不匹配：{relative}（文件可能被篡改或损坏）")
        info = inspect_database(target)
        if info["error"]:
            raise VerifyError(f"备份数据库无法读取：{relative}（{info['error']}）")
        if info["integrity"] != "ok" or entry.get("integrity") != "ok":
            raise VerifyError(f"备份数据库完整性检查失败：{relative}（{info['integrity']}）")
        if info["foreign_keys"]:
            raise VerifyError(f"备份数据库外键检查失败：{relative}（{info['foreign_keys']} 条）")
        _entry_counts_mismatch(relative, entry.get("counts"), info["counts"])
        expected_tables = entry.get("tables")
        if not isinstance(expected_tables, list) or sorted(expected_tables) != info["tables"]:
            raise VerifyError(f"备份数据库表结构不一致：{relative}")
        expected_user_version = entry.get("user_version", 0)
        if expected_user_version != info["user_version"]:
            raise VerifyError(
                f"备份数据库 schema 版本不一致：{relative}（清单 {expected_user_version} / 实际 {info['user_version']}）")
        if relative == REGISTRY_NAME:
            registry_entries += 1
        else:
            if entry.get("role") != "event":
                raise VerifyError(f"备份清单赛事库角色错误：{relative}")
        infos[relative] = info
        entries_by_path[relative] = entry
    if registry_entries != 1:
        raise VerifyError("备份清单必须且只能包含一个 registry.db")

    manifest_deployment = manifest.get("deployment_id")
    registry_deployment = infos[REGISTRY_NAME].get("deployment_id")
    if manifest_deployment and registry_deployment and manifest_deployment != registry_deployment:
        raise VerifyError("备份清单 deployment_id 与 registry 数据库不一致")

    warnings = []
    for relative, info in infos.items():
        # 归档文件尾部多余字节：SQLite 备份通常只含有效页；出现时提示人工核对。
        if (info.get("trailing_garbage_bytes") or 0) > 0:
            warnings.append(
                f"备份数据库 {relative} 文件尾部存在多余字节"
                f"（有效页 {info.get('page_bytes')} 字节 / 文件 {info.get('file_bytes')} 字节），"
                f"可能来自被追加的源文件或拷贝损坏，请人工核对")
        if relative == REGISTRY_NAME:
            continue
        database_deployment = info.get("deployment_id")
        entry_deployment = entries_by_path[relative].get("deployment_id")
        if database_deployment and entry_deployment and database_deployment != entry_deployment:
            raise VerifyError(f"赛事库 deployment_id 与清单不一致：{relative}")
        if manifest_deployment and database_deployment and database_deployment != manifest_deployment:
            # 历史赛事库可能由旧版本独立初始化（各自随机 deployment_id），
            # 不阻断备份/恢复，但提示人工核对。
            warnings.append(
                f"赛事库 {relative} 的 deployment_id 与 registry 不同（历史库可能存在，请人工核对）")

    listed = set(seen)
    for path in sorted(archive.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(archive).as_posix()
        if relative == MANIFEST_NAME or relative in listed:
            continue
        warnings.append(f"备份目录存在清单外文件（不会被恢复）：{relative}")
    return {"manifest": manifest, "infos": infos, "files": len(file_entries),
            "deployment_id": manifest_deployment, "warnings": warnings,
            "verified": True}


# ------------------------------------------------------------------ 恢复
def _verify_restored(manifest: dict, db_path: Path, events_dir: Path) -> dict:
    """恢复后对照清单再校验一遍落盘文件，并检查赛事身份一致性。"""
    warnings: list[str] = []
    event_ids_in_archive: set[int] = set()
    for entry in manifest.get("files", []):
        relative = _safe_relative(entry.get("path"))
        target = _live_path(relative, db_path, events_dir)
        if not target.is_file():
            raise RestoreError(f"恢复后文件缺失：{target}")
        digest, size = _file_fingerprint(target)
        if size != entry.get("bytes") or digest != entry.get("sha256"):
            raise RestoreError(f"恢复后文件校验失败：{target}（大小/哈希与清单不一致）")
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(target) + suffix)
            if sidecar.exists():
                raise RestoreError(f"恢复后仍存在数据库边车文件：{sidecar}")
        info = inspect_database(target)
        if info["integrity"] != "ok":
            raise RestoreError(f"恢复后数据库完整性检查失败：{target}（{info['integrity']}）")
        if info["foreign_keys"]:
            raise RestoreError(f"恢复后数据库外键检查失败：{target}（{info['foreign_keys']} 条）")
        _entry_counts_mismatch(relative, entry.get("counts"), info["counts"])
        if relative == REGISTRY_NAME:
            continue
        match = EVENT_DB_NAME.fullmatch(target.name)
        if match:
            event_ids_in_archive.add(int(match.group(1)))

    registry_events: dict[int, str] = {}
    registry_tables = inspect_database(db_path)["tables"]
    if "events" in registry_tables:
        conn = _connect_readonly(db_path)
        try:
            for row in conn.execute("SELECT id, uuid FROM events ORDER BY id"):
                registry_events[int(row[0])] = str(row[1] or "")
        finally:
            conn.close()
    for event_id in sorted(event_ids_in_archive):
        if event_id not in registry_events:
            warnings.append(f"赛事库 event_{event_id}.db 在恢复后的 registry 中没有对应赛事记录（文件保留，未删除）")
    for event_id in sorted(set(registry_events) - event_ids_in_archive):
        warnings.append(f"registry 中的赛事 {event_id} 没有对应赛事库文件（可能从未创建或备份时缺失）")
    for path in canonical_event_files(events_dir):
        match = EVENT_DB_NAME.fullmatch(path.name)
        if match and int(match.group(1)) not in event_ids_in_archive:
            warnings.append(f"赛事库 event_{match.group(1)}.db 不在本次备份清单内（文件保留，未删除）")
    stray_files = sorted(Path(events_dir).iterdir()) if Path(events_dir).is_dir() else []
    for path in stray_files:
        if path.is_file() and not EVENT_DB_NAME.fullmatch(path.name):
            warnings.append(f"赛事目录存在非赛事库文件（保留，未删除）：{path.name}")
    return {"warnings": warnings, "verified": True}


def _guard_review_increments(archive: Path, manifest: dict, db_path: Path, events_dir: Path) -> list[str]:
    """An older archive must never erase new review facts or revoked authority.

    Immutable rows must survive byte-for-byte; mutable current heads/grants and
    ownership epochs must also survive. A pre-restore archive is already saved
    by the caller. Recovery without these facts requires a separate reconciled
    archive, not an override flag.

    当前库缺失/损坏时不阻断恢复（损坏库已无法保全任何事实），而是返回告警，
    由调用方写入恢复输出并提示人工核对。
    """
    warnings: list[str] = []
    protected = ('result_candidates','candidate_heads','review_decisions','review_receipts',
                 'review_grants','recording_epochs','result_disputes','review_recusals','official_versions')
    members = {_safe_relative(e.get('path')) for e in manifest['files']}
    has_review_facts = False
    for relative, _role, _eid, source in _source_entries(db_path, events_dir):
        try:
            current = _connect_readonly(source)
        except sqlite3.Error as exc:
            warnings.append(
                f"当前数据库不可读，跳过复核事实保全校验：{relative}（{type(exc).__name__}: {exc}）；"
                f"本次恢复按有效归档执行，请人工核对恢复后的正式结果")
            continue
        target = None
        try:
            tables = {r[0] for r in current.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            incoming = _archive_member(archive,relative) if relative in members else None
            if incoming is not None:
                target = _connect_readonly(incoming)
            target_tables = {r[0] for r in target.execute("SELECT name FROM sqlite_master WHERE type='table'")} if target else set()
            for table in protected:
                if table not in tables:
                    continue
                suffix = ' WHERE legacy=0' if table=='official_versions' else ''
                rows = {tuple(r) for r in current.execute(f'SELECT * FROM {table}{suffix}')}
                if not rows:
                    continue
                has_review_facts = True
                columns = [r[1] for r in current.execute(f'PRAGMA table_info({table})')]
                if table not in target_tables:
                    raise RestoreError(f'禁止丢失独立复核增量：{relative}/{table}；已保全当前备份，请前向修复或提供包含全部增量的恢复归档')
                target_columns = [r[1] for r in target.execute(f'PRAGMA table_info({table})')]
                if columns != target_columns:
                    raise RestoreError(f'复核恢复结构不兼容：{relative}/{table}')
                saved = {tuple(r) for r in target.execute(f'SELECT * FROM {table}{suffix}')}
                if not rows.issubset(saved):
                    raise RestoreError(f'禁止丢失或覆盖复核事实/权限状态：{relative}/{table}；请保留增量并核对恢复归档')
        except sqlite3.Error as exc:
            warnings.append(
                f"当前数据库读取异常，跳过复核事实保全校验：{relative}（{type(exc).__name__}: {exc}）；"
                f"本次恢复按有效归档执行，请人工核对恢复后的正式结果")
        finally:
            current.close()
            if target is not None:
                target.close()
    if has_review_facts:
        warnings.extend(_guard_review_authority(db_path, _archive_member(archive, REGISTRY_NAME)))
    return warnings


def _guard_review_authority(current_path: Path, incoming_path: Path) -> list[str]:
    """Keep registry revocations when restoring event review facts.

    A restore may invalidate a newer login, but may never reintroduce a token
    absent from the live registry. Diagnostics deliberately exclude values.

    只比较账号/权限真源列（snapshot_revision 属于同步记账计数，每次服务启动都会
    +1，不应被误判为权限回退）；当前 registry 缺失/损坏时返回告警而不阻断恢复。
    """
    warnings: list[str] = []
    try:
        current = _connect_readonly(current_path)
    except sqlite3.Error as exc:
        return [f"当前 registry 不可读，跳过账号/权限真源保全校验：{current_path}"
                f"（{type(exc).__name__}: {exc}）；请恢复后人工核对账号与授权"]
    try:
        incoming = _connect_readonly(incoming_path)
    except sqlite3.Error as exc:
        current.close()
        raise RestoreError(f"恢复归档 registry 不可读：{incoming_path}（{exc}）") from exc
    try:
        try:
            live_users = _user_authority_rows(current)
            saved_users = _user_authority_rows(incoming)
            if live_users != saved_users:
                raise RestoreError('禁止回退独立复核账号/权限真源：users；请提供保全当前授权状态的恢复归档')
            for table, selection in (
                ('event identity', 'SELECT id,uuid FROM events'),
                ('event scope', "SELECT k,v FROM settings WHERE k LIKE 'access:user:%'"),
            ):
                live = {tuple(r) for r in current.execute(selection)}
                saved = {tuple(r) for r in incoming.execute(selection)}
                if live != saved:
                    raise RestoreError(f'禁止回退独立复核账号/权限真源：{table}；请提供保全当前授权状态的恢复归档')
            live_tokens = {tuple(r) for r in current.execute('SELECT * FROM tokens')}
            saved_tokens = {tuple(r) for r in incoming.execute('SELECT * FROM tokens')}
            if not saved_tokens.issubset(live_tokens):
                raise RestoreError('禁止恢复已撤销的独立复核登录凭据；请保全当前账号权限真源')

            def high_water(conn):
                row = conn.execute('SELECT v FROM settings WHERE k=?', (clock.HIGH_WATER_KEY,)).fetchone()
                try:
                    return float(row[0]) if row else 0
                except (ValueError, TypeError):
                    raise RestoreError('复核恢复时钟真源无效，请核对恢复归档') from None
            if high_water(incoming) < high_water(current):
                raise RestoreError('禁止回退独立复核时钟高水位；请保全当前凭据失效边界')
        except sqlite3.Error as exc:
            # 当前 registry 损坏/半损坏：无法读取真源，跳过校验并告警，不阻断恢复。
            return [f"当前 registry 读取异常，跳过账号/权限真源保全校验：{current_path}"
                    f"（{type(exc).__name__}: {exc}）；"
                    f"本次恢复按有效归档执行，请恢复后人工核对账号与授权"]
    finally:
        current.close()
        incoming.close()
    return warnings


def restore_archive(archive_dir: Path | str,
                    data_dir: Path | str | None = None,
                    db_path: Path | str | None = None,
                    events_dir: Path | str | None = None, *,
                    lock: instance_lock.InstanceLock | None = None) -> dict:
    """把归档成套恢复到当前数据目录（要求服务已停止）。

    步骤：拿实例锁 → verify 归档 → 对当前库做 pre-restore 成套快照 →
    逐文件临时名 + ``os.replace``（先清理旧库 -wal/-shm）→ 恢复后自动再
    verify。清单外旧文件只告警不删除。

    ``lock`` 由调用方（run.py）传入已持有的实例锁时可以复用，避免同进程
    重复加锁；不传则内部获取并在结束后释放。锁被占用抛
    :class:`app.instance_lock.InstanceLockError`。
    """
    data_dir = Path(data_dir if data_dir is not None else config.DATA_DIR)
    db_path = Path(db_path if db_path is not None else config.DB_PATH)
    events_dir = Path(events_dir if events_dir is not None else config.EVENTS_DIR)
    archive = Path(archive_dir)

    holder = lock
    owned = holder is None
    if owned:
        holder = instance_lock.acquire(data_dir)
    try:
        verified = verify_archive(archive)
        manifest = verified["manifest"]
        db_path.parent.mkdir(parents=True, exist_ok=True)
        events_dir.mkdir(parents=True, exist_ok=True)

        pre_snapshot = None
        snapshot_warnings: list[str] = []
        if db_path.is_file():
            stamp = clock.utc_now().strftime("%Y%m%d-%H%M%S")
            snapshot_dir = _unique_directory(_backups_root(db_path) / f"pre-restore-{stamp}")
            try:
                snapshot = build_archive(snapshot_dir, data_dir=data_dir,
                                         db_path=db_path, events_dir=events_dir)
            except BackupError as exc:
                # 灾难恢复场景：当前库已损坏时无法生成恢复前快照。
                # 不能因此阻断“从有效归档恢复”这一唯一可用路径；明确告警并继续。
                if not _looks_corrupt(str(exc)):
                    raise
                snapshot_warnings.append(
                    f"当前数据库无法生成恢复前快照（可能已损坏）：{exc}；"
                    f"已继续从备份恢复，本次恢复没有可回滚的恢复前快照，请人工核对结果")
                shutil.rmtree(snapshot_dir, ignore_errors=True)
            else:
                pre_snapshot = snapshot["archive_dir"]
                snapshot_warnings = list(snapshot.get("warnings") or [])

        snapshot_warnings.extend(_guard_review_increments(archive, manifest, db_path, events_dir))

        restored: list[str] = []
        removed_sidecars: list[str] = []
        stages: list[Path] = []
        try:
            for entry in manifest["files"]:
                relative = _safe_relative(entry.get("path"))
                source = _archive_member(archive, relative)
                target = _live_path(relative, db_path, events_dir)
                target.parent.mkdir(parents=True, exist_ok=True)
                stage = target.with_name(f".{target.name}.restore-{os.getpid()}.tmp")
                stages.append(stage)
                shutil.copyfile(source, stage)
                digest, size = _file_fingerprint(stage)
                if digest != entry.get("sha256") or size != entry.get("bytes"):
                    raise RestoreError(f"恢复临时文件校验失败：{relative}")
                for suffix in ("-wal", "-shm"):
                    sidecar = Path(str(target) + suffix)
                    if sidecar.exists():
                        sidecar.unlink()
                        removed_sidecars.append(str(sidecar))
                os.replace(stage, target)
                stages.remove(stage)
                restored.append(str(target))
        except RestoreError:
            raise
        except BaseException as exc:
            raise RestoreError(
                f"恢复中断：{exc}；当前数据可能处于部分恢复状态，"
                f"恢复前快照：{pre_snapshot or '无（恢复前没有数据库文件）'}") from exc
        finally:
            for stage in stages:
                stage.unlink(missing_ok=True)

        live = _verify_restored(manifest, db_path, events_dir)
        warnings = list(verified["warnings"]) + snapshot_warnings + list(live["warnings"])
        return {
            "archive_dir": str(archive),
            "restored": restored,
            "removed_sidecars": removed_sidecars,
            "pre_restore_snapshot": pre_snapshot,
            "warnings": warnings,
            "verified": True,
            "manifest": manifest,
        }
    finally:
        if owned:
            holder.release()
