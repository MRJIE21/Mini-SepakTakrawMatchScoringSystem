"""Build the read-only display state from published config, live snapshots and results."""
from __future__ import annotations

import hashlib
from datetime import datetime

from . import clock, db, display_store
from .errors import ApiError


def _now(conn) -> str:
    """服务器时间统一 UTC ISO8601（P2-B REQ-011）。"""
    return clock.utc_iso()


def _set_chips(sets, current_set: int | None) -> list[dict]:
    by_no = {}
    for item in sets or []:
        try:
            by_no[int(item.get("set_no"))] = item
        except (TypeError, ValueError):
            continue
    total = max(3, max(by_no) if by_no else 3)
    chips = []
    for set_no in range(1, total + 1):
        item = by_no.get(set_no)
        if item is None:
            chips.append({"set_no": set_no, "label": f"第{set_no}局 -:-", "state": "live" if current_set == set_no else ""})
            continue
        home = int(item.get("home_points") or 0)
        away = int(item.get("away_points") or 0)
        winner = item.get("winner_side") or ""
        state = "done" if winner else ("live" if current_set == set_no else "")
        chips.append({"set_no": set_no, "label": f"第{set_no}局 {home}:{away}", "state": state})
    return chips


def _points_from_sets(sets: list[dict]) -> tuple[int, int, int, int]:
    played = [item for item in sets or [] if item.get("winner_side") or item.get("home_points") or item.get("away_points")]
    if not played:
        return 0, 0, 0, 0
    last = played[-1]
    home_sets = sum(1 for item in sets or [] if item.get("winner_side") == "home")
    away_sets = sum(1 for item in sets or [] if item.get("winner_side") == "away")
    return int(last.get("home_points") or 0), int(last.get("away_points") or 0), home_sets, away_sets


def _tile(event_conn, index: int, slot) -> dict:
    base = {
        "slot": index,
        "visible": True,
        "match_id": None,
        "label": f"{index + 1} 号场",
        "court": "",
        "round": "",
        "status": "unassigned",
        "home": {"name": "", "points": None, "sets": 0},
        "away": {"name": "", "points": None, "sets": 0},
        "current_set": None,
        "sets": _set_chips([], None),
        "scheduled_at": "",
        "updated_at": "",
    }
    if not slot or not slot.get("match_id"):
        return base
    match_id = int(slot["match_id"])
    base["match_id"] = match_id
    label = str(slot.get("label") or "").strip()
    try:
        from .api.common import match_full_context
        ctx = match_full_context(event_conn, match_id)
    except ApiError:
        base["status"] = "missing"
        base["label"] = label or f"{index + 1} 号场"
        return base
    venue = str(ctx.get("venue_name") or "").strip()
    base["court"] = label or venue or f"{index + 1} 号场"
    base["label"] = label or venue or f"{index + 1} 号场"
    parts = [str(ctx.get("group_name") or "").strip(), str(ctx.get("category_name") or "").strip(),
             str(ctx.get("round_label") or "").strip()]
    base["round"] = " · ".join(part for part in parts if part)
    base["scheduled_at"] = str(ctx.get("scheduled_at") or "")
    base["home"]["name"] = str(ctx.get("home", {}).get("label") or "")
    base["away"]["name"] = str(ctx.get("away", {}).get("label") or "")
    match_status = str(ctx.get("status") or "")
    result_status = str(ctx.get("result_status") or "")
    base["match_status"] = match_status
    base["result_status"] = result_status
    base["revision"] = int(ctx.get("result_version") or 0)
    if match_status == "finished":
        sets = ctx.get("sets") or []
        home_points, away_points, home_sets, away_sets = _points_from_sets(sets)
        base.update({
            "status": "finished",
            "current_set": None,
            "sets": _set_chips(sets, None),
            "home": {**base["home"], "points": home_points, "sets": home_sets},
            "away": {**base["away"], "points": away_points, "sets": away_sets},
            "updated_at": str(ctx.get("updated_at") or ""),
        })
        return base
    if match_status == "void":
        base["status"] = "void"
        return base
    live = display_store.live_row(event_conn, match_id)
    if live is None:
        expired = db.q1(event_conn, "SELECT * FROM display_live WHERE match_id = ?", (match_id,))
        if expired is not None and match_status == "ready":
            base.update({
                "status": "stale",
                "current_set": expired["current_set"],
                "sets": _set_chips(_loads(expired["sets_json"]), expired["current_set"]),
                "home": {**base["home"], "points": int(expired["home_points"]), "sets": int(expired["home_sets"])},
                "away": {**base["away"], "points": int(expired["away_points"]), "sets": int(expired["away_sets"])},
                "updated_at": str(expired["updated_at"] or ""),
                "revision": int(expired["revision"] or 0),
            })
            return base
        base["status"] = "upcoming"
        return base
    base.update({
        "status": "live",
        "current_set": live.get("current_set"),
        "sets": _set_chips(live.get("sets") or [], live.get("current_set")),
        "home": {**base["home"], "points": int(live.get("home_points") or 0), "sets": int(live.get("home_sets") or 0)},
        "away": {**base["away"], "points": int(live.get("away_points") or 0), "sets": int(live.get("away_sets") or 0)},
        "updated_at": str(live.get("updated_at") or ""),
        "revision": int(live.get("revision") or 0),
    })
    return base


