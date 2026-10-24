"""Live display state: screen credentials, pair codes, published config and snapshots.

The display layer is deliberately separate from official results: ``display_live``
is a presentation snapshot only and never feeds standings, placements or exports.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime, timedelta

from . import clock, db
from .errors import ApiError, bad_request, conflict, not_found

LAYOUTS = (1, 2, 3, 4, 8)
MODES = ("score", "announce", "standby")
PAIR_TTL_SECONDS = 600
LIVE_TTL_SECONDS = 120
LAST_SEEN_WRITE_SECONDS = 5
ONLINE_WINDOW_SECONDS = 15
SLOT_COUNT = 8
MAX_LABEL_LENGTH = 40
MAX_ANNOUNCEMENT_TITLE = 80
MAX_ANNOUNCEMENT_BODY = 500

# Pairing is a public endpoint: bound it per client address and globally.
PAIR_START_WINDOW = 60
PAIR_START_PER_IP = 5
PAIR_START_GLOBAL = 60
PAIR_STATUS_WINDOW = 60
PAIR_STATUS_PER_IP = 180
PAIR_CLAIM_WINDOW = 60
PAIR_CLAIM_PER_USER = 10
PAIR_CLAIM_PER_IP = 20

_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, deque] = {}


def reset_rate_limits() -> None:
    """Test hook: the in-memory limiter is per process, like the HTTP worker set."""
    with _RATE_LOCK:
        _RATE_BUCKETS.clear()


def _rate_check(key: str, limit: int, window: int) -> None:
    now = time.monotonic()
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS.setdefault(key, deque())
        cutoff = now - window
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            raise ApiError(429, "rate_limited", "请求过于频繁，请稍后重试")
        bucket.append(now)



def _now() -> str:
    """本地展示文本（判定一律用 epoch）。"""
    return datetime.fromtimestamp(clock.utc_epoch()).strftime("%Y-%m-%d %H:%M:%S")


def _after(seconds: int) -> str:
    return datetime.fromtimestamp(clock.utc_epoch() + int(seconds)).strftime("%Y-%m-%d %H:%M:%S")


def _epoch_now(conn: sqlite3.Connection) -> int:
    return int(clock.wall_epoch(conn))


def _row_epoch(row, epoch_field: str, text_field: str) -> int:
    try:
        value = row[epoch_field]
    except (KeyError, IndexError):
        value = 0
    if value:
        return int(value)
    try:
        text = row[text_field]
    except (KeyError, IndexError):
        text = ""
    parsed = clock.parse_local_text(text)
    return int(parsed) if parsed else 0


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def backup_before_upgrade(conn: sqlite3.Connection) -> None:
    """Take one verified pre-display backup before creating the new tables."""
    tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "settings" not in tables:
        return
    if {"display_screens", "display_config", "display_live"} & tables:
        return
    from .team_rules_store import _backup
    _backup(conn, ".before-display-v1.db")


# ------------------------------------------------------------------ devices
def create_screen(conn: sqlite3.Connection, event_id: int, name: str, token: str | None = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise bad_request("请填写大屏名称")
    if len(name) > 60:
        raise bad_request("大屏名称过长")
    token = token or new_token()
    if not conn.execute("SELECT id FROM events WHERE id = ?", (int(event_id),)).fetchone():
        raise not_found("赛事不存在")
    screen_id = db.insert(conn, "display_screens", {
        "name": name, "event_id": int(event_id), "token_hash": _digest(token),
        "last_seen_at": "", "revoked_at": None,
    })
    return {"id": screen_id, "name": name, "event_id": int(event_id), "token": token}


def screen_for_token(conn: sqlite3.Connection, token: str | None) -> dict | None:
    if not token or not isinstance(token, str):
        return None
    row = db.q1(conn, "SELECT * FROM display_screens WHERE token_hash = ? AND revoked_at IS NULL",
                (_digest(token),))
    if row is None:
        return None
    screen = dict(row)
    if _should_touch(screen):
        now_text = _now()
        now_epoch = _epoch_now(conn)
        db.run(conn, "UPDATE display_screens SET last_seen_at = ?, last_seen_epoch = ? WHERE id = ?",
               (now_text, now_epoch, screen["id"]))
        screen["last_seen_at"] = now_text
        screen["last_seen_epoch"] = now_epoch
    return screen


def screen_by_id(conn: sqlite3.Connection, screen_id: int) -> dict:
    row = db.q1(conn, "SELECT * FROM display_screens WHERE id = ?", (int(screen_id),))
    if row is None:
        raise not_found("大屏不存在")
    return dict(row)


def revoke_screen(conn: sqlite3.Connection, screen_id: int) -> dict:
    row = db.q1(conn, "SELECT * FROM display_screens WHERE id = ?", (int(screen_id),))
    if row is None:
        raise not_found("大屏不存在")
    db.run(conn, "UPDATE display_screens SET revoked_at = ?, last_seen_at = '', last_seen_epoch = 0 WHERE id = ?",
           (_now(), int(screen_id)))
    db.run(conn, "UPDATE display_pair_codes SET token_once = '' WHERE screen_id = ?", (int(screen_id),))
    return {"id": int(screen_id), "revoked": True}


def _should_touch(screen) -> bool:
    value = dict(screen or {})
    previous = _row_epoch(value, "last_seen_epoch", "last_seen_at")
    if not previous:
        return True
    return (clock.utc_epoch() - previous) >= LAST_SEEN_WRITE_SECONDS


def screen_online(screen, conn: sqlite3.Connection | None = None) -> bool:
    """A screen is online only after it has polled state within the window."""
    value = dict(screen or {})
    previous = _row_epoch(value, "last_seen_epoch", "last_seen_at")
    if not previous:
        return False
    current = clock.wall_epoch(conn) if conn is not None else clock.utc_epoch()
    return (current - previous) <= ONLINE_WINDOW_SECONDS


def _client_key(client_ip: str | None) -> str:
    return (client_ip or "local").strip() or "local"


# ------------------------------------------------------------------ pairing
def start_pair(conn: sqlite3.Connection, device_secret: str, client_ip: str | None = None) -> dict:
    if not isinstance(device_secret, str) or len(device_secret.strip()) < 16:
        raise bad_request("设备标识无效")
    ip = _client_key(client_ip)
    _rate_check(f"pair-start:{ip}", PAIR_START_PER_IP, PAIR_START_WINDOW)
    _rate_check("pair-start:global", PAIR_START_GLOBAL, PAIR_START_WINDOW)
    # P2-B：过期配对码不再在业务请求中顺带删除，交给 run.py maintenance 处理。
    code = ""
    for _ in range(12):
        candidate = "".join(secrets.choice("0123456789") for _ in range(6))
        if not db.q1(conn, "SELECT id FROM display_pair_codes WHERE code_hash = ?", (_digest(candidate),)):
            code = candidate
            break
    if not code:
        raise conflict("配对码生成繁忙，请稍后重试", code="pair_busy")
    pair_id = db.insert(conn, "display_pair_codes", {
        "code_hash": _digest(code),
        "device_hash": _digest(device_secret.strip()),
        "screen_id": None,
        "event_id": None,
        "expires_at": _after(PAIR_TTL_SECONDS),
        "expires_at_epoch": int(clock.utc_epoch()) + PAIR_TTL_SECONDS,
        "claimed_at": None,
        "token_once": "",
    })
    return {"id": pair_id, "code": code, "expires_in": PAIR_TTL_SECONDS}


def pair_status(conn: sqlite3.Connection, pair_id: int, device_secret: str,
                client_ip: str | None = None) -> dict:
    _rate_check(f"pair-status:{_client_key(client_ip)}", PAIR_STATUS_PER_IP, PAIR_STATUS_WINDOW)
    row = db.q1(conn, "SELECT * FROM display_pair_codes WHERE id = ?", (int(pair_id),))
    if row is None:
        raise not_found("配对请求不存在")
    if not isinstance(device_secret, str) or _digest(device_secret.strip()) != row["device_hash"]:
        raise bad_request("设备标识不匹配")
    if _row_epoch(row, "expires_at_epoch", "expires_at") <= _epoch_now(conn) and not row["claimed_at"]:
        return {"status": "expired"}
    if row["claimed_at"] and row["screen_id"]:
        return {"status": "claimed", "screen_id": row["screen_id"], "token": row["token_once"] or ""}
    return {"status": "pending", "expires_at": row["expires_at"]}


def claim_pair(conn: sqlite3.Connection, code: str, event_id: int, name: str,
               user_id: int | None = None, client_ip: str | None = None) -> dict:
    code = (code or "").strip()
    if not (len(code) == 6 and code.isdigit()):
        raise bad_request("请输入 6 位配对码")
    ip = _client_key(client_ip)
    _rate_check(f"pair-claim:user:{user_id if user_id is not None else ip}",
                PAIR_CLAIM_PER_USER, PAIR_CLAIM_WINDOW)
    _rate_check(f"pair-claim:ip:{ip}", PAIR_CLAIM_PER_IP, PAIR_CLAIM_WINDOW)
    row = db.q1(conn,
                "SELECT * FROM display_pair_codes WHERE code_hash = ? AND claimed_at IS NULL",
                (_digest(code),))
    if row is None:
        raise not_found("配对码不存在或已被使用")
    if _row_epoch(row, "expires_at_epoch", "expires_at") <= _epoch_now(conn):
        raise conflict("配对码已过期，请在大屏上重新生成", code="pair_expired")
    # 单屏：重新配对替换该赛事原有的有效凭据，旧大屏会立即回到配对界面。
    now = _now()
    db.run(conn, "UPDATE display_screens SET revoked_at = ?, last_seen_at = '', last_seen_epoch = 0 "
                 "WHERE event_id = ? AND revoked_at IS NULL", (now, int(event_id)))
    db.run(conn, "UPDATE display_pair_codes SET token_once = '' WHERE screen_id IN "
                 "(SELECT id FROM display_screens WHERE event_id = ? AND revoked_at = ?)",
           (int(event_id), now))
    screen = create_screen(conn, int(event_id), name)
    db.run(conn,
           "UPDATE display_pair_codes SET screen_id = ?, event_id = ?, claimed_at = ?, token_once = ? WHERE id = ?",
           (screen["id"], int(event_id), now, screen["token"], row["id"]))
    return {"screen": {k: screen[k] for k in ("id", "name", "event_id")}, "token": screen["token"]}


# ------------------------------------------------------------------ published config
def _default_config() -> dict:
    return {"layout": 8, "mode": "score", "slots": [None] * SLOT_COUNT,
            "visible_slots": list(range(SLOT_COUNT)),
            "announcement_title": "", "announcement_body": "", "poll_ms": 500,
            "revision": 0, "updated_at": "", "updated_by": None}


def _normalise_slots(value) -> list:
    if value is None:
        value = []
    if not isinstance(value, list):
        raise bad_request("槽位必须是数组")
    if len(value) > SLOT_COUNT:
        raise bad_request("最多只能配置 8 个窗口")
    slots = []
    seen = set()
    for item in value:
        if item is None:
            slots.append(None)
            continue
        if isinstance(item, int):
            item = {"match_id": item, "label": ""}
        if not isinstance(item, dict):
            raise bad_request("槽位格式不正确")
        match_id = item.get("match_id")
        if match_id is None or match_id == "":
            slots.append(None)
            continue
        try:
            match_id = int(match_id)
        except (TypeError, ValueError):
            raise bad_request("槽位比赛编号无效") from None
        if match_id <= 0:
            raise bad_request("槽位比赛编号无效")
        if match_id in seen:
            raise bad_request("同一场比赛不能占用两个窗口")
        seen.add(match_id)
        label = str(item.get("label") or "").strip()
        if len(label) > MAX_LABEL_LENGTH:
            raise bad_request("槽位名称过长")
        slots.append({"match_id": match_id, "label": label})
    slots += [None] * (SLOT_COUNT - len(slots))
    return slots


def _normalise_visible(value, layout: int) -> list:
    if value is None:
        value = list(range(layout)) if layout < SLOT_COUNT else list(range(SLOT_COUNT))
    if not isinstance(value, list):
        raise bad_request("可见槽位必须是数组")
    visible = []
    for item in value:
        try:
            index = int(item)
        except (TypeError, ValueError):
            raise bad_request("可见槽位编号无效") from None
        if index < 0 or index >= SLOT_COUNT:
            raise bad_request("可见槽位编号超出范围")
        if index in visible:
            raise bad_request("可见槽位不能重复")
        visible.append(index)
    visible.sort()
    expected = SLOT_COUNT if layout == SLOT_COUNT else layout
    if len(visible) != expected:
        raise bad_request("可见槽位数量必须与布局一致")
    if layout == SLOT_COUNT and visible != list(range(SLOT_COUNT)):
        raise bad_request("8 窗口布局必须显示全部槽位")
    return visible


def _normalise_poll_ms(value, fallback: int = 500) -> int:
    try:
        poll_ms = int(value)
    except (TypeError, ValueError):
        raise bad_request("刷新间隔必须是 100–1000 的整数毫秒") from None
    if poll_ms < 100 or poll_ms > 1000:
        raise bad_request("刷新间隔必须在 100–1000ms 之间")
    return poll_ms


def get_config(conn: sqlite3.Connection) -> dict:
    row = db.q1(conn, "SELECT * FROM display_config WHERE id = 1")
    if row is None:
        return _default_config()
    out = dict(row)
    try:
        out["slots"] = json.loads(out.pop("slots_json") or "[]")
    except ValueError:
        out["slots"] = []
    try:
        out["visible_slots"] = json.loads(out.pop("visible_slots_json") or "[]")
    except ValueError:
        out["visible_slots"] = []
    out["slots"] = (out["slots"] + [None] * SLOT_COUNT)[:SLOT_COUNT]
    try:
        out["poll_ms"] = _normalise_poll_ms(out.get("poll_ms", 500))
    except ApiError:
        out["poll_ms"] = 500
    return out


def publish_config(conn: sqlite3.Connection, user_id: int | None, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise bad_request("配置格式不正确")
    try:
        layout = int(payload.get("layout", 8))
    except (TypeError, ValueError):
        raise bad_request("布局无效") from None
    if layout not in LAYOUTS:
        raise bad_request("布局只能是 1/2/3/4/8")
    mode = str(payload.get("mode") or "score")
    if mode not in MODES:
        raise bad_request("画面模式无效")
    slots = _normalise_slots(payload.get("slots"))
    visible = _normalise_visible(payload.get("visible_slots"), layout)
    title = str(payload.get("announcement_title") or "").strip()
    body = str(payload.get("announcement_body") or "").strip()
    if len(title) > MAX_ANNOUNCEMENT_TITLE or len(body) > MAX_ANNOUNCEMENT_BODY:
        raise bad_request("公告内容过长")
    current = get_config(conn)
    poll_ms = _normalise_poll_ms(payload.get("poll_ms", current.get("poll_ms", 500)))
    revision = int(current.get("revision") or 0) + 1
    now = _now()
    values = {
        "layout": layout, "mode": mode,
        "slots_json": json.dumps(slots, ensure_ascii=False),
        "visible_slots_json": json.dumps(visible, ensure_ascii=False),
        "announcement_title": title, "announcement_body": body,
        "poll_ms": poll_ms,
        "revision": revision, "updated_at": now,
        "updated_by": int(user_id) if user_id else None,
    }
    if db.q1(conn, "SELECT id FROM display_config WHERE id = 1"):
        db.run(conn,
               "UPDATE display_config SET layout=?, mode=?, slots_json=?, visible_slots_json=?, "
               "announcement_title=?, announcement_body=?, poll_ms=?, revision=?, updated_at=?, "
               "updated_by=? WHERE id=1",
               (layout, mode, values["slots_json"], values["visible_slots_json"], title, body,
                poll_ms, revision, now, values["updated_by"]))
    else:
        db.insert(conn, "display_config", {"id": 1, **values})
    return get_config(conn)


# ------------------------------------------------------------------ live snapshots
def _int(value, name: str, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise bad_request(f"{name} 无效") from None


def sync_live(conn: sqlite3.Connection, match_id: int, payload: dict) -> dict:
    """Store the display-only snapshot; caller has already checked ownership/status."""
    if not isinstance(payload, dict):
        raise bad_request("快照格式不正确")
    match_id = int(match_id)
    match = db.q1(conn, "SELECT id, status FROM matches WHERE id = ?", (match_id,))
    if match is None:
        raise not_found("场次不存在")
    if match["status"] != "ready":
        raise conflict("只有待记录场次可以同步直播比分", code="not_ready")
    existing = db.q1(conn, "SELECT * FROM display_live WHERE match_id = ?", (match_id,))
    event_seq = _int(payload.get("event_seq"), "事件序号")
    draft_uid = str(payload.get("draft_uid") or "").strip()
    stream_epoch = _int(payload.get('stream_epoch',0),'直播流版本')
    if existing is not None and stream_epoch < int(existing['stream_epoch']):
        raise conflict('直播流已过期',code='stale_snapshot')
    if existing is not None and stream_epoch == int(existing['stream_epoch']):
        if event_seq < int(existing["event_seq"]):
            raise conflict("快照已过期，旧记录不能覆盖新比分", code="stale_snapshot")
        if event_seq == int(existing["event_seq"]) and draft_uid and existing["draft_uid"] \
                and draft_uid != existing["draft_uid"]:
            raise conflict("记录身份不一致", code="stale_snapshot")
    revision = int(existing["revision"]) + 1 if existing is not None else 1
    sets = payload.get("sets") or []
    if not isinstance(sets, list):
        raise bad_request("局分格式不正确")
    values = {
        "match_id": match_id, "revision": revision, "event_seq": event_seq,
        "status": str(payload.get("status") or "live")[:24],
        "current_set": payload.get("current_set"),
        "home_points": _int(payload.get("home_points", 0), "主队得分"),
        "away_points": _int(payload.get("away_points", 0), "客队得分"),
        "home_sets": _int(payload.get("home_sets", 0), "主队局分"),
        "away_sets": _int(payload.get("away_sets", 0), "客队局分"),
        "sets_json": json.dumps(sets, ensure_ascii=False),
        "lineup_hash": str(payload.get("lineup_hash") or "")[:64],
        "recorder_id": payload.get("recorder_id"),
        "draft_uid": draft_uid[:80],
        "stream_epoch": stream_epoch,
        "updated_at": _now(),
        "expires_at": _after(LIVE_TTL_SECONDS),
        "expires_at_epoch": int(clock.utc_epoch()) + LIVE_TTL_SECONDS,
    }
    if existing is None:
        db.insert(conn, "display_live", values)
    else:
        db.run(conn,
               "UPDATE display_live SET revision=?, event_seq=?, status=?, current_set=?, home_points=?, "
               "away_points=?, home_sets=?, away_sets=?, sets_json=?, lineup_hash=?, recorder_id=?, "
               "draft_uid=?, updated_at=?, expires_at=?, expires_at_epoch=?,stream_epoch=? WHERE match_id=?",
               (values["revision"], values["event_seq"], values["status"], values["current_set"],
                values["home_points"], values["away_points"], values["home_sets"], values["away_sets"],
                values["sets_json"], values["lineup_hash"], values["recorder_id"],
                values["draft_uid"], values["updated_at"], values["expires_at"],
                values["expires_at_epoch"], values['stream_epoch'], match_id))
    return live_row(conn, match_id)


def live_row(conn: sqlite3.Connection, match_id: int) -> dict | None:
    row = db.q1(conn, "SELECT * FROM display_live WHERE match_id = ?", (int(match_id),))
    if row is None or _row_epoch(row, "expires_at_epoch", "expires_at") <= _epoch_now(conn):
        return None
    out = dict(row)
    try:
        out["sets"] = json.loads(out.pop("sets_json") or "[]")
    except ValueError:
        out["sets"] = []
    return out


def live_rows(conn: sqlite3.Connection) -> list[dict]:
    rows = db.q(conn, "SELECT * FROM display_live ORDER BY match_id")
    now = _epoch_now(conn)
    out = []
    for row in rows:
        if _row_epoch(row, "expires_at_epoch", "expires_at") <= now:
            continue
        item = dict(row)
        try:
            item["sets"] = json.loads(item.pop("sets_json") or "[]")
        except ValueError:
            item["sets"] = []
        out.append(item)
    return out


def clear_live(conn: sqlite3.Connection, match_id: int) -> None:
    db.run(conn, "DELETE FROM display_live WHERE match_id = ?", (int(match_id),))


def purge_expired(conn: sqlite3.Connection) -> None:
    db.run(conn, "DELETE FROM display_live WHERE expires_at <= ?", (_now(),))
    db.run(conn, "DELETE FROM display_pair_codes WHERE expires_at <= ? AND claimed_at IS NULL", (_now(),))
