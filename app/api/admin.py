"""账号、审计与备份（设计大纲 3、9.2）。"""
from __future__ import annotations

import os
import sqlite3
import tempfile

from .. import clock, db, security, access
from ..errors import bad_request, conflict
from ..http_server import Response, route
from .common import get_or_404

ADMIN = ("admin",)


def _invalidate_event_cache():
    """账号赛事分配影响 /api/events 过滤结果，缓存必须失效（REQ-004）。"""
    try:
        from . import catalog
        invalidate = getattr(catalog, "invalidate_event_stats", None)
        if invalidate is not None:
            invalidate()
    except Exception:
        pass


@route("GET", r"/api/users", roles=ADMIN, scope="registry")
def list_users(ctx):
    rows = db.q(ctx.conn, "SELECT id, username, display_name, role, active, created_at FROM users ORDER BY id")
    # 赛事名随账号范围一起由服务端给出：客户端不再依赖启动时的赛事快照，
    # 跨标签页/多管理员同时改赛事后，列表里的“所属赛事”仍与后台一致。
    event_names = {int(row["id"]): row["name"]
                   for row in db.q(ctx.conn, "SELECT id, name FROM events")}
    out = []
    for r in rows:
        item = dict(r)
        item["role_name"] = security.ROLE_NAMES.get(r["role"], r["role"])
        item['event_ids'] = access.event_ids(ctx.conn, r)
        item['event_names'] = [event_names.get(int(eid), f"赛事 {eid}")
                               for eid in (item['event_ids'] or [])]
        sync = db.q1(ctx.conn, "SELECT COUNT(*) AS pending,MAX(last_error) AS error FROM user_snapshot_outbox WHERE user_id=?", (r['id'],))
        item['snapshot_sync_pending'] = sync['pending']
        item['snapshot_sync_error'] = sync['error'] or ''
        out.append(item)
    return {"users": out, "roles": security.ROLE_NAMES}


@route("POST", r"/api/users", roles=ADMIN, scope="registry")
def create_user(ctx):
    raw_username = ctx.body.get("username")
    raw_password = ctx.body.get("password")
    # 字段必须是文本：数字/对象等类型若直接 .strip() 会抛异常并变成 500。
    if not isinstance(raw_username, str) or not isinstance(raw_password, str):
        raise bad_request("用户名和密码必须为文本")
    username = raw_username.strip()
    password = raw_password
    role = ctx.body.get("role") or "recorder"
    if role not in security.ROLES:
        raise bad_request('角色不合法')
    if not username or len(password) < 6:
        raise bad_request("请填写用户名，密码至少 6 位")
    if db.q1(ctx.conn, "SELECT id FROM users WHERE username = ?", (username,)):
        raise conflict("用户名已存在", code="duplicate")
    uid = security.create_user(ctx.conn, username, password, role,
                               ctx.body.get("display_name") or username)
    access.set_events(ctx.conn, uid, ctx.body.get('event_ids', []))
    _invalidate_event_cache()
    db.sync_user_to_event_databases(ctx.conn, uid)
    security.audit(ctx.conn, ctx.user, "create_user", "user", uid, {"role": role})
    return {"user_id": uid, "snapshot_sync_pending": True}


@route("POST", r"/api/users/(?P<user_id>\d+)/password", roles=ADMIN, scope="registry")
def reset_password(ctx):
    user_id = int(ctx.params["user_id"])
    get_or_404(ctx.conn, "users", user_id, "账号")
    password = ctx.body.get("password") or ""
    if len(password) < 6:
        raise bad_request("密码至少 6 位")
    security.set_password(ctx.conn, user_id, password)
    db.sync_user_to_event_databases(ctx.conn, user_id)
    revoked = security.revoke_user_tokens(ctx.conn, user_id)
    security.audit(ctx.conn, ctx.user, "reset_password", "user", user_id, {"revoked": revoked})
    return {"message": "密码已重置，该账号所有设备需重新登录", "revoked": revoked,
            "snapshot_sync_pending": True}


def _active_admin_count(conn) -> int:
    return int(db.q1(conn, "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1")["n"])


