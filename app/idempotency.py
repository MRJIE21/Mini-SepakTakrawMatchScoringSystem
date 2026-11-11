"""组合提交幂等：同一请求标识 + 相同内容只产生一个业务对象。

改进方案 §9.2 / §15.3：前端“保存中”遇到网络超时会进入“结果待核实”，
用同一 request_uid 重试；服务端凭 request_log 判断这次提交是否已经落库，
避免重复建队、重复报名。

调用方运行在 http_server 的 db.tx 事务里（BEGIN IMMEDIATE 持有写锁），
因此“写业务数据 + 写幂等记录”是原子的：业务回滚则幂等记录不残留，
业务提交则重放一定能查到。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3

from . import db
from .errors import conflict

UID_KEYS = ("request_uid", "requestUid")


def extract_uid(body: dict | None) -> str:
    for key in UID_KEYS:
        value = (body or {}).get(key)
        if value:
            return str(value).strip()
    return ""


def payload_without_uid(body: dict | None) -> dict:
    return {k: v for k, v in (body or {}).items() if k not in UID_KEYS}


def content_hash(payload) -> str:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def replay_or_run(conn: sqlite3.Connection, user, uid: str, payload, fn, scope: str = "",
                  *, strict: bool = False):
    """按幂等约定执行 fn。

    uid 为空时退化为普通调用，保持既有接口行为不变。
    返回值是 fn 的结果字典；重放时额外带 ``replayed: True``。
    """
    if not uid:
        return fn()

    row = db.q1(conn, "SELECT * FROM request_log WHERE uid = ?", (uid,))
    digest = content_hash(payload)
    if row is not None:
        if row["payload_hash"] != digest or (strict and (
                row["user_id"] != (user or {}).get("id") or row["scope"] != scope)):
            raise conflict(
                "该请求标识已用于另一份内容，请修改后重新提交（不要重复使用同一请求标识）",
                code="request_uid_reused",
                detail={"request_uid": uid},
            )
        if row["status"] == "conflict" and row["message"] == "school_cascade_deleted":
            raise conflict("原请求关联的学校或报名已级联删除，请重新读取", code="school_cascade_deleted")
        result = json.loads(row["result_json"] or "{}")
        result["replayed"] = True
        return result

    result = fn()
    db.insert(conn, "request_log", {
        "uid": uid,
        "scope": scope,
        "user_id": (user or {}).get("id"),
        "payload_hash": digest,
        "status": "succeeded",
        "result_json": json.dumps(result, ensure_ascii=False, default=str),
    })
    return result
