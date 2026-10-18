"""单实例锁：同一数据目录只允许一个服务进程。

设计要点（P2-B REQ-009）：

* 锁文件路径取自 :func:`app.config.service_lock_path`（默认
  ``DATA_DIR/stss.instance.lock``），刻意不放进 ``events/``，避免被赛事库
  启动扫描误当成 ``event_<数字>.db``。
* 使用操作系统级排他锁（Windows ``msvcrt.locking`` / POSIX ``fcntl.flock``），
  进程正常退出或崩溃时由 OS 自动释放；“锁文件残留但无进程持有”只作为提示，
  不影响下一次启动。
* 文件内容只作提示：JSON ``{pid, port, started_at_utc, data_dir}``。内容写在
  0 偏移处，OS 锁加在 :data:`LOCK_OFFSET` 偏移，两者互不覆盖。
* 冲突时抛 :class:`InstanceLockError`，消息包含占用进程 PID 与端口，供
  ``run.py`` 打印并非零退出。

本模块只依赖标准库，且不启动线程、不修改业务数据库。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import clock, config

#: OS 锁加在数据区之后的固定偏移；JSON 提示内容不会超过 MAX_PAYLOAD。
LOCK_OFFSET = 4096
MAX_PAYLOAD = 2048

_LOCK_HINT = "若确认该进程已不存在，可删除锁文件后重试：{path}"


class InstanceLockError(RuntimeError):
    """实例锁被占用（或本进程重复获取）。

    ``pid``/``port``/``started_at_utc``/``data_dir`` 来自锁文件内容，可能为
    ``None``（旧版本残留、内容损坏或占用方尚未写入完成）。
    """

    def __init__(self, message: str, *, path: Path | str | None = None,
                 pid: int | None = None, port: int | None = None,
                 started_at_utc: str | None = None, data_dir: str | None = None,
                 info: dict | None = None):
        super().__init__(message)
        self.path = Path(path) if path is not None else None
        self.pid = pid
        self.port = port
        self.started_at_utc = started_at_utc
        self.data_dir = data_dir
        self.info = dict(info or {})


class InstanceLock:
    """已持有的实例锁；支持 with 与显式 :meth:`release`。"""

    def __init__(self, path: Path, handle, info: dict):
        self.path = Path(path)
        self.info = dict(info)
        self._handle = handle
        self._released = False

    @property
    def pid(self) -> int | None:
        return self.info.get("pid")

    @property
    def port(self) -> int | None:
        return self.info.get("port")

    @property
    def started_at_utc(self) -> str | None:
        return self.info.get("started_at_utc")

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            _unlock(handle)
        finally:
            try:
                handle.close()
            finally:
                _HELD.pop(str(self.path.resolve()), None)

    def __enter__(self) -> "InstanceLock":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return f"InstanceLock(path={self.path!s}, pid={self.pid}, port={self.port})"


#: 当前进程已持有的锁（路径 -> InstanceLock），防止同进程重复获取时误判。
_HELD: dict[str, InstanceLock] = {}


def _service_lock_path(path: Path | str | None = None) -> Path:
    if path is not None:
        return Path(path)
    return Path(config.service_lock_path())


def _open_lock_file(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
    return os.fdopen(fd, "r+b", buffering=0)


def _try_lock(handle) -> bool:
    """非阻塞获取 OS 排他锁；被占用返回 False，其它错误向上抛。"""
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError as exc:
        busy_codes = {getattr(os, "EACCES", 13), getattr(os, "EAGAIN", 11),
                      getattr(os, "EWOULDBLOCK", 11), 13, 11, 35}
        if exc.errno in busy_codes:
            return False
        raise


def _unlock(handle) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass  # 进程即将退出时忽略解锁失败：OS 会随句柄关闭释放。


def _read_info(handle) -> dict:
    try:
        handle.seek(0)
        raw = handle.read(MAX_PAYLOAD)
    except OSError:
        return {}
    if not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_info(handle, info: dict) -> None:
    payload = json.dumps(info, ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_PAYLOAD:
        raise InstanceLockError("实例锁内容过长，无法写入锁文件")
    handle.seek(0)
    handle.truncate(0)
    handle.write(payload)
    handle.flush()
    try:
        os.fsync(handle.fileno())
    except OSError:
        pass  # 网络盘/受限文件系统允许降级：锁仍由 OS 句柄持有。


def _busy_message(path: Path, info: dict) -> str:
    pid = info.get("pid")
    port = info.get("port")
    details = []
    if pid:
        details.append(f"PID {pid}")
    if port:
        details.append(f"端口 {port}")
    if not details:
        details.append("PID/端口未知（锁文件内容缺失或损坏）")
    started = info.get("started_at_utc")
    if started:
        details.append(f"启动时间 {started}")
    data_dir = info.get("data_dir")
    if data_dir:
        details.append(f"数据目录 {data_dir}")
    message = (f"同一数据目录已有服务实例正在运行（{'，'.join(details)}），"
               f"本次启动已取消。")
    if os.name == "nt" and port:
        message += (f"如需确认占用进程：netstat -ano | findstr :{port}。")
    message += _LOCK_HINT.format(path=path)
    return message


def acquire(data_dir: Path | str | None = None, port: int | None = None,
            *, path: Path | str | None = None) -> InstanceLock:
    """获取数据目录级实例锁并写入提示信息。

    冲突时抛 :class:`InstanceLockError`（带占用 PID/端口）。返回的
    :class:`InstanceLock` 在进程生命周期内持有，也可用 ``with`` 管理。
    """
    lock_path = _service_lock_path(path)
    key = str(lock_path.resolve())
    held = _HELD.get(key)
    if held is not None and not held._released:
        raise InstanceLockError(
            f"当前进程已持有该数据目录的实例锁（PID {os.getpid()}，端口 {held.port}），"
            f"不能重复获取：{lock_path}",
            path=lock_path, pid=os.getpid(), port=held.port, data_dir=held.info.get("data_dir"),
            info=held.info)
    try:
        handle = _open_lock_file(lock_path)
    except OSError as exc:
        raise InstanceLockError(f"无法创建实例锁文件：{lock_path}（{exc}）",
                                path=lock_path) from exc
    try:
        if not _try_lock(handle):
            info = _read_info(handle)
            handle.close()
            raise InstanceLockError(
                _busy_message(lock_path, info), path=lock_path,
                pid=info.get("pid"), port=info.get("port"),
                started_at_utc=info.get("started_at_utc"), data_dir=info.get("data_dir"),
                info=info)
    except InstanceLockError:
        raise
    except BaseException:
        handle.close()
        raise
    resolved_data_dir = Path(data_dir if data_dir is not None else config.DATA_DIR).resolve()
    info = {
        "pid": os.getpid(),
        "port": int(port) if port is not None else None,
        "started_at_utc": clock.utc_iso(),
        "data_dir": str(resolved_data_dir),
    }
    try:
        _write_info(handle, info)
    except BaseException:
        _unlock(handle)
        handle.close()
        raise
    lock = InstanceLock(lock_path, handle, info)
    _HELD[key] = lock
    return lock


def probe(data_dir: Path | str | None = None, *,
          path: Path | str | None = None) -> dict:
    """只读探测实例状态（不创建、不删除锁文件）。

    返回 ``{"locked": bool|None, "pid", "port", "started_at_utc", "data_dir",
    "path"}``；``locked`` 为 ``None`` 表示无法判断（如无权限打开锁文件）。
    """
    del data_dir  # 兼容签名；路径由 config.service_lock_path()/path 决定
    lock_path = _service_lock_path(path)
    result: dict = {"locked": False, "pid": None, "port": None,
                    "started_at_utc": None, "data_dir": None,
                    "path": str(lock_path)}
    if not lock_path.exists():
        return result
    try:
        handle = _open_lock_file(lock_path)
    except OSError as exc:
        result["locked"] = None
        result["error"] = str(exc)
        return result
    try:
        if _try_lock(handle):
            _unlock(handle)
            return result
        info = _read_info(handle)
        result.update(locked=True, pid=info.get("pid"), port=info.get("port"),
                      started_at_utc=info.get("started_at_utc"),
                      data_dir=info.get("data_dir"), info=info)
        return result
    finally:
        handle.close()


def is_locked(data_dir: Path | str | None = None, *,
              path: Path | str | None = None) -> bool:
    status = probe(data_dir, path=path)
    return status.get("locked") is True


def describe_status(data_dir: Path | str | None = None, *,
                    path: Path | str | None = None) -> str:
    """给只读命令（backup/verify）打印的一行实例状态提示。"""
    status = probe(data_dir, path=path)
    if status.get("locked") is None:
        return f"无法探测服务实例状态：{status.get('error', '未知错误')}"
    if not status.get("locked"):
        return "未检测到运行中的服务实例（只读操作可安全继续）。"
    details = []
    if status.get("pid"):
        details.append(f"PID {status['pid']}")
    if status.get("port"):
        details.append(f"端口 {status['port']}")
    if not details:
        details.append("PID/端口未知")
    return (f"检测到运行中的服务实例（{'，'.join(details)}）：本次为在线只读操作，"
            "备份使用 SQLite 在线快照，已提交数据保持一致；恢复/维护清理请先停止服务。")


def reset_for_tests() -> None:
    """测试隔离：释放本进程登记的所有锁（不删除锁文件）。"""
    for lock in list(_HELD.values()):
        lock.release()
    _HELD.clear()