def _guard_last_admin(conn, user_id: int, fields: dict) -> None:
    """最后一个启用中的管理员不能被停用或降级，否则所有账号将无法再管理账号。"""
    if fields.get("role", "admin") == "admin" and int(fields.get("active", 1)) == 1:
        return
    current = db.q1(conn, "SELECT role, active FROM users WHERE id=?", (user_id,))
    if current is None or current["role"] != "admin" or not current["active"]:
        return
    if _active_admin_count(conn) <= 1:
        raise conflict("不能停用或降级最后一个启用中的赛事管理员；请先启用或新建另一个管理员",
                       code="last_admin")


@route("PUT", r"/api/users/(?P<user_id>\d+)", roles=ADMIN, scope="registry")
def update_user(ctx):
    user_id = int(ctx.params["user_id"])
    get_or_404(ctx.conn, "users", user_id, "账号")
    fields = {}
    if "display_name" in ctx.body:
        fields["display_name"] = ctx.body["display_name"]
    if "role" in ctx.body:
        if ctx.body["role"] not in security.ROLES:
            raise bad_request("角色不合法")
        fields["role"] = ctx.body["role"]
    if "active" in ctx.body:
        fields["active"] = 1 if ctx.body["active"] else 0
    _guard_last_admin(ctx.conn, user_id, fields)
    if 'event_ids' in ctx.body:
        access.set_events(ctx.conn, user_id, ctx.body['event_ids'])
        _invalidate_event_cache()
        security.audit(ctx.conn, ctx.user, 'set_event_access', 'user', user_id, {'event_ids': ctx.body['event_ids']})
    if fields:
        db.update(ctx.conn, "users", user_id, fields)
        db.sync_user_to_event_databases(ctx.conn, user_id)
        security.audit(ctx.conn, ctx.user, "update_user", "user", user_id, fields)
    return {"message": "已更新", "snapshot_sync_pending": bool(fields)}


@route("GET", r"/api/audit-logs", roles=ADMIN)
def audit_logs(ctx):
    args: list = []
    where = ["1=1"]
    if ctx.arg("entity_type"):
        where.append("a.entity_type = ?")
        args.append(ctx.arg("entity_type"))
    if ctx.arg("entity_id"):
        where.append("a.entity_id = ?")
        args.append(int(ctx.arg("entity_id")))
    if ctx.arg("action"):
        where.append("a.action = ?")
        args.append(ctx.arg("action"))
    limit = int(ctx.arg("limit") or 200)
    scope = (ctx.arg("scope") or "event").strip().lower()
    close_conn = False
    conn = ctx.conn
    if scope == "registry":
        # 登录/登出/账号类审计写在索引库；赛事库范围看不到它们。
        conn = db.connect()
        close_conn = True
    try:
        rows = db.q(conn,
                    f"""SELECT a.*, u.display_name AS user_name FROM audit_logs a
                          LEFT JOIN users u ON u.id = a.user_id
                         WHERE {' AND '.join(where)} ORDER BY a.id DESC LIMIT ?""",
                    args + [limit])
        return {"logs": db.rows_to_dicts(rows), "scope": scope}
    finally:
        if close_conn:
            conn.close()


@route("GET", r"/api/admin/backup", roles=ADMIN)
def backup(ctx):
    """下载数据库备份（SQLite）。

    使用 sqlite3 的在线备份接口生成一致快照：直接复制数据库文件会漏掉 WAL 中
    尚未合并的写入，得到损坏或过期的副本。迁移到 PostgreSQL 后改用 pg_dump 定期备份。
    """
    stamp = clock.utc_iso().replace(":", "").replace("-", "").replace("Z", "")[:15]
    event_id = ctx.headers.get("X-Event-ID") or "current"
    with tempfile.TemporaryDirectory(prefix="stss_backup_") as tmp:
        snapshot = os.path.join(tmp, f"event_{event_id}_backup_{stamp}.db")
        dest = sqlite3.connect(snapshot)
        source_path = ctx.conn.execute("PRAGMA database_list").fetchone()[2]
        source = db.connect(source_path, existing=True) if source_path else ctx.conn
        try:
            source.backup(dest)
        finally:
            dest.close()
            if source is not ctx.conn:
                source.close()
        with open(snapshot, "rb") as fh:
            data = fh.read()
    with db.tx(ctx.conn):
        if ctx.conn is not db.get_conn():
            db.ensure_user_snapshot(ctx.conn, ctx.user)
        security.audit(ctx.conn, ctx.user, "backup", "database", None, {"size": len(data)})
    return Response(data, 200, "application/octet-stream",
                    {"Content-Disposition": f'attachment; filename="event_{event_id}_backup_{stamp}.db"'})