def _loads(raw: str):
    import json
    try:
        value = json.loads(raw or "[]")
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def _state_version(config: dict, tiles: list[dict]) -> str:
    """Stable digest covering every change the display must repaint for.

    ``revision`` intentionally stays as the legacy config/match digest.  It
    cannot represent transitions such as live -> stale (the live row keeps the
    same revision while expiring) or ready -> missing (the deleted match simply
    disappears), so the display used to keep showing stale boards until a manual
    refresh.  state_version adds tile status/existence and mode/poll settings.
    """
    parts = [
        f"config:{int(config.get('revision') or 0)}",
        f"mode:{config.get('mode') or 'score'}",
        f"poll:{int(config.get('poll_ms') or 500)}",
        f"layout:{int(config.get('layout') or 8)}",
        f"visible:{','.join(str(item) for item in (config.get('visible_slots') or []))}",
    ]
    for tile in tiles:
        parts.append(
            f"{tile.get('slot')}:{tile.get('match_id')}:{tile.get('status')}:"
            f"{tile.get('revision', 0)}:{tile.get('updated_at', '')}:{int(bool(tile.get('visible')))}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


def build_state(event_conn, screen: dict) -> dict:
    config = display_store.get_config(event_conn)
    visible = [int(item) for item in (config.get("visible_slots") or [])]
    tiles = []
    revision_parts = [str(int(config.get("revision") or 0))]
    for index in range(display_store.SLOT_COUNT):
        tile = _tile(event_conn, index, config["slots"][index] if index < len(config["slots"]) else None)
        tile["visible"] = index in visible
        if tile.get("match_id") is not None:
            revision_parts.append(
                f"{tile['match_id']}:{tile.get('revision', 0)}:{tile.get('updated_at', '')}:{tile['visible']}")
        tiles.append(tile)
    revision = "|".join(revision_parts)
    try:
        state_version = _state_version(config, tiles)
    except Exception:
        # A display must stay renderable even if a future field breaks the digest.
        state_version = revision
    return {
        "status": "PASS",
        "screen": {"id": screen.get("id"), "name": screen.get("name")},
        "event_id": screen.get("event_id"),
        "layout": int(config.get("layout") or 8),
        "mode": config.get("mode") or "score",
        "poll_ms": int(config.get("poll_ms") or 500),
        "visible_slots": visible,
        "slots": tiles,
        "announcement": {
            "title": config.get("announcement_title") or "",
            "body": config.get("announcement_body") or "",
        },
        "config_updated_at": config.get("updated_at") or "",
        "revision": revision,
        "config_revision": int(config.get("revision") or 0),
        "state_version": state_version,
        "server_time": _now(event_conn),
    }
