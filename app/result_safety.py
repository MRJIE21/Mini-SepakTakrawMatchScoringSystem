"""Shared atomic boundary and immutable receipts for result mutations."""
from __future__ import annotations

import functools
import json
import uuid

from . import db
from .domain import validation
from .errors import bad_request, conflict, forbidden


def atomic_result(fn):
    """A caught failure cannot leave half a result in an outer transaction."""
    @functools.wraps(fn)
    def wrapped(ctx):
        with db.tx(ctx.conn):
            with db.savepoint(ctx.conn, "result_" + uuid.uuid4().hex):
                return fn(ctx)
    return wrapped


def require_version(body):
    value = body.get("base_version")
    if value is None:
        raise bad_request("请升级记录页面，并核对已保存输入后重新加载结果版本",
                          code="client_upgrade_required")
    if type(value) is not int or value < 0:
        raise bad_request("base_version 必须是非负整数")
    return value


def result_scope(ctx, kind, subject_id, category_id):
    event = db.q1(ctx.conn, """SELECT e.id,e.uuid FROM events e JOIN groups g ON g.event_id=e.id
        JOIN categories c ON c.group_id=g.id WHERE c.id=?""", (category_id,))
    deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k='deployment_id'")
    identity = {"event_id": event["id"], "event_uuid": event["uuid"],
                "deployment_id": deployment["v"] if deployment else ""}
    frozen = (ctx.body or {}).get("event_identity")
    headers = {k.lower(): v for k, v in (ctx.headers or {}).items()}
    if headers.get("x-event-uuid") and not frozen:
        raise bad_request("提交包缺少冻结的赛事身份", code="missing_event_identity")
    if frozen is not None and (not isinstance(frozen, dict) or
            str(frozen.get("event_id", "")) != str(identity["event_id"]) or
            frozen.get("event_uuid") != identity["event_uuid"] or
            frozen.get("deployment_id", "") != identity["deployment_id"]):
        raise conflict("提交包身份与当前赛事或部署不一致", code="event_identity_mismatch")
    return json.dumps({**identity, "kind": kind, "subject_id": subject_id,
                       "path": ctx.path}, sort_keys=True, separators=(",", ":"))


def receipt(uid, kind, subject_id, body, applied_version, submission_id=None):
    result = {"uid": uid, "kind": kind, "subject_id": subject_id,
              "payload_hash": validation.payload_hash(body),
              "applied_version": applied_version, "status": "confirmed"}
    if submission_id is not None:
        result["submission_id"] = submission_id
    return result


def submission_receipt(conn, row):
    if row["kind"] == "match":
        subject_id = row["match_id"]
    else:
        item = db.q1(conn, "SELECT participation_id FROM individual_results WHERE id=?",
                     (row["individual_result_id"],))
        subject_id = item["participation_id"] if item else None
    return {"uid": row["uid"], "kind": row["kind"], "subject_id": subject_id,
            "payload_hash": row["payload_hash"], "applied_version": row["base_version"] + 1,
            "submission_id": row["id"], "status": row["status"]}


def can_read_receipt(ctx, user_id):
    # Event authorization/authentication is enforced before this endpoint; claim
    # ownership deliberately is not: reassignment must not hide a commit receipt.
    return ctx.user["id"] == user_id or ctx.user["role"] in ("admin", "organizer")


def require_result_role(ctx):
    if ctx.user["role"] not in ("admin", "organizer"):
        raise forbidden("正式结果更正需要管理员或成绩人员操作")
