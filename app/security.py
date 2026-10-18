"""用户、角色与令牌。

角色来自设计大纲第 3 节：
  admin     赛事管理员
  organizer 编排与成绩人员
  recorder  场地记录员
  viewer    成绩查看者
  display_operator 大屏操作员
"""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timedelta

from . import config, db

ROLES = ("admin", "organizer", "recorder", "viewer", "display_operator")
ROLE_NAMES = {
    "admin": "赛事管理员",
    "organizer": "编排与成绩人员",
    "recorder": "场地记录员",
    "viewer": "成绩查看者",
    "display_operator": "大屏操作员",
}

# 登录失败限流：进程内内存实现，阈值可通过 config/env 调整；重启清零。
_LOGIN_LOCK = threading.Lock()
_LOGIN_FAILURES: dict[str, deque] = {}
_LOGIN_LOCKS: dict[str, float] = {}


def reset_login_limits() -> None:
    with _LOGIN_LOCK:
        _LOGIN_FAILURES.clear()
        _LOGIN_LOCKS.clear()


def _prune(values: deque, now: float) -> None:
    floor = now - max(1, config.LOGIN_WINDOW_SECONDS)
    while values and values[0] <= floor:
        values.popleft()


def login_retry_after(ip: str, username: str) -> int:
    """Return remaining lock seconds for this IP+username or IP, else 0."""
    now = time.monotonic()
    keys = (f'user|{ip}|{username.strip().lower()}', f'ip|{ip}')
    with _LOGIN_LOCK:
        retry = 0
        for key in keys:
            until = _LOGIN_LOCKS.get(key, 0)
            if until > now:
                retry = max(retry, int(until - now) + 1)
        return retry


def record_login_failure(ip: str, username: str) -> int:
    """Record one failed attempt and return lock seconds if now locked."""
    now = time.monotonic()
    user_key = f'user|{ip}|{username.strip().lower()}'
    ip_key = f'ip|{ip}'
    with _LOGIN_LOCK:
        retry = 0
        for key, limit in ((user_key, config.LOGIN_MAX_FAILS), (ip_key, config.LOGIN_IP_MAX_FAILS)):
            values = _LOGIN_FAILURES.setdefault(key, deque())
            _prune(values, now)
            values.append(now)
            if len(values) >= max(1, limit):
                until = now + max(1, config.LOGIN_LOCK_SECONDS)
                _LOGIN_LOCKS[key] = until
                values.clear()
                retry = max(retry, int(until - now) + 1)
        return retry


def clear_login_failures(ip: str, username: str) -> None:
    with _LOGIN_LOCK:
        _LOGIN_FAILURES.pop(f'user|{ip}|{username.strip().lower()}', None)
        _LOGIN_LOCKS.pop(f'user|{ip}|{username.strip().lower()}', None)


def ensure_default_users(conn) -> str | None:
    """首次启动只建立管理员账号。

    不再内置固定密码：未显式设置 STSS_ADMIN_PASSWORD 时生成随机初始口令，
    仅在启动控制台显示一次，必须登录后立即修改。
    """
    if db.q1(conn, "SELECT id FROM users LIMIT 1"):
        return None
    configured = os.environ.get("STSS_ADMIN_PASSWORD")
    password = configured or secrets.token_urlsafe(9)
    create_user(conn, "admin", password, "admin", "赛事管理员")
    return None if configured else password


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 120_000)
    return digest.hex(), salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    candidate, _ = hash_password(password, salt)
    return secrets.compare_digest(candidate, password_hash)


def create_user(conn, username: str, password: str, role: str, display_name: str = "") -> int:
    if role not in ROLES:
        raise ValueError(f"未知角色：{role}")
    pwd_hash, salt = hash_password(password)
    return db.insert(conn, "users", {
        "username": username,
        "password_hash": pwd_hash,
        "salt": salt,
        "display_name": display_name or username,
        "role": role,
    })


def set_password(conn, user_id: int, password: str) -> None:
    pwd_hash, salt = hash_password(password)
    db.update(conn, "users", user_id, {"password_hash": pwd_hash, "salt": salt})


def login(conn, username: str, password: str) -> str | None:
    row = db.q1(conn, "SELECT * FROM users WHERE username = ? AND active = 1", (username,))
    if row is None or not verify_password(password, row["password_hash"], row["salt"]):
        return None
    token = secrets.token_urlsafe(32)
    expires = datetime.now() + timedelta(hours=config.TOKEN_TTL_HOURS)
    db.insert(conn, "tokens", {
        "token": token,
        "user_id": row["id"],
        "expires_at": expires.strftime("%Y-%m-%d %H:%M:%S"),
    })
    return token


def logout(conn, token: str) -> None:
    db.run(conn, "DELETE FROM tokens WHERE token = ?", (token,))


def user_for_token(conn, token: str | None) -> dict | None:
    if not token:
        return None
    row = db.q1(
        conn,
        """SELECT u.*, t.expires_at FROM tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token = ? AND u.active = 1""",
        (token,),
    )
    if row is None:
        return None
    if row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        db.run(conn, "DELETE FROM tokens WHERE token = ?", (token,))
        return None
    return dict(row)


def audit(conn, user: dict | None, action: str, entity_type: str = "", entity_id: int | None = None,
          detail: dict | None = None) -> None:
    import json
    db.insert(conn, "audit_logs", {
        "user_id": user["id"] if user else None,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "detail_json": json.dumps(detail or {}, ensure_ascii=False),
    })
