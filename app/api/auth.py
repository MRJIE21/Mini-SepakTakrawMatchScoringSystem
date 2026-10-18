"""登录与当前用户。"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from .. import config, db, security
from ..errors import ApiError, bad_request, unauthorized
from ..http_server import route


@route("POST", r"/api/login", public=True, scope="registry", transaction=False)
def login(ctx):
    body = ctx.body or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not username or not password:
        raise bad_request("请填写用户名和密码")
    ip = ctx.remote_addr or ""
    retry = security.login_retry_after(ip, username)
    if retry:
        raise ApiError(429, "login_locked", f"登录尝试过于频繁，请在 {retry} 秒后重试",
                       {"retry_after": retry})
    row = db.q1(ctx.conn, "SELECT * FROM users WHERE username=? AND active=1", (username,))
    if row is None or not security.verify_password(password, row['password_hash'], row['salt']):
        retry = security.record_login_failure(ip, username)
        security.audit(ctx.conn, None, "login_failed", "user", None,
                       {"username": username, "ip": ip, "retry_after": retry})
        if retry:
            raise ApiError(429, "login_locked", f"登录尝试过于频繁，请在 {retry} 秒后重试",
                           {"retry_after": retry})
        raise unauthorized("用户名或密码不正确")
    security.clear_login_failures(ip, username)
    # PBKDF2 在写锁外执行；短事务内复核密码与 active，不能接受同时重置的旧密码。
    with db.tx(ctx.conn):
        fresh = db.q1(ctx.conn, "SELECT * FROM users WHERE id=? AND active=1", (row['id'],))
        if fresh is None or fresh['password_hash'] != row['password_hash'] or fresh['salt'] != row['salt']:
            raise unauthorized("账号已更新，请重新登录")
        token = secrets.token_urlsafe(32)
        expires = datetime.now() + timedelta(hours=config.TOKEN_TTL_HOURS)
        db.insert(ctx.conn, 'tokens', {'token': token, 'user_id': fresh['id'],
                                      'expires_at': expires.strftime('%Y-%m-%d %H:%M:%S')})
        user = dict(fresh)
        security.audit(ctx.conn, user, "login", "user", user["id"])
    return {"token": token, "user": public_user(user)}


@route("POST", r"/api/logout", scope="registry")
def logout(ctx):
    auth = ctx.headers.get("Authorization") or ""
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if token:
        security.logout(ctx.conn, token)
    return {"message": "已退出登录"}


@route("GET", r"/api/me", scope="registry")
def me(ctx):
    return {"user": public_user(ctx.user), "roles": security.ROLE_NAMES}


@route("POST", r"/api/me/password", scope="registry")
def change_password(ctx):
    body = ctx.body or {}
    old = body.get("old_password") or ""
    new = body.get("new_password") or ""
    if len(new) < 6:
        raise bad_request("新密码至少 6 位")
    row = ctx.conn.execute("SELECT * FROM users WHERE id = ?", (ctx.user["id"],)).fetchone()
    if not security.verify_password(old, row["password_hash"], row["salt"]):
        raise bad_request("原密码不正确", code="wrong_password")
    security.set_password(ctx.conn, ctx.user["id"], new)
    db.sync_user_to_event_databases(ctx.conn, ctx.user["id"])
    security.audit(ctx.conn, ctx.user, "change_password", "user", ctx.user["id"])
    return {"message": "密码已更新", "snapshot_sync_pending": True}


def public_user(user: dict) -> dict:
    return {"id": user["id"], "username": user["username"],
            "display_name": user["display_name"], "role": user["role"],
            "role_name": security.ROLE_NAMES.get(user["role"], user["role"])}
