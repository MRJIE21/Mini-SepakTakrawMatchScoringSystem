"""日志配置：控制台 + 数据目录下按大小轮转的日志文件。

P2-B REQ-009：在 ``run.py`` 入口最早调用 :func:`configure`，把服务、访问与
错误日志同时写入 ``config.logs_dir()/server.log``（UTF-8，按 STSS_LOG_MAX_BYTES
轮转、保留 STSS_LOG_BACKUP_COUNT 份），并保留控制台输出；``pythonw`` 没有
stderr 时只有文件 handler。

约束：

* 幂等：重复调用只会清理带本模块标记的 handler，不碰调用方/测试自己挂的
  handler，也不会重复输出。
* 日志目录不可写/轮转创建失败时回退到 stderr，绝不阻断服务启动。
* 时间戳统一 UTC（REQ-011），格式 ``2026-10-18T14:02:33Z``。
"""
from __future__ import annotations

import logging
import logging.handlers
import sys
import time
from pathlib import Path

from . import config

#: 业务模块建议使用该 logger 名（或它的子 logger，如 ``stss.http``）。
LOGGER_NAME = "stss"
_HANDLER_MARK = "_stss_handler"
_FORMAT = "%(asctime)sZ %(levelname)s [%(name)s] %(message)s"
_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S"
_DEFAULT_LEVEL = logging.INFO
_STATE: dict = {"configured": False, "file": None, "fallback": False,
                "level": _DEFAULT_LEVEL}
_UNSET = object()


class _UTCFormatter(logging.Formatter):
    """日志时间统一使用 UTC，避免本机时区/夏令时影响排障。"""

    converter = time.gmtime


def _level_value(level) -> int:
    if isinstance(level, int):
        return level
    name = str(level or "").strip().upper()
    value = getattr(logging, name, None)
    if isinstance(value, int):
        return value
    return _DEFAULT_LEVEL


def _own_handlers() -> list:
    """收集所有带本模块标记的 handler（正常只有 root 上的两个）。"""
    handlers = []
    loggers = [logging.getLogger()] + list(logging.Logger.manager.loggerDict.values())
    for logger in loggers:
        if not isinstance(logger, logging.Logger):
            continue
        for handler in list(getattr(logger, "handlers", ())):
            if getattr(handler, _HANDLER_MARK, False):
                handlers.append(handler)
    return handlers


def _remove_own_handlers() -> None:
    for handler in _own_handlers():
        logger = getattr(handler, "_stss_logger", None)
        if logger is None:
            # 兜底：从所有 logger 上移除。
            for candidate in [logging.getLogger()] + list(logging.Logger.manager.loggerDict.values()):
                if not isinstance(candidate, logging.Logger):
                    continue
                if handler in candidate.handlers:
                    candidate.removeHandler(handler)
        else:
            logger.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass


def _mark(handler, logger):
    setattr(handler, _HANDLER_MARK, True)
    setattr(handler, "_stss_logger", logger)
    return handler


def configure(*, log_dir: Path | str | None = None, level=None,
              max_bytes: int | None = None, backup_count: int | None = None,
              stream=_UNSET) -> dict:
    """配置（或重新配置）日志输出，返回状态字典。

    参数默认取自 ``app.config``；测试可显式传入 ``log_dir``/``max_bytes`` 等
    覆盖值。``stream`` 缺省时使用 ``sys.stderr``（``sys.stderr`` 为 None 时
    不创建控制台 handler）；显式传 ``stream=None`` 表示不输出控制台。

    返回值：``{"configured": True, "file": 路径或 None, "level": 数值,
    "fallback": 是否回退到控制台, "error": 文件失败原因或 None}``。
    """
    root = logging.getLogger()
    _remove_own_handlers()

    directory = Path(log_dir) if log_dir is not None else Path(config.logs_dir())
    level_value = _level_value(config.LOG_LEVEL if level is None else level)
    size = int(config.LOG_MAX_BYTES if max_bytes is None else max_bytes)
    backups = int(config.LOG_BACKUP_COUNT if backup_count is None else backup_count)
    size = max(1, size)
    backups = max(0, backups)

    formatter = _UTCFormatter(_FORMAT, datefmt=_DATE_FORMAT)
    file_path: Path | None = None
    file_error: str | None = None
    try:
        directory.mkdir(parents=True, exist_ok=True)
        log_file = directory / "server.log"
        handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=size, backupCount=backups,
            encoding="utf-8", delay=False)
        handler.setLevel(level_value)
        handler.setFormatter(formatter)
        root.addHandler(_mark(handler, root))
        file_path = log_file
    except (OSError, ValueError) as exc:
        file_error = f"{type(exc).__name__}: {exc}"

    console = sys.stderr if stream is _UNSET else stream
    if console is not None:
        stream_handler = logging.StreamHandler(console)
        stream_handler.setLevel(level_value)
        stream_handler.setFormatter(formatter)
        root.addHandler(_mark(stream_handler, root))

    root.setLevel(level_value)
    state = {"configured": True, "file": str(file_path) if file_path else None,
             "level": level_value, "fallback": file_error is not None,
             "error": file_error}
    _STATE.update(state)
    if file_error is not None:
        # 日志文件不可写：只要控制台可用就提示一次，不阻断启动。
        logging.getLogger(LOGGER_NAME).warning(
            "日志文件不可写，已回退到控制台输出：%s", file_error)
    return dict(state)


def get_logger(name: str | None = None) -> logging.Logger:
    """返回业务 logger（默认 ``stss``，可传 ``stss.http`` 等子名）。"""
    return logging.getLogger(name or LOGGER_NAME)


def status() -> dict:
    return dict(_STATE)


def reset() -> None:
    """测试隔离：移除并关闭本模块创建的 handler（其余 handler 不动）。"""
    _remove_own_handlers()
    logging.getLogger().setLevel(logging.WARNING)
    _STATE.update(configured=False, file=None, fallback=False,
                  level=_DEFAULT_LEVEL)
