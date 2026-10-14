"""用户、角色与令牌。

角色来自设计大纲第 3 节：
  admin     赛事管理员
  organizer 编排与成绩人员
  recorder  场地记录员
  viewer    成绩查看者
"""
from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta

from . import config, db

ROLES = ("admin", "organizer", "recorder", "viewer")
ROLE_NAMES = {
    "admin": "赛事管理员",
    "organizer": "编排与成绩人员",
    "recorder": "场地记录员",
    "viewer": "成绩查看者",
}

# 本地赛事部署的固定初始管理员密码；仍可通过环境变量覆盖，或登录后修改。
DEFAULT_ADMIN_PASSWORD = "Admin123456"


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


def ensure_default_users(conn) -> str | None:
    """首次启动只建立管理员账号。

    不再内置 organizer/recorder/viewer 等固定密码账号：现场账号由管理员在
    “账号管理”中按角色创建，避免出现人尽可知的默认口令。

    返回需要打印给运维的初始密码：
      - 环境变量 STSS_ADMIN_PASSWORD 指定时使用环境变量并返回 None；
      - 未指定时使用固定初始密码 DEFAULT_ADMIN_PASSWORD；
      - 已有账号的数据库返回 None。
    """
    if db.q1(conn, "SELECT id FROM users LIMIT 1"):
        return None
    configured = os.environ.get("STSS_ADMIN_PASSWORD")
    password = configured or DEFAULT_ADMIN_PASSWORD
    create_user(conn, "admin", password, "admin", "赛事管理员")
    return None if configured else password


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
