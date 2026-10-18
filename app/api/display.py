"""Live display endpoints: pairing, read-only state, publish and live snapshots."""
from __future__ import annotations

from .. import access, db, display_state, display_store, security
from ..errors import bad_request, forbidden, not_found
from ..http_server import json_response, route


def _integer(value, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise bad_request(f"{name} 无效") from None
    return result


def _event_conn(event_id: int):
    try:
        return db.get_event_conn(int(event_id))
    except (FileNotFoundError, ValueError):
        raise not_found("赛事数据库不存在") from None


def _check_event_scope(ctx, event_id: int):
    if ctx.user["role"] == "admin":
        return
    if int(event_id) not in access.event_ids(ctx.conn, ctx.user):
        raise forbidden("账号未分配该赛事，请联系管理员")


@route("POST", r"/api/display/pair/start", public=True, scope="registry")
def pair_start(ctx):
    body = ctx.body or {}
    return display_store.start_pair(ctx.conn, body.get("device_secret") or "", ctx.remote_addr)


@route("GET", r"/api/display/pair/status", public=True, scope="registry")
def pair_status(ctx):
    pair_id = _integer(ctx.arg("id"), "配对编号")
    return display_store.pair_status(ctx.conn, pair_id, ctx.arg("device_secret") or "", ctx.remote_addr)


@route("POST", r"/api/display/pair/claim", roles=("admin", "organizer", "display_operator"), scope="registry")
def pair_claim(ctx):
    body = ctx.body or {}
    event_id = _integer(body.get("event_id"), "赛事编号")
    if not db.q1(ctx.conn, "SELECT id FROM events WHERE id = ?", (event_id,)):
        raise not_found("赛事不存在")
    _check_event_scope(ctx, event_id)
    claimed = display_store.claim_pair(ctx.conn, str(body.get("code") or ""), event_id,
                                       str(body.get("name") or "体育馆大屏"),
                                       ctx.user["id"], ctx.remote_addr)
    security.audit(ctx.conn, ctx.user, "display_pair_claim", "display_screen",
                   claimed["screen"]["id"], {"event_id": event_id, "name": claimed["screen"]["name"]})
    return {"screen": claimed["screen"]}


@route("GET", r"/api/display/console", roles=("admin", "organizer", "display_operator"), scope="registry")
def console(ctx):
    event_id = _integer(ctx.arg("event_id"), "赛事编号")
    event = db.q1(ctx.conn, "SELECT id, name FROM events WHERE id = ?", (event_id,))
    if not event:
        raise not_found("赛事不存在")
    _check_event_scope(ctx, event_id)
    event_conn = _event_conn(event_id)
    display_store.purge_expired(event_conn)
    config = display_store.get_config(event_conn)
    screens = db.rows_to_dicts(db.q(
        ctx.conn,
        "SELECT id, name, event_id, created_at, last_seen_at, revoked_at FROM display_screens "
        "WHERE event_id = ? ORDER BY id", (event_id,)))
    for screen in screens:
        screen["online"] = display_store.screen_online(screen)
    return {"event": {"id": event["id"], "name": event["name"]}, "config": config, "screens": screens}


@route("GET", r"/api/display/preview", roles=("admin", "organizer", "display_operator"), scope="registry")
def preview(ctx):
    event_id = _integer(ctx.arg("event_id"), "赛事编号")
    event = db.q1(ctx.conn, "SELECT id, name FROM events WHERE id = ?", (event_id,))
    if not event:
        raise not_found("赛事不存在")
    _check_event_scope(ctx, event_id)
    event_conn = _event_conn(event_id)
    state = display_state.build_state(event_conn, {"id": None, "name": "预览", "event_id": event_id})
    return json_response({"ok": True, **state})


@route("POST", r"/api/display/publish", roles=("admin", "organizer", "display_operator"), scope="registry", transaction=False)
def publish(ctx):
    body = ctx.body or {}
    event_id = _integer(body.get("event_id"), "赛事编号")
    _check_event_scope(ctx, event_id)
    event_conn = _event_conn(event_id)
    slots = body.get("slots") or []
    match_ids = []
    for slot in slots:
        if not isinstance(slot, dict) or slot.get("match_id") in (None, ""):
            continue
        match_ids.append(_integer(slot.get("match_id"), "场次编号"))
    if match_ids:
        marks = ",".join("?" for _ in match_ids)
        found = {row["id"] for row in db.q(
            event_conn,
            f"SELECT m.id FROM matches m JOIN categories c ON c.id = m.category_id "
            f"WHERE m.id IN ({marks}) AND c.kind = 'team'", tuple(match_ids))}
        missing = [match_id for match_id in match_ids if match_id not in found]
        if missing:
            raise bad_request("只能绑定本赛事的三人赛场次", detail={"match_ids": missing})
    with db.tx(event_conn):
        config = display_store.publish_config(event_conn, ctx.user["id"], body)
        security.audit(event_conn, ctx.user, "display_publish", "display", 1, {
            "layout": config["layout"], "mode": config["mode"], "revision": config["revision"]})
    return {"config": config}


@route("POST", r"/api/display/revoke", roles=("admin", "organizer", "display_operator"), scope="registry")
def revoke(ctx):
    body = ctx.body or {}
    screen_id = _integer(body.get("screen_id"), "大屏编号")
    screen = display_store.screen_by_id(ctx.conn, screen_id)
    _check_event_scope(ctx, screen["event_id"])
    result = display_store.revoke_screen(ctx.conn, screen_id)
    security.audit(ctx.conn, ctx.user, "display_revoke", "display_screen", screen_id, {})
    return result


@route("POST", r"/api/display/live", roles=("admin", "organizer", "recorder"), scope="event")
def live(ctx):
    body = ctx.body or {}
    match_id = _integer(body.get("match_id"), "场次编号")
    match = db.q1(ctx.conn, "SELECT id, status FROM matches WHERE id = ?", (match_id,))
    if match is None:
        raise not_found("场次不存在")
    access.require_owner(ctx, "match", match_id)
    owner = access.assignment(ctx.conn, "match", match_id)
    recorder_id = owner["user_id"] if owner else ctx.user["id"]
    payload = {**body, "recorder_id": recorder_id}
    return display_store.sync_live(ctx.conn, match_id, payload)
