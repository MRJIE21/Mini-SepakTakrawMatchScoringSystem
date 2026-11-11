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
import secrets
import threading
import time
from collections import deque
from datetime import datetime

from . import clock, config, db

ROLES = ("admin", "organizer", "recorder", "viewer", "display_operator")
ROLE_NAMES = {
    "admin": "赛事管理员",
    "organizer": "编排与成绩人员",
    "recorder": "场地记录员",
    "viewer": "成绩查看者",
    "display_operator": "大屏操作员",
}

# 固定能力是角色之上的服务端授权边界。当前版本只开放给管理员；
# 后续如增加授权管理，必须另行设计权限与审计流程。
REGISTRATION_DELETE = "registration.delete"
ROLE_CAPABILITIES = {
    "admin": (REGISTRATION_DELETE,),
    "organizer": (),
    "recorder": (),
    "viewer": (),
    "display_operator": (),
}


def capabilities(user_or_role) -> list[str]:
    role = (user_or_role.get("role") if isinstance(user_or_role, dict)
            else str(user_or_role or ""))
    return list(ROLE_CAPABILITIES.get(role, ()))


def has_capability(user_or_role, capability: str) -> bool:
    return capability in capabilities(user_or_role)

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


# Single source for the administrator bootstrap credential; never log or return it.
ADMIN_INITIAL_PASSWORD = "123456"


def ensure_default_users(conn) -> None:
    """首次启动只建立管理员账号，使用固定初始密码，不返回口令。"""
    if db.q1(conn, "SELECT id FROM users LIMIT 1"):
        return
    create_user(conn, "admin", ADMIN_INITIAL_PASSWORD, "admin", "赛事管理员")


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


def token_hash(value: str) -> str:
    """服务端只保存令牌的 sha256 哈希；明文只出现在登录响应与客户端。"""
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def issue_token(conn, user_id: int) -> str:
    """签发一次性返回的明文令牌，数据库只落哈希与 UTC epoch。"""
    token = secrets.token_urlsafe(32)
    expires_epoch = int(clock.utc_epoch()) + int(config.TOKEN_TTL_HOURS) * 3600
    expires_text = datetime.fromtimestamp(expires_epoch).strftime("%Y-%m-%d %H:%M:%S")
    db.insert(conn, "tokens", {
        "token": token_hash(token),
        "user_id": int(user_id),
        "expires_at": expires_text,
        "expires_at_epoch": expires_epoch,
    })
    return token


def revoke_user_tokens(conn, user_id: int, keep_token_hash: str | None = None) -> int:
    """吊销该用户全部令牌；keep_token_hash 用于改密时保留当前会话。"""
    if keep_token_hash:
        cursor = conn.execute("DELETE FROM tokens WHERE user_id = ? AND token <> ?",
                              (int(user_id), keep_token_hash))
    else:
        cursor = conn.execute("DELETE FROM tokens WHERE user_id = ?", (int(user_id),))
    return max(0, cursor.rowcount or 0)


def login(conn, username: str, password: str) -> str | None:
    row = db.q1(conn, "SELECT * FROM users WHERE username = ? AND active = 1", (username,))
    if row is None or not verify_password(password, row["password_hash"], row["salt"]):
        return None
    return issue_token(conn, row["id"])


def logout(conn, token: str) -> None:
    if token:
        db.run(conn, "DELETE FROM tokens WHERE token = ?", (token_hash(token),))


def _token_expired(conn, row) -> bool:
    epoch = row["expires_at_epoch"] if "expires_at_epoch" in row.keys() else 0
    if not epoch:
        epoch = clock.parse_local_text(row["expires_at"]) or 0
    if not epoch:
        return True
    # 时钟回拨由 clock.wall_epoch 的持久化高水位兜底：回拨后已过期令牌不会复活。
    return clock.wall_epoch(conn) >= epoch


def user_for_token(conn, token: str | None) -> dict | None:
    if not token:
        return None
    row = db.q1(
        conn,
        """SELECT u.*, t.expires_at, t.expires_at_epoch FROM tokens t
             JOIN users u ON u.id = t.user_id
            WHERE t.token = ? AND u.active = 1""",
        (token_hash(token),),
    )
    if row is None:
        return None
    if _token_expired(conn, row):
        # P2-B：日常运行不自动删除过期数据，交给 run.py maintenance 处理。
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
