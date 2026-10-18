"""统一 UTC / 单调时间。

P2-B：令牌过期、大屏在线判定、备份文件名等安全相关时间统一走 UTC epoch，
并用持久化高水位夹紧本机时钟回拨，避免“已过期令牌在回拨后重新有效”。
旧数据库中的本地时间字符串只读取/兼容解析，不批量改写。
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

HIGH_WATER_KEY = 'clock:high_water'
_high_water_lock = threading.Lock()
_high_water_cache: float | None = None
_last_persist = 0.0
_PERSIST_INTERVAL = 60.0
_ADVANCE_THRESHOLD = 300.0


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_epoch() -> float:
    """Raw wall-clock epoch (UTC seconds). Tests may patch this."""
    return time.time()


def utc_iso(epoch: float | None = None) -> str:
    moment = utc_now() if epoch is None else datetime.fromtimestamp(epoch, timezone.utc)
    return moment.isoformat(timespec='seconds').replace('+00:00', 'Z')


def monotonic() -> float:
    return time.monotonic()


def parse_local_text(value: str | None) -> float | None:
    """把历史本地时间字符串（YYYY-mm-dd HH:MM:SS）解释为本机时区后转 epoch。"""
    if not value:
        return None
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f'):
        try:
            return datetime.strptime(value, fmt).astimezone().timestamp()
        except ValueError:
            continue
    return None


def read_high_water(conn) -> float:
    """Read persisted high-water epoch from settings (0 when absent)."""
    global _high_water_cache
    row = conn.execute("SELECT v FROM settings WHERE k = ?", (HIGH_WATER_KEY,)).fetchone()
    try:
        stored = float(row['v']) if row is not None else 0.0
    except (TypeError, ValueError):
        stored = 0.0
    with _high_water_lock:
        if _high_water_cache is not None:
            stored = max(stored, _high_water_cache)
        _high_water_cache = stored
    return stored


def wall_epoch(conn) -> float:
    """回拨安全的墙钟 epoch：max(真实时间, 持久化高水位)。"""
    global _high_water_cache, _last_persist
    real = utc_epoch()
    with _high_water_lock:
        high = _high_water_cache
    if high is None:
        high = read_high_water(conn)
    value = max(real, high)
    if value > high + _ADVANCE_THRESHOLD or (high == 0 and value):
        now_mono = monotonic()
        if now_mono - _last_persist >= 1.0:
            try:
                _persist_high_water(conn, value)
            except Exception:
                pass  # 高水位写失败降级为内存夹紧，不阻断业务
            _last_persist = now_mono
    return value


def _persist_high_water(conn, value: float) -> None:
    global _high_water_cache
    with _high_water_lock:
        _high_water_cache = max(value, _high_water_cache or 0.0)
        cached = _high_water_cache
    row = conn.execute("SELECT v FROM settings WHERE k = ?", (HIGH_WATER_KEY,)).fetchone()
    if row is None:
        conn.execute("INSERT INTO settings (k, v) VALUES (?, ?)", (HIGH_WATER_KEY, repr(cached)))
    else:
        conn.execute("UPDATE settings SET v = ? WHERE k = ?", (repr(cached), HIGH_WATER_KEY))


def reset_cache() -> None:
    """测试隔离：清空进程内高水位缓存。"""
    global _high_water_cache, _last_persist
    with _high_water_lock:
        _high_water_cache = None
        _last_persist = 0.0
