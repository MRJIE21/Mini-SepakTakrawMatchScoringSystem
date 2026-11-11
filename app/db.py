"""SQLite 访问层：连接管理、事务、行对象、schema 初始化。

这一层很薄，目的是让上层（domain / api）只看见 SQL 和字典，
将来换成 PostgreSQL（psycopg）时只需要改本文件与少量 SQL 方言。
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from . import config

_local = threading.local()


def connect(db_path: Path | str | None = None, *, busy_ms: int | None = None,
            existing: bool = False) -> sqlite3.Connection:
    path = str(db_path or config.DB_PATH)
    wait = config.DB_BUSY_MS if busy_ms is None else busy_ms
    if path != ":memory:" and not existing:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    source = Path(path).resolve().as_uri() + "?mode=rw" if existing else path
    conn = sqlite3.connect(source, uri=existing, timeout=wait / 1000, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        if path != ":memory:":
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            if mode.lower() != "wal":
                conn.execute("PRAGMA journal_mode = WAL")
        conn.execute(f"PRAGMA busy_timeout = {int(wait)}")
    except BaseException:
        conn.close()
        raise
    return conn


def get_conn() -> sqlite3.Connection:
    """每线程一个全局索引库连接。SQLite 的 WAL 模式支持多读单写。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = connect()
        _local.conn = conn
    return conn


def close_thread_connections() -> None:
    """HTTP 请求线程结束时显式释放连接，避免 Windows 下临时库和 WAL 被占用。"""
    connections = list(getattr(_local, "event_conns", {}).values())
    registry = getattr(_local, "conn", None)
    if registry is not None:
        connections.append(registry)
    _local.conn = None
    _local.event_conns = {}
    for conn in connections:
        conn.close()


def event_db_path(event_id: int) -> Path:
    """赛事业务库路径只由整数 ID 生成，避免名称进入文件路径。"""
    return config.EVENTS_DIR / f"event_{int(event_id)}.db"


def get_event_conn(event_id: int) -> sqlite3.Connection:
    """取得当前线程内指定赛事的独立连接。"""
    conns = getattr(_local, "event_conns", None)
    if conns is None:
        conns = {}
        _local.event_conns = conns
    event_id = int(event_id)
    conn = conns.get(event_id)
    if conn is None:
        path = event_db_path(event_id)
        if not path.exists():
            raise FileNotFoundError(f"赛事数据库不存在：{path.name}")
        conn = connect(path, existing=True)
        if not conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_result_sets'").fetchone():
            conn.close()
            init_db(path)
            conn = connect(path, existing=True)
        conns[event_id] = conn
    return conn


def create_event_database(event_id: int, event: dict, registry_conn: sqlite3.Connection) -> Path:
    """为新赛事建立独立业务库，并复制账号快照供审计外键使用。"""
    path = event_db_path(event_id)
    if path.exists():
        raise FileExistsError(f"赛事数据库已存在：{path.name}")
    try:
        init_db(path)
        conn = connect(path)
        try:
            with tx(conn):
                conn.execute(
                    """INSERT INTO events(id,uuid,name,start_date,end_date,location,status,created_at)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (event_id, event.get("uuid", ""), event["name"], event.get("start_date", ""), event.get("end_date", ""),
                     event.get("location", ""), event.get("status", "draft"), event["created_at"]),
                )
                deployment = q1(registry_conn, "SELECT v FROM settings WHERE k = 'deployment_id'")
                if deployment:
                    conn.execute("INSERT OR REPLACE INTO settings(k,v) VALUES('deployment_id',?)",
                                 (deployment["v"],))
                users = q(registry_conn, "SELECT * FROM users ORDER BY id")
                for user in users:
                    ensure_user_snapshot(conn, user)
        finally:
            conn.close()
    except BaseException:
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(path) + suffix)
            if candidate.exists():
                candidate.unlink()
        raise
    return path


def remove_event_database(event_id: int) -> None:
    """删除一次创建失败留下的赛事库文件；仅用于创建事务的回滚补偿。"""
    path = event_db_path(event_id)
    cached = getattr(_local, "event_conns", {}).pop(int(event_id), None)
    if cached is not None:
        cached.close()
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            candidate.unlink()


def sync_user_to_event_databases(registry_conn: sqlite3.Connection, user_id: int) -> None:
    """兼容账号调用入口：在全局事务中递增版本并持久入队，不等待赛事库。"""
    with tx(registry_conn):
        registry_conn.execute("UPDATE users SET snapshot_revision=snapshot_revision+1 WHERE id=?", (user_id,))
        enqueue_user_snapshot(registry_conn, user_id)


def enqueue_user_snapshot(registry_conn: sqlite3.Connection, user_id: int) -> None:
    user = q1(registry_conn, "SELECT * FROM users WHERE id = ?", (user_id,))
    if user is None:
        return
    deployment = q1(registry_conn, "SELECT v FROM settings WHERE k='deployment_id'")["v"]
    for event in q(registry_conn, "SELECT id FROM events ORDER BY id"):
        identity = q1(registry_conn, "SELECT uuid FROM events WHERE id=?", (event["id"],))
        registry_conn.execute("""INSERT INTO user_snapshot_outbox
            (event_id,user_id,event_uuid,deployment_id,target_revision,next_attempt_at)
            VALUES(?,?,?,?,?,0) ON CONFLICT(event_id,user_id) DO UPDATE SET
            event_uuid=excluded.event_uuid,deployment_id=excluded.deployment_id,
            target_revision=excluded.target_revision,next_attempt_at=0,attempts=0,last_error=''""",
            (event["id"], user_id, identity["uuid"], deployment, user["snapshot_revision"]))


def ensure_user_snapshot(conn: sqlite3.Connection, user) -> None:
    """外键与显示快照；版本条件禁止迟到的旧 active/密码覆盖新记录。"""
    snapshot = dict(user)
    columns = ("id", "username", "password_hash", "salt", "display_name", "role", "active", "created_at", "snapshot_revision")
    snapshot.setdefault("snapshot_revision", 1)
    conn.execute("""INSERT INTO users(id,username,password_hash,salt,display_name,role,active,created_at,snapshot_revision)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        username=excluded.username,password_hash=excluded.password_hash,salt=excluded.salt,
        display_name=excluded.display_name,role=excluded.role,active=excluded.active,
        snapshot_revision=excluded.snapshot_revision
        WHERE excluded.snapshot_revision > users.snapshot_revision""",
        tuple(snapshot[column] for column in columns))


def is_busy(exc: BaseException) -> bool:
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    code = getattr(exc, "sqlite_errorcode", None)
    if code is not None:
        return code & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
    return str(exc).lower() in ("database is locked", "database table is locked", "database schema is locked")


def _rollback_preserving_error(conn):
    try:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
            return not conn.in_transaction
    except BaseException:
        pass  # 上层仍须看到原始错误；请求结束会关闭不能恢复的连接。
    return False


@contextmanager
def tx(conn: sqlite3.Connection | None = None):
    """显式事务。嵌套调用时复用外层事务。"""
    c = conn or get_conn()
    if c.in_transaction:
        yield c
        return
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
        c.execute("COMMIT")
    except BaseException as exc:
        rolled_back = _rollback_preserving_error(c)
        try:
            exc.transaction_rolled_back = rolled_back
        except (AttributeError, TypeError):
            pass
        raise


@contextmanager
def read_tx(conn: sqlite3.Connection):
    """物化整个读取包时保持一个快照；调用方负责在网络发送前结束。"""
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        _rollback_preserving_error(conn)
        raise


@contextmanager
def savepoint(conn: sqlite3.Connection, name: str):
    """嵌套子事务：块内异常只回滚到该保存点，外层事务继续。

    批量报名按“业务项”原子保存、允许部分成功时需要它（改进方案 §8.4）。
    name 只允许内部生成的 sp0/sp1 这类标识，不接受外部输入。
    """
    conn.execute(f"SAVEPOINT {name}")
    try:
        yield conn
        conn.execute(f"RELEASE {name}")
    except BaseException:
        try:
            conn.execute(f"ROLLBACK TO {name}")
            conn.execute(f"RELEASE {name}")
        except BaseException:
            _rollback_preserving_error(conn)
        raise


def init_db(db_path: Path | str | None = None) -> None:
    schema = (Path(__file__).resolve().parent / "schema.sql").read_text(encoding="utf-8")
    conn = connect(db_path)
    try:
        from . import team_rules_store
        from . import individual_draw_store
        from . import individual_draw_session_store
        from . import display_store
        from . import participation_deletion
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='categories'").fetchone() and not conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_result_sets'").fetchone():
            team_rules_store._backup(conn, '.before-manual-results-v1.sqlite')
        individual_draw_store.backup_before_upgrade(conn)
        individual_draw_session_store.backup_before_upgrade(conn)
        team_rules_store.backup_before_upgrade(conn)
        display_store.backup_before_upgrade(conn)
        participation_deletion.backup_before_upgrade(conn)
        # 旧 participations 表尚无 deleted_at；必须先升级再执行新版 schema。
        participation_deletion.install(conn)
        from . import registration_history
        registration_history.install(conn, schema)
        conn.executescript(schema)
        # 新库由 schema 建表；在此补记迁移标记并统一校验索引定义。
        participation_deletion.install(conn)
        _migrate(conn)
        _migrate_individual_results(conn)
        _migrate_token_hashes(conn)
        _migrate_epoch_times(conn)
        _migrate_user_roles(conn)
        _migrate_group_draw_method(conn)
        from . import school_deletion
        school_deletion.clean_orphan_history(conn)
    finally:
        conn.close()


def _migrate_individual_results(conn):
    from .domain.individual_results import FIELDS, normalize

    marker = "migration:individual-results-two-significant-digits"
    if q1(conn, "SELECT v FROM settings WHERE k=?", (marker,)):
        return
    category_query = """SELECT DISTINCT pl.category_id FROM placements pl
                       JOIN categories c ON c.id=pl.category_id WHERE c.kind='individual'"""
    if q1(conn, "SELECT 1 FROM individual_results LIMIT 1") or q1(conn, category_query):
        from .backup import online_backup
        online_backup(conn, ".before-individual-results-v2.db")
    with tx(conn):
        if q1(conn, "SELECT v FROM settings WHERE k=?", (marker,)):
            return
        for row in q(conn, "SELECT * FROM individual_results"):
            values = {}
            for key, _ in FIELDS:
                try:
                    values[key] = normalize(row[key])
                except ValueError:
                    values[key] = None
            status = row["result_status"]
            if row["confirmed"] and values["violation_count"] is not None and values["violation_count"] >= 2:
                status = "dsq"
            elif status == "normal" and None in values.values():
                status = "pending"
            update(conn, "individual_results", row["id"], {
                **values, "result_status": status, "rank_no": None,
                "confirmed": 0 if status == "pending" else row["confirmed"],
                "version": row["version"] + 1,
            })
        for category in q(conn, category_query):
            cid = category["category_id"]
            run(conn, """UPDATE placements SET rank_no=NULL, status='pending',
                         note='个人赛规则已更新，请重新确认项目名次', version=version+1,
                         confirmed_by=NULL, confirmed_at=NULL WHERE category_id=?""", (cid,))
            run(conn, "DELETE FROM school_points WHERE category_id=?", (cid,))
        run(conn, "INSERT INTO settings(k,v) VALUES(?, '1')", (marker,))


def _migrate_user_roles(conn: sqlite3.Connection) -> None:
    """旧 users 表的 CHECK 不含 display_operator；SQLite 只能重建表。"""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
    if row is None or 'display_operator' in (row['sql'] or ''):
        return
    from .team_rules_store import _backup
    _backup(conn, '.before-display-operator-role.db')
    if conn.in_transaction:
        raise RuntimeError('用户角色迁移必须在独立事务前执行')
    conn.execute('PRAGMA foreign_keys=OFF')
    try:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('''
            CREATE TABLE users_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              salt TEXT NOT NULL,
              display_name TEXT NOT NULL DEFAULT '',
              role TEXT NOT NULL CHECK (role IN ('admin','organizer','recorder','viewer','display_operator')),
              active INTEGER NOT NULL DEFAULT 1,
              snapshot_revision INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )
        ''')
        conn.execute('''INSERT INTO users_new
            (id, username, password_hash, salt, display_name, role, active, snapshot_revision, created_at)
            SELECT id, username, password_hash, salt, display_name, role, active, snapshot_revision, created_at
            FROM users''')
        conn.execute('DROP TABLE users')
        conn.execute('ALTER TABLE users_new RENAME TO users')
        conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction:
            conn.execute('ROLLBACK')
        raise
    finally:
        conn.execute('PRAGMA foreign_keys=ON')


def _migrate_group_draw_method(conn: sqlite3.Connection) -> None:
    """旧库的 group_draws 只允许 random/seeded，新增循环落位需要重建表。

    SQLite 无法修改 CHECK 约束，只能新建同构表→复制数据→替换。
    升级前先留 .sqlite 快照（serve() 只扫描 event_*.db，不会误升级快照）。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='group_draws'").fetchone()
    if not row or "'cycle'" in (row['sql'] or ''):
        return
    from .team_rules_store import _backup
    _backup(conn, '.before-group-cycle-v1.sqlite')
    conn.executescript('''
        CREATE TABLE group_draws_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          method TEXT NOT NULL CHECK (method IN ('random','seeded','cycle')),
          status TEXT NOT NULL DEFAULT 'drawing' CHECK (status IN ('drawing','complete','confirmed','cancelled')),
          rev INTEGER NOT NULL DEFAULT 1,
          revealed INTEGER NOT NULL DEFAULT 0,
          capacities_json TEXT NOT NULL,
          roster_json TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          confirmed_by INTEGER REFERENCES users(id),
          confirmed_at TEXT,
          cancel_reason TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO group_draws_new SELECT * FROM group_draws;
        DROP TABLE group_draws;
        ALTER TABLE group_draws_new RENAME TO group_draws;
        CREATE INDEX IF NOT EXISTS idx_group_draws_category ON group_draws(category_id, id);
    ''')


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {row["name"] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def _migrate_token_hashes(conn: sqlite3.Connection) -> None:
    """P2-B：tokens.token 从明文改为 sha256 哈希（列名保持兼容）。

    单事务、幂等；任何非 64 位小写十六进制的既有值都视为历史明文并替换。
    该迁移只改数据值、不改结构，因此不生成含明文令牌的升级备份
    （REQ-003 要求备份不得含明文有效令牌）；失败整体回滚。
    """
    if "tokens" not in _table_names(conn) or "settings" not in _table_names(conn):
        return
    rows = conn.execute("SELECT token FROM tokens").fetchall()
    updates = []
    for row in rows:
        value = row["token"] or ""
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            updates.append((hashlib.sha256(value.encode("utf-8")).hexdigest(), value))
    if not updates:
        conn.execute("INSERT OR IGNORE INTO settings(k, v) VALUES('token_hash_v1', '1')")
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        for digest, legacy in updates:
            conn.execute("UPDATE tokens SET token = ? WHERE token = ?", (digest, legacy))
        conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('token_hash_v1', '1')")
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def _migrate_epoch_times(conn: sqlite3.Connection) -> None:
    """P2-B：为安全相关时间补齐 epoch 列并回填历史本地时间字符串。

    旧 TEXT 列保留只读兼容；只回填 epoch=0 且文本非空的行，幂等、不批量改写历史。
    """
    from . import clock
    tables = _table_names(conn)
    targets = (
        ("tokens", "expires_at", "expires_at_epoch"),
        ("display_screens", "last_seen_at", "last_seen_epoch"),
        ("display_pair_codes", "expires_at", "expires_at_epoch"),
        ("display_live", "expires_at", "expires_at_epoch"),
    )
    for table, text_column, epoch_column in targets:
        if table not in tables:
            continue
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if epoch_column not in columns:
            continue
        rows = conn.execute(
            f"SELECT rowid AS rid, {text_column} AS legacy FROM {table} "
            f"WHERE {epoch_column} = 0 AND {text_column} <> ''").fetchall()
        for row in rows:
            epoch = clock.parse_local_text(row["legacy"])
            if epoch is not None:
                conn.execute(f"UPDATE {table} SET {epoch_column} = ? WHERE rowid = ?",
                             (int(epoch), row["rid"]))
    if "settings" in tables:
        conn.execute("INSERT OR IGNORE INTO settings(k, v) VALUES('utc_epoch_v1', '1')")


def _migrate(conn: sqlite3.Connection) -> None:
    """为旧数据库补齐新增列（SQLite 不支持 IF NOT EXISTS 加列，这里按表结构探测）。

    增补兼容结构，并将缺少确认依据的历史自动名次和重置赛标为待复核。
    比赛主键、原始成绩、人工名次、成绩引用与已存队长标记保留。
    """
    migrations = {
        "users": ["snapshot_revision INTEGER NOT NULL DEFAULT 1"],
        "events": ["uuid TEXT NOT NULL DEFAULT ''"],
        "submissions": ["home_participation INTEGER", "away_participation INTEGER"],
        "schools": ["rev INTEGER NOT NULL DEFAULT 1"],
        "athletes": ["rev INTEGER NOT NULL DEFAULT 1"],
        "teams": ["rev INTEGER NOT NULL DEFAULT 1"],
        "participations": ["rev INTEGER NOT NULL DEFAULT 1"],
        "individual_results": ["error_count INTEGER", "violation_count INTEGER"],
        "pools": ["confirmation_basis TEXT NOT NULL DEFAULT ''", "confirmation_resolutions TEXT NOT NULL DEFAULT '[]'"],
        "matches": ["schedule_role TEXT NOT NULL DEFAULT ''", "schedule_revision INTEGER NOT NULL DEFAULT 1", "winner_rank INTEGER", "loser_rank INTEGER",
                    "reset_parent_id INTEGER REFERENCES matches(id)",
                    "reset_state TEXT NOT NULL DEFAULT 'none'", "reset_parent_version INTEGER"],
        "display_config": ["poll_ms INTEGER NOT NULL DEFAULT 250 CHECK (poll_ms BETWEEN 100 AND 1000)"],
        "tokens": ["expires_at_epoch INTEGER NOT NULL DEFAULT 0"],
        "display_screens": ["last_seen_epoch INTEGER NOT NULL DEFAULT 0"],
        "display_pair_codes": ["expires_at_epoch INTEGER NOT NULL DEFAULT 0"],
        "display_live": ["expires_at_epoch INTEGER NOT NULL DEFAULT 0"],
    }
    for table, columns in migrations.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for column in columns:
            name = column.split()[0]
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column}")
    deployment = conn.execute("SELECT v FROM settings WHERE k = 'deployment_id'").fetchone()
    if deployment is None:
        conn.execute("INSERT INTO settings(k,v) VALUES('deployment_id',?)", (str(uuid.uuid4()),))
    for row in conn.execute("SELECT id FROM events WHERE uuid = '' OR uuid IS NULL").fetchall():
        conn.execute("UPDATE events SET uuid = ? WHERE id = ?", (str(uuid.uuid4()), row["id"]))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON events(uuid) WHERE uuid <> ''")
    from . import result_migrations, list_revision
    result_migrations.install(conn)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_active_reset ON matches(reset_parent_id) WHERE reset_state='active'")
    from . import team_rules_store
    team_rules_store.install(conn)
    list_revision.install(conn)


# ------------------------------------------------------------------ 便捷查询
def q(conn: sqlite3.Connection, sql: str, args: tuple | list = ()) -> list[sqlite3.Row]:
    return conn.execute(sql, args).fetchall()


def q1(conn: sqlite3.Connection, sql: str, args: tuple | list = ()):
    return conn.execute(sql, args).fetchone()


def run(conn: sqlite3.Connection, sql: str, args: tuple | list = ()) -> sqlite3.Cursor:
    return conn.execute(sql, args)


def insert(conn: sqlite3.Connection, table: str, data: dict) -> int:
    cols = ", ".join(data.keys())
    marks = ", ".join("?" for _ in data)
    cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(data.values()))
    return int(cur.lastrowid)


def update(conn: sqlite3.Connection, table: str, row_id: int, data: dict) -> None:
    if not data:
        return
    sets = ", ".join(f"{k} = ?" for k in data)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*data.values(), row_id))


def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]


def row_to_dict(row) -> dict | None:
    return dict(row) if row is not None else None


def now(conn: sqlite3.Connection | None = None) -> str:
    """当前本地时间字符串（与 schema 默认值一致的格式）。"""
    c = conn or get_conn()
    return c.execute("SELECT datetime('now','localtime') AS t").fetchone()["t"]
